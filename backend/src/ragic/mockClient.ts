/**
 * Mock RagicClient — demo 模式用，把上游從 Ragic SaaS 替換成記憶體假倉。
 *
 * 設計：
 * - 公開介面與 RagicClient 完全同形（duck-typing；TS 上靠 export `MockRagicClient as typeof RagicClient`）
 * - 記憶體儲存 `Map<normalizedFormPath, Map<entryId, RagicRecord>>`
 * - normalizePath 把 `/test` 後綴與尾斜線都收斂掉，避免 write target 切換時打到不同桶
 * - 寫入動作（create/update/delete/action button）會即時生效，後續 read 看得到變更
 * - 子表（_subtable_<id>）：payload 含 -new 開頭的暫時鍵會被分派新數字 ID
 * - executeActionButton 一律回 SUCCESS（demo 沒有真實 workflow 要驗）
 * - 仍走 ragicRequestScheduler — token bucket / circuit breaker 還是會運作，
 *   只是「outbound HTTP」被換成 Promise.resolve，這樣 runtimeStats / 限流 demo 都還活著
 */

import type { AxiosResponse } from "axios";
import { env } from "../config/env";
import { FORM_104_CONFIG } from "../config/forms/form-104";
import { FORM_105_CONFIG } from "../config/forms/form-105";
import {
  getLatencyMs,
  getState as getFaultInjectionState,
  shouldDropField,
  shouldInjectFailure,
} from "../infra/faultInjection";
import {
  ragicRequestScheduler,
  type RagicReadPriority,
  type RagicRequestSchedulerStats,
} from "../infra/ragicRequestScheduler";
import { UpstreamError } from "../utils/httpError";
import type {
  RagicActionButtonExecutionResult,
  RagicFormData,
  RagicRecord,
  RagicWriteMethod,
  RagicWriteOptions,
} from "./client";

interface RagicPageQuery {
  limit: number;
  offset: number;
  where?: string | string[];
  fts?: string;
}

interface RagicReadRequestOptions {
  timeoutMs?: number;
  priority?: RagicReadPriority;
}

export interface MockRagicClientOptions {
  /** 每個 form bucket 最多保留多少筆 entry；超過會 evict 最舊的「非 seed」 */
  maxEntriesPerForm?: number;
}

const DEFAULT_MAX_ENTRIES_PER_FORM = 300;

function normalizeFormPath(formPath: string): string {
  let p = formPath.trim();
  if (p.endsWith("/")) p = p.slice(0, -1);
  // 收斂 test/prod write target 的尾綴差異
  if (p.endsWith("/test")) p = p.slice(0, -5);
  return p;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export type DemoFixture = Record<string, Record<string, RagicRecord>>;

export class MockRagicClient {
  private readonly store: Map<string, Map<string, RagicRecord>> = new Map();
  private nextEntryId = 1_000_000;
  private nextSubtableRowId = 50_000;
  private readonly seed: DemoFixture;
  private readonly maxEntriesPerForm: number;
  private lastResetAt: string = new Date().toISOString();

  constructor(seed: DemoFixture, options: MockRagicClientOptions = {}) {
    this.seed = seed;
    this.maxEntriesPerForm = Math.max(
      1,
      Math.trunc(options.maxEntriesPerForm ?? DEFAULT_MAX_ENTRIES_PER_FORM)
    );
    this.loadSeedIntoStore();
  }

  /**
   * 清空 in-memory store 並重新載入 fixture seed。
   * 用於 /api/__demo/reset endpoint，讓 demo 可以快速回到初始狀態。
   */
  reset(): void {
    this.store.clear();
    this.nextEntryId = 1_000_000;
    this.nextSubtableRowId = 50_000;
    this.loadSeedIntoStore();
    this.lastResetAt = new Date().toISOString();
  }

  /** 回傳 reset 元資料給 /__demo/info 使用 */
  getDemoMetadata(): {
    lastResetAt: string;
    maxEntriesPerForm: number;
    buckets: Array<{ formPath: string; entries: number; seeded: number }>;
  } {
    const buckets: Array<{ formPath: string; entries: number; seeded: number }> = [];
    for (const [formPath, bucket] of this.store) {
      let seeded = 0;
      for (const rec of bucket.values()) {
        if (rec._demoSeed === true) seeded++;
      }
      buckets.push({ formPath, entries: bucket.size, seeded });
    }
    return {
      lastResetAt: this.lastResetAt,
      maxEntriesPerForm: this.maxEntriesPerForm,
      buckets,
    };
  }

  private loadSeedIntoStore(): void {
    for (const [path, records] of Object.entries(this.seed)) {
      const key = normalizeFormPath(path);
      const bucket = new Map<string, RagicRecord>();
      for (const [entryId, record] of Object.entries(records)) {
        // _demoSeed:true 標記 seed entry，evict 時跳過
        bucket.set(entryId, { ...record, _ragicId: entryId, _demoSeed: true });
      }
      this.store.set(key, bucket);
    }
  }

  /**
   * 寫入後檢查 bucket 大小，超過上限就 evict 最舊的「非 seed」entry。
   * Map 的 iteration 是 insertion order → 第一個非 seed 就是「最早被加進來的 mutation entry」。
   */
  private evictIfOverCap(bucket: Map<string, RagicRecord>): void {
    while (bucket.size > this.maxEntriesPerForm) {
      let evicted = false;
      for (const [id, rec] of bucket) {
        if (rec._demoSeed === true) continue;
        bucket.delete(id);
        evicted = true;
        break;
      }
      // 全部都是 seed（極端情況：cap 設小於 seed 量）→ 停手不動 seed
      if (!evicted) break;
    }
  }

  private getBucket(formPath: string): Map<string, RagicRecord> {
    const key = normalizeFormPath(formPath);
    let bucket = this.store.get(key);
    if (!bucket) {
      bucket = new Map();
      this.store.set(key, bucket);
    }
    return bucket;
  }

  async getFormData(formPath: string, _useCache = true): Promise<RagicFormData> {
    await this.applyReadFault();
    return this.simulateRead(`mock.getFormData:${formPath}`, () => this.snapshot(formPath));
  }

  async getFormDataWithOptions(
    formPath: string,
    _useCache = true,
    options: RagicReadRequestOptions = {}
  ): Promise<RagicFormData> {
    await this.applyReadFault();
    return this.simulateRead(
      `mock.getFormData:${formPath}`,
      () => this.snapshot(formPath),
      options.priority ?? "user"
    );
  }

  async getFormPage(
    formPath: string,
    query: RagicPageQuery,
    _useCache = true,
    options: RagicReadRequestOptions = {}
  ): Promise<RagicFormData> {
    await this.applyReadFault();
    return this.simulateRead(
      `mock.getFormPage:${formPath}`,
      () => this.paginate(formPath, query),
      options.priority ?? "user"
    );
  }

  async getEntry(
    formPath: string,
    entryId: string,
    _useCache = true,
    options: RagicReadRequestOptions = {}
  ): Promise<RagicRecord | null> {
    await this.applyReadFault();
    return this.simulateRead(
      `mock.getEntry:${formPath}/${entryId}`,
      () => {
        const bucket = this.getBucket(formPath);
        const found = bucket.get(String(entryId));
        return found ? this.cloneRecord(found) : null;
      },
      options.priority ?? "user"
    );
  }

  async updateEntry(
    formPath: string,
    entryId: string,
    payload: RagicRecord,
    _method: RagicWriteMethod = "PATCH",
    _writeOptions: boolean | RagicWriteOptions = true
  ): Promise<RagicRecord> {
    await this.applyWriteFault();
    return ragicRequestScheduler.runWrite(
      `mock.updateEntry:${formPath}/${entryId}`,
      async () => {
        const bucket = this.getBucket(formPath);
        const id = String(entryId);
        const existing = bucket.get(id) ?? { _ragicId: id };
        const merged = this.mergeRecord(existing, payload);
        bucket.set(id, merged);

        // 同 createEntry 邏輯：form 16 寫入要同步推回 form 104/105 subtable
        this.propagateForm16ToParentSubtable(formPath, id, merged);

        return { status: "SUCCESS", ...this.cloneRecord(merged) };
      }
    );
  }

  async deleteEntry(formPath: string, entryId: string): Promise<void> {
    await this.applyWriteFault();
    await ragicRequestScheduler.runWrite(
      `mock.deleteEntry:${formPath}/${entryId}`,
      async () => {
        this.getBucket(formPath).delete(String(entryId));
        // form 16 entry 被刪 → 對應的 form 104/105 subtable row 也要清掉
        this.propagateForm16DeleteToParentSubtable(formPath, String(entryId));
      }
    );
  }

  private propagateForm16DeleteToParentSubtable(formPath: string, rowId: string): void {
    if (!/\/c1\/16/.test(formPath)) return;
    for (const parentConfig of [FORM_104_CONFIG, FORM_105_CONFIG]) {
      if (!parentConfig.ragicPath) continue;
      const parentBucket = this.getBucket(parentConfig.ragicPath);
      const subtableId = parentConfig.subtableId;
      for (const [parentId, parentRecord] of parentBucket) {
        const subtable = parentRecord[subtableId] as Record<string, RagicRecord> | undefined;
        if (!subtable || !(rowId in subtable)) continue;
        const next = { ...subtable };
        delete next[rowId];
        parentBucket.set(parentId, { ...parentRecord, [subtableId]: next });
        return;
      }
    }
  }

  async createEntry(
    formPath: string,
    payload: RagicRecord,
    _writeOptions: boolean | RagicWriteOptions = true
  ): Promise<RagicRecord> {
    await this.applyWriteFault();
    // Fault injection：在 form 16 寫入時隨機掉一個 critical field，
    // 觸發 form16WriteVerifier 後續比對失敗 → 自動 DELETE rollback。
    const effectivePayload = this.maybeDropCriticalField(formPath, payload);
    return ragicRequestScheduler.runWrite(
      `mock.createEntry:${formPath}`,
      async () => {
        const bucket = this.getBucket(formPath);
        const newId = String(this.nextEntryId++);
        const seed: RagicRecord = { _ragicId: newId };
        const record = this.mergeRecord(seed, effectivePayload);
        bucket.set(newId, record);

        // Demo 語意還原：Ragic 生產上有 workflow 把 Form 16 entry 自動推回 Form 104/105 subtable
        // 這裡用 mock 主動模擬，否則 runCreateReportFlow 的 pollCreatedSubtableRow 找不到新列
        this.propagateForm16ToParentSubtable(formPath, newId, record);

        // Demo 防爆：bucket 超過上限就 evict 最舊的非 seed entry
        this.evictIfOverCap(bucket);

        return { status: "SUCCESS", ...this.cloneRecord(record) };
      }
    );
  }

  // --- Fault injection helpers ---

  private async applyReadFault(): Promise<void> {
    const latency = getLatencyMs();
    if (latency > 0) await sleep(latency);
    if (shouldInjectFailure()) {
      throw new UpstreamError(
        "[fault-injection] simulated upstream 5xx",
        "RAGIC_READ_FAILED"
      );
    }
  }

  private async applyWriteFault(): Promise<void> {
    const latency = getLatencyMs();
    if (latency > 0) await sleep(latency);
    if (shouldInjectFailure()) {
      throw new UpstreamError(
        "[fault-injection] simulated upstream 5xx",
        "RAGIC_WRITE_FAILED"
      );
    }
  }

  /**
   * 只對 form 16 起作用：候選 critical fields 來自 env 的 work order / type / dep field ID。
   * 觸發機率符合且 payload 裡至少有一個候選欄位時，隨機挑一個 delete 掉。
   */
  private maybeDropCriticalField(formPath: string, payload: RagicRecord): RagicRecord {
    if (!/\/c1\/16/.test(formPath)) return payload;
    if (!shouldDropField()) return payload;
    const candidates = [
      env.RAGIC_FORM_16_WORK_ORDER_FIELD_ID,
      env.RAGIC_FORM_16_TYPE_FIELD_ID,
      env.RAGIC_FORM_16_DEP_FIELD_ID,
    ].filter((fid) => typeof fid === "string" && fid.length > 0 && fid in payload);
    if (candidates.length === 0) return payload;
    const victim = candidates[Math.floor(Math.random() * candidates.length)];
    const next = { ...payload };
    delete next[victim];
    return next;
  }

  private propagateForm16ToParentSubtable(
    formPath: string,
    rowId: string,
    form16Record: RagicRecord
  ): void {
    if (!/\/c1\/16/.test(formPath)) return;
    const workOrderFieldId = env.RAGIC_FORM_16_WORK_ORDER_FIELD_ID;
    const workOrderNo = form16Record[workOrderFieldId];
    if (typeof workOrderNo !== "string" || !workOrderNo) return;

    for (const parentConfig of [FORM_104_CONFIG, FORM_105_CONFIG]) {
      if (!parentConfig.ragicPath) continue;
      const parentBucket = this.getBucket(parentConfig.ragicPath);
      const workOrderKey = parentConfig.mainFields.workOrderNo;
      for (const [parentId, parentRecord] of parentBucket) {
        if (parentRecord[workOrderKey] !== workOrderNo) continue;

        // mapFields 用「中文名稱 key」找欄位（form-104.ts:9 NOTE）；
        // 同一個值同時寫入「numeric field ID」與「中文名稱」兩種 key，
        // 後續 read 流程跟未來真正打 Ragic 都能正確 mapping
        const subtableRow: RagicRecord = {};
        const subtableWriteFields = parentConfig.writeConfig.subtableWriteFields as Record<string, string>;
        const subtableReadFields = parentConfig.subtableFields as Record<string, string>;
        for (const [fieldName, writeFieldId] of Object.entries(subtableWriteFields)) {
          if (typeof writeFieldId !== "string") continue;
          if (!(writeFieldId in form16Record)) continue;
          const value = form16Record[writeFieldId];
          subtableRow[writeFieldId] = value;
          const readKey = subtableReadFields[fieldName];
          if (readKey) {
            subtableRow[readKey] = value;
          }
        }
        const subtableId = parentConfig.subtableId;
        const existingSub =
          (parentRecord[subtableId] as Record<string, RagicRecord> | undefined) ?? {};
        const updated = { ...parentRecord, [subtableId]: { ...existingSub, [rowId]: subtableRow } };
        parentBucket.set(parentId, updated);
        return;
      }
    }
  }

  async getActionButtons(
    formPath: string,
    _category: "massOperation" = "massOperation",
    _options: RagicReadRequestOptions = {}
  ): Promise<Array<{ id: string; name: string }>> {
    await this.applyReadFault();
    if (/\/16\b/.test(formPath)) {
      return [{ id: "48", name: "[demo] 儲存停機資料" }];
    }
    if (/\/(104|105)\b/.test(formPath)) {
      return [
        { id: "13", name: "[demo] 結案" },
        { id: "18", name: "[demo] 重新開單" },
      ];
    }
    return [];
  }

  async executeActionButton(
    formPath: string,
    entryId: string,
    buttonId: string
  ): Promise<RagicActionButtonExecutionResult> {
    return ragicRequestScheduler.runWrite(
      `mock.executeActionButton:${formPath}/${entryId}#${buttonId}`,
      async () => ({
        status: "SUCCESS",
        msg: `[demo] action button ${buttonId} acknowledged`,
        raw: { status: "SUCCESS", buttonId } as RagicRecord,
      })
    );
  }

  clearFormCache(_formPath: string): void {
    // 記憶體 store 不需要 cache 清除
  }

  clearCache(): void {
    // no-op
  }

  getRuntimeStats(): RagicRequestSchedulerStats {
    return ragicRequestScheduler.getStats();
  }

  /** Demo control plane bridge：給 /__demo/info 用，完整 state 走 /__demo/fault-injection */
  getFaultInjection(): { enabled: boolean } {
    return { enabled: getFaultInjectionState().enabled };
  }

  // --- 內部：寫入時的 merge / subtable 處理 ---

  private mergeRecord(existing: RagicRecord, patch: RagicRecord): RagicRecord {
    const result: RagicRecord = { ...existing };
    for (const [key, value] of Object.entries(patch)) {
      if (key.startsWith("_subtable_") && isObject(value)) {
        result[key] = this.mergeSubtable(
          key,
          (existing[key] as Record<string, RagicRecord> | undefined) ?? {},
          value as Record<string, unknown>
        );
        continue;
      }
      // Ragic 子表刪除 sentinel：{"_DELSUB_<subtableId>": [rowId, ...]} 或 {"_DELSUB__subtable_<id>": [...]}
      if (key.startsWith("_DELSUB_") && Array.isArray(value)) {
        const subtableKey = key.startsWith("_DELSUB__subtable_")
          ? key.slice("_DELSUB_".length) // -> "_subtable_<id>"
          : `_subtable_${key.slice("_DELSUB_".length)}`;
        const sub = (result[subtableKey] as Record<string, RagicRecord> | undefined) ?? {};
        const next = { ...sub };
        for (const rowId of value as unknown[]) {
          const k = String(rowId);
          delete next[k];
        }
        result[subtableKey] = next;
        continue;
      }
      result[key] = value as RagicRecord[string];
    }
    return result;
  }

  private mergeSubtable(
    subtableKey: string,
    existing: Record<string, RagicRecord>,
    patch: Record<string, unknown>
  ): Record<string, RagicRecord> {
    const merged: Record<string, RagicRecord> = { ...existing };
    const parentConfig =
      FORM_104_CONFIG.subtableId === subtableKey
        ? FORM_104_CONFIG
        : FORM_105_CONFIG.subtableId === subtableKey
          ? FORM_105_CONFIG
          : null;
    for (const [rowKey, rowValue] of Object.entries(patch)) {
      if (!isObject(rowValue)) continue;
      // Ragic 新增子表行慣例：用 `-new1` 等暫時鍵 → mock 給它真實數字 ID
      const finalKey =
        rowKey.startsWith("-") || rowKey === ""
          ? String(this.nextSubtableRowId++)
          : rowKey;
      const existingRow = merged[finalKey] ?? {};
      const incoming = rowValue as RagicRecord;
      const synced = parentConfig
        ? this.syncSubtableRowKeys(parentConfig, incoming)
        : incoming;
      merged[finalKey] = { ...existingRow, ...synced };
    }
    return merged;
  }

  /**
   * 寫入 payload 用 numeric field ID（writeConfig），讀取卻用中文 key（subtableFields）。
   * mock 在 merge 時把同一個值雙向寫入，後續 mapFields 才讀得到。
   */
  private syncSubtableRowKeys(
    parentConfig: typeof FORM_104_CONFIG,
    row: RagicRecord
  ): RagicRecord {
    const writeFields = parentConfig.writeConfig.subtableWriteFields as Record<string, string>;
    const readFields = parentConfig.subtableFields as Record<string, string>;
    const result: RagicRecord = { ...row };
    for (const [fieldName, writeId] of Object.entries(writeFields)) {
      if (typeof writeId !== "string") continue;
      const readKey = readFields[fieldName];
      if (!readKey) continue;
      // ID → 中文名稱
      if (writeId in row && !(readKey in row)) {
        result[readKey] = row[writeId];
      }
      // 中文名稱 → ID
      if (readKey in row && !(writeId in row)) {
        result[writeId] = row[readKey];
      }
    }
    return result;
  }

  // --- 內部：讀取 helper ---

  private snapshot(formPath: string): RagicFormData {
    const bucket = this.getBucket(formPath);
    const out: RagicFormData = {};
    for (const [id, rec] of bucket) {
      out[id] = this.cloneRecord(rec);
    }
    return out;
  }

  private paginate(formPath: string, query: RagicPageQuery): RagicFormData {
    const bucket = this.getBucket(formPath);
    let rows = Array.from(bucket.entries());

    if (query.fts && typeof query.fts === "string" && query.fts.trim()) {
      const needle = query.fts.trim().toLowerCase();
      rows = rows.filter(([, rec]) => recordContainsText(rec, needle));
    }
    if (query.where) {
      const conditions = Array.isArray(query.where) ? query.where : [query.where];
      rows = rows.filter(([, rec]) =>
        conditions.every((cond) => matchWhereCondition(rec, cond))
      );
    }

    const sliced = rows.slice(query.offset, query.offset + query.limit);
    const out: RagicFormData = {};
    for (const [id, rec] of sliced) {
      out[id] = this.cloneRecord(rec);
    }
    return out;
  }

  private cloneRecord(rec: RagicRecord): RagicRecord {
    // 用 JSON 走一遍夠了：mock 資料全是 JSON-serializable
    return JSON.parse(JSON.stringify(rec)) as RagicRecord;
  }

  private async simulateRead<T>(
    label: string,
    work: () => T,
    priority: RagicReadPriority = "user"
  ): Promise<T> {
    return ragicRequestScheduler.runRead(label, async () => work(), priority);
  }
}

function recordContainsText(rec: RagicRecord, needle: string): boolean {
  for (const value of Object.values(rec)) {
    if (typeof value === "string" && value.toLowerCase().includes(needle)) {
      return true;
    }
    if (isObject(value)) {
      // 子表 nested object：再下一層
      for (const inner of Object.values(value)) {
        if (typeof inner === "string" && inner.toLowerCase().includes(needle)) {
          return true;
        }
        if (isObject(inner)) {
          for (const innermost of Object.values(inner)) {
            if (
              typeof innermost === "string" &&
              innermost.toLowerCase().includes(needle)
            ) {
              return true;
            }
          }
        }
      }
    }
  }
  return false;
}

function matchWhereCondition(rec: RagicRecord, condition: string): boolean {
  // Ragic where 格式：`<fieldId>,<op>,<value>`
  const parts = condition.split(",");
  if (parts.length < 3) return true;
  const [fieldId, op, ...rest] = parts;
  const target = rest.join(",").trim().toLowerCase();
  const fieldValue = rec[fieldId];
  if (typeof fieldValue !== "string") return false;
  const haystack = fieldValue.toLowerCase();
  switch (op) {
    case "like":
      return haystack.includes(target);
    case "eq":
    case "=":
      return haystack === target;
    case "neq":
    case "!=":
      return haystack !== target;
    default:
      return haystack.includes(target);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 讓 TS 編譯時 AxiosResponse 不會被 tree-shake 警告（保留 type-only import 形狀）
export type __MockRagicClientAxiosCompat = AxiosResponse;

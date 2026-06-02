import type { BatchCreateRowRequest, ReportMutationPayload } from "../../api/workReport";
import type { WorkReportFormId } from "./types";
import { getOrCreateClientId } from "./debug/clientIdentity";

const WORK_REPORT_RETRYABLE_BATCH_CREATE_STORE_KEY =
  "work-report:retryable-batch-create-store:v1";
const RETRYABLE_BATCH_CREATE_MAX_ITEMS = 20;
const RETRYABLE_BATCH_CREATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RETRYABLE_BATCH_CREATE_CHANGED_EVENT = "work-report:retryable-batch-create-changed";

function dispatchStoreChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(RETRYABLE_BATCH_CREATE_CHANGED_EVENT));
}

export interface RetryableBatchCreateRecord {
  taskId: string;
  retryRootTaskId: string;
  retriedFromTaskId?: string;
  latestRetryTaskId?: string;
  formId: WorkReportFormId;
  entryId: string;
  workOrderNo?: string | null;
  /** 每筆 row 帶 clientRowKey 做 idempotency；舊版 store 可能只有 payload，讀取時會補 key=undefined */
  rows: BatchCreateRowRequest[];
  editSessionId?: string;
  actorClientId: string;
  createdAt: string;
}

function isLikelyReportMutationPayload(value: Record<string, unknown>): boolean {
  // 只驗 date（永遠必填）；其他欄位放寬交給 backend 判斷，
  // 避免 null / undefined 的合法情境（例如計畫停機時段留空）被誤判成垃圾資料丟棄
  return typeof value.date === "string" && value.date.length > 0;
}

function normalizeStoredRow(raw: unknown): { row: BatchCreateRowRequest; migrated: boolean } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const maybePayload = record.payload;
  if (maybePayload && typeof maybePayload === "object" && !Array.isArray(maybePayload)) {
    const payload = maybePayload as Record<string, unknown>;
    if (!isLikelyReportMutationPayload(payload)) return null;
    return {
      row: {
        payload: payload as unknown as ReportMutationPayload,
        ...(typeof record.clientRowKey === "string" && record.clientRowKey.length > 0
          ? { clientRowKey: String(record.clientRowKey) }
          : {}),
      },
      migrated: false,
    };
  }
  // 舊 shape：整個 row 就是 payload，沒有 clientRowKey
  if (!isLikelyReportMutationPayload(record)) return null;
  return {
    row: { payload: record as unknown as ReportMutationPayload },
    migrated: true,
  };
}

type RetryableBatchCreateStore = Record<string, RetryableBatchCreateRecord>;

function readLocalStorageValue(key: string): string {
  if (typeof window === "undefined") {
    return "";
  }
  try {
    return String(window.localStorage.getItem(key) ?? "").trim();
  } catch {
    return "";
  }
}

function writeLocalStorageValue(key: string, value: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (!value) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, value);
  } catch {
    // NOTE: localStorage 寫入失敗不阻塞主流程
  }
}

function isRetryableBatchCreateRecord(
  value: unknown
): value is RetryableBatchCreateRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<RetryableBatchCreateRecord>;
  return (
    typeof candidate.taskId === "string" &&
    typeof candidate.retryRootTaskId === "string" &&
    typeof candidate.formId === "string" &&
    typeof candidate.entryId === "string" &&
    Array.isArray(candidate.rows) &&
    typeof candidate.actorClientId === "string" &&
    typeof candidate.createdAt === "string"
  );
}

function readRetryableBatchCreateStore(): RetryableBatchCreateStore {
  const raw = readLocalStorageValue(WORK_REPORT_RETRYABLE_BATCH_CREATE_STORE_KEY);
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const now = Date.now();
    let didMigrate = false;
    const entries = Object.entries(parsed)
      .filter((entry): entry is [string, RetryableBatchCreateRecord] =>
        isRetryableBatchCreateRecord(entry[1])
      )
      .map(([taskId, record]): [string, RetryableBatchCreateRecord] => {
        const normalizedRows = (Array.isArray(record.rows) ? record.rows : [])
          .map(normalizeStoredRow)
          .filter((item): item is { row: BatchCreateRowRequest; migrated: boolean } => item !== null);
        if (normalizedRows.some((item) => item.migrated)) didMigrate = true;
        return [taskId, { ...record, rows: normalizedRows.map((item) => item.row) }];
      })
      .filter(([, record]) => {
        const createdAt = Date.parse(record.createdAt);
        return Number.isNaN(createdAt) || now - createdAt < RETRYABLE_BATCH_CREATE_TTL_MS;
      })
      .slice(-RETRYABLE_BATCH_CREATE_MAX_ITEMS);

    const store = Object.fromEntries(entries) as RetryableBatchCreateStore;
    // 發現舊 shape → 順手 migrate 回 localStorage，避免每次 read 都要轉換
    // 用 raw setItem 避免再 dispatch 廣播（單純格式升級，對其他頁面無意義）
    if (didMigrate && typeof window !== "undefined") {
      try {
        window.localStorage.setItem(
          WORK_REPORT_RETRYABLE_BATCH_CREATE_STORE_KEY,
          JSON.stringify(store)
        );
      } catch {
        // 容忍 localStorage 寫入失敗
      }
    }
    return store;
  } catch {
    return {};
  }
}

function writeRetryableBatchCreateStore(store: RetryableBatchCreateStore): void {
  writeLocalStorageValue(
    WORK_REPORT_RETRYABLE_BATCH_CREATE_STORE_KEY,
    JSON.stringify(store)
  );
  // 同分頁也能收到（`storage` 事件僅跨 tab 發送）
  dispatchStoreChanged();
}

export function saveRetryableBatchCreateRecord(
  record: Omit<RetryableBatchCreateRecord, "actorClientId">
): void {
  const store = readRetryableBatchCreateStore();
  store[record.taskId] = {
    ...record,
    actorClientId: getOrCreateClientId(),
  };

  const orderedEntries = Object.entries(store)
    .sort((left, right) => {
      const leftTime = Date.parse(left[1].createdAt);
      const rightTime = Date.parse(right[1].createdAt);
      return leftTime - rightTime;
    })
    .slice(-RETRYABLE_BATCH_CREATE_MAX_ITEMS);

  writeRetryableBatchCreateStore(Object.fromEntries(orderedEntries));
}

export function getRetryableBatchCreateRecord(
  taskId: string
): RetryableBatchCreateRecord | null {
  const store = readRetryableBatchCreateStore();
  return store[taskId] ?? null;
}

export function deleteRetryableBatchCreateRecord(taskId: string): void {
  if (!taskId) return;
  const store = readRetryableBatchCreateStore();
  if (!store[taskId]) return;
  delete store[taskId];
  writeRetryableBatchCreateStore(store);
}

/**
 * Retry 鏈：一次送出失敗後 retry 會產生多筆 record（原始 + 每次 retry），
 * 它們共享同一個 retryRootTaskId。當其中一筆最終成功，整條鏈都應一起清掉。
 */
export function deleteRetryableBatchCreateRecordChain(taskId: string): void {
  if (!taskId) return;
  const store = readRetryableBatchCreateStore();
  const target = store[taskId];
  if (!target) return;
  const rootId = target.retryRootTaskId || taskId;
  let mutated = false;
  for (const [key, record] of Object.entries(store)) {
    if ((record.retryRootTaskId || key) === rootId) {
      delete store[key];
      mutated = true;
    }
  }
  if (mutated) {
    writeRetryableBatchCreateStore(store);
  }
}

/**
 * 回傳去重後的 retry chain「代表記錄」：每條鏈只保留最新一筆
 * - 先以 latestRetryTaskId 判斷 chain head
 * - 同 retryRootTaskId 多個 head（中段 TTL 清掉的邊界）時，以 createdAt 最新者為代表
 */
export function listRetryableBatchCreateRecords(): RetryableBatchCreateRecord[] {
  const store = readRetryableBatchCreateStore();
  const values = Object.values(store);
  const chainHeads = values.filter((record) => {
    const nextId = record.latestRetryTaskId;
    if (!nextId) return true;
    return !store[nextId];
  });

  // 同 retryRootTaskId 只保留 createdAt 最新的那一筆
  const byRoot = new Map<string, RetryableBatchCreateRecord>();
  for (const record of chainHeads) {
    const rootId = record.retryRootTaskId || record.taskId;
    const existing = byRoot.get(rootId);
    if (!existing) {
      byRoot.set(rootId, record);
      continue;
    }
    const currentTime = Date.parse(record.createdAt);
    const existingTime = Date.parse(existing.createdAt);
    if (currentTime > existingTime) {
      byRoot.set(rootId, record);
    }
  }

  return Array.from(byRoot.values()).sort((a, b) => {
    const aTime = Date.parse(a.createdAt);
    const bTime = Date.parse(b.createdAt);
    return bTime - aTime;
  });
}

export function replaceRetryableBatchCreateRecord(
  previousTaskId: string,
  nextRecord: Omit<RetryableBatchCreateRecord, "actorClientId">
): void {
  const store = readRetryableBatchCreateStore();
  if (previousTaskId && store[previousTaskId]) {
    store[previousTaskId] = {
      ...store[previousTaskId],
      latestRetryTaskId: nextRecord.taskId,
    };
  }
  store[nextRecord.taskId] = {
    ...nextRecord,
    actorClientId: getOrCreateClientId(),
  };
  writeRetryableBatchCreateStore(store);
}

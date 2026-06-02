import { env, resolveWritePath } from "../../config/env";
import { FORM_104_CONFIG } from "../../config/forms/form-104";
import { ragicClient, type RagicRecord } from "../../ragic/client";
import { normalizeRows } from "../work-report/shared/ragicRowUtils";
import { getFirstFieldValue } from "../work-report/shared/subtableUtils";
import {
  isEmptyValue,
  normalizeComparableValue,
  parseNumericValue,
} from "../work-report/shared/valueUtils";
import { workReportReadService } from "../work-report/workReportReadService";
import { buildBackgroundReadOptions } from "../work-report/shared/refreshEntryOptions";
import { form16DowntimeSqliteRepository } from "../../storage/sqlite/form16DowntimeSqliteRepository";
import {
  FORM16_FIELD_NAME_CANDIDATES,
  FORM16_REQUIRED_FALLBACK_BY_REPORT_TYPE,
  resolveForm16ReportType,
} from "../work-report/create/form16ReportTypeRules";
import { HttpError } from "../../utils/httpError";
import type { Form16DowntimeRecord } from "../../types/form16Downtime";
import { checkOrCreateForm16Entry } from "./form16IdempotencyService";
import { assertForm16EntryStored } from "./form16WriteVerifier";

const FORM_16_DEFAULT_INPUT_OPTIONS = "整天";
const FORM_16_DEFAULT_SHIFT_TYPE = "正常班Reg";
const FORM_16_DEFAULT_START_TIME = "08:00";
const FORM_16_DEFAULT_END_TIME = "17:00";
const FORM_16_DEFAULT_BREAK_TIME = "1.00";
const FORM_16_DEFAULT_PLANNED_IDLE_MINUTES = 480;

const FORM_16_FIELD_CANDIDATES = {
  workOrderNo: [
    FORM_104_CONFIG.mainFields.workOrderNo,
    "工令單單號",
    env.RAGIC_FORM_16_WORK_ORDER_FIELD_ID,
    "No.工令單單號",
    "ERP Work Order No.工令單單號",
  ],
  reportType: [env.RAGIC_FORM_16_TYPE_FIELD_ID, "報工類別", "Type報工類別"],
  processCode: [
    "PROCESS子製程別代碼",
    FORM_104_CONFIG.writeConfig.subtableWriteFields.processCode,
    FORM_104_CONFIG.subtableFields.processCode,
  ],
  machineId: [
    "Mach機台/Pack Type包裝類別",
    FORM_104_CONFIG.writeConfig.subtableWriteFields.machineId,
    FORM_104_CONFIG.subtableFields.machineId,
  ],
  operatorId: [
    "Operator ID操作者工號",
    FORM_104_CONFIG.writeConfig.subtableWriteFields.operatorId,
    FORM_104_CONFIG.subtableFields.operatorId,
  ],
  operatorName: [
    "Operator擔當姓名",
    FORM_104_CONFIG.writeConfig.subtableWriteFields.operatorName,
    FORM_104_CONFIG.subtableFields.operatorName,
  ],
  date: [
    "Date生產日期",
    "Production Date生產日",
    FORM_104_CONFIG.writeConfig.subtableWriteFields.date,
    FORM_104_CONFIG.subtableFields.date,
  ],
  plannedIdle: [
    "計畫停機?",
    FORM_104_CONFIG.writeConfig.subtableWriteFields.plannedIdle,
    FORM_104_CONFIG.subtableFields.plannedIdle,
    "Planned Idle計畫停機？",
  ],
  startTime: [
    "Start Time開工時間(H:M)",
    FORM_104_CONFIG.writeConfig.subtableWriteFields.startTime,
    FORM_104_CONFIG.subtableFields.startTime,
  ],
  endTime: [
    "End Time完工時間(H:M)",
    FORM_104_CONFIG.writeConfig.subtableWriteFields.endTime,
    FORM_104_CONFIG.subtableFields.endTime,
  ],
  breakTime: [
    "Break Time扣除休息時間(時Hr)",
    FORM_104_CONFIG.writeConfig.subtableWriteFields.breakTime,
    FORM_104_CONFIG.subtableFields.breakTime,
  ],
  plannedIdleMinutes: [
    "(P)Planned Idle計劃停機/分",
    FORM_104_CONFIG.writeConfig.subtableWriteFields.plannedIdleMinutes,
    FORM_104_CONFIG.subtableFields.plannedIdleMinutes,
  ],
  remark: [
    env.RAGIC_FORM_16_REMARK_FIELD_ID,
    "Remark備註",
    FORM_104_CONFIG.writeConfig.subtableWriteFields.remark,
    FORM_104_CONFIG.subtableFields.remark,
  ],
} as const;

export interface CreateForm16DowntimeInput {
  date: string;
  machineId: string;
  processCode: string;
  operatorId?: string;
  plannedIdleMinutes?: number;
  remark?: string;
  /**
   * 前端產的 UUID idempotency key。同一次送出流程（含重試）重用同一個 key，
   * 後端會用 SQLite 映射擋掉 retry 風暴造成的重複寫入。沒帶 key 仍可執行但無保護。
   */
  clientRowKey?: string;
}

export interface UpdateForm16DowntimeInput {
  date?: string;
  machineId?: string;
  processCode?: string;
  /** 傳空字串代表清空操作者 */
  operatorId?: string;
  plannedIdleMinutes?: number;
  remark?: string;
}

export interface ListForm16DowntimeOptions {
  refresh?: boolean;
  limit?: number;
  offset?: number;
}

export interface ListForm16DowntimeResult {
  records: Form16DowntimeRecord[];
  totalCount: number;
  source: "sqlite" | "ragic-refresh" | "sqlite-fallback";
  refreshed: boolean;
  refreshTriggered?: boolean;
}

function pickNullableText(record: RagicRecord, fields: readonly string[]): string | null {
  const value = getFirstFieldValue(record, [...fields]);
  if (isEmptyValue(value)) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized || null;
}

function resolvePlannedIdleFlag(record: RagicRecord): boolean {
  for (const field of FORM_16_FIELD_CANDIDATES.plannedIdle) {
    const normalized = normalizeComparableValue(getFirstFieldValue(record, [field])).toLowerCase();
    if (normalized === "yes") {
      return true;
    }
  }

  const plannedIdleMinutes = parseNumericValue(
    getFirstFieldValue(record, [...FORM_16_FIELD_CANDIDATES.plannedIdleMinutes])
  );
  return plannedIdleMinutes !== null && plannedIdleMinutes > 0;
}

function resolveForm16Path(): string {
  const resolved = resolveWritePath("16", env.RAGIC_FORM_16_PATH) ?? env.RAGIC_FORM_16_PATH;
  if (!resolved.trim()) {
    throw new HttpError(503, "Form 16 路徑未設定", "FORM_NOT_CONFIGURED");
  }
  return resolved;
}

export class Form16DowntimeService {
  private refreshSnapshotPromise: Promise<Form16DowntimeRecord[]> | null = null;

  async getOptions() {
    try {
      return await workReportReadService.getFormOptions("104", ["machineId", "operatorId", "processCode"]);
    } catch (error) {
      console.warn("[form16-downtime][options-failed]", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { machineId: [], operatorId: [], processCode: [] } as Awaited<
        ReturnType<typeof workReportReadService.getFormOptions>
      >;
    }
  }

  async listRecords(options: ListForm16DowntimeOptions = {}): Promise<ListForm16DowntimeResult> {
    const limit =
      typeof options.limit === "number" && Number.isFinite(options.limit) && options.limit > 0
        ? Math.trunc(options.limit)
        : 50;
    const offset =
      typeof options.offset === "number" && Number.isFinite(options.offset) && options.offset > 0
        ? Math.trunc(options.offset)
        : 0;
    const paginateRecords = (records: Form16DowntimeRecord[]) =>
      records.slice(offset, offset + limit);

    if (!env.SQLITE_ENABLED) {
      const records = await this.fetchRecordsFromRagic();
      return {
        records: paginateRecords(records),
        totalCount: records.length,
        source: "ragic-refresh",
        refreshed: true,
      };
    }

    const snapshotState = await form16DowntimeSqliteRepository.getSnapshotState();
    const hasSnapshot = Boolean(snapshotState);

    if (hasSnapshot && !options.refresh) {
      return {
        records: await form16DowntimeSqliteRepository.listRecords({ limit, offset }),
        totalCount: snapshotState?.totalRecords ?? 0,
        source: "sqlite",
        refreshed: false,
      };
    }

    if (!hasSnapshot) {
      // 沒有 snapshot 時不阻塞 — 回空、背景觸發 refresh
      void this.refreshSqliteSnapshotFromRagic().catch((error) => {
        console.warn("[form16-downtime][background-initial-refresh-failed]", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return {
        records: [],
        totalCount: 0,
        source: "sqlite",
        refreshed: false,
      };
    }

    // refresh=true — 背景刷新、先回舊資料，避免跟 auto-sync 搶 concurrency timeout
    void this.refreshSqliteSnapshotFromRagic().catch((error) => {
      console.warn("[form16-downtime][background-refresh-failed]", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return {
      records: await form16DowntimeSqliteRepository.listRecords({ limit, offset }),
      totalCount: snapshotState?.totalRecords ?? 0,
      source: "sqlite",
      refreshed: false,
      refreshTriggered: true,
    };
  }

  async refreshSqliteSnapshotFromRagic(): Promise<Form16DowntimeRecord[]> {
    if (this.refreshSnapshotPromise) {
      return this.refreshSnapshotPromise;
    }

    const run = (async () => {
      const records = await this.fetchRecordsFromRagic();
      // fetchRecordsFromRagic 失敗會 throw（不會回 []），所以走到這代表 fetch 成功。
      // 0 筆是合法結果（30 天內真的沒任何計畫停機，或舊資料超出時間範圍），
      // 此時 SQLite 該同步成空集合，syncSnapshot([]) 會 delete 殘留的 30+ 天舊資料。
      // 之前有個「records.length === 0 + existing > 0 就跳過」的保護是為了防 fetch
      // 失敗誤覆蓋，但 fetch 失敗已經 throw 不會走到這，保護反而擋掉合法清除。
      if (env.SQLITE_ENABLED) {
        // incremental sync：比對 diff、不會洗掉剛 upsert 的新建 entry
        await form16DowntimeSqliteRepository.syncSnapshot(records, new Date().toISOString());
      }
      return records;
    })();

    this.refreshSnapshotPromise = run.finally(() => {
      this.refreshSnapshotPromise = null;
    });

    return run;
  }

  async checkSnapshotStaleness(): Promise<{ isStale: boolean }> {
    if (!env.SQLITE_ENABLED) {
      return { isStale: true };
    }
    const snapshotState = await form16DowntimeSqliteRepository.getSnapshotState();
    const snapshotAt = snapshotState?.snapshotAt ? Date.parse(snapshotState.snapshotAt) : Number.NaN;
    const isStale =
      !snapshotState ||
      Number.isNaN(snapshotAt) ||
      Date.now() - snapshotAt >= env.FORM16_SQLITE_REFRESH_INTERVAL_MS;
    return { isStale };
  }

  async refreshSqliteSnapshotIfStale(): Promise<{
    refreshed: boolean;
    records: Form16DowntimeRecord[];
  }> {
    if (!env.SQLITE_ENABLED) {
      const records = await this.fetchRecordsFromRagic();
      return {
        refreshed: true,
        records,
      };
    }

    const snapshotState = await form16DowntimeSqliteRepository.getSnapshotState();
    const snapshotAt = snapshotState?.snapshotAt ? Date.parse(snapshotState.snapshotAt) : Number.NaN;
    const isStale =
      !snapshotState ||
      Number.isNaN(snapshotAt) ||
      Date.now() - snapshotAt >= env.FORM16_SQLITE_REFRESH_INTERVAL_MS;

    if (!isStale) {
      return {
        refreshed: false,
        records: [],
      };
    }

    const records = await this.refreshSqliteSnapshotFromRagic();
    return {
      refreshed: true,
      records,
    };
  }

  async refreshEntrySnapshotFromRagic(entryId: string): Promise<Form16DowntimeRecord | null> {
    const normalizedEntryId = String(entryId ?? "").trim();
    if (!normalizedEntryId) {
      return null;
    }

    const form16Path = resolveForm16Path();
    // Form 16 沒 webhook，這條是：
    // (a) callback task 觸發 → 背景刷新 SQLite snapshot
    // (b) 使用者 downtime 新增/編輯/刪除後 → 刷新 SQLite（已被 try/catch 包住，失敗可接受）
    // 兩者都是「使用者主請求之外」的背景任務，走 background lane 不污染使用者 lane。
    const entry = await ragicClient.getEntry(
      form16Path,
      normalizedEntryId,
      false,
      buildBackgroundReadOptions("background")
    );
    const snapshotAt = new Date().toISOString();

    if (!entry) {
      if (env.SQLITE_ENABLED) {
        await form16DowntimeSqliteRepository.deleteRecord(normalizedEntryId, snapshotAt);
      }
      return null;
    }

    const record = this.mapRowToRecord(normalizedEntryId, entry);
    if (!record) {
      if (env.SQLITE_ENABLED) {
        await form16DowntimeSqliteRepository.deleteRecord(normalizedEntryId, snapshotAt);
      }
      return null;
    }

    if (env.SQLITE_ENABLED) {
      await form16DowntimeSqliteRepository.upsertRecord(record, snapshotAt);
    }
    return record;
  }

  private async fetchRecordsFromRagic(): Promise<Form16DowntimeRecord[]> {
    const form16Path = resolveForm16Path();
    const t0 = Date.now();

    // 只抓 30 天內（90 天仍有 7000+ 筆太慢，停機紀錄只需近期資料）
    // 多條件 AND：
    //   - Date生產日期 >= 30 天前         (1002190)
    //   - 計畫停機 = Yes                   (1012814)
    // 把 plannedIdle filter 推到 Ragic 側，避免拉回來再本地 filter 造成 rawCount >> filteredCount 的浪費
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 30);
    const dateFrom = `${cutoffDate.getFullYear()}/${String(cutoffDate.getMonth() + 1).padStart(2, "0")}/${String(cutoffDate.getDate()).padStart(2, "0")}`;
    const whereClauses = [
      `1002190,>=,${dateFrom}`,
      `1012814,eq,Yes`,
    ];

    // 分頁全表掃語意上是 bulk read（跟 auto-sync 同類），走 sync lane：
    // - 跟 background callback / verify / projection 分流，避免 bulk 把 4 slot pool 塞滿
    // - timeout 也用 sync 的 60s（單頁可能很大，要長 timeout）
    const allRows: ReturnType<typeof normalizeRows> = [];
    let offset = 0;
    const pageSize = 1000;

    while (true) {
      const page = await ragicClient.getFormPage(
        form16Path,
        { limit: pageSize, offset, where: whereClauses },
        false,
        { timeoutMs: env.RAGIC_SYNC_READ_TIMEOUT_MS, priority: "sync" }
      );
      const rows = normalizeRows(page);
      allRows.push(...rows);
      if (rows.length < pageSize) {
        break;
      }
      offset += pageSize;
    }

    const mapped = allRows
      .sort((left, right) => Number(right.entryId) - Number(left.entryId))
      .map((row) => this.mapRowToRecord(row.entryId, row.data))
      .filter((record): record is Form16DowntimeRecord => {
        return Boolean(
          record &&
            String(record.workOrderNo ?? "").trim() === "" &&
            record.machineId &&
            record.processCode
        );
      });

    const fetchMs = Date.now() - t0;
    if (fetchMs > 10000) {
      console.warn("[form16-downtime][fetch-slow]", {
        fetchMs,
        rawCount: allRows.length,
        filteredCount: mapped.length,
      });
    }

    return mapped;
  }

  async createRecord(input: CreateForm16DowntimeInput): Promise<{ created: true; entryId: string }> {
    const form16Path = resolveForm16Path();
    const date = String(input.date ?? "").trim();
    const machineId = String(input.machineId ?? "").trim();
    const processCode = String(input.processCode ?? "").trim();
    const operatorId = String(input.operatorId ?? "").trim();
    const remark = String(input.remark ?? "").trim();

    if (!date) {
      throw new HttpError(400, "缺少必要欄位：date", "INVALID_PAYLOAD");
    }
    if (!machineId) {
      throw new HttpError(400, "缺少必要欄位：machineId", "INVALID_PAYLOAD");
    }
    if (!processCode) {
      throw new HttpError(400, "缺少必要欄位：processCode", "INVALID_PAYLOAD");
    }

    const plannedIdleMinutes =
      typeof input.plannedIdleMinutes === "number" && Number.isFinite(input.plannedIdleMinutes)
        ? Math.max(0, Math.trunc(input.plannedIdleMinutes))
        : FORM_16_DEFAULT_PLANNED_IDLE_MINUTES;

    const t0 = Date.now();
    const resolvedReportType = resolveForm16ReportType("", processCode, "");

    const [operatorName, resolvedRequiredFields] = await Promise.all([
      operatorId ? this.resolveOperatorName(operatorId) : Promise.resolve(""),
      this.resolveForm16RequiredFields(
        form16Path,
        "",
        processCode,
        resolvedReportType.type
      ),
    ]);

    const payload: RagicRecord = {
      [FORM_104_CONFIG.writeConfig.subtableWriteFields.date]: date,
      [FORM_104_CONFIG.writeConfig.subtableWriteFields.plannedIdle]: "Yes",
      [FORM_104_CONFIG.writeConfig.subtableWriteFields.processCode]: processCode,
      [FORM_104_CONFIG.writeConfig.subtableWriteFields.machineId]: machineId,
      [FORM_104_CONFIG.writeConfig.subtableWriteFields.inputOptions]:
        FORM_16_DEFAULT_INPUT_OPTIONS,
      [FORM_104_CONFIG.writeConfig.subtableWriteFields.shiftType]:
        FORM_16_DEFAULT_SHIFT_TYPE,
      [FORM_104_CONFIG.writeConfig.subtableWriteFields.startTime]:
        FORM_16_DEFAULT_START_TIME,
      [FORM_104_CONFIG.writeConfig.subtableWriteFields.endTime]:
        FORM_16_DEFAULT_END_TIME,
      [FORM_104_CONFIG.writeConfig.subtableWriteFields.breakTime]:
        FORM_16_DEFAULT_BREAK_TIME,
      [FORM_104_CONFIG.writeConfig.subtableWriteFields.plannedIdleMinutes]:
        plannedIdleMinutes,
      [env.RAGIC_FORM_16_REMARK_FIELD_ID]: remark || undefined,
      [env.RAGIC_FORM_16_WORK_ORDER_FIELD_ID]: "",
      [env.RAGIC_FORM_16_TYPE_FIELD_ID]: resolvedReportType.type,
      [env.RAGIC_FORM_16_DEP_FIELD_ID]: resolvedRequiredFields.depUnit,
      [env.RAGIC_FORM_16_PROD_TYPE_FIELD_ID]: resolvedRequiredFields.prodType,
    };

    if (operatorId) {
      payload[FORM_104_CONFIG.writeConfig.subtableWriteFields.operatorId] = operatorId;
      payload[FORM_104_CONFIG.writeConfig.subtableWriteFields.operatorName] =
        operatorName || operatorId;
    }

    const { entryId: createdEntryId, reused } = await checkOrCreateForm16Entry({
      clientRowKey: input.clientRowKey,
      source: "downtime",
      create: async () => {
        // 失敗語意統一：讓 ragicClient.createEntry 的 error 自然拋出，上層 idempotency
        // 不會記 mapping、route task worker 會標 failed、前端看到錯誤。
        // 原本的 try/catch + localEntryId=null 會讓 function 回「成功但 null」，
        // upstream 以為成功、實際沒建到資料，是 silent 失敗
        const createResult = await ragicClient.createEntry(form16Path, payload, {
          doWorkflow: true,
        });
        // Ragic POST 回傳 { status, msg, ragicId, rv, data }
        const ragicId = String(
          (createResult as Record<string, unknown>)?.ragicId ?? ""
        ).trim();
        let localEntryId: string;
        if (ragicId) {
          localEntryId = ragicId;
        } else {
          const numericKeys = Object.keys(createResult ?? {})
            .filter((k) => /^\d+$/.test(k))
            .sort((a, b) => Number(b) - Number(a));
          if (numericKeys.length === 0) {
            throw new HttpError(
              502,
              "Form 16 createEntry 沒回 ragicId 也找不到 numeric entry key",
              "RAGIC_WRITE_FAILED"
            );
          }
          localEntryId = numericKeys[0];
        }

        ragicClient.clearFormCache(form16Path);

        // Post-write verify：立刻讀回來比對核心欄位是否真的有寫進去。
        // 對不起來會直接 DELETE 這筆 + throw，阻止 idempotency 記 mapping、讓上層收到錯誤。
        // 只驗 workOrderNo（downtime 要空）跟 type；depUnit/prodType 是 Ragic 推算欄位、
        // 會被 workflow 轉換，不適合嚴格比對（會誤殺合法 entry）
        await assertForm16EntryStored(form16Path, localEntryId, {
          workOrderNo: "",
          type: resolvedReportType.type,
        });

        // 同步 await — 呼叫端（route task worker）已經是背景，不需再開一層
        // Action button 48 是把 entry 從「剛建」變成「可用的計畫停機紀錄」的關鍵步驟，
        // 失敗留著 entry 就是 orphan（type 有值但 1012814 不是 Yes）。
        // 所以這裡改成：失敗 → DELETE + throw，讓上層（idempotency + 使用者）知道失敗
        const form16ButtonId = env.RAGIC_FORM_16_SAVE_ACTION_BUTTON_ID.trim();
        if (localEntryId && form16ButtonId) {
          try {
            await ragicClient.executeActionButton(form16Path, localEntryId, form16ButtonId);
            ragicClient.clearFormCache(form16Path);
          } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            console.warn("[form16-downtime][action-button-48-failed]", {
              entryId: localEntryId,
              error: errMsg,
            });
            try {
              await ragicClient.deleteEntry(form16Path, localEntryId);
              console.warn("[form16-downtime][action-button-48-rollback-deleted]", {
                entryId: localEntryId,
              });
            } catch (deleteError) {
              console.error("[form16-downtime][action-button-48-rollback-delete-failed]", {
                entryId: localEntryId,
                error: deleteError instanceof Error ? deleteError.message : String(deleteError),
              });
            }
            throw new HttpError(
              502,
              `Form 16 action button 48 失敗（已回滾刪除 entry ${localEntryId}）：${errMsg}`,
              "RAGIC_ACTION_BUTTON_FAILED"
            );
          }
        }

        if (env.SQLITE_ENABLED && localEntryId) {
          try {
            await this.refreshEntrySnapshotFromRagic(localEntryId);
          } catch (error) {
            console.warn("[form16-downtime][sqlite-entry-refresh-failed]", {
              entryId: localEntryId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        return { entryId: localEntryId };
      },
    });

    const totalMs = Date.now() - t0;
    if (totalMs > 15000) {
      console.warn("[form16-downtime][create-slow]", { totalMs, entryId: createdEntryId });
    }
    if (reused) {
      console.info("[form16-downtime][idempotency-hit]", {
        clientRowKey: input.clientRowKey,
        entryId: createdEntryId,
      });
    }
    // create callback 成功路徑必定回 string，但 checkOrCreateForm16Entry 介面保留
    // entryId: string | null 給其他未來 caller；這裡 runtime narrow + defensive throw
    if (!createdEntryId) {
      throw new HttpError(
        500,
        "建立停機紀錄後沒拿到 entryId",
        "RAGIC_WRITE_FAILED"
      );
    }
    return { created: true, entryId: createdEntryId };
  }

  async updateRecord(
    entryId: string,
    patch: UpdateForm16DowntimeInput
  ): Promise<{ id: string }> {
    const normalizedEntryId = String(entryId ?? "").trim();
    if (!/^\d+$/.test(normalizedEntryId)) {
      throw new HttpError(400, `非法的 entryId：${entryId}`, "INVALID_ENTRY_ID");
    }
    const form16Path = resolveForm16Path();

    const payload: RagicRecord = {};
    const writeFields = FORM_104_CONFIG.writeConfig.subtableWriteFields;

    if (patch.date !== undefined) {
      const value = String(patch.date).trim();
      if (!value) throw new HttpError(400, "date 不可為空", "INVALID_PAYLOAD");
      payload[writeFields.date] = value;
    }

    const processCodeChanged = patch.processCode !== undefined;
    let nextProcessCode = "";
    if (processCodeChanged) {
      const value = String(patch.processCode ?? "").trim();
      if (!value) throw new HttpError(400, "processCode 不可為空", "INVALID_PAYLOAD");
      nextProcessCode = value;
      payload[writeFields.processCode] = value;
    }

    if (patch.machineId !== undefined) {
      const value = String(patch.machineId).trim();
      if (!value) throw new HttpError(400, "machineId 不可為空", "INVALID_PAYLOAD");
      payload[writeFields.machineId] = value;
    }

    if (patch.plannedIdleMinutes !== undefined) {
      const value =
        typeof patch.plannedIdleMinutes === "number" && Number.isFinite(patch.plannedIdleMinutes)
          ? Math.max(0, Math.trunc(patch.plannedIdleMinutes))
          : FORM_16_DEFAULT_PLANNED_IDLE_MINUTES;
      payload[writeFields.plannedIdleMinutes] = value;
    }

    if (patch.remark !== undefined) {
      const value = String(patch.remark ?? "").trim();
      payload[env.RAGIC_FORM_16_REMARK_FIELD_ID] = value || "";
    }

    if (patch.operatorId !== undefined) {
      const value = String(patch.operatorId ?? "").trim();
      if (value) {
        const operatorName = await this.resolveOperatorName(value);
        payload[writeFields.operatorId] = value;
        payload[writeFields.operatorName] = operatorName || value;
      } else {
        payload[writeFields.operatorId] = "";
        payload[writeFields.operatorName] = "";
      }
    }

    // processCode 變更時同步補齊衍生欄位（reportType + dep + prodType）
    if (processCodeChanged) {
      const resolvedReportType = resolveForm16ReportType("", nextProcessCode, "");
      const resolvedRequiredFields = await this.resolveForm16RequiredFields(
        form16Path,
        "",
        nextProcessCode,
        resolvedReportType.type
      );
      payload[env.RAGIC_FORM_16_TYPE_FIELD_ID] = resolvedReportType.type;
      payload[env.RAGIC_FORM_16_DEP_FIELD_ID] = resolvedRequiredFields.depUnit;
      payload[env.RAGIC_FORM_16_PROD_TYPE_FIELD_ID] = resolvedRequiredFields.prodType;
    }

    if (Object.keys(payload).length === 0) {
      throw new HttpError(400, "沒有需要更新的欄位", "INVALID_PAYLOAD");
    }

    await ragicClient.updateEntry(form16Path, normalizedEntryId, payload, "POST", {
      doWorkflow: true,
      doFormula: true,
      doLinkLoad: "all",
    });
    // Ragic 寫入成功後同步 refresh local snapshot
    // - Ragic 端沒有 webhook，沒有其他機制會幫忙同步，必須這裡顧好
    // - refresh 失敗（mapRowToRecord 回 null / Ragic 抖動）只 log，不誤報 500
    try {
      await this.refreshEntrySnapshotFromRagic(normalizedEntryId);
    } catch (error) {
      console.warn("[form16-downtime][update-refresh-failed]", {
        entryId: normalizedEntryId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { id: normalizedEntryId };
  }

  async deleteRecord(entryId: string): Promise<{ deleted: true }> {
    const normalizedEntryId = String(entryId ?? "").trim();
    if (!/^\d+$/.test(normalizedEntryId)) {
      throw new HttpError(400, `非法的 entryId：${entryId}`, "INVALID_ENTRY_ID");
    }
    const form16Path = resolveForm16Path();
    await ragicClient.deleteEntry(form16Path, normalizedEntryId);
    // 同步從本地 SQLite 刪掉（Ragic 端沒有 webhook 會幫忙通知）
    if (env.SQLITE_ENABLED) {
      try {
        await form16DowntimeSqliteRepository.deleteRecord(
          normalizedEntryId,
          new Date().toISOString()
        );
      } catch (error) {
        console.warn("[form16-downtime][sqlite-delete-failed]", {
          entryId: normalizedEntryId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { deleted: true };
  }

  private mapRowToRecord(entryId: string, row: RagicRecord): Form16DowntimeRecord | null {
    const workOrderNo = pickNullableText(row, FORM_16_FIELD_CANDIDATES.workOrderNo);
    if (!resolvePlannedIdleFlag(row)) {
      return null;
    }

    return {
      id: entryId,
      date: pickNullableText(row, FORM_16_FIELD_CANDIDATES.date),
      machineId: pickNullableText(row, FORM_16_FIELD_CANDIDATES.machineId),
      processCode: pickNullableText(row, FORM_16_FIELD_CANDIDATES.processCode),
      operatorId: pickNullableText(row, FORM_16_FIELD_CANDIDATES.operatorId),
      operatorName: pickNullableText(row, FORM_16_FIELD_CANDIDATES.operatorName),
      reportType: pickNullableText(row, FORM_16_FIELD_CANDIDATES.reportType),
      startTime: pickNullableText(row, FORM_16_FIELD_CANDIDATES.startTime),
      endTime: pickNullableText(row, FORM_16_FIELD_CANDIDATES.endTime),
      breakTime: pickNullableText(row, FORM_16_FIELD_CANDIDATES.breakTime),
      plannedIdleMinutes: parseNumericValue(
        getFirstFieldValue(row, [...FORM_16_FIELD_CANDIDATES.plannedIdleMinutes])
      ),
      remark: pickNullableText(row, FORM_16_FIELD_CANDIDATES.remark),
      workOrderNo,
    };
  }

  private async resolveOperatorName(operatorId: string): Promise<string> {
    const options = await this.getOptions();
    const operatorOptions = options.operatorId ?? [];
    const matched = operatorOptions.find(
      (item) => String(item.value ?? "").trim() === operatorId
    );
    return String(matched?.display ?? matched?.label ?? "").trim();
  }

  private async resolveForm16RequiredFields(
    form16Path: string,
    workOrderNo: string,
    processCode: string,
    reportType: string
  ): Promise<{ depUnit: string; prodType: string; source: string }> {
    const depFieldId = env.RAGIC_FORM_16_DEP_FIELD_ID;
    const prodTypeFieldId = env.RAGIC_FORM_16_PROD_TYPE_FIELD_ID;
    const processFieldId = env.RAGIC_FORM_16_PROCESS_FIELD_ID;
    const typeFieldId = env.RAGIC_FORM_16_TYPE_FIELD_ID;
    const workOrderFieldId = env.RAGIC_FORM_16_WORK_ORDER_FIELD_ID;

    const whereCandidates: Array<{ where: string; source: string }> = [];
    if (processCode) {
      whereCandidates.push({
        where: `${processFieldId},eq,${processCode}`,
        source: "processCode-history",
      });
    }
    if (reportType) {
      whereCandidates.push({
        where: `${typeFieldId},eq,${reportType}`,
        source: "reportType-history",
      });
    }
    if (workOrderNo) {
      whereCandidates.push({
        where: `${workOrderFieldId},eq,${workOrderNo}`,
        source: "workOrder-history",
      });
    }

    if (whereCandidates.length > 0) {
      // Form 16 downtime create 使用者流程推導 required fields，走 user lane
      const pages = await Promise.all(
        whereCandidates.map((candidate) =>
          ragicClient.getFormPage(
            form16Path,
            { limit: 200, offset: 0, where: candidate.where },
            false,
            { priority: "user" }
          )
        )
      );

      for (let i = 0; i < whereCandidates.length; i++) {
        const rows = normalizeRows(pages[i])
          .map((row) => {
            const depUnit = normalizeComparableValue(
              getFirstFieldValue(row.data, [depFieldId, ...FORM16_FIELD_NAME_CANDIDATES.depUnit])
            );
            const prodType = normalizeComparableValue(
              getFirstFieldValue(row.data, [
                prodTypeFieldId,
                ...FORM16_FIELD_NAME_CANDIDATES.prodType,
              ])
            );
            return { entryId: row.entryId, depUnit, prodType };
          })
          .filter((row) => row.depUnit && row.prodType)
          .sort((a, b) => Number(b.entryId) - Number(a.entryId));

        if (rows.length > 0) {
          return {
            depUnit: rows[0].depUnit,
            prodType: rows[0].prodType,
            source: whereCandidates[i].source,
          };
        }
      }
    }

    const fallback = FORM16_REQUIRED_FALLBACK_BY_REPORT_TYPE[reportType];
    if (fallback) {
      return {
        depUnit: fallback.depUnit,
        prodType: fallback.prodType,
        source: "reportType-fallback-map",
      };
    }

    throw new HttpError(
      400,
      `無法補齊 [16] 必填欄位 Dep/Prod.Type，製程=${processCode || "-"}，報工類別=${reportType || "-"}`,
      "INVALID_PAYLOAD"
    );
  }
}

export const form16DowntimeService = new Form16DowntimeService();

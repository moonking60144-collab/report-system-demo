import { parseActivityLogFieldPrecondition, resolveActivityLogFieldPatch, type ActivityLogExpectedValues } from "./activityLogFieldPrecondition";
import { env, resolveWritePath } from "../../config/env";
import { FORM_901_CONFIG } from "../../config/forms/form-901";
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
import {
  buildActivityLogDowntimeRecordSnapshotHash,
  activityLogDowntimeSqliteRepository,
} from "../../storage/sqlite/activityLogDowntimeSqliteRepository";
import { activityLogClientRowKeyRepository } from "../../storage/sqlite/activityLogClientRowKeyRepository";
import {
  activityLogPlannedIdleSqliteRepository,
  type PlannedIdleMachineAggregate,
  type PlannedIdleSqliteRecord,
} from "../../storage/sqlite/activityLogPlannedIdleSqliteRepository";
import {
  ACTIVITY_LOG_FIELD_NAME_CANDIDATES,
  ACTIVITY_LOG_REQUIRED_FALLBACK_BY_REPORT_TYPE,
  mapProcessCodeToReportType,
  resolveActivityLogReportType,
} from "../work-report/create/activityLogReportTypeRules";
import { HttpError } from "../../utils/httpError";
import type { ActivityLogDowntimeRecord } from "../../types/activityLogDowntime";
import { checkOrCreateActivityLogEntry } from "./activityLogIdempotencyService";
import { activityLogWriteReverifyService } from "./activityLogWriteReverifyService";
import { verifyNewlyCreatedActivityLogEntryOrRollback } from "./activityLogWriteVerifier";
import { createStableJsonFingerprint } from "../../utils/stableJsonFingerprint";
import { createKeyedSerialQueue } from "../../utils/keyedSerialQueue";
import {
  WorkReportAutoSyncYieldRequestedError,
  workReportMutationSyncCoordinator,
} from "../work-report-sync/workReportMutationSyncCoordinator";

const ACTIVITY_LOG_FORM_DEFAULT_INPUT_OPTIONS = "整天";
const ACTIVITY_LOG_FORM_DEFAULT_SHIFT_TYPE = "正常班Reg";
const ACTIVITY_LOG_FORM_DEFAULT_START_TIME = "08:00";
const ACTIVITY_LOG_FORM_DEFAULT_END_TIME = "17:00";
const ACTIVITY_LOG_FORM_DEFAULT_BREAK_TIME = "1.00";
const ACTIVITY_LOG_FORM_DEFAULT_PLANNED_IDLE_MINUTES = 480;

const ACTIVITY_LOG_FORM_FIELD_CANDIDATES = {
  workOrderNo: [
    FORM_901_CONFIG.mainFields.workOrderNo,
    "demo_work_order_no",
    env.UPSTREAM_ACTIVITY_LOG_WORK_ORDER_FIELD_ID,
  ],
  reportType: [env.UPSTREAM_ACTIVITY_LOG_TYPE_FIELD_ID, "demo_report_type"],
  processCode: [
    "demo_process_code",
    FORM_901_CONFIG.writeConfig.subtableWriteFields.processCode,
    FORM_901_CONFIG.subtableFields.processCode,
  ],
  machineId: [
    "demo_machine_id",
    FORM_901_CONFIG.writeConfig.subtableWriteFields.machineId,
    FORM_901_CONFIG.subtableFields.machineId,
  ],
  operatorId: [
    "demo_operator_id",
    FORM_901_CONFIG.writeConfig.subtableWriteFields.operatorId,
    FORM_901_CONFIG.subtableFields.operatorId,
  ],
  operatorName: [
    "demo_operator_name",
    FORM_901_CONFIG.writeConfig.subtableWriteFields.operatorName,
    FORM_901_CONFIG.subtableFields.operatorName,
  ],
  date: [
    "demo_date",
    FORM_901_CONFIG.writeConfig.subtableWriteFields.date,
    FORM_901_CONFIG.subtableFields.date,
  ],
  plannedIdle: [
    "demo_planned_idle",
    FORM_901_CONFIG.writeConfig.subtableWriteFields.plannedIdle,
    FORM_901_CONFIG.subtableFields.plannedIdle,
  ],
  startTime: [
    "demo_start_time",
    FORM_901_CONFIG.writeConfig.subtableWriteFields.startTime,
    FORM_901_CONFIG.subtableFields.startTime,
  ],
  endTime: [
    "demo_end_time",
    FORM_901_CONFIG.writeConfig.subtableWriteFields.endTime,
    FORM_901_CONFIG.subtableFields.endTime,
  ],
  breakTime: [
    "demo_break_time",
    FORM_901_CONFIG.writeConfig.subtableWriteFields.breakTime,
    FORM_901_CONFIG.subtableFields.breakTime,
  ],
  plannedIdleMinutes: [
    "demo_planned_idle_minutes",
    FORM_901_CONFIG.writeConfig.subtableWriteFields.plannedIdleMinutes,
    FORM_901_CONFIG.subtableFields.plannedIdleMinutes,
  ],
  remark: [
    env.UPSTREAM_ACTIVITY_LOG_REMARK_FIELD_ID,
    "demo_remark",
    FORM_901_CONFIG.writeConfig.subtableWriteFields.remark,
    FORM_901_CONFIG.subtableFields.remark,
  ],
} as const;

export interface CreateActivityLogDowntimeInput {
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

export interface UpdateActivityLogDowntimeInput {
  date?: string;
  machineId?: string;
  processCode?: string;
  /** 傳空字串代表清空操作者 */
  operatorId?: string;
  plannedIdleMinutes?: number;
  remark?: string;
}

export interface ActivityLogDowntimeMutationOptions {
  expectedSnapshotHash?: string | null;
  deferProjection?: boolean;
}

export interface ListActivityLogDowntimeOptions {
  refresh?: boolean;
  limit?: number;
  offset?: number;
}

export interface ListActivityLogDowntimeResult {
  records: ActivityLogDowntimeRecord[];
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
  for (const field of ACTIVITY_LOG_FORM_FIELD_CANDIDATES.plannedIdle) {
    const normalized = normalizeComparableValue(getFirstFieldValue(record, [field])).toLowerCase();
    if (normalized === "yes") {
      return true;
    }
  }

  const plannedIdleMinutes = parseNumericValue(
    getFirstFieldValue(record, [...ACTIVITY_LOG_FORM_FIELD_CANDIDATES.plannedIdleMinutes])
  );
  return plannedIdleMinutes !== null && plannedIdleMinutes > 0;
}

function resolveActivityLogPath(): string {
  const resolved = resolveWritePath("903", env.UPSTREAM_ACTIVITY_LOG_PATH) ?? env.UPSTREAM_ACTIVITY_LOG_PATH;
  if (!resolved.trim()) {
    throw new HttpError(503, "activity log 路徑未設定", "FORM_NOT_CONFIGURED");
  }
  return resolved;
}

export interface PlannedIdleMachineSummary {
  machineId: string;
  prodType: string;
  totalMinutes: number;
  totalDays: number;
  count: number;
}

export interface PlannedIdleSummaryResult {
  month: string;
  machines: PlannedIdleMachineSummary[];
  source: "sqlite" | "ragic-live";
  refreshed: boolean;
  refreshTriggered: boolean;
  snapshotAt: string | null;
}

// 解析月份範圍：傳 YYYY/MM（或 YYYY-MM）用該月，沒傳就用「當月」。回 Ragic 日期格式的起訖。
function resolveMonthRange(input?: string): { ym: string; start: string; end: string } {
  let year: number;
  let month: number;
  const trimmed = String(input ?? "").trim();
  if (trimmed) {
    const matched = trimmed.match(/^(\d{4})[/-](\d{1,2})$/);
    if (!matched) {
      throw new HttpError(400, "month 參數格式需為 YYYY/MM", "INVALID_MONTH");
    }
    year = Number(matched[1]);
    month = Number(matched[2]);
    if (month < 1 || month > 12) {
      throw new HttpError(400, "month 月份需介於 1~12", "INVALID_MONTH");
    }
  } else {
    const now = new Date();
    year = now.getFullYear();
    month = now.getMonth() + 1;
  }
  const mm = String(month).padStart(2, "0");
  const lastDay = new Date(year, month, 0).getDate();
  return {
    ym: `${year}/${mm}`,
    start: `${year}/${mm}/01`,
    end: `${year}/${mm}/${String(lastDay).padStart(2, "0")}`,
  };
}

// A2：把 Ragic 日期（可能 YYYY/MM/DD 或 YYYY-MM-DD、或無前導零）正規化成 month_key = YYYY/MM。
// 不能直接 date.slice(0,7) —— dash 格式或無前導零會跟 aggregateByMonth 比對的 YYYY/MM 對不上、SQLite 路徑 silent 漏算。
function toMonthKey(date: string): string {
  const matched = String(date).replace(/-/g, "/").match(/^(\d{4})\/(\d{1,2})/);
  if (!matched) {
    return "";
  }
  return `${matched[1]}/${matched[2].padStart(2, "0")}`;
}

// 計畫停機 SQLite 同步保留範圍：近 7 個月（含本月、多留 1 個月緩衝）。
// B5：前端月份下拉給近 6 個月；後端多撈 1 個月，確保跨時區/跨月邊界時下拉最舊月一定落在同步窗內、不會每次 fallback。
function resolveHalfYearRange(): { start: string; end: string; oldestMonth: string } {
  const now = new Date();
  const startDate = new Date(now.getFullYear(), now.getMonth() - 6, 1);
  const oldestMonth = `${startDate.getFullYear()}/${String(startDate.getMonth() + 1).padStart(2, "0")}`;
  const start = `${oldestMonth}/01`;
  const end = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}`;
  return { start, end, oldestMonth };
}

export class ActivityLogDowntimeService {
  private refreshSnapshotPromise: Promise<ActivityLogDowntimeRecord[]> | null = null;
  private readonly entryProjectionQueue = createKeyedSerialQueue();
  // 背景重撈某月計畫停機的 in-flight promise（key=ym），防同月併發重複慢撈、也防無界累積。
  private readonly plannedIdleMonthRefreshing = new Map<string, Promise<string | null>>();

  async getOptions() {
    try {
      const options = await workReportReadService.getFormOptions("901", ["machineId", "operatorId", "processCode"]);
      return {
        ...options,
        // 停機的 Type 由製程推導；推不出報工類別的製程直接不給選，避免送出才被 Ragic 擋
        processCode: (options.processCode ?? []).filter(
          (option) => mapProcessCodeToReportType(option.value) !== null
        ),
      };
    } catch (error) {
      console.warn("[activityLog-downtime][options-failed]", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { machineId: [], operatorId: [], processCode: [] } as Awaited<
        ReturnType<typeof workReportReadService.getFormOptions>
      >;
    }
  }

  async listRecords(options: ListActivityLogDowntimeOptions = {}): Promise<ListActivityLogDowntimeResult> {
    const limit =
      typeof options.limit === "number" && Number.isFinite(options.limit) && options.limit > 0
        ? Math.trunc(options.limit)
        : 50;
    const offset =
      typeof options.offset === "number" && Number.isFinite(options.offset) && options.offset > 0
        ? Math.trunc(options.offset)
        : 0;
    const paginateRecords = (records: ActivityLogDowntimeRecord[]) =>
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

    const snapshotState = await activityLogDowntimeSqliteRepository.getSnapshotState();
    const hasSnapshot = Boolean(snapshotState);

    if (hasSnapshot && !options.refresh) {
      return {
        records: await activityLogDowntimeSqliteRepository.listRecords({ limit, offset }),
        totalCount: snapshotState?.totalRecords ?? 0,
        source: "sqlite",
        refreshed: false,
      };
    }

    if (!hasSnapshot) {
      // 沒有 snapshot 時不阻塞 — 回空、背景觸發 refresh
      void this.refreshSqliteSnapshotFromRagic({ yieldToMutation: true }).catch((error) => {
        console.warn("[activityLog-downtime][background-initial-refresh-failed]", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return {
        records: [],
        totalCount: 0,
        source: "sqlite",
        refreshed: false,
        refreshTriggered: true,
      };
    }

    // refresh=true — 背景刷新、先回舊資料，避免跟 auto-sync 搶 concurrency timeout
    void this.refreshSqliteSnapshotFromRagic({ yieldToMutation: true }).catch((error) => {
      console.warn("[activityLog-downtime][background-refresh-failed]", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return {
      records: await activityLogDowntimeSqliteRepository.listRecords({ limit, offset }),
      totalCount: snapshotState?.totalRecords ?? 0,
      source: "sqlite",
      refreshed: false,
      refreshTriggered: true,
    };
  }

  async refreshSqliteSnapshotFromRagic(
    options: { yieldToMutation?: boolean } = {}
  ): Promise<ActivityLogDowntimeRecord[]> {
    if (this.refreshSnapshotPromise) {
      return this.refreshSnapshotPromise;
    }

    const run = (async () => {
      const shouldYieldToMutation = options.yieldToMutation
        ? () => workReportMutationSyncCoordinator.shouldDeferAutoSyncForMutation()
        : undefined;

      while (true) {
        const releaseSyncSlot = await workReportMutationSyncCoordinator.acquireSyncSlot();
        try {
          for (let attempt = 1; attempt <= 2; attempt += 1) {
            const expectedRevision = env.SQLITE_ENABLED
              ? (await activityLogDowntimeSqliteRepository.getSnapshotState())?.revision ?? 0
              : 0;
            const records = await this.fetchRecordsFromRagic(shouldYieldToMutation);
            if (shouldYieldToMutation?.()) {
              throw new WorkReportAutoSyncYieldRequestedError();
            }
            if (!env.SQLITE_ENABLED) {
              return records;
            }
            const result = await activityLogDowntimeSqliteRepository.syncSnapshot(
              records,
              new Date().toISOString(),
              expectedRevision
            );
            if (result === "applied") {
              return records;
            }
          }
          throw new HttpError(
            409,
            "停機紀錄同步期間持續有較新的資料異動，這輪快照未套用，稍後會再次同步。",
            "ACTIVITY_LOG_DOWNTIME_SNAPSHOT_CONFLICT"
          );
        } catch (error) {
          if (
            !options.yieldToMutation ||
            !(error instanceof WorkReportAutoSyncYieldRequestedError)
          ) {
            throw error;
          }
        } finally {
          releaseSyncSlot();
        }
      }
    })();

    this.refreshSnapshotPromise = run.finally(() => {
      this.refreshSnapshotPromise = null;
    });

    return this.refreshSnapshotPromise;
  }

  async checkSnapshotStaleness(): Promise<{ isStale: boolean }> {
    if (!env.SQLITE_ENABLED) {
      return { isStale: true };
    }
    const snapshotState = await activityLogDowntimeSqliteRepository.getSnapshotState();
    const snapshotAt = snapshotState?.snapshotAt ? Date.parse(snapshotState.snapshotAt) : Number.NaN;
    const isStale =
      !snapshotState ||
      Number.isNaN(snapshotAt) ||
      Date.now() - snapshotAt >= env.ACTIVITY_LOG_SQLITE_REFRESH_INTERVAL_MS;
    return { isStale };
  }

  async refreshSqliteSnapshotIfStale(): Promise<{
    refreshed: boolean;
    records: ActivityLogDowntimeRecord[];
  }> {
    if (!env.SQLITE_ENABLED) {
      const records = await this.fetchRecordsFromRagic();
      return {
        refreshed: true,
        records,
      };
    }

    const snapshotState = await activityLogDowntimeSqliteRepository.getSnapshotState();
    const snapshotAt = snapshotState?.snapshotAt ? Date.parse(snapshotState.snapshotAt) : Number.NaN;
    const isStale =
      !snapshotState ||
      Number.isNaN(snapshotAt) ||
      Date.now() - snapshotAt >= env.ACTIVITY_LOG_SQLITE_REFRESH_INTERVAL_MS;

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

  async refreshEntrySnapshotFromRagic(entryId: string): Promise<ActivityLogDowntimeRecord | null> {
    const normalizedEntryId = String(entryId ?? "").trim();
    if (!normalizedEntryId) {
      return null;
    }

    let result: ActivityLogDowntimeRecord | null = null;
    await this.entryProjectionQueue.enqueue(`activityLog:${normalizedEntryId}`, async () => {
      result = await this.refreshEntrySnapshotFromRagicNow(normalizedEntryId);
    });
    return result;
  }

  private async refreshEntrySnapshotFromRagicNow(
    normalizedEntryId: string
  ): Promise<ActivityLogDowntimeRecord | null> {

    const activityLogPath = resolveActivityLogPath();
    // activity log 沒 webhook，這條是：
    // (a) callback task 觸發 → 背景刷新 SQLite snapshot
    // (b) 使用者 downtime 新增/編輯/刪除後 → 刷新 SQLite（已被 try/catch 包住，失敗可接受）
    // 兩者都是「使用者主請求之外」的背景任務，走 background lane 不污染使用者 lane。
    const entry = await ragicClient.getEntry(
      activityLogPath,
      normalizedEntryId,
      false,
      buildBackgroundReadOptions("background")
    );
    const snapshotAt = new Date().toISOString();

    if (!entry) {
      if (env.SQLITE_ENABLED) {
        await activityLogDowntimeSqliteRepository.deleteRecord(normalizedEntryId, snapshotAt);
      }
      return null;
    }

    const record = this.mapRowToRecord(normalizedEntryId, entry);
    if (!record) {
      if (env.SQLITE_ENABLED) {
        await activityLogDowntimeSqliteRepository.deleteRecord(normalizedEntryId, snapshotAt);
      }
      return null;
    }

    if (env.SQLITE_ENABLED) {
      await activityLogDowntimeSqliteRepository.upsertRecord(record, snapshotAt);
    }
    return record;
  }

  private async fetchRecordsFromRagic(
    shouldYieldToMutation?: () => boolean
  ): Promise<ActivityLogDowntimeRecord[]> {
    const activityLogPath = resolveActivityLogPath();
    const t0 = Date.now();

    // 只抓 30 天內（90 天仍有 7000+ 筆太慢，停機紀錄只需近期資料）
    // 多條件 AND：
    //   - Date生產日期 >= 30 天前         (9001030)
    //   - 計畫停機 = Yes                   (9001068)
    // 把 plannedIdle filter 推到 Ragic 側，避免拉回來再本地 filter 造成 rawCount >> filteredCount 的浪費
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 30);
    const dateFrom = `${cutoffDate.getFullYear()}/${String(cutoffDate.getMonth() + 1).padStart(2, "0")}/${String(cutoffDate.getDate()).padStart(2, "0")}`;
    const whereClauses = [
      `9001030,>=,${dateFrom}`,
      `9001068,eq,Yes`,
    ];

    // 分頁全表掃語意上是 bulk read（跟 auto-sync 同類），走 sync lane：
    // - 跟 background callback / verify / projection 分流，避免 bulk 把 4 slot pool 塞滿
    // - timeout 也用 sync 的 60s（單頁可能很大，要長 timeout）
    const allRows: ReturnType<typeof normalizeRows> = [];
    let offset = 0;
    const pageSize = 1000;

    while (true) {
      if (shouldYieldToMutation?.()) {
        throw new WorkReportAutoSyncYieldRequestedError();
      }
      const page = await ragicClient.getFormPage(
        activityLogPath,
        { limit: pageSize, offset, where: whereClauses },
        false,
        { timeoutMs: env.RAGIC_SYNC_READ_TIMEOUT_MS, priority: "sync" }
      );
      const rows = normalizeRows(page);
      allRows.push(...rows);
      if (shouldYieldToMutation?.()) {
        throw new WorkReportAutoSyncYieldRequestedError();
      }
      if (rows.length < pageSize) {
        break;
      }
      offset += pageSize;
    }

    const mapped = allRows
      .sort((left, right) => Number(right.entryId) - Number(left.entryId))
      .map((row) => this.mapRowToRecord(row.entryId, row.data))
      .filter((record): record is ActivityLogDowntimeRecord => {
        return Boolean(
          record &&
            String(record.workOrderNo ?? "").trim() === "" &&
            record.machineId &&
            record.processCode
        );
      });

    const fetchMs = Date.now() - t0;
    if (fetchMs > 10000) {
      console.warn("[activityLog-downtime][fetch-slow]", {
        fetchMs,
        rawCount: allRows.length,
        filteredCount: mapped.length,
      });
    }

    return mapped;
  }

  // 每機台當月計畫停機彙總（口徑 B：撈當月全部、加總所有 (P)計畫停機分 > 0 的筆，含有工令的部分停機，跟稼動表一致）。
  // 不走 mapRowToRecord（它會濾掉 flag≠Yes 的部分停機），直接讀 row 的 (P) 欄。
  async summarizePlannedIdleByMachine(
    monthInput?: string,
    refresh = false
  ): Promise<PlannedIdleSummaryResult> {
    const { ym, start, end } = resolveMonthRange(monthInput);

    // A1：SQLITE 關閉時直接走即時撈、不碰任何 SQLite（對齊 listRecords 的 fallback，避免 getDb 直接 throw 503）。
    if (!env.SQLITE_ENABLED) {
      const records = await this.fetchPlannedIdleRowsFromRagic(start, end);
      return this.toSummaryResult(
        ym,
        this.aggregateRecords(records),
        "ragic-live",
        true,
        false,
        new Date().toISOString()
      );
    }

    // 平常走 SQLite：
    // B1：用同步 state 判斷「這個月已同步過」→ 即使 0 筆也直接回（代表這月真的沒計畫停機），不必每次回源全表掃。
    const state = await activityLogPlannedIdleSqliteRepository.getState();
    const synced = Boolean(state?.syncedAt && state.oldestMonth && ym >= state.oldestMonth);
    if (synced) {
      const refreshedAt = await activityLogPlannedIdleSqliteRepository.getMonthSyncedAt(ym);
      if (refresh) {
        void this.refreshPlannedIdleMonth(ym, start, end).catch((error) => {
          console.warn("[planned-idle][background-refresh-failed]", {
            ym,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      const stored = await activityLogPlannedIdleSqliteRepository.aggregateByMonth(ym);
      return this.toSummaryResult(
        ym,
        stored,
        "sqlite",
        false,
        refresh,
        refreshedAt ?? state?.syncedAt ?? null
      );
    }

    // SQLite 完全沒這月（首次、或 ym 超出同步範圍）：只能即時撈一次填上
    const refreshBarrier = await activityLogPlannedIdleSqliteRepository.getRefreshBarrier(ym);
    const records = await this.fetchPlannedIdleRowsFromRagic(start, end);
    const fetchedAt = new Date().toISOString();
    let replaceResult: "applied" | "stale" | "failed" = "failed";
    // C9：寫快取失敗不該擋掉已撈到的結果，比照同檔其他 SQLite 寫入「失敗只 log」。
    try {
      replaceResult = await activityLogPlannedIdleSqliteRepository.replaceMonth(
        ym,
        records,
        fetchedAt,
        refreshBarrier
      );
    } catch (error) {
      console.warn("[planned-idle][replace-month-failed]", {
        ym,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (replaceResult === "stale") {
      return this.toSummaryResult(
        ym,
        await activityLogPlannedIdleSqliteRepository.aggregateByMonth(ym),
        "sqlite",
        true,
        false,
        (await activityLogPlannedIdleSqliteRepository.getMonthSyncedAt(ym)) ??
          (await activityLogPlannedIdleSqliteRepository.getState())?.syncedAt ??
          null
      );
    }
    return this.toSummaryResult(
      ym,
      this.aggregateRecords(records),
      "ragic-live",
      true,
      false,
      (await activityLogPlannedIdleSqliteRepository.getMonthSyncedAt(ym)) ?? fetchedAt
    );
  }

  private refreshPlannedIdleMonth(
    ym: string,
    start: string,
    end: string
  ): Promise<string | null> {
    const existing = this.plannedIdleMonthRefreshing.get(ym);
    if (existing) {
      return existing;
    }
    const run = (async () => {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const refreshBarrier = await activityLogPlannedIdleSqliteRepository.getRefreshBarrier(ym);
        const records = await this.fetchPlannedIdleRowsFromRagic(start, end);
        const syncedAt = new Date().toISOString();
        const result = await activityLogPlannedIdleSqliteRepository.replaceMonth(
          ym,
          records,
          syncedAt,
          refreshBarrier
        );
        if (result === "applied") {
          return activityLogPlannedIdleSqliteRepository.getMonthSyncedAt(ym);
        }
      }
      throw new HttpError(
        409,
        `計畫停機 ${ym} 同步期間持續有較新的資料異動，這輪快照未套用。`,
        "ACTIVITY_LOG_PLANNED_IDLE_MONTH_CONFLICT"
      );
    })()
      .finally(() => {
        this.plannedIdleMonthRefreshing.delete(ym);
      });
    this.plannedIdleMonthRefreshing.set(ym, run);
    return run;
  }

  // 背景定時同步：撈近半年所有 (P)計畫停機分 > 0 的筆，全量替換 SQLite（順便清掉半年外的）。
  async syncPlannedIdleHalfYear(): Promise<{ total: number }> {
    const { start, end, oldestMonth } = resolveHalfYearRange();
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const expectedProjectionRevision =
        await activityLogPlannedIdleSqliteRepository.getProjectionRevision();
      const records = await this.fetchPlannedIdleRowsFromRagic(start, end);
      const result = await activityLogPlannedIdleSqliteRepository.replaceAll(
        records,
        oldestMonth,
        new Date().toISOString(),
        expectedProjectionRevision
      );
      if (result === "applied") {
        return { total: records.length };
      }
    }
    throw new HttpError(
      409,
      "半年計畫停機同步期間持續有較新的資料異動，這輪快照未套用。",
      "ACTIVITY_LOG_PLANNED_IDLE_SYNC_CONFLICT"
    );
  }

  // 撈 activity log 指定日期範圍、挑出計畫停機分鐘數 > 0 的筆（含有工令的部分停機）。
  private async fetchPlannedIdleRowsFromRagic(
    start: string,
    end: string
  ): Promise<PlannedIdleSqliteRecord[]> {
    const activityLogPath = resolveActivityLogPath();
    const where = [`9001030,gte,${start}`, `9001030,lte,${end}`];
    const records: PlannedIdleSqliteRecord[] = [];
    let offset = 0;
    const pageSize = 1000;
    while (true) {
      const page = await ragicClient.getFormPage(
        activityLogPath,
        { limit: pageSize, offset, where },
        false,
        { timeoutMs: env.RAGIC_SYNC_READ_TIMEOUT_MS, priority: "sync" }
      );
      const rows = normalizeRows(page);
      for (const row of rows) {
        const plannedMin = parseNumericValue(
          getFirstFieldValue(row.data, [...ACTIVITY_LOG_FORM_FIELD_CANDIDATES.plannedIdleMinutes])
        );
        if (plannedMin === null || plannedMin <= 0) {
          continue;
        }
        const machineId = String(
          getFirstFieldValue(row.data, [...ACTIVITY_LOG_FORM_FIELD_CANDIDATES.machineId]) ?? ""
        ).trim();
        if (!machineId) {
          continue;
        }
        const date = String(
          getFirstFieldValue(row.data, [...ACTIVITY_LOG_FORM_FIELD_CANDIDATES.date]) ?? ""
        ).trim();
        const monthKey = toMonthKey(date);
        // C8：date 空 / 無法解析月份 → 跳過，避免存進 month_key='' 的孤兒列（不被任何月份統計到）。
        if (!monthKey) {
          continue;
        }
        const prodType = String(
          getFirstFieldValue(row.data, [
            env.UPSTREAM_ACTIVITY_LOG_PROD_TYPE_FIELD_ID,
            ...ACTIVITY_LOG_FIELD_NAME_CANDIDATES.prodType,
          ]) ?? ""
        ).trim();
        records.push({
          entryId: row.entryId,
          date,
          monthKey,
          machineId,
          prodType,
          // C5：(P)計畫停機分以整數存（欄位 INTEGER）；理論上為整數，Math.round 防個位小數誤差。
          plannedMinutes: Math.round(plannedMin),
        });
      }
      if (rows.length < pageSize) {
        break;
      }
      offset += pageSize;
    }
    return records;
  }

  private aggregateRecords(records: PlannedIdleSqliteRecord[]): PlannedIdleMachineAggregate[] {
    // A3：先依 entry_id 升冪排序，prodType 才會取到「該機台最小 entry_id 的非空值」，
    // 跟 repository.aggregateByMonth 的 SQL 子查詢同一基準，確保即時撈 vs SQLite 兩路徑分類一致。
    const sorted = [...records].sort((left, right) => Number(left.entryId) - Number(right.entryId));
    const machines = new Map<string, PlannedIdleMachineAggregate>();
    for (const record of sorted) {
      const entry =
        machines.get(record.machineId) ?? {
          machineId: record.machineId,
          prodType: "",
          totalMinutes: 0,
          count: 0,
        };
      entry.totalMinutes += record.plannedMinutes;
      entry.count += 1;
      if (!entry.prodType && record.prodType) {
        entry.prodType = record.prodType;
      }
      machines.set(record.machineId, entry);
    }
    return [...machines.values()];
  }

  private toSummaryResult(
    ym: string,
    aggregates: PlannedIdleMachineAggregate[],
    source: "sqlite" | "ragic-live",
    refreshed: boolean,
    refreshTriggered: boolean,
    snapshotAt: string | null
  ): PlannedIdleSummaryResult {
    const machines = aggregates
      .map((entry) => ({
        machineId: entry.machineId,
        prodType: entry.prodType,
        totalMinutes: entry.totalMinutes,
        totalDays: Math.round((entry.totalMinutes / 480) * 100) / 100,
        count: entry.count,
      }))
      .sort((left, right) => right.totalMinutes - left.totalMinutes);
    return { month: ym, machines, source, refreshed, refreshTriggered, snapshotAt };
  }

  // 同日同機台已有計畫停機就擋掉，避免像 5/11 那樣重複建一筆、把稼動表的計劃停機天數灌爆。
  private async assertNoDuplicatePlannedIdle(
    activityLogPath: string,
    date: string,
    machineId: string,
    excludeEntryId?: string
  ): Promise<void> {
    const ragicDate = date.replace(/-/g, "/");
    const normalizedExcludedEntryId = String(excludeEntryId ?? "").trim();
    // 只用「日期 + 計畫停機=Yes」查（機台是 linked 欄、where 不穩），撈回來本地比對機台
    const page = await ragicClient.getFormPage(
      activityLogPath,
      { limit: 1000, offset: 0, where: [`9001030,eq,${ragicDate}`, `9001068,eq,Yes`] },
      false,
      { timeoutMs: env.RAGIC_READ_TIMEOUT_MS, priority: "user" }
    );
    const duplicate = normalizeRows(page).some((row) => {
      if (normalizedExcludedEntryId && row.entryId === normalizedExcludedEntryId) {
        return false;
      }
      const record = this.mapRowToRecord(row.entryId, row.data);
      return Boolean(record && String(record.machineId ?? "").trim() === machineId);
    });
    if (duplicate) {
      throw new HttpError(
        409,
        `${ragicDate} 機台 ${machineId} 已有計畫停機紀錄，請勿重複建立。`,
        "DUPLICATE_PLANNED_IDLE"
      );
    }
  }

  async createRecord(
    input: CreateActivityLogDowntimeInput,
    options: { deferProjection?: boolean } = {}
  ): Promise<{ created: true; entryId: string }> {
    const activityLogPath = resolveActivityLogPath();
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
        : ACTIVITY_LOG_FORM_DEFAULT_PLANNED_IDLE_MINUTES;

    const recoveredEntryId = await this.findConfirmedCreateRecovery({
      clientRowKey: input.clientRowKey,
      activityLogPath,
      date,
      machineId,
      processCode,
      operatorId,
      plannedIdleMinutes,
      remark,
    });
    if (recoveredEntryId) {
      console.info("[activityLog-downtime][idempotency-early-hit]", {
        clientRowKey: input.clientRowKey,
        entryId: recoveredEntryId,
      });
      await this.bumpPlannedIdleProjectionRevision("create", recoveredEntryId);
      return { created: true, entryId: recoveredEntryId };
    }

    const t0 = Date.now();
    const resolvedReportType = resolveActivityLogReportType("", processCode, "");

    const [operatorName, resolvedRequiredFields] = await Promise.all([
      operatorId ? this.resolveOperatorName(operatorId) : Promise.resolve(""),
      this.resolveActivityLogRequiredFields(
        activityLogPath,
        "",
        processCode,
        resolvedReportType.type
      ),
    ]);

    const payload: RagicRecord = {
      [FORM_901_CONFIG.writeConfig.subtableWriteFields.date]: date,
      [FORM_901_CONFIG.writeConfig.subtableWriteFields.plannedIdle]: "Yes",
      [FORM_901_CONFIG.writeConfig.subtableWriteFields.processCode]: processCode,
      [FORM_901_CONFIG.writeConfig.subtableWriteFields.machineId]: machineId,
      [FORM_901_CONFIG.writeConfig.subtableWriteFields.inputOptions]:
        ACTIVITY_LOG_FORM_DEFAULT_INPUT_OPTIONS,
      [FORM_901_CONFIG.writeConfig.subtableWriteFields.shiftType]:
        ACTIVITY_LOG_FORM_DEFAULT_SHIFT_TYPE,
      [FORM_901_CONFIG.writeConfig.subtableWriteFields.startTime]:
        ACTIVITY_LOG_FORM_DEFAULT_START_TIME,
      [FORM_901_CONFIG.writeConfig.subtableWriteFields.endTime]:
        ACTIVITY_LOG_FORM_DEFAULT_END_TIME,
      [FORM_901_CONFIG.writeConfig.subtableWriteFields.breakTime]:
        ACTIVITY_LOG_FORM_DEFAULT_BREAK_TIME,
      [FORM_901_CONFIG.writeConfig.subtableWriteFields.plannedIdleMinutes]:
        plannedIdleMinutes,
      [env.UPSTREAM_ACTIVITY_LOG_REMARK_FIELD_ID]: remark || undefined,
      [env.UPSTREAM_ACTIVITY_LOG_WORK_ORDER_FIELD_ID]: "",
      // [activity] 的 Type 雖然後續可由公式維護，但 API create 的必填驗證跑在公式之前；
      // create payload 必須先帶入，否則會被 Ragic 以「Field demo_report_type contains empty value (code: 202)」拒絕。
      [env.UPSTREAM_ACTIVITY_LOG_TYPE_FIELD_ID]: resolvedReportType.type,
      [env.UPSTREAM_ACTIVITY_LOG_DEP_FIELD_ID]: resolvedRequiredFields.depUnit,
      [env.UPSTREAM_ACTIVITY_LOG_PROD_TYPE_FIELD_ID]: resolvedRequiredFields.prodType,
    };

    if (operatorId) {
      payload[FORM_901_CONFIG.writeConfig.subtableWriteFields.operatorId] = operatorId;
      payload[FORM_901_CONFIG.writeConfig.subtableWriteFields.operatorName] =
        operatorName || operatorId;
    }

    const { entryId: createdEntryId, reused } = await checkOrCreateActivityLogEntry({
      clientRowKey: input.clientRowKey,
      source: "downtime",
      operationFingerprint: createStableJsonFingerprint({
        operation: "create-downtime",
        payload,
      }),
      create: async (reservation) => {
        // confirmed idempotency mapping 會在進入 callback 前直接回既有 entry；只有新 reservation
        // 才做 duplicate guard，避免服務重啟後把已成功建立的同一筆誤判成重複。
        await this.assertNoDuplicatePlannedIdle(activityLogPath, date, machineId);

        // 失敗語意統一：讓 ragicClient.createEntry 的 error 自然拋出，上層 idempotency
        // 不會記 mapping、route task worker 會標 failed、前端看到錯誤。
        // 原本的 try/catch + localEntryId=null 會讓 function 回「成功但 null」，
        // upstream 以為成功、實際沒建到資料，是 silent 失敗
        const createResult = await ragicClient.createEntry(activityLogPath, payload, {
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
              "activity log createEntry 沒回 ragicId 也找不到 numeric entry key",
              "RAGIC_WRITE_FAILED"
            );
          }
          localEntryId = numericKeys[0];
        }

        ragicClient.clearFormCache(activityLogPath);

        // Post-write verify：立刻讀回來比對核心欄位是否真的有寫進去。
        // 對不起來會直接 DELETE 這筆 + throw，阻止 idempotency 記 mapping、讓上層收到錯誤。
        // 只驗 workOrderNo（downtime 要空）跟 type；depUnit/prodType 是 Ragic 推算欄位、
        // 會被 workflow 轉換，不適合嚴格比對（會誤殺合法 entry）
        await verifyNewlyCreatedActivityLogEntryOrRollback({
          activityLogPath,
          entryId: localEntryId,
          expected: {
            workOrderNo: "",
            type: resolvedReportType.type,
          },
          createOperationId:
            reservation?.reservationToken ??
            input.clientRowKey ??
            `downtime-create:${localEntryId}`,
          options: {
            readPriority: "background",
            timeoutMs: env.ACTIVITY_LOG_WRITE_VERIFY_TIMEOUT_MS,
            maxRetries: env.ACTIVITY_LOG_WRITE_VERIFY_MAX_RETRIES,
            continueOnReadError: true,
            onReadIndeterminate: async (payload) => {
              await activityLogWriteReverifyService.enqueue({
                ...payload,
                source: "downtime",
                clientRowKey: input.clientRowKey,
                idempotencySource: "downtime",
                ...(reservation?.reservationToken
                  ? { idempotencyReservationToken: reservation.reservationToken }
                  : {}),
              });
            },
          },
        });

        // 同步 await — 呼叫端（route task worker）已經是背景，不需再開一層
        // Action button 48 是把 entry 從「剛建」變成「可用的計畫停機紀錄」的關鍵步驟，
        // 失敗留著 entry 就是 orphan（type 有值但 9001068 不是 Yes）。
        // 所以這裡改成：失敗 → DELETE + throw，讓上層（idempotency + 使用者）知道失敗
        const activityLogButtonId = env.UPSTREAM_ACTIVITY_LOG_SAVE_ACTION_BUTTON_ID.trim();
        if (localEntryId && activityLogButtonId) {
          try {
            await ragicClient.executeActionButton(activityLogPath, localEntryId, activityLogButtonId);
            ragicClient.clearFormCache(activityLogPath);
          } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            console.warn("[activityLog-downtime][action-button-48-failed]", {
              entryId: localEntryId,
              error: errMsg,
            });
            try {
              await ragicClient.deleteEntry(activityLogPath, localEntryId);
              console.warn("[activityLog-downtime][action-button-48-rollback-deleted]", {
                entryId: localEntryId,
              });
            } catch (deleteError) {
              console.error("[activityLog-downtime][action-button-48-rollback-delete-failed]", {
                entryId: localEntryId,
                error: deleteError instanceof Error ? deleteError.message : String(deleteError),
              });
              throw new HttpError(
                502,
                `activity log action button 48 失敗，且 rollback delete 未確認（entry ${localEntryId} 可能已建立）：${errMsg}`,
                "RAGIC_ACTION_BUTTON_INDETERMINATE"
              );
            }
            throw new HttpError(
              502,
              `activity log action button 48 失敗（已回滾刪除 entry ${localEntryId}）：${errMsg}`,
              "RAGIC_ACTION_BUTTON_FAILED"
            );
          }
        }

        if (env.SQLITE_ENABLED && localEntryId) {
          const refreshProjection = async () => {
            try {
              await this.refreshEntrySnapshotFromRagic(localEntryId);
            } catch (error) {
              console.warn("[activityLog-downtime][sqlite-entry-refresh-failed]", {
                entryId: localEntryId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          };
          if (options.deferProjection) {
            void refreshProjection();
          } else {
            await refreshProjection();
          }
        }

        return { entryId: localEntryId };
      },
    });

    const totalMs = Date.now() - t0;
    if (totalMs > 15000) {
      console.warn("[activityLog-downtime][create-slow]", { totalMs, entryId: createdEntryId });
    }
    if (reused) {
      console.info("[activityLog-downtime][idempotency-hit]", {
        clientRowKey: input.clientRowKey,
        entryId: createdEntryId,
      });
    }
    // create callback 成功路徑必定回 string，但 checkOrCreateActivityLogEntry 介面保留
    // entryId: string | null 給其他未來 caller；這裡 runtime narrow + defensive throw
    if (!createdEntryId) {
      throw new HttpError(
        500,
        "建立停機紀錄後沒拿到 entryId",
        "RAGIC_WRITE_FAILED"
      );
    }
    await this.bumpPlannedIdleProjectionRevision("create", createdEntryId);
    return { created: true, entryId: createdEntryId };
  }

  async updateRecord(
    entryId: string,
    patch: UpdateActivityLogDowntimeInput,
    options: ActivityLogDowntimeMutationOptions & { fieldPreconditionVersion?: 1; expectedValues?: ActivityLogExpectedValues } = {}
  ): Promise<{ id: string; beforeSnapshot: ActivityLogDowntimeRecord }> {
    const normalizedEntryId = String(entryId ?? "").trim();
    if (!/^\d+$/.test(normalizedEntryId)) {
      throw new HttpError(400, `非法的 entryId：${entryId}`, "INVALID_ENTRY_ID");
    }
    const activityLogPath = resolveActivityLogPath();
    const beforeSnapshot = await this.readCurrentRecordFromRagic(activityLogPath, normalizedEntryId);
    const expectedValues = parseActivityLogFieldPrecondition(options, patch);
    if (expectedValues) {
      patch = resolveActivityLogFieldPatch(beforeSnapshot, patch, expectedValues);
    } else {
      await this.assertRecordSnapshotUnchanged(normalizedEntryId, options.expectedSnapshotHash, beforeSnapshot);
    }

    const payload: RagicRecord = {};
    const writeFields = FORM_901_CONFIG.writeConfig.subtableWriteFields;
    let nextDate: string | null = null;
    let nextMachineId: string | null = null;

    if (patch.date !== undefined) {
      const value = String(patch.date).trim();
      if (!value) throw new HttpError(400, "date 不可為空", "INVALID_PAYLOAD");
      nextDate = value;
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
      nextMachineId = value;
      payload[writeFields.machineId] = value;
    }

    if (patch.plannedIdleMinutes !== undefined) {
      const value =
        typeof patch.plannedIdleMinutes === "number" && Number.isFinite(patch.plannedIdleMinutes)
          ? Math.max(0, Math.trunc(patch.plannedIdleMinutes))
          : ACTIVITY_LOG_FORM_DEFAULT_PLANNED_IDLE_MINUTES;
      payload[writeFields.plannedIdleMinutes] = value;
    }

    if (patch.remark !== undefined) {
      const value = String(patch.remark ?? "").trim();
      payload[env.UPSTREAM_ACTIVITY_LOG_REMARK_FIELD_ID] = value || "";
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

    // processCode 變更時同步補齊 Type + lookup 欄位；[activity] Type 雖有公式/defaultFormula，
    // 但 API update 不會可靠重算，必須送目前推導值，避免製程與 Type 留在舊狀態。
    if (processCodeChanged) {
      const resolvedReportType = resolveActivityLogReportType("", nextProcessCode, "");
      const resolvedRequiredFields = await this.resolveActivityLogRequiredFields(
        activityLogPath,
        "",
        nextProcessCode,
        resolvedReportType.type
      );
      payload[env.UPSTREAM_ACTIVITY_LOG_TYPE_FIELD_ID] = resolvedReportType.type;
      payload[env.UPSTREAM_ACTIVITY_LOG_DEP_FIELD_ID] = resolvedRequiredFields.depUnit;
      payload[env.UPSTREAM_ACTIVITY_LOG_PROD_TYPE_FIELD_ID] = resolvedRequiredFields.prodType;
    }

    if (Object.keys(payload).length === 0 && !expectedValues) {
      throw new HttpError(400, "沒有需要更新的欄位", "INVALID_PAYLOAD");
    }

    if (nextDate !== null || nextMachineId !== null) {
      const effectiveDate = nextDate ?? String(beforeSnapshot.date ?? "").trim();
      const effectiveMachineId = nextMachineId ?? String(beforeSnapshot.machineId ?? "").trim();
      if (!effectiveDate || !effectiveMachineId) {
        throw new HttpError(
          409,
          "無法確認停機紀錄目前的日期或機台，請重新整理後再操作",
          "DOWNTIME_RECORD_STALE"
        );
      }
      await this.assertNoDuplicatePlannedIdle(
        activityLogPath,
        effectiveDate,
        effectiveMachineId,
        normalizedEntryId
      );
    }

    if (Object.keys(payload).length > 0) {
      await ragicClient.updateEntry(activityLogPath, normalizedEntryId, payload, "POST", {
        doWorkflow: true,
        doFormula: true,
        doLinkLoad: "all",
      });
      await this.bumpPlannedIdleProjectionRevision("update", normalizedEntryId);
    }
    // Ragic 寫入成功後同步 refresh local snapshot
    // - Ragic 端沒有 webhook，沒有其他機制會幫忙同步，必須這裡顧好
    // - refresh 失敗（mapRowToRecord 回 null / Ragic 抖動）只 log，不誤報 500
    const refreshProjection = async () => {
      try {
        await this.refreshEntrySnapshotFromRagic(normalizedEntryId);
      } catch (error) {
        console.warn("[activityLog-downtime][update-refresh-failed]", {
          entryId: normalizedEntryId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    if (options.deferProjection) {
      void refreshProjection();
    } else {
      await refreshProjection();
    }
    return { id: normalizedEntryId, beforeSnapshot };
  }

  async deleteRecord(
    entryId: string,
    options: ActivityLogDowntimeMutationOptions = {}
  ): Promise<{ deleted: true; beforeSnapshot: ActivityLogDowntimeRecord }> {
    const normalizedEntryId = String(entryId ?? "").trim();
    if (!/^\d+$/.test(normalizedEntryId)) {
      throw new HttpError(400, `非法的 entryId：${entryId}`, "INVALID_ENTRY_ID");
    }
    const activityLogPath = resolveActivityLogPath();
    const beforeSnapshot = await this.readCurrentRecordFromRagic(activityLogPath, normalizedEntryId);
    await this.assertRecordSnapshotUnchanged(
      normalizedEntryId,
      options.expectedSnapshotHash,
      beforeSnapshot
    );
    await ragicClient.deleteEntry(activityLogPath, normalizedEntryId);
    await this.bumpPlannedIdleProjectionRevision("delete", normalizedEntryId);
    // 同步從本地 SQLite 刪掉（Ragic 端沒有 webhook 會幫忙通知）
    if (env.SQLITE_ENABLED) {
      const deleteProjection = async () => {
        try {
          await activityLogDowntimeSqliteRepository.deleteRecord(
            normalizedEntryId,
            new Date().toISOString()
          );
        } catch (error) {
          console.warn("[activityLog-downtime][sqlite-delete-failed]", {
            entryId: normalizedEntryId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };
      if (options.deferProjection) {
        void deleteProjection();
      } else {
        await deleteProjection();
      }
    }
    return { deleted: true, beforeSnapshot };
  }

  private async bumpPlannedIdleProjectionRevision(
    operation: "create" | "update" | "delete",
    entryId: string
  ): Promise<void> {
    if (!env.SQLITE_ENABLED) {
      return;
    }
    try {
      await activityLogPlannedIdleSqliteRepository.bumpProjectionRevision();
    } catch (error) {
      // Ragic mutation 已完成，SQLite cache invalidation 失敗不可反轉成「寫入失敗」。
      console.warn("[activityLog-downtime][planned-idle-revision-bump-failed]", {
        operation,
        entryId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async findConfirmedCreateRecovery(input: {
    clientRowKey?: string | null;
    activityLogPath: string;
    date: string;
    machineId: string;
    processCode: string;
    operatorId: string;
    plannedIdleMinutes: number;
    remark: string;
  }): Promise<string | null> {
    const clientRowKey = String(input.clientRowKey ?? "").trim();
    if (!clientRowKey || !env.SQLITE_ENABLED) {
      return null;
    }

    const mapping = await activityLogClientRowKeyRepository.lookup(clientRowKey);
    if (
      mapping?.status !== "confirmed" ||
      mapping.source !== "downtime" ||
      !/^\d+$/.test(mapping.entryId)
    ) {
      return null;
    }

    let record: ActivityLogDowntimeRecord | undefined;
    try {
      record = (await activityLogDowntimeSqliteRepository.listRecords()).find(
        (candidate) => candidate.id === mapping.entryId
      );
    } catch {
      record = undefined;
    }
    if (!record) {
      try {
        const entry = await ragicClient.getEntry(input.activityLogPath, mapping.entryId, false, {
          timeoutMs: env.RAGIC_READ_TIMEOUT_MS,
          priority: "user",
        });
        record = entry ? this.mapRowToRecord(mapping.entryId, entry) ?? undefined : undefined;
      } catch {
        return null;
      }
    }
    if (!record) {
      return null;
    }

    const normalizeDate = (value: string | null | undefined) =>
      String(value ?? "").trim().replace(/-/g, "/");
    const normalizeText = (value: string | null | undefined) => String(value ?? "").trim();
    return normalizeDate(record.date) === normalizeDate(input.date) &&
      normalizeText(record.machineId) === input.machineId &&
      normalizeText(record.processCode) === input.processCode &&
      normalizeText(record.operatorId) === input.operatorId &&
      record.plannedIdleMinutes === input.plannedIdleMinutes &&
      normalizeText(record.remark) === input.remark
      ? mapping.entryId
      : null;
  }

  private async readCurrentRecordFromRagic(
    activityLogPath: string,
    entryId: string
  ): Promise<ActivityLogDowntimeRecord> {
    const currentEntry = await ragicClient.getEntry(activityLogPath, entryId, false, {
      timeoutMs: env.RAGIC_READ_TIMEOUT_MS,
      priority: "user",
    });
    const currentRecord = currentEntry ? this.mapRowToRecord(entryId, currentEntry) : null;
    if (!currentRecord) {
      throw new HttpError(
        404,
        "停機紀錄已不存在或不再是計畫停機資料",
        "DOWNTIME_RECORD_NOT_FOUND"
      );
    }
    return currentRecord;
  }

  private mapRowToRecord(entryId: string, row: RagicRecord): ActivityLogDowntimeRecord | null {
    const workOrderNo = pickNullableText(row, ACTIVITY_LOG_FORM_FIELD_CANDIDATES.workOrderNo);
    if (!resolvePlannedIdleFlag(row)) {
      return null;
    }

    return {
      id: entryId,
      snapshotHash: null,
      date: pickNullableText(row, ACTIVITY_LOG_FORM_FIELD_CANDIDATES.date),
      machineId: pickNullableText(row, ACTIVITY_LOG_FORM_FIELD_CANDIDATES.machineId),
      processCode: pickNullableText(row, ACTIVITY_LOG_FORM_FIELD_CANDIDATES.processCode),
      operatorId: pickNullableText(row, ACTIVITY_LOG_FORM_FIELD_CANDIDATES.operatorId),
      operatorName: pickNullableText(row, ACTIVITY_LOG_FORM_FIELD_CANDIDATES.operatorName),
      reportType: pickNullableText(row, ACTIVITY_LOG_FORM_FIELD_CANDIDATES.reportType),
      startTime: pickNullableText(row, ACTIVITY_LOG_FORM_FIELD_CANDIDATES.startTime),
      endTime: pickNullableText(row, ACTIVITY_LOG_FORM_FIELD_CANDIDATES.endTime),
      breakTime: pickNullableText(row, ACTIVITY_LOG_FORM_FIELD_CANDIDATES.breakTime),
      plannedIdleMinutes: parseNumericValue(
        getFirstFieldValue(row, [...ACTIVITY_LOG_FORM_FIELD_CANDIDATES.plannedIdleMinutes])
      ),
      remark: pickNullableText(row, ACTIVITY_LOG_FORM_FIELD_CANDIDATES.remark),
      workOrderNo,
    };
  }

  async assertRecordSnapshotUnchanged(
    entryId: string,
    expectedSnapshotHash?: string | null,
    currentRecord?: ActivityLogDowntimeRecord
  ): Promise<void> {
    const expected = String(expectedSnapshotHash ?? "").trim();
    if (!expected || !env.SQLITE_ENABLED) return;
    const current = currentRecord
      ? buildActivityLogDowntimeRecordSnapshotHash(currentRecord)
      : await activityLogDowntimeSqliteRepository.getRecordSnapshotHash(entryId);
    if (!current) {
      throw new HttpError(
        409,
        "停機紀錄已不存在或尚未同步，請重新整理後再操作",
        "DOWNTIME_RECORD_STALE"
      );
    }
    if (current !== expected) {
      throw new HttpError(
        409,
        "停機紀錄已被其他操作更新，請重新整理後再操作",
        "DOWNTIME_RECORD_STALE"
      );
    }
  }

  private async resolveOperatorName(operatorId: string): Promise<string> {
    const options = await this.getOptions();
    const operatorOptions = options.operatorId ?? [];
    const matched = operatorOptions.find(
      (item) => String(item.value ?? "").trim() === operatorId
    );
    return String(matched?.display ?? matched?.label ?? "").trim();
  }

  private async resolveActivityLogRequiredFields(
    activityLogPath: string,
    workOrderNo: string,
    processCode: string,
    reportType: string
  ): Promise<{ depUnit: string; prodType: string; source: string }> {
    const depFieldId = env.UPSTREAM_ACTIVITY_LOG_DEP_FIELD_ID;
    const prodTypeFieldId = env.UPSTREAM_ACTIVITY_LOG_PROD_TYPE_FIELD_ID;
    const processFieldId = env.UPSTREAM_ACTIVITY_LOG_PROCESS_FIELD_ID;
    const typeFieldId = env.UPSTREAM_ACTIVITY_LOG_TYPE_FIELD_ID;
    const workOrderFieldId = env.UPSTREAM_ACTIVITY_LOG_WORK_ORDER_FIELD_ID;

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
      // activity log downtime create 使用者流程推導 required fields，走 user lane
      const pages = await Promise.all(
        whereCandidates.map((candidate) =>
          ragicClient.getFormPage(
            activityLogPath,
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
              getFirstFieldValue(row.data, [depFieldId, ...ACTIVITY_LOG_FIELD_NAME_CANDIDATES.depUnit])
            );
            const prodType = normalizeComparableValue(
              getFirstFieldValue(row.data, [
                prodTypeFieldId,
                ...ACTIVITY_LOG_FIELD_NAME_CANDIDATES.prodType,
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

    const fallback = ACTIVITY_LOG_REQUIRED_FALLBACK_BY_REPORT_TYPE[reportType];
    if (fallback) {
      return {
        depUnit: fallback.depUnit,
        prodType: fallback.prodType,
        source: "reportType-fallback-map",
      };
    }

    throw new HttpError(
      400,
      `無法補齊 [activity] 必填欄位 Dep/Prod.Type，製程=${processCode || "-"}，報工類別=${reportType || "-"}`,
      "INVALID_PAYLOAD"
    );
  }
}

export const activityLogDowntimeService = new ActivityLogDowntimeService();

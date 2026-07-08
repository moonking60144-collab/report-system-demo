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
  form16PlannedIdleSqliteRepository,
  type PlannedIdleMachineAggregate,
  type PlannedIdleSqliteRecord,
} from "../../storage/sqlite/form16PlannedIdleSqliteRepository";
import {
  FORM16_FIELD_NAME_CANDIDATES,
  FORM16_REQUIRED_FALLBACK_BY_REPORT_TYPE,
  mapProcessCodeToReportType,
  resolveForm16ReportType,
} from "../work-report/create/form16ReportTypeRules";
import { HttpError } from "../../utils/httpError";
import type { Form16DowntimeRecord } from "../../types/form16Downtime";
import { checkOrCreateForm16Entry } from "./form16IdempotencyService";
import { form16WriteReverifyService } from "./form16WriteReverifyService";
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

export interface Form16DowntimeMutationOptions {
  expectedSnapshotHash?: string | null;
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
  // C14：資料來源，前端可據此辨「SQLite 快取」或「即時撈最新」的新鮮度。
  source: "sqlite" | "ragic-live";
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

export class Form16DowntimeService {
  private refreshSnapshotPromise: Promise<Form16DowntimeRecord[]> | null = null;
  // 背景重撈某月計畫停機的 in-flight promise（key=ym），防同月併發重複慢撈、也防無界累積。
  private readonly plannedIdleMonthRefreshing = new Map<string, Promise<void>>();

  async getOptions() {
    try {
      const options = await workReportReadService.getFormOptions("104", ["machineId", "operatorId", "processCode"]);
      return {
        ...options,
        // 停機的 Type 由製程推導；推不出報工類別的製程直接不給選，避免送出才被 Ragic 擋
        processCode: (options.processCode ?? []).filter(
          (option) => mapProcessCodeToReportType(option.value) !== null
        ),
      };
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
        refreshTriggered: true,
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
      return this.toSummaryResult(ym, this.aggregateRecords(records), "ragic-live");
    }

    // 平常走 SQLite：
    // B1：用同步 state 判斷「這個月已同步過」→ 即使 0 筆也直接回（代表這月真的沒計畫停機），不必每次回源全表掃。
    const state = await form16PlannedIdleSqliteRepository.getState();
    const synced = Boolean(state?.syncedAt && state.oldestMonth && ym >= state.oldestMonth);
    if (synced) {
      const stored = await form16PlannedIdleSqliteRepository.aggregateByMonth(ym);
      // refresh：先回 SQLite 舊值，背景重撈該月寫回，不把 c1/16 全表慢掃（~2-4 分）
      // 掛在使用者請求上（對齊 listRecords 的背景刷新；同月併發只觸發一次）。
      if (refresh) {
        this.refreshPlannedIdleMonthInBackground(ym, start, end);
      }
      return this.toSummaryResult(ym, stored, "sqlite");
    }

    // SQLite 完全沒這月（首次、或 ym 超出同步範圍）：只能即時撈一次填上
    const records = await this.fetchPlannedIdleRowsFromRagic(start, end);
    // C9：寫快取失敗不該擋掉已撈到的結果，比照同檔其他 SQLite 寫入「失敗只 log」。
    try {
      await form16PlannedIdleSqliteRepository.replaceMonth(ym, records, new Date().toISOString());
    } catch (error) {
      console.warn("[planned-idle][replace-month-failed]", {
        ym,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return this.toSummaryResult(ym, this.aggregateRecords(records), "ragic-live");
  }

  // 背景重撈某月計畫停機寫回 SQLite，不阻塞使用者；同月併發只跑一個、跑完即釋放。
  private refreshPlannedIdleMonthInBackground(ym: string, start: string, end: string): void {
    if (this.plannedIdleMonthRefreshing.has(ym)) {
      return;
    }
    const run = (async () => {
      const records = await this.fetchPlannedIdleRowsFromRagic(start, end);
      await form16PlannedIdleSqliteRepository.replaceMonth(ym, records, new Date().toISOString());
    })()
      .catch((error) => {
        console.warn("[planned-idle][background-refresh-failed]", {
          ym,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.plannedIdleMonthRefreshing.delete(ym);
      });
    this.plannedIdleMonthRefreshing.set(ym, run);
  }

  // 背景定時同步：撈近半年所有 (P)計畫停機分 > 0 的筆，全量替換 SQLite（順便清掉半年外的）。
  async syncPlannedIdleHalfYear(): Promise<{ total: number }> {
    const { start, end, oldestMonth } = resolveHalfYearRange();
    const records = await this.fetchPlannedIdleRowsFromRagic(start, end);
    await form16PlannedIdleSqliteRepository.replaceAll(
      records,
      oldestMonth,
      new Date().toISOString()
    );
    return { total: records.length };
  }

  // 撈 c1/16 指定日期範圍、挑出 (P)計畫停機分 > 0 的筆（口徑 B：含有工令的部分停機）。
  private async fetchPlannedIdleRowsFromRagic(
    start: string,
    end: string
  ): Promise<PlannedIdleSqliteRecord[]> {
    const form16Path = resolveForm16Path();
    const where = [`1002190,gte,${start}`, `1002190,lte,${end}`];
    const records: PlannedIdleSqliteRecord[] = [];
    let offset = 0;
    const pageSize = 1000;
    while (true) {
      const page = await ragicClient.getFormPage(
        form16Path,
        { limit: pageSize, offset, where },
        false,
        { timeoutMs: env.RAGIC_SYNC_READ_TIMEOUT_MS, priority: "sync" }
      );
      const rows = normalizeRows(page);
      for (const row of rows) {
        const plannedMin = parseNumericValue(
          getFirstFieldValue(row.data, [...FORM_16_FIELD_CANDIDATES.plannedIdleMinutes])
        );
        if (plannedMin === null || plannedMin <= 0) {
          continue;
        }
        const machineId = String(
          getFirstFieldValue(row.data, [...FORM_16_FIELD_CANDIDATES.machineId]) ?? ""
        ).trim();
        if (!machineId) {
          continue;
        }
        const date = String(
          getFirstFieldValue(row.data, [...FORM_16_FIELD_CANDIDATES.date]) ?? ""
        ).trim();
        const monthKey = toMonthKey(date);
        // C8：date 空 / 無法解析月份 → 跳過，避免存進 month_key='' 的孤兒列（不被任何月份統計到）。
        if (!monthKey) {
          continue;
        }
        const prodType = String(
          getFirstFieldValue(row.data, [
            env.RAGIC_FORM_16_PROD_TYPE_FIELD_ID,
            ...FORM16_FIELD_NAME_CANDIDATES.prodType,
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
    source: "sqlite" | "ragic-live"
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
    return { month: ym, machines, source };
  }

  // 同日同機台已有計畫停機就擋掉，避免像 5/11 那樣重複建一筆、把稼動表的計劃停機天數灌爆。
  private async assertNoDuplicatePlannedIdle(
    form16Path: string,
    date: string,
    machineId: string
  ): Promise<void> {
    const ragicDate = date.replace(/-/g, "/");
    // 只用「日期 + 計畫停機=Yes」查（機台是 linked 欄、where 不穩），撈回來本地比對機台
    const page = await ragicClient.getFormPage(
      form16Path,
      { limit: 1000, offset: 0, where: [`1002190,eq,${ragicDate}`, `1012814,eq,Yes`] },
      false,
      { timeoutMs: env.RAGIC_READ_TIMEOUT_MS, priority: "user" }
    );
    const duplicate = normalizeRows(page).some((row) => {
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

    // 同日同機台重複防呆：稼動表會把每筆計畫停機當一天扣，重複建就灌爆運轉率（如 5/11 建兩筆）
    await this.assertNoDuplicatePlannedIdle(form16Path, date, machineId);

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
      // [16] 的 Type 雖然後續可由公式維護，但 API create 的必填驗證跑在公式之前；
      // create payload 必須先帶入，否則會被 Ragic 以「Field Type報工類別 contains empty value (code: 202)」拒絕。
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
        await assertForm16EntryStored(
          form16Path,
          localEntryId,
          {
            workOrderNo: "",
            type: resolvedReportType.type,
          },
          {
            readPriority: "background",
            timeoutMs: env.FORM16_WRITE_VERIFY_TIMEOUT_MS,
            maxRetries: env.FORM16_WRITE_VERIFY_MAX_RETRIES,
            continueOnReadError: true,
            onReadIndeterminate: async (payload) => {
              await form16WriteReverifyService.enqueue({
                ...payload,
                source: "downtime",
              });
            },
          }
        );

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
              throw new HttpError(
                502,
                `Form 16 action button 48 失敗，且 rollback delete 未確認（entry ${localEntryId} 可能已建立）：${errMsg}`,
                "RAGIC_ACTION_BUTTON_INDETERMINATE"
              );
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
    patch: UpdateForm16DowntimeInput,
    options: Form16DowntimeMutationOptions = {}
  ): Promise<{ id: string }> {
    const normalizedEntryId = String(entryId ?? "").trim();
    if (!/^\d+$/.test(normalizedEntryId)) {
      throw new HttpError(400, `非法的 entryId：${entryId}`, "INVALID_ENTRY_ID");
    }
    const form16Path = resolveForm16Path();
    await this.assertRecordSnapshotUnchanged(normalizedEntryId, options.expectedSnapshotHash);

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

    // processCode 變更時同步補齊 Type + lookup 欄位；[16] Type 雖有公式/defaultFormula，
    // 但 API update 不會可靠重算，必須送目前推導值，避免製程與 Type 留在舊狀態。
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

  async deleteRecord(
    entryId: string,
    options: Form16DowntimeMutationOptions = {}
  ): Promise<{ deleted: true }> {
    const normalizedEntryId = String(entryId ?? "").trim();
    if (!/^\d+$/.test(normalizedEntryId)) {
      throw new HttpError(400, `非法的 entryId：${entryId}`, "INVALID_ENTRY_ID");
    }
    const form16Path = resolveForm16Path();
    await this.assertRecordSnapshotUnchanged(normalizedEntryId, options.expectedSnapshotHash);
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
      snapshotHash: null,
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

  async assertRecordSnapshotUnchanged(
    entryId: string,
    expectedSnapshotHash?: string | null
  ): Promise<void> {
    const expected = String(expectedSnapshotHash ?? "").trim();
    if (!expected || !env.SQLITE_ENABLED) return;
    const current = await form16DowntimeSqliteRepository.getRecordSnapshotHash(entryId);
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

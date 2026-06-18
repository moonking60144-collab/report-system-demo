import { env } from "../../config/env";
import { getFormConfig } from "../../config/forms";
import { ragicClient, type RagicFormData } from "../../ragic/client";
import {
  workReportSqliteRepository,
  type StoredSyncState,
} from "../../storage/sqlite/workReportSqliteRepository";
import type {
  ReportFullQueryOptions,
  ReportFullQueryResult,
  ReportQueryOptions,
  ReportQueryResult,
  WorkReportRecord,
} from "../../types/workReport";
import { HttpError } from "../../utils/httpError";
import { reportFullSnapshotService } from "../reportFullSnapshotService";
import { resolveSqliteFullReportsCacheState } from "./readModelState";
import { mapFields, resolveCandidateFieldKeys } from "./queries/rowTransform";
import { normalizeRows, type RagicRow } from "./shared/ragicRowUtils";
import { WorkReportReadSupport } from "./shared/workReportReadSupport";

export class WorkReportReportsReadService {
  constructor(private readonly support: WorkReportReadSupport) {}

  async getReports(
    formId: string,
    options: ReportQueryOptions
  ): Promise<ReportQueryResult> {
    if (this.shouldUseStructuredReportQuery(options)) {
      return this.getStructuredReports(formId, options);
    }

    if (!options.refresh) {
      const sqliteResult = await this.tryGetReportsFromSqlite(formId, options);
      if (sqliteResult) {
        return sqliteResult;
      }
    }

    const config = getFormConfig(formId);
    const keyword = options.keyword?.trim() ?? "";
    const useCache = !options.refresh;
    const searchFields = Array.from(
      new Set([
        ...resolveCandidateFieldKeys(
          config.mainFields.workOrderNo,
          config.mainFieldFallbacks?.workOrderNo
        ),
        ...resolveCandidateFieldKeys(
          config.mainFields.customerPartNo,
          config.mainFieldFallbacks?.customerPartNo
        ),
        ...resolveCandidateFieldKeys(
          config.mainFields.machineCode,
          config.mainFieldFallbacks?.machineCode
        ),
      ])
    ).filter(Boolean);

    const pageLimit = options.limit + 1;
    let rawPage: RagicFormData;

    // 使用者列表讀取：明確傳 priority: "user"，避免靠 default 藏風險（M2 review 結論）
    if (keyword) {
      rawPage = await ragicClient.getFormPage(
        config.ragicPath,
        {
          limit: pageLimit,
          offset: options.offset,
          fts: keyword,
        },
        useCache,
        { priority: "user" }
      );

      if (normalizeRows(rawPage).length === 0 && searchFields.length > 0) {
        const whereKeyword = keyword.replace(/,/g, " ").trim();
        const fallbackPages = await Promise.all(
          searchFields.map((fieldId) =>
            ragicClient.getFormPage(
              config.ragicPath,
              {
                limit: pageLimit,
                offset: options.offset,
                where: `${fieldId},like,${whereKeyword}`,
              },
              useCache,
              { priority: "user" }
            )
          )
        );
        const firstHit = fallbackPages.find((page) => normalizeRows(page).length > 0);
        if (firstHit) {
          rawPage = firstHit;
        }
      }
    } else {
      rawPage = await ragicClient.getFormPage(
        config.ragicPath,
        {
          limit: pageLimit,
          offset: options.offset,
        },
        useCache,
        { priority: "user" }
      );
    }

    let rows = normalizeRows(rawPage);
    if (options.entryId) {
      rows = rows.filter((row) => this.isSameEntry(row, options.entryId!));
    }

    const hasMore = rows.length > options.limit;
    const slicedRows = rows.slice(0, options.limit);
    const data = slicedRows.map((row) => ({
      id: String(row.data._ragicId ?? row.data._ragic_id ?? row.entryId),
      ...mapFields(row.data, config.mainFields, config.mainFieldFallbacks),
      reports: [],
    }));

    return { data, count: data.length, totalCount: data.length, hasMore };
  }

  async getFullReports(
    formId: string,
    options: ReportFullQueryOptions
  ): Promise<ReportFullQueryResult> {
    if (!options.refresh) {
      const sqliteResult = await this.tryGetFullReportsFromSqlite(formId);
      if (sqliteResult) {
        return sqliteResult;
      }
    }

    return reportFullSnapshotService.getOrBuild(formId, {
      forceRefresh: Boolean(options.refresh),
      builder: async () => this.buildFullReportRecords(formId),
    });
  }

  prewarmFullReports(formId: string): boolean {
    if (!env.REPORT_FULL_CACHE_ENABLED) {
      return false;
    }

    return reportFullSnapshotService.triggerRebuildInBackground(
      formId,
      async () => this.buildFullReportRecords(formId),
      "startup-prewarm"
    );
  }

  async buildFullReportRecords(formId: string): Promise<WorkReportRecord[]> {
    const config = getFormConfig(formId);
    const limit = 1000;
    let offset = 0;
    const rowsById = new Map<string, WorkReportRecord>();

    while (true) {
      // 全表掃：走 sync lane
      // Why：跟其他 bulk ops（scanFormRecords）語意一致，共用 pool 不額外引入新 lane。
      // Tradeoff：
      // - 優點：不跟 user 即時讀取搶資源，也不跟 background callback burst 互搶 slot
      // - 缺點：使用者主動 /reports/full 遇 cold cache 時，會排隊等 sync lane
      //        （但這種 bulk 請求本來就慢，延遲幾秒不算大 regression）
      // 若未來觀察到使用者端 full hydration 被 sync lane 塞住，可改拉獨立 `fullhydration` lane。
      const page = await ragicClient.getFormPage(
        config.ragicPath,
        { limit, offset },
        false,
        { timeoutMs: env.RAGIC_SYNC_READ_TIMEOUT_MS, priority: "sync" }
      );
      const rows = normalizeRows(page);
      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        const id = String(row.data._ragicId ?? row.data._ragic_id ?? row.entryId);
        rowsById.set(id, {
          id,
          ...mapFields(row.data, config.mainFields, config.mainFieldFallbacks),
          reports: [],
        });
      }

      if (rows.length < limit) {
        break;
      }
      offset += limit;
    }

    return Array.from(rowsById.values()).slice(0, env.REPORT_FULL_CACHE_MAX_RECORDS);
  }

  private isSameEntry(row: RagicRow, entryId: string): boolean {
    const ragicId = String(row.data._ragicId ?? row.data._ragic_id ?? "");
    return row.entryId === entryId || ragicId === entryId;
  }

  private shouldUseStructuredReportQuery(options: ReportQueryOptions): boolean {
    return Boolean(
      options.status ||
        options.ragicUnfinishedStatus ||
        options.filterMachineCode ||
        options.machineCode ||
        options.workOrderKeyword ||
        options.customerPartKeyword ||
        (options.siteRunning && options.siteRunning !== "all") ||
        (options.startSchedule && options.startSchedule !== "all") ||
        options.updatedDateFrom ||
        options.updatedDateTo ||
        options.keyword ||
        (options.sortRules?.length ?? 0) > 0
    );
  }

  private async getStructuredReports(
    formId: string,
    options: ReportQueryOptions
  ): Promise<ReportQueryResult> {
    if (!options.refresh) {
      const sqliteResult = await this.tryGetStructuredReportsFromSqlite(formId, options);
      if (sqliteResult) {
        return sqliteResult;
      }
      if (this.support.shouldUseSqliteRead(formId)) {
        throw new HttpError(
          503,
          "報表索引尚未可讀，請稍後重試或先執行同步。",
          "SQLITE_READ_MODEL_UNAVAILABLE"
        );
      }
    }

    const sourceRecords = (await this.getFullReports(formId, { refresh: Boolean(options.refresh) })).data;
    return this.support.filterSortAndPaginateReports(sourceRecords, options);
  }

  private async tryGetReportsFromSqlite(
    formId: string,
    options: ReportQueryOptions
  ): Promise<ReportQueryResult | null> {
    if (!this.support.shouldUseSqliteRead(formId)) {
      return null;
    }

    try {
      const syncState = await workReportSqliteRepository.getSyncState(formId);
      if (!this.support.isSqliteSnapshotReady(syncState, { allowStale: true })) {
        return null;
      }

      return workReportSqliteRepository.getReports(formId, {
        limit: options.limit,
        offset: options.offset,
        keyword: options.keyword,
        entryId: options.entryId,
      });
    } catch (error) {
      console.warn("[sqlite-read-fallback][reports]", {
        formId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async tryGetFullReportsFromSqlite(
    formId: string
  ): Promise<ReportFullQueryResult | null> {
    if (!this.support.shouldUseSqliteRead(formId)) {
      return null;
    }

    try {
      const syncState = await workReportSqliteRepository.getSyncState(formId);
      if (!this.support.isSqliteSnapshotReady(syncState, { allowStale: true })) {
        return null;
      }

      const records = await workReportSqliteRepository.getFullReports(formId);
      return {
        data: records,
        meta: {
          formId,
          count: records.length,
          cacheSource: "sqlite",
          cacheState: resolveSqliteFullReportsCacheState(syncState),
          snapshotAt: syncState?.snapshotAt ?? null,
          expiresAt: null,
          refreshTriggered: false,
          truncated: false,
        },
      };
    } catch (error) {
      console.warn("[sqlite-read-fallback][reports-full]", {
        formId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async tryGetStructuredReportsFromSqlite(
    formId: string,
    options: ReportQueryOptions
  ): Promise<ReportQueryResult | null> {
    if (!this.support.shouldUseSqliteRead(formId)) {
      return null;
    }

    try {
      const syncState = await workReportSqliteRepository.getSyncState(formId);
      if (!this.support.isSqliteSnapshotReady(syncState, { allowStale: true })) {
        return null;
      }
      return await workReportSqliteRepository.getReports(formId, {
        limit: options.limit,
        offset: options.offset,
        keyword: options.keyword,
        workOrderKeyword: options.workOrderKeyword,
        customerPartKeyword: options.customerPartKeyword,
        entryId: options.entryId,
        status: options.status,
        ragicUnfinishedStatus: options.ragicUnfinishedStatus,
        machineCode: options.machineCode,
        filterMachineCode: options.filterMachineCode,
        siteRunning: options.siteRunning,
        startSchedule: options.startSchedule,
        updatedDateFrom: options.updatedDateFrom,
        updatedDateTo: options.updatedDateTo,
        sortRules: options.sortRules,
      });
    } catch (error) {
      console.warn("[sqlite-read-fallback][structured-reports]", {
        formId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

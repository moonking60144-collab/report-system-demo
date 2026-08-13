import { getFormConfig } from "../../config/forms";
import { ragicClient } from "../../ragic/client";
import type { RagicReadPriority } from "../../infra/ragicRequestScheduler";
import type { WorkReportRecord } from "../../types/workReport";
import { HttpError } from "../../utils/httpError";
import { transformRow } from "./queries/rowTransform";
import { WorkReportOptionsReadService } from "./workReportOptionsReadService";
import { workReportSqliteRepository } from "../../storage/sqlite/workReportSqliteRepository";
import { WorkReportReadSupport } from "./shared/workReportReadSupport";

export class WorkReportEntryReadService {
  constructor(
    private readonly support: WorkReportReadSupport,
    private readonly optionsReadService: WorkReportOptionsReadService
  ) {}

  async getReportByEntryId(
    formId: string,
    entryId: string,
    options: {
      refresh?: boolean;
      allowSqliteFallbackOnRefresh?: boolean;
      ragicReadTimeoutMs?: number;
      ragicReadMaxRetries?: number;
      /** Ragic 讀取 lane；背景任務（callback / sync / mutation projection）要傳 "background" 或 "sync"
       *  避免污染使用者 lane 的 circuit breaker。 */
      priority?: RagicReadPriority;
      persistRefreshToSqlite?: boolean;
    } = {}
  ): Promise<WorkReportRecord> {
    const sqliteRecord = await this.tryGetReportByEntryIdFromSqlite(formId, entryId);
    if (!options.refresh) {
      if (sqliteRecord) {
        return sqliteRecord;
      }
    }

    const config = getFormConfig(formId);
    const useCache = !options.refresh;
    let entryData;
    try {
      entryData = await ragicClient.getEntry(config.ragicPath, entryId, useCache, {
        timeoutMs: options.ragicReadTimeoutMs,
        maxRetries: options.ragicReadMaxRetries,
        priority: options.priority,
      });
    } catch (error) {
      if (
        options.refresh &&
        options.allowSqliteFallbackOnRefresh &&
        sqliteRecord &&
        shouldFallbackToSqlite(error)
      ) {
        console.warn("[work-report-detail][refresh-sqlite-fallback]", {
          formId,
          entryId,
          error: error instanceof Error ? error.message : String(error),
        });
        return sqliteRecord;
      }
      throw error;
    }
    if (!entryData) {
      throw new HttpError(404, `找不到報工資料：${entryId}`, "REPORT_NOT_FOUND");
    }
    const linkedSources = await this.optionsReadService.prepareLinkedSourceMaps(
      config.linkedFields,
      options.priority ?? "user"
    );
    const record = transformRow({ entryId, data: entryData }, config, linkedSources);
    if (options.refresh && options.persistRefreshToSqlite) {
      await this.persistRefreshedEntrySnapshot(formId, entryId, record);
    }
    return record;
  }

  private async tryGetReportByEntryIdFromSqlite(
    formId: string,
    entryId: string
  ): Promise<WorkReportRecord | null> {
    if (!this.support.shouldUseSqliteRead(formId)) {
      return null;
    }

    try {
      const syncState = await workReportSqliteRepository.getSyncState(formId);
      if (!this.support.isSqliteSnapshotReady(syncState)) {
        return null;
      }
      return await workReportSqliteRepository.getReportByEntryId(formId, entryId);
    } catch (error) {
      console.warn("[sqlite-read-fallback][entry]", {
        formId,
        entryId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async persistRefreshedEntrySnapshot(
    formId: string,
    entryId: string,
    record: WorkReportRecord
  ): Promise<void> {
    // WHY: 只在已成功刷新到 Ragic 最新資料時才更新 entry snapshot，
    // 避免用可能過期的快取資料蓋掉 SQLite 既有真實快照；若快照寫入失敗則僅記錄告警不中斷讀取流程，
    // 以確保讀取可用性優先於本地同步成功率。
    if (!this.support.shouldUseSqliteRead(formId)) {
      return;
    }

    const snapshotAt = new Date().toISOString();
    try {
      await workReportSqliteRepository.upsertEntrySnapshot(formId, record, snapshotAt);
    } catch (error) {
      console.warn("[work-report-detail][refresh-snapshot-write-failed]", {
        formId,
        entryId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function shouldFallbackToSqlite(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.statusCode >= 500;
  }
  return true;
}

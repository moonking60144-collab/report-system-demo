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
    // linked source fetch 跟著 caller 指定的 lane；同一個使用者 / 背景請求共用同一條 lane。
    // caller 沒明示時 fallback "user"（跟 ragicClient.getEntry 一致的 default 語意），
    // 但 prepareLinkedSourceMaps 本身不提供 default 避免別處 silent drop。
    const linkedSources = await this.optionsReadService.prepareLinkedSourceMaps(
      config.linkedFields,
      options.priority ?? "user"
    );
    return transformRow({ entryId, data: entryData }, config, linkedSources);
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
      if (!this.support.isSqliteSnapshotReady(syncState, { allowStale: true })) {
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
}

function shouldFallbackToSqlite(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.statusCode >= 500;
  }
  return true;
}

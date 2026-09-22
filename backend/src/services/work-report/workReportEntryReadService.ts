import { resolveWorkReportDataPath } from "../../config/env";
import { AxiosError } from "axios";
import { getFormConfig } from "../../config/forms";
import { ragicClient } from "../../ragic/client";
import type { RagicReadPriority } from "../../infra/ragicRequestScheduler";
import type { ReportEntryQueryResult, WorkReportRecord } from "../../types/workReport";
import { HttpError, UpstreamError } from "../../utils/httpError";
import { transformRow } from "./queries/rowTransform";
import { WorkReportOptionsReadService } from "./workReportOptionsReadService";
import { workReportSqliteRepository } from "../../storage/sqlite/workReportSqliteRepository";
import { WorkReportReadSupport } from "./shared/workReportReadSupport";
import { createRagicLiveReadMeta, resolveSqliteReadMeta } from "./readModelState";
import { runWorkReportEntryProjection } from "../work-report-sync/workReportEntryProjectionQueue";

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
    return (await this.getReportByEntryIdResult(formId, entryId, options)).data;
  }

  async getReportByEntryIdResult(
    formId: string,
    entryId: string,
    options: {
      refresh?: boolean;
      allowSqliteFallbackOnRefresh?: boolean;
      ragicReadTimeoutMs?: number;
      ragicReadMaxRetries?: number;
      priority?: RagicReadPriority;
      persistRefreshToSqlite?: boolean;
    } = {}
  ): Promise<ReportEntryQueryResult> {
    if (options.refresh && options.persistRefreshToSqlite) {
      return runWorkReportEntryProjection(formId, entryId, () =>
        this.readReportByEntryIdResult(formId, entryId, options)
      );
    }
    return this.readReportByEntryIdResult(formId, entryId, options);
  }

  private async readReportByEntryIdResult(
    formId: string,
    entryId: string,
    options: NonNullable<Parameters<WorkReportEntryReadService["getReportByEntryIdResult"]>[2]>
  ): Promise<ReportEntryQueryResult> {
    const sqliteResult = await this.tryGetReportByEntryIdFromSqlite(formId, entryId);
    if (!options.refresh) {
      if (sqliteResult) {
        return sqliteResult;
      }
    }

    const config = getFormConfig(formId);
    const readPath = resolveWorkReportDataPath(formId, config.ragicPath);
    const useCache = !options.refresh;
    let entryData;
    try {
      entryData = await ragicClient.getEntry(readPath, entryId, useCache, {
        timeoutMs: options.ragicReadTimeoutMs,
        maxRetries: options.ragicReadMaxRetries,
        priority: options.priority,
        strictResponse: options.refresh === true,
      });
    } catch (error) {
      const readError = error instanceof AxiosError && error.response?.status === 404
        ? new HttpError(404, "找不到報工資料，請核對工令或聯絡開發者。", "REPORT_NOT_FOUND")
        : classifyEntryReadError(error);
      if (
        options.refresh &&
        options.allowSqliteFallbackOnRefresh &&
        sqliteResult &&
        shouldFallbackToSqlite(readError)
      ) {
        console.warn("[work-report-detail][refresh-sqlite-fallback]", {
          formId,
          entryId,
          error: error instanceof Error ? error.message : String(error),
        });
        return sqliteResult;
      }
      throw readError;
    }
    if (!entryData) {
      throw new HttpError(404, `找不到報工資料：${entryId}`, "REPORT_NOT_FOUND");
    }
    const linkedSources = await this.optionsReadService.prepareLinkedSourceMaps(
      config.linkedFields,
      options.priority ?? "user"
    ).catch(error => {
      if (error instanceof AxiosError && error.response?.status === 404) {
        throw new UpstreamError("Ragic 關聯來源資料無法讀取，系統將稍後重新確認。", "RAGIC_LINKED_SOURCE_READ_FAILED");
      }
      throw classifyEntryReadError(error);
    });
    const record = transformRow({ entryId, data: entryData }, config, linkedSources);
    if (options.refresh && options.persistRefreshToSqlite) {
      await this.persistRefreshedEntrySnapshot(formId, entryId, record);
    }
    return {
      data: record,
      meta: createRagicLiveReadMeta(),
    };
  }

  private async tryGetReportByEntryIdFromSqlite(
    formId: string,
    entryId: string
  ): Promise<ReportEntryQueryResult | null> {
    if (!this.support.shouldUseSqliteRead(formId)) {
      return null;
    }

    try {
      const syncState = await workReportSqliteRepository.getSyncState(formId);
      if (!this.support.isSqliteSnapshotReady(syncState, { allowStale: true })) {
        return null;
      }
      const record = await workReportSqliteRepository.getReportByEntryId(formId, entryId);
      return record
        ? {
            data: record,
            meta: resolveSqliteReadMeta(syncState),
          }
        : null;
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
      const syncState = await workReportSqliteRepository.getSyncState(formId);
      if (syncState?.status === "running") {
        await workReportSqliteRepository.enqueueProjectionEvent(formId, entryId, "update");
      }
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

function classifyEntryReadError(error: unknown): unknown {
  if (error instanceof AxiosError && (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT")) {
    return new HttpError(504, "Ragic 資料讀取逾時，系統將稍後重新確認。", "RAGIC_READ_TIMEOUT");
  }
  return error;
}

function shouldFallbackToSqlite(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.statusCode >= 500;
  }
  return true;
}

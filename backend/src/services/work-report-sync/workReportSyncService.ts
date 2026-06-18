import { randomUUID } from "crypto";
import { env } from "../../config/env";
import { getFormConfig } from "../../config/forms";
import { publishWorkReportFormUpdated } from "../../events/realtimeEventBus";
import { ragicClient } from "../../ragic/client";
import { workReportSqliteRepository } from "../../storage/sqlite/workReportSqliteRepository";
import { sqliteClient } from "../../storage/sqlite/sqliteClient";
import type { WorkReportRecord } from "../../types/workReport";
import { workReportReadService } from "../work-report/workReportReadService";
import { buildRefreshEntryOptions } from "../work-report/shared/refreshEntryOptions";
import { normalizeRows, type RagicRow } from "../work-report/shared/ragicRowUtils";
import { prepareLinkedSourceMaps } from "../work-report/queries/linkedSources";
import { transformRow } from "../work-report/queries/rowTransform";
import { WorkReportSyncService } from "./workReportSyncServiceFactory";

function normalizeEntryId(value: unknown): string {
  return String(value ?? "").trim();
}

async function scanFormRecords(
  formId: string,
  onProgress: (count: number) => void
): Promise<WorkReportRecord[]> {
  const config = getFormConfig(formId);
  // sync 全表掃 → 同條 lane（sync）；不跟使用者 / background 搶資源
  const linkedSources = await prepareLinkedSourceMaps(config.linkedFields, "sync");
  const recordsByEntryId = new Map<string, WorkReportRecord>();
  const pageLimit = 1000;
  // 一波併發抓幾頁：沿用 sync lane concurrency 上限；outbound 速率由 background
  // token bucket 鎖住，不會吃掉 user/write 的前景預算。設 1 即等同序列。
  const waveSize = env.RAGIC_SYNC_READ_CONCURRENCY;
  let duplicateCount = 0;

  const ingestRows = (rows: ReturnType<typeof normalizeRows>): void => {
    for (const row of rows) {
      const normalizedRow: RagicRow = {
        entryId: row.entryId,
        data: row.data,
      };
      const transformed = transformRow(normalizedRow, config, linkedSources);
      const entryId = normalizeEntryId(transformed.id);
      if (!entryId) {
        continue;
      }
      if (recordsByEntryId.has(entryId)) {
        duplicateCount += 1;
        // NOTE: live pagination during sync may surface the same entry twice; keep the latest copy.
        recordsByEntryId.delete(entryId);
      }
      recordsByEntryId.set(entryId, {
        ...transformed,
        id: entryId,
      });
    }
  };

  let baseOffset = 0;
  let done = false;
  while (!done) {
    const offsets = Array.from(
      { length: waveSize },
      (_unused, index) => baseOffset + index * pageLimit
    );
    const pages = await Promise.all(
      offsets.map((offset) =>
        ragicClient.getFormPage(
          config.ragicPath,
          { limit: pageLimit, offset },
          false,
          { timeoutMs: env.RAGIC_SYNC_READ_TIMEOUT_MS, priority: "sync" }
        )
      )
    );

    // Promise.all 保序 → 依 offset 遞增處理，維持序列版「後抓覆蓋先抓」去重語意
    for (const page of pages) {
      const rows = normalizeRows(page);
      if (rows.length < pageLimit) {
        done = true;
      }
      ingestRows(rows);
    }

    onProgress(recordsByEntryId.size);
    baseOffset += waveSize * pageLimit;
  }

  if (duplicateCount > 0) {
    console.warn("[sqlite-sync][duplicate-entry-deduped]", {
      formId,
      duplicateCount,
    });
  }

  return Array.from(recordsByEntryId.values());
}

export { type WorkReportSyncTask } from "./workReportSyncServiceFactory";

export const workReportSyncService = new WorkReportSyncService({
  scanFormRecords,
  refreshEntry(formId, entryId) {
    return workReportReadService.getReportByEntryId(
      formId,
      entryId,
      buildRefreshEntryOptions("sync")
    );
  },
  replaceFormSnapshot: async (formId, records, syncedAt) => {
    const result = await workReportSqliteRepository.replaceFormSnapshot(formId, records, syncedAt);
    // 全量 snapshot 是 WAL 暴漲主因；寫完立即 checkpoint 把整庫 WAL 搬回主檔。
    await sqliteClient.checkpoint();
    return result;
  },
  upsertEntrySnapshot:
    workReportSqliteRepository.upsertEntrySnapshot.bind(workReportSqliteRepository),
  deleteEntrySnapshot:
    workReportSqliteRepository.deleteEntrySnapshot.bind(workReportSqliteRepository),
  getSyncState: workReportSqliteRepository.getSyncState.bind(workReportSqliteRepository),
  upsertSyncState: workReportSqliteRepository.upsertSyncState.bind(workReportSqliteRepository),
  getLatestProjectionSeq:
    workReportSqliteRepository.getLatestProjectionSeq.bind(workReportSqliteRepository),
  getOldestPendingProjectionSeq:
    workReportSqliteRepository.getOldestPendingProjectionSeq.bind(workReportSqliteRepository),
  listPendingProjectionEntries:
    workReportSqliteRepository.listPendingProjectionEntries.bind(workReportSqliteRepository),
  markProjectionRangeProcessed:
    workReportSqliteRepository.markProjectionRangeProcessed.bind(workReportSqliteRepository),
  cleanupProcessedProjectionEvents:
    workReportSqliteRepository.cleanupProcessedProjectionEvents.bind(workReportSqliteRepository),
  getFormSnapshotCounts:
    workReportSqliteRepository.getFormSnapshotCounts.bind(workReportSqliteRepository),
  cleanupOldFormGenerations:
    workReportSqliteRepository.cleanupOldFormGenerations.bind(workReportSqliteRepository),
  publishWorkReportFormUpdated,
  generateTaskId: () => randomUUID(),
});

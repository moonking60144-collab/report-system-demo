import { randomUUID } from "crypto";
import { env } from "../../config/env";
import { getFormConfig } from "../../config/forms";
import { publishWorkReportFormUpdated } from "../../events/realtimeEventBus";
import { ragicClient } from "../../ragic/client";
import { workReportSqliteRepository } from "../../storage/sqlite/workReportSqliteRepository";
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
  let offset = 0;
  let duplicateCount = 0;

  while (true) {
    const page = await ragicClient.getFormPage(
      config.ragicPath,
      { limit: pageLimit, offset },
      false,
      { timeoutMs: env.RAGIC_SYNC_READ_TIMEOUT_MS, priority: "sync" }
    );
    const rows = normalizeRows(page);
    if (rows.length === 0) {
      break;
    }

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

    onProgress(recordsByEntryId.size);

    if (rows.length < pageLimit) {
      break;
    }
    offset += pageLimit;
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
  replaceFormSnapshot:
    workReportSqliteRepository.replaceFormSnapshot.bind(workReportSqliteRepository),
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
  publishWorkReportFormUpdated,
  generateTaskId: () => randomUUID(),
});

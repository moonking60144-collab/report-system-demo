import assert from "node:assert/strict";
import test from "node:test";
import { HttpError } from "../../src/utils/httpError";
import { WorkReportSyncService } from "../../src/services/work-report-sync/workReportSyncServiceFactory";
import { READ_MODEL_SCHEMA_VERSION } from "../../src/storage/sqlite/readModelSchema";

test("sync 開始時保留舊 snapshot，完成後會 replay dirty entry queue", async () => {
  const syncStatePatches: Array<Record<string, unknown>> = [];
  const replayWindows: Array<[number, number]> = [];
  const refreshedEntries: string[] = [];
  const replayUpsertGenerationIds: string[] = [];
  const countGenerationIds: Array<string | null> = [];
  const markedSeqs: number[] = [];
  const cleanedSeqs: number[] = [];
  let snapshotGenerationId = "";

  let latestSeqCall = 0;
  const latestSeqs = [10, 10, 12, 12];

  const service = new WorkReportSyncService({
    generateTaskId: () => "sync-105",
    scanFormRecords: async (_formId, onProgress) => {
      onProgress(0);
      return [];
    },
    refreshEntry: async (_formId, entryId) => {
      refreshedEntries.push(entryId);
      return {
        id: entryId,
        workOrderNo: `WO-${entryId}`,
        customerPartNo: null,
        erpPartNo: null,
        status: "未結案",
        reports: [],
      };
    },
    replaceFormSnapshot: async (_formId, _records, syncedAt) => {
      snapshotGenerationId = syncedAt;
      return { entryCount: 0, rowCount: 0 };
    },
    upsertEntrySnapshot: async (_formId, _record, _syncedAt, options) => {
      replayUpsertGenerationIds.push(options?.generationId ?? "");
      return { rowCount: 0 };
    },
    deleteEntrySnapshot: async () => undefined,
    getSyncState: async () => null,
    upsertSyncState: async (patch) => {
      syncStatePatches.push({ ...patch });
    },
    getLatestProjectionSeq: async () => {
      const value = latestSeqs[Math.min(latestSeqCall, latestSeqs.length - 1)];
      latestSeqCall += 1;
      return value;
    },
    getOldestPendingProjectionSeq: async () => 3,
    listPendingProjectionEntries: async (_formId, afterSeq, upToSeq) => {
      replayWindows.push([afterSeq, upToSeq]);
      if (afterSeq === 2 && upToSeq === 10) {
        return [{ entryId: "E-1", latestSeq: 7 }];
      }
      if (afterSeq === 10 && upToSeq === 12) {
        return [{ entryId: "E-2", latestSeq: 12 }];
      }
      return [];
    },
    markProjectionRangeProcessed: async (_formId, upToSeq) => {
      markedSeqs.push(upToSeq);
    },
    cleanupProcessedProjectionEvents: async (_formId, upToSeq) => {
      cleanedSeqs.push(upToSeq);
    },
    getFormSnapshotCounts: async (_formId, options) => {
      countGenerationIds.push(options?.generationId ?? null);
      return {
        entryCount: 2,
        rowCount: 4,
      };
    },
    publishWorkReportFormUpdated: () => undefined,
  });

  const task = await service.requestSync("105", {
    triggeredBy: "test",
    waitForCompletion: true,
  });

  assert.equal(task.status, "success");
  assert.equal(task.syncedEntries, 2);
  assert.equal(task.syncedRows, 4);
  assert.deepEqual(replayWindows, [
    [2, 10],
    [10, 12],
  ]);
  assert.deepEqual(refreshedEntries, ["E-1", "E-2"]);
  assert.match(snapshotGenerationId, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(replayUpsertGenerationIds, [snapshotGenerationId, snapshotGenerationId]);
  assert.deepEqual(countGenerationIds, [snapshotGenerationId]);
  assert.deepEqual(markedSeqs, [12]);
  assert.deepEqual(cleanedSeqs, [12]);

  const runningPatch = syncStatePatches[0];
  assert.equal(runningPatch.status, "running");
  assert.equal("snapshotAt" in runningPatch, false);
  assert.equal("totalEntries" in runningPatch, false);
  assert.equal("totalRows" in runningPatch, false);

  const successPatch = syncStatePatches[syncStatePatches.length - 1];
  assert.equal(successPatch.status, "success");
  assert.equal(successPatch.activeGenerationId, snapshotGenerationId);
  assert.equal(successPatch.totalEntries, 2);
  assert.equal(successPatch.totalRows, 4);
  assert.equal(typeof successPatch.snapshotAt, "string");
  assert.equal(successPatch.readModelVersion, READ_MODEL_SCHEMA_VERSION);
});

test("sync replay 遇到 REPORT_NOT_FOUND 會刪除 SQLite entry snapshot", async () => {
  let deletedEntryId = "";
  let snapshotGenerationId = "";
  let deleteGenerationId = "";

  const service = new WorkReportSyncService({
    generateTaskId: () => "sync-105-delete",
    scanFormRecords: async () => [],
    refreshEntry: async () => {
      throw new HttpError(404, "找不到報工資料：E-404", "REPORT_NOT_FOUND");
    },
    replaceFormSnapshot: async (_formId, _records, syncedAt) => {
      snapshotGenerationId = syncedAt;
      return { entryCount: 0, rowCount: 0 };
    },
    upsertEntrySnapshot: async () => ({ rowCount: 0 }),
    deleteEntrySnapshot: async (_formId, entryId, options) => {
      deletedEntryId = entryId;
      deleteGenerationId = options?.generationId ?? "";
    },
    getSyncState: async () => null,
    upsertSyncState: async () => undefined,
    getLatestProjectionSeq: async () => 1,
    getOldestPendingProjectionSeq: async () => 1,
    listPendingProjectionEntries: async (_formId, afterSeq, upToSeq) => {
      if (afterSeq === 0 && upToSeq === 1) {
        return [{ entryId: "E-404", latestSeq: 1 }];
      }
      return [];
    },
    markProjectionRangeProcessed: async () => undefined,
    cleanupProcessedProjectionEvents: async () => undefined,
    getFormSnapshotCounts: async () => ({
      entryCount: 0,
      rowCount: 0,
    }),
    publishWorkReportFormUpdated: () => undefined,
  });

  await service.requestSync("105", {
    triggeredBy: "test",
    waitForCompletion: true,
  });

  assert.equal(deletedEntryId, "E-404");
  assert.equal(deleteGenerationId, snapshotGenerationId);
});

test("sync 失敗時不主動覆寫 snapshotAt 與 counts", async () => {
  const syncStatePatches: Array<Record<string, unknown>> = [];

  const service = new WorkReportSyncService({
    generateTaskId: () => "sync-105-failed",
    scanFormRecords: async () => {
      throw new Error("sync failed");
    },
    refreshEntry: async () => {
      throw new Error("unreachable");
    },
    replaceFormSnapshot: async () => ({ entryCount: 0, rowCount: 0 }),
    upsertEntrySnapshot: async () => ({ rowCount: 0 }),
    deleteEntrySnapshot: async () => undefined,
    getSyncState: async () => null,
    upsertSyncState: async (patch) => {
      syncStatePatches.push({ ...patch });
    },
    getLatestProjectionSeq: async () => 0,
    getOldestPendingProjectionSeq: async () => null,
    listPendingProjectionEntries: async () => [],
    markProjectionRangeProcessed: async () => undefined,
    cleanupProcessedProjectionEvents: async () => undefined,
    getFormSnapshotCounts: async () => ({
      entryCount: 0,
      rowCount: 0,
    }),
    publishWorkReportFormUpdated: () => undefined,
  });

  const task = await service.requestSync("105", {
    triggeredBy: "test",
    waitForCompletion: true,
  });

  assert.equal(task.status, "failed");
  const failedPatch = syncStatePatches[syncStatePatches.length - 1];
  assert.equal(failedPatch.status, "failed");
  assert.equal("snapshotAt" in failedPatch, false);
  assert.equal("totalEntries" in failedPatch, false);
  assert.equal("totalRows" in failedPatch, false);
});

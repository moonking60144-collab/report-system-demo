import assert from "node:assert/strict";
import test from "node:test";
import { HttpError } from "../../src/utils/httpError";
import { WorkReportSyncService } from "../../src/services/work-report-sync/workReportSyncServiceFactory";
import {
  createWorkReportMutationSyncCoordinator,
  WorkReportAutoSyncYieldRequestedError,
} from "../../src/services/work-report-sync/workReportMutationSyncCoordinator";
import { READ_MODEL_SCHEMA_VERSION } from "../../src/storage/sqlite/readModelSchema";

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("sync 開始時保留舊 snapshot，完成後會 replay dirty entry queue", async () => {
  const syncStatePatches: Array<Record<string, unknown>> = [];
  const replayWindows: Array<[number, number]> = [];
  const refreshedEntries: string[] = [];
  const replayUpsertGenerationIds: string[] = [];
  const countGenerationIds: Array<string | null> = [];
  const markedSeqs: number[] = [];
  const cleanedSeqs: number[] = [];
  const publishedEntryBatches: Array<[string, string[]]> = [];
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
    publishWorkReportEntriesUpdated: (formId, entryIds) => {
      publishedEntryBatches.push([formId, entryIds]);
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
  assert.deepEqual(countGenerationIds, [snapshotGenerationId, snapshotGenerationId]);
  assert.deepEqual(markedSeqs, [10, 12]);
  assert.deepEqual(cleanedSeqs, [10, 12]);
  assert.deepEqual(publishedEntryBatches, [["105", ["E-1", "E-2"]]]);

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

test("sync promote 前最後一刻 enqueue 的 mutation 會在 promote 後補 replay", async () => {
  const syncStatePatches: Array<Record<string, unknown>> = [];
  const replayWindows: Array<[number, number]> = [];
  const refreshedEntries: string[] = [];
  const replayUpsertGenerationIds: string[] = [];
  const markedSeqs: number[] = [];
  const cleanedSeqs: number[] = [];
  const countResults = [
    { entryCount: 0, rowCount: 0 },
    { entryCount: 1, rowCount: 2 },
  ];
  let snapshotGenerationId = "";
  let latestSeqCall = 0;
  const latestSeqs = [0, 0, 1];

  const service = new WorkReportSyncService({
    generateTaskId: () => "sync-105-race",
    scanFormRecords: async () => [],
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
      return { rowCount: 2 };
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
    getOldestPendingProjectionSeq: async () => null,
    listPendingProjectionEntries: async (_formId, afterSeq, upToSeq) => {
      replayWindows.push([afterSeq, upToSeq]);
      if (afterSeq === 0 && upToSeq === 1) {
        return [{ entryId: "E-RACE", latestSeq: 1 }];
      }
      return [];
    },
    markProjectionRangeProcessed: async (_formId, upToSeq) => {
      markedSeqs.push(upToSeq);
    },
    cleanupProcessedProjectionEvents: async (_formId, upToSeq) => {
      cleanedSeqs.push(upToSeq);
    },
    getFormSnapshotCounts: async () => countResults.shift() ?? { entryCount: 1, rowCount: 2 },
    publishWorkReportEntriesUpdated: () => undefined,
    publishWorkReportFormUpdated: () => undefined,
  });

  const task = await service.requestSync("105", {
    triggeredBy: "test",
    waitForCompletion: true,
  });

  assert.equal(task.status, "success");
  assert.equal(task.syncedEntries, 1);
  assert.equal(task.syncedRows, 2);
  assert.deepEqual(replayWindows, [[0, 1]]);
  assert.deepEqual(refreshedEntries, ["E-RACE"]);
  assert.deepEqual(replayUpsertGenerationIds, [snapshotGenerationId]);
  assert.deepEqual(markedSeqs, [1]);
  assert.deepEqual(cleanedSeqs, [1]);

  const successPatches = syncStatePatches.filter((patch) => patch.status === "success");
  assert.equal(successPatches.length, 2);
  assert.equal(successPatches.at(-1)?.activeGenerationId, snapshotGenerationId);
  assert.equal(successPatches.at(-1)?.totalEntries, 1);
  assert.equal(successPatches.at(-1)?.totalRows, 2);
});

test("sync replay 遇到 REPORT_NOT_FOUND 會刪除 SQLite entry snapshot", async () => {
  let deletedEntryId = "";
  let publishedEntryId = "";
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
    publishWorkReportEntriesUpdated: (_formId, entryIds) => {
      publishedEntryId = entryIds[0] ?? "";
    },
    publishWorkReportFormUpdated: () => undefined,
  });

  await service.requestSync("105", {
    triggeredBy: "test",
    waitForCompletion: true,
  });

  assert.equal(deletedEntryId, "E-404");
  assert.equal(deleteGenerationId, snapshotGenerationId);
  assert.equal(publishedEntryId, "E-404");
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
    publishWorkReportEntriesUpdated: () => undefined,
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

test("手動同步會等待既有寫入，並回報等待狀態", async () => {
  const coordinator = createWorkReportMutationSyncCoordinator();
  const releaseMutation = await coordinator.acquireMutationSlot();
  const scanStarted = createDeferred();
  const releaseScan = createDeferred();
  const syncStatePatches: Array<Record<string, unknown>> = [];
  let scanCallCount = 0;
  const service = new WorkReportSyncService({
    coordinator,
    generateTaskId: () => "sync-105-batch-barrier",
    scanFormRecords: async () => {
      scanCallCount += 1;
      scanStarted.resolve();
      await releaseScan.promise;
      return [];
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
    getFormSnapshotCounts: async () => ({ entryCount: 0, rowCount: 0 }),
    publishWorkReportEntriesUpdated: () => undefined,
    publishWorkReportFormUpdated: () => undefined,
  });

  const acceptedTask = await service.requestSync("105", {
    triggeredBy: "toolbar-refresh",
    waitForCompletion: false,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(acceptedTask.accepted, true);
  assert.equal(scanCallCount, 0);
  assert.equal(syncStatePatches.length, 0);
  const waitingTask = await service.getStatus("105");
  assert.equal(waitingTask?.status, "running");
  assert.equal(waitingTask?.message, "正在等待報工寫入完成");

  releaseMutation();
  await scanStarted.promise;
  releaseScan.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const finishedTask = await service.getStatus("105");
  assert.equal(finishedTask?.status, "success");
});

test("sync replay 通知會在釋放同步 slot 後分批發送", async () => {
  let syncSlotActive = false;
  const publishedEntries: string[] = [];
  const publishedBatchSizes: number[] = [];
  const pendingEntries = Array.from({ length: 201 }, (_, index) => ({
    entryId: `E-${index + 1}`,
    latestSeq: 1,
  }));
  const coordinator = {
    acquireMutationSlot: async () => () => undefined,
    acquireSyncSlot: async () => {
      syncSlotActive = true;
      return () => {
        syncSlotActive = false;
      };
    },
    shouldDeferAutoSyncForMutation: () => false,
  };

  const service = new WorkReportSyncService({
    coordinator,
    generateTaskId: () => "sync-105-publish-after-release",
    scanFormRecords: async () => [],
    refreshEntry: async (_formId, entryId) => ({
      id: entryId,
      workOrderNo: `WO-${entryId}`,
      customerPartNo: null,
      erpPartNo: null,
      status: "未結案",
      reports: [],
    }),
    replaceFormSnapshot: async () => ({ entryCount: 0, rowCount: 0 }),
    upsertEntrySnapshot: async () => ({ rowCount: 0 }),
    deleteEntrySnapshot: async () => undefined,
    getSyncState: async () => null,
    upsertSyncState: async () => undefined,
    getLatestProjectionSeq: async () => 1,
    getOldestPendingProjectionSeq: async () => 1,
    listPendingProjectionEntries: async (_formId, afterSeq, upToSeq) =>
      afterSeq === 0 && upToSeq === 1
        ? pendingEntries
        : [],
    markProjectionRangeProcessed: async () => undefined,
    cleanupProcessedProjectionEvents: async () => undefined,
    getFormSnapshotCounts: async () => ({ entryCount: 1, rowCount: 0 }),
    publishWorkReportEntriesUpdated: (_formId, entryIds) => {
      assert.equal(syncSlotActive, false);
      publishedBatchSizes.push(entryIds.length);
      publishedEntries.push(...entryIds);
    },
    publishWorkReportFormUpdated: () => {
      assert.equal(syncSlotActive, false);
    },
  });

  const task = await service.requestSync("105", {
    triggeredBy: "test",
    waitForCompletion: true,
  });

  assert.equal(task.status, "success");
  assert.deepEqual(publishedBatchSizes, [200, 1]);
  assert.equal(publishedEntries.length, 201);
  assert.equal(publishedEntries[0], "E-1");
  assert.equal(publishedEntries.at(-1), "E-201");
});

test("auto-sync 在使用者寫入等待時會先讓位，且重掃後才 promote snapshot", async () => {
  const coordinator = createWorkReportMutationSyncCoordinator();
  const firstScanStarted = createDeferred();
  const continueFirstScan = createDeferred();
  const syncStatePatches: Array<Record<string, unknown>> = [];
  let scanCallCount = 0;
  let replaceCallCount = 0;
  const service = new WorkReportSyncService({
    coordinator,
    generateTaskId: () => "sync-105-auto-yield",
    scanFormRecords: async (_formId, onProgress, options) => {
      scanCallCount += 1;
      onProgress(scanCallCount);
      if (scanCallCount === 1) {
        firstScanStarted.resolve();
        await continueFirstScan.promise;
        if (options?.shouldYieldToMutation?.()) {
          throw new WorkReportAutoSyncYieldRequestedError();
        }
      }
      return [];
    },
    refreshEntry: async () => {
      throw new Error("unreachable");
    },
    replaceFormSnapshot: async () => {
      replaceCallCount += 1;
      return { entryCount: 0, rowCount: 0 };
    },
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
    getFormSnapshotCounts: async () => ({ entryCount: 0, rowCount: 0 }),
    publishWorkReportEntriesUpdated: () => undefined,
    publishWorkReportFormUpdated: () => undefined,
  });

  const syncPromise = service.requestSync("105", {
    triggeredBy: "auto-schedule",
    waitForCompletion: true,
  });
  await firstScanStarted.promise;

  const mutationSlotPromise = coordinator.acquireMutationSlot();
  await new Promise<void>((resolve) => setImmediate(resolve));
  continueFirstScan.resolve();
  const releaseMutation = await mutationSlotPromise;
  const replaceCountWhileMutationOwnsSlot = replaceCallCount;
  const yieldedTask = await service.getStatus("105");
  const yieldedSyncState = syncStatePatches.at(-1);
  releaseMutation();

  const completedTask = await syncPromise;
  assert.equal(replaceCountWhileMutationOwnsSlot, 0);
  assert.equal(yieldedTask?.status, "running");
  assert.equal(yieldedTask?.message, "正在等待報工寫入完成");
  assert.equal(yieldedSyncState?.status, "idle");
  assert.equal(yieldedSyncState?.message, "已讓位給報工寫入，等待重新同步");
  assert.equal(scanCallCount, 2);
  assert.equal(replaceCallCount, 1);
  assert.equal(completedTask.status, "success");
});

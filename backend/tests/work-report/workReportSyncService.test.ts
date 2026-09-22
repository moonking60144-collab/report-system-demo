import assert from "node:assert/strict";
import test from "node:test";
import { HttpError } from "../../src/utils/httpError";
import { WorkReportSyncService } from "../../src/services/work-report-sync/workReportSyncServiceFactory";
import {
  createWorkReportMutationSyncCoordinator,
} from "../../src/services/work-report-sync/workReportMutationSyncCoordinator";
import { READ_MODEL_SCHEMA_VERSION } from "../../src/storage/sqlite/readModelSchema";
import { workReportTaskRegistryService } from "../../src/services/work-report/workReportTaskRegistryService";

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

for (const failedPhase of ["scanMs", "snapshotWriteMs", "promotionWaitMs", "finalReplayMs"] as const) {
  test(`auto-sync ${failedPhase} 失敗仍保留耗時並釋放 lease`, async (t) => {
    let clock = Date.now();
    t.mock.method(Date, "now", () => clock);
    let leaseActive = false;
    let slotActive = false;
    let seqRead = 0;
    const failAt = (phase: typeof failedPhase) => {
      if (phase === failedPhase) {
        clock += 73;
        throw new Error(`failed ${phase}`);
      }
    };
    const service = new WorkReportSyncService({
      generateTaskId: () => `sync-timing-failure-${failedPhase}`,
      coordinator: {
        acquireMutationSlot: async () => () => undefined,
        acquireSyncSlot: async () => () => undefined,
        shouldDeferAutoSyncForMutation: () => false,
        acquireAutoSyncScanSlot: async () => {
          leaseActive = true;
          return {
            promote: async () => {
              failAt("promotionWaitMs");
              slotActive = true;
              return () => { slotActive = false; };
            },
            release: () => { leaseActive = false; },
          };
        },
      },
      scanFormRecords: async () => { failAt("scanMs"); return []; },
      replaceFormSnapshot: async () => {
        failAt("snapshotWriteMs");
        return { entryCount: 0, rowCount: 0 };
      },
      refreshEntry: async () => {
        assert.equal(slotActive, true);
        failAt("finalReplayMs");
        throw new Error("unexpected refresh");
      },
      upsertEntrySnapshot: async () => ({ rowCount: 0 }),
      deleteEntrySnapshot: async () => undefined,
      getSyncState: async () => null,
      upsertSyncState: async () => undefined,
      getLatestProjectionSeq: async () => ++seqRead >= 3 ? 1 : 0,
      getOldestPendingProjectionSeq: async () => null,
      listPendingProjectionEntries: async (_form, _after, upper) =>
        upper === 1 ? [{ entryId: "tail", latestSeq: 1 }] : [],
      markProjectionRangeProcessed: async () => undefined,
      cleanupProcessedProjectionEvents: async () => undefined,
      getFormSnapshotCounts: async () => ({ entryCount: 0, rowCount: 0 }),
      publishWorkReportEntriesUpdated: () => undefined,
      publishWorkReportFormUpdated: () => undefined,
    });
    const task = await service.requestSync("902", {
      triggeredBy: "auto-schedule", waitForCompletion: true,
    });
    assert.equal(task.status, "failed");
    assert.equal(task.error?.message, `failed ${failedPhase}`);
    assert.equal(task[failedPhase], 73);
    assert.equal(workReportTaskRegistryService.getTask(task.taskId)?.[failedPhase], 73);
    assert.equal(slotActive, false);
    assert.equal(leaseActive, false);
  });
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
    generateTaskId: () => "sync-902",
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

  const task = await service.requestSync("902", {
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
  assert.deepEqual(publishedEntryBatches, [["902", ["E-1", "E-2"]]]);

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
    { entryCount: 1, rowCount: 2 },
  ];
  let snapshotGenerationId = "";
  let latestSeqCall = 0;
  const latestSeqs = [0, 0, 1];

  const service = new WorkReportSyncService({
    generateTaskId: () => "sync-902-race",
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

  const task = await service.requestSync("902", {
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
  assert.equal(successPatches.length, 1);
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
    generateTaskId: () => "sync-902-delete",
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

  await service.requestSync("902", {
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
    generateTaskId: () => "sync-902-failed",
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

  const task = await service.requestSync("902", {
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
    generateTaskId: () => "sync-902-batch-barrier",
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

  const acceptedTask = await service.requestSync("902", {
    triggeredBy: "toolbar-refresh",
    waitForCompletion: false,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(acceptedTask.accepted, true);
  assert.equal(scanCallCount, 0);
  assert.equal(syncStatePatches.length, 0);
  const waitingTask = await service.getStatus("902");
  assert.equal(waitingTask?.status, "running");
  assert.equal(waitingTask?.message, "正在等待報工寫入完成");

  releaseMutation();
  await scanStarted.promise;
  releaseScan.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const finishedTask = await service.getStatus("902");
  assert.equal(finishedTask?.status, "success");
});

test("mutation reconcile 在 sync 已執行時會合併成完成後的下一輪同步", async () => {
  const firstScanStarted = createDeferred();
  const releaseFirstScan = createDeferred();
  let taskSequence = 0;
  let scanCallCount = 0;
  const service = new WorkReportSyncService({
    generateTaskId: () => `sync-reconcile-${++taskSequence}`,
    scanFormRecords: async () => {
      scanCallCount += 1;
      if (scanCallCount === 1) {
        firstScanStarted.resolve();
        await releaseFirstScan.promise;
      }
      return [];
    },
    refreshEntry: async () => {
      throw new Error("unreachable");
    },
    replaceFormSnapshot: async () => ({ entryCount: 0, rowCount: 0 }),
    upsertEntrySnapshot: async () => ({ rowCount: 0 }),
    deleteEntrySnapshot: async () => undefined,
    getSyncState: async () => null,
    upsertSyncState: async () => undefined,
    getLatestProjectionSeq: async () => 0,
    getOldestPendingProjectionSeq: async () => null,
    listPendingProjectionEntries: async () => [],
    markProjectionRangeProcessed: async () => undefined,
    cleanupProcessedProjectionEvents: async () => undefined,
    getFormSnapshotCounts: async () => ({ entryCount: 0, rowCount: 0 }),
    publishWorkReportEntriesUpdated: () => undefined,
    publishWorkReportFormUpdated: () => undefined,
  });

  await service.requestSync("901", {
    triggeredBy: "toolbar-refresh",
    waitForCompletion: false,
  });
  await firstScanStarted.promise;

  const queued = await service.requestSync("901", {
    triggeredBy: "mutation-reconcile",
    waitForCompletion: false,
    queueIfRunning: true,
  });
  assert.equal(queued.accepted, false);

  releaseFirstScan.resolve();
  while (scanCallCount < 2) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(scanCallCount, 2);
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
    generateTaskId: () => "sync-902-publish-after-release",
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

  const task = await service.requestSync("902", {
    triggeredBy: "test",
    waitForCompletion: true,
  });

  assert.equal(task.status, "success");
  assert.deepEqual(publishedBatchSizes, [200, 1]);
  assert.equal(publishedEntries.length, 201);
  assert.equal(publishedEntries[0], "E-1");
  assert.equal(publishedEntries.at(-1), "E-201");
});

test("auto-sync 掃描期間不佔用 mutation slot，完成後才以短 slot promote snapshot", async () => {
  const coordinator = createWorkReportMutationSyncCoordinator();
  const firstScanStarted = createDeferred();
  const continueFirstScan = createDeferred();
  const syncStatePatches: Array<Record<string, unknown>> = [];
  let scanCallCount = 0;
  let replaceCallCount = 0;
  const service = new WorkReportSyncService({
    coordinator,
    generateTaskId: () => "sync-902-auto-yield",
    scanFormRecords: async (_formId, onProgress, options) => {
      scanCallCount += 1;
      onProgress(scanCallCount);
      if (scanCallCount === 1) {
        firstScanStarted.resolve();
        await continueFirstScan.promise;
      }
      assert.equal(typeof options?.waitForMutationIdle, "function");
      await options?.waitForMutationIdle?.();
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

  const syncPromise = service.requestSync("902", {
    triggeredBy: "auto-schedule",
    waitForCompletion: true,
  });
  await firstScanStarted.promise;

  const releaseMutation = await coordinator.acquireMutationSlot();
  assert.equal(replaceCallCount, 0);
  continueFirstScan.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(replaceCallCount, 0);
  releaseMutation();

  const completedTask = await syncPromise;
  assert.equal(scanCallCount, 1);
  assert.equal(replaceCallCount, 1);
  assert.equal(completedTask.status, "success");
  assert.equal(syncStatePatches.some((patch) => patch.status === "idle"), false);
});

test("auto-sync pre-replay 在鎖外、final tail 與 promote 在短 slot 內完成", async (t) => {
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  let syncSlotActive = false;
  let scanLeaseActive = false;
  let latestSeqCall = 0;
  const replayWindows: Array<[number, number]> = [];
  const refreshSlotStates: Array<{ scan: boolean; sync: boolean }> = [];
  const syncSlotStates: Array<{ status: string; active: boolean }> = [];
  const upsertGenerationIds: string[] = [];
  const latestSeqs = [0, 1, 2];
  const coordinator = {
    acquireMutationSlot: async () => () => undefined,
    acquireSyncSlot: async () => {
      throw new Error("auto-sync should promote its scan lease instead of acquiring a full slot");
    },
    acquireAutoSyncScanSlot: async () => {
      scanLeaseActive = true;
      return {
        promote: async () => {
          assert.equal(scanLeaseActive, true);
          clock += 250;
          scanLeaseActive = false;
          syncSlotActive = true;
          let released = false;
          return () => {
            if (released) {
              return;
            }
            released = true;
            syncSlotActive = false;
          };
        },
        release: () => {
          scanLeaseActive = false;
        },
      };
    },
    shouldDeferAutoSyncForMutation: () => false,
  };
  const service = new WorkReportSyncService({
    coordinator,
    generateTaskId: () => "sync-902-auto-tail",
    scanFormRecords: async () => {
      clock += 11;
      return [];
    },
    refreshEntry: async (_formId, entryId) => {
      clock += entryId === "E-TAIL" ? 300 : 31;
      refreshSlotStates.push({ scan: scanLeaseActive, sync: syncSlotActive });
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
      clock += 23;
      upsertGenerationIds.push(syncedAt);
      return { entryCount: 0, rowCount: 0 };
    },
    upsertEntrySnapshot: async (_formId, _record, _syncedAt, options) => {
      upsertGenerationIds.push(options?.generationId ?? "");
      return { rowCount: 1 };
    },
    deleteEntrySnapshot: async () => undefined,
    getSyncState: async () => null,
    upsertSyncState: async (patch) => {
      syncSlotStates.push({ status: patch.status, active: syncSlotActive });
    },
    getLatestProjectionSeq: async () => latestSeqs[Math.min(latestSeqCall++, latestSeqs.length - 1)],
    getOldestPendingProjectionSeq: async () => null,
    listPendingProjectionEntries: async (_formId, afterSeq, upToSeq) => {
      replayWindows.push([afterSeq, upToSeq]);
      if (afterSeq === 0 && upToSeq === 1) {
        return [{ entryId: "E-PRE", latestSeq: 1 }];
      }
      if (afterSeq === 1 && upToSeq === 2) {
        return [{ entryId: "E-TAIL", latestSeq: 2 }];
      }
      return [];
    },
    markProjectionRangeProcessed: async (_formId, upToSeq) => {
      assert.equal(upToSeq, 2);
      assert.equal(syncSlotActive, true);
    },
    cleanupProcessedProjectionEvents: async () => undefined,
    getFormSnapshotCounts: async () => {
      clock += 7;
      return { entryCount: 2, rowCount: 0 };
    },
    publishWorkReportEntriesUpdated: (_formId, entryIds) => {
      assert.equal(syncSlotActive, false);
      assert.deepEqual(entryIds, ["E-PRE", "E-TAIL"]);
    },
    publishWorkReportFormUpdated: () => {
      assert.equal(syncSlotActive, false);
    },
  });

  const task = await service.requestSync("902", {
    triggeredBy: "auto-schedule",
    waitForCompletion: true,
  });

  assert.equal(task.status, "success");
  const expectedTimings = {
    scanMs: 11,
    snapshotWriteMs: 23,
    promotionWaitMs: 250,
    finalReplayMs: 300,
    promotionSlotHeldMs: 307,
  };
  const registered = workReportTaskRegistryService.getTask(task.taskId);
  for (const [key, value] of Object.entries(expectedTimings)) {
    assert.equal(task[key as keyof typeof expectedTimings], value, key);
    assert.equal(registered?.[key as keyof typeof expectedTimings], value, `registry ${key}`);
  }
  assert.deepEqual(replayWindows, [
    [0, 1],
    [1, 2],
  ]);
  assert.deepEqual(refreshSlotStates, [
    { scan: true, sync: false },
    { scan: false, sync: true },
  ]);
  assert.deepEqual(upsertGenerationIds.slice(1), [upsertGenerationIds[0], upsertGenerationIds[0]]);
  assert.equal(syncSlotStates.some((state) => state.status === "success" && !state.active), false);
  assert.equal(syncSlotStates.some((state) => state.status === "success" && state.active), true);
  assert.equal(scanLeaseActive, false);
  assert.equal(syncSlotActive, false);
});

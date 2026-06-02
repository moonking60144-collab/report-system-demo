import assert from "node:assert/strict";
import test from "node:test";
import { HttpError } from "../../src/utils/httpError";
import {
  WorkReportMutationProjectionService,
  type MutationProjectionSyncState,
} from "../../src/services/work-report-sync/workReportMutationProjectionServiceFactory";
import { READ_MODEL_SCHEMA_VERSION } from "../../src/storage/sqlite/readModelSchema";

test("mutation 在 running 狀態只 enqueue，不做即時 projection", async () => {
  let enqueueCount = 0;
  let readCalled = false;

  const service = new WorkReportMutationProjectionService({
    shouldProject: () => true,
    getSyncState: async () =>
      ({
        status: "running",
        snapshotAt: "2026-03-10T00:00:00.000Z",
        readModelVersion: READ_MODEL_SCHEMA_VERSION,
      }) satisfies MutationProjectionSyncState,
    enqueueProjectionEvent: async () => {
      enqueueCount += 1;
      return 7;
    },
    refreshEntry: async () => {
      readCalled = true;
      throw new Error("should not read");
    },
    upsertEntrySnapshot: async () => ({ rowCount: 0 }),
    deleteEntrySnapshot: async () => undefined,
    markProjectionEventProcessed: async () => undefined,
    cleanupProcessedProjectionEvents: async () => undefined,
    touchSyncStateSnapshot: async () => undefined,
    markRecentlyProjectedEntry: () => undefined,
  });

  await service.projectEntryAfterMutation("105", "E-1", "update");
  assert.equal(enqueueCount, 1);
  assert.equal(readCalled, false);
});

test("mutation 在可讀 snapshot 狀態會即時 projection 並清理 queue", async () => {
  const processedSeqs: number[] = [];
  const cleanedSeqs: number[] = [];
  let touchedMessage = "";
  const markedRecords: Array<{ formId: string; entryId: string; reason: string }> = [];

  const service = new WorkReportMutationProjectionService({
    shouldProject: () => true,
    getSyncState: async () =>
      ({
        status: "success",
        snapshotAt: "2026-03-10T00:00:10.000Z",
        readModelVersion: READ_MODEL_SCHEMA_VERSION,
      }) satisfies MutationProjectionSyncState,
    enqueueProjectionEvent: async () => 11,
    refreshEntry: async () => ({
      id: "E-1",
      workOrderNo: "WO-1",
      customerPartNo: null,
      erpPartNo: null,
      status: "未結案",
      reports: [],
    }),
    upsertEntrySnapshot: async () => ({ rowCount: 0 }),
    deleteEntrySnapshot: async () => undefined,
    markProjectionEventProcessed: async (_formId, seq) => {
      processedSeqs.push(seq);
    },
    cleanupProcessedProjectionEvents: async (_formId, seq) => {
      cleanedSeqs.push(seq);
    },
    touchSyncStateSnapshot: async (_formId, _snapshotAt, message) => {
      touchedMessage = String(message ?? "");
    },
    markRecentlyProjectedEntry: (formId, entryId, reason) => {
      markedRecords.push({ formId, entryId, reason });
    },
  });

  await service.projectEntryAfterMutation("105", "E-1", "update");
  assert.deepEqual(processedSeqs, [11]);
  assert.deepEqual(cleanedSeqs, [11]);
  assert.equal(touchedMessage, "entry-projection:update:E-1");
  assert.deepEqual(markedRecords, [{ formId: "105", entryId: "E-1", reason: "update" }]);
});

test("mutation 遇到 REPORT_NOT_FOUND 會刪除 SQLite entry snapshot 並清理 queue", async () => {
  let deletedEntryId = "";
  const processedSeqs: number[] = [];
  const markedRecords: Array<{ formId: string; entryId: string; reason: string }> = [];

  const service = new WorkReportMutationProjectionService({
    shouldProject: () => true,
    getSyncState: async () =>
      ({
        status: "failed",
        snapshotAt: "2026-03-10T00:00:10.000Z",
        readModelVersion: READ_MODEL_SCHEMA_VERSION,
      }) satisfies MutationProjectionSyncState,
    enqueueProjectionEvent: async () => 12,
    refreshEntry: async () => {
      throw new HttpError(404, "找不到報工資料：E-404", "REPORT_NOT_FOUND");
    },
    upsertEntrySnapshot: async () => ({ rowCount: 0 }),
    deleteEntrySnapshot: async (_formId, entryId) => {
      deletedEntryId = entryId;
    },
    markProjectionEventProcessed: async (_formId, seq) => {
      processedSeqs.push(seq);
    },
    cleanupProcessedProjectionEvents: async () => undefined,
    touchSyncStateSnapshot: async () => undefined,
    markRecentlyProjectedEntry: (formId, entryId, reason) => {
      markedRecords.push({ formId, entryId, reason });
    },
  });

  await service.projectEntryAfterMutation("105", "E-404", "delete");
  assert.equal(deletedEntryId, "E-404");
  assert.deepEqual(processedSeqs, [12]);
  assert.deepEqual(markedRecords, [{ formId: "105", entryId: "E-404", reason: "delete" }]);
});

test("mutation 遇到舊版 read model snapshot 不做即時 projection", async () => {
  let readCalled = false;

  const service = new WorkReportMutationProjectionService({
    shouldProject: () => true,
    getSyncState: async () =>
      ({
        status: "success",
        snapshotAt: "2026-03-10T00:00:10.000Z",
        readModelVersion: READ_MODEL_SCHEMA_VERSION - 1,
      }) satisfies MutationProjectionSyncState,
    enqueueProjectionEvent: async () => 13,
    refreshEntry: async () => {
      readCalled = true;
      throw new Error("should not read old snapshot");
    },
    upsertEntrySnapshot: async () => ({ rowCount: 0 }),
    deleteEntrySnapshot: async () => undefined,
    markProjectionEventProcessed: async () => undefined,
    cleanupProcessedProjectionEvents: async () => undefined,
    touchSyncStateSnapshot: async () => undefined,
    markRecentlyProjectedEntry: () => undefined,
  });

  await service.projectEntryAfterMutation("105", "E-legacy", "update");
  assert.equal(readCalled, false);
});

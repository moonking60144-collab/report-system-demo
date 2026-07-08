import test from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../../src/utils/httpError";
import { env } from "../../src/config/env";
import { workReportBatchCreateTaskService } from "../../src/services/work-report/workReportBatchCreateTaskService";
import { workReportBatchDeleteTaskService } from "../../src/services/work-report/workReportBatchDeleteTaskService";
import { workReportReadService } from "../../src/services/work-report/workReportReadService";
import { workReportService } from "../../src/services/workReportService";
import type {
  BatchCreateRowKeyRecord,
  BatchCreateRowKeyRepository,
} from "../../src/storage/sqlite/batchCreateRowKeyRepository";
import {
  workReportTaskRegistryService,
  type WorkReportQueueTaskRecord,
} from "../../src/services/work-report/workReportTaskRegistryService";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitTaskFinished(taskId: string): Promise<WorkReportQueueTaskRecord> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const task = workReportTaskRegistryService.getTask(taskId);
    if (task?.status === "success" || task?.status === "failed") {
      return task;
    }
    await sleep(10);
  }
  const task = workReportTaskRegistryService.getTask(taskId);
  assert.fail(`task did not finish: ${taskId}, status=${task?.status ?? "missing"}`);
}

function buildPendingRowKeyRecord(input: {
  clientRowKey: string;
  formId: string;
  entryId: string;
}): BatchCreateRowKeyRecord {
  const now = new Date().toISOString();
  return {
    clientRowKey: input.clientRowKey,
    formId: input.formId,
    entryId: input.entryId,
    ragicRowId: "",
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
}

test("批次新增 worker 前置檢查失敗時不建立任何列", async () => {
  let createRowCalls = 0;
  const task = workReportBatchCreateTaskService.requestBatchCreate({
    formId: "104",
    entryId: `precondition-create-${Date.now()}`,
    rows: [{ payload: { machineId: "P10" } }],
    beforeRun: async () => {
      throw new HttpError(409, "工單已被其他人更新", "ENTRY_CONFLICT");
    },
    createRow: async () => {
      createRowCalls += 1;
      return { rowId: "1001" };
    },
  });

  assert.ok(task.taskId);
  const finishedTask = await waitTaskFinished(task.taskId);
  assert.equal(createRowCalls, 0);
  assert.equal(finishedTask.status, "failed");
  assert.equal(finishedTask.errorCode, "ENTRY_CONFLICT");
  assert.match(String(finishedTask.errorMessage ?? ""), /前置檢查失敗/);
});

test("批次新增狀態前置檢查會擋已結案工令", async (t) => {
  const readMock = t.mock.method(
    workReportReadService,
    "getReportByEntryId",
    async () => ({
      id: "closed-entry",
      status: "已結案",
      reports: [],
    })
  );

  await assert.rejects(
    () => workReportService.assertBatchCreateEntryAcceptsReports("104", "closed-entry"),
    (error: unknown) =>
      error instanceof HttpError &&
      error.statusCode === 409 &&
      error.code === "ENTRY_CLOSED"
  );
  assert.equal(readMock.mock.callCount(), 1);
  assert.deepEqual(readMock.mock.calls[0]?.arguments, [
    "104",
    "closed-entry",
    {
      refresh: true,
      priority: "mutation",
      ragicReadTimeoutMs: env.RAGIC_MUTATION_READ_TIMEOUT_MS,
      ragicReadMaxRetries: env.RAGIC_MUTATION_READ_MAX_RETRIES,
    },
  ]);
});

test("批次新增狀態前置檢查允許未結案工令", async (t) => {
  const readMock = t.mock.method(
    workReportReadService,
    "getReportByEntryId",
    async () => ({
      id: "open-entry",
      status: "未結案",
      reports: [],
    })
  );

  await workReportService.assertBatchCreateEntryAcceptsReports("104", "open-entry");
  assert.equal(readMock.mock.callCount(), 1);
  assert.equal(readMock.mock.calls[0]?.arguments[2]?.refresh, true);
});

test("批次新增狀態前置檢查讀取失敗時會 fail closed", async (t) => {
  t.mock.method(workReportReadService, "getReportByEntryId", async () => {
    throw new Error("ECONNABORTED");
  });

  await assert.rejects(
    () => workReportService.assertBatchCreateEntryAcceptsReports("104", "unknown-entry"),
    (error: unknown) =>
      error instanceof HttpError &&
      error.statusCode === 409 &&
      error.code === "ENTRY_STATUS_UNKNOWN"
  );
});

test("批次新增狀態不可確認時 worker 不建立任何列", async (t) => {
  let createRowCalls = 0;
  t.mock.method(workReportReadService, "getReportByEntryId", async () => {
    throw new Error("ECONNABORTED");
  });

  const task = workReportBatchCreateTaskService.requestBatchCreate({
    formId: "104",
    entryId: `status-unknown-create-${Date.now()}`,
    rows: [{ payload: { machineId: "P10" } }],
    beforeRun: async () => {
      await workReportService.assertBatchCreateEntryAcceptsReports("104", "unknown-entry");
    },
    createRow: async () => {
      createRowCalls += 1;
      return { rowId: "1001" };
    },
  });

  assert.ok(task.taskId);
  const finishedTask = await waitTaskFinished(task.taskId);
  assert.equal(createRowCalls, 0);
  assert.equal(finishedTask.status, "failed");
  assert.equal(finishedTask.errorCode, "ENTRY_STATUS_UNKNOWN");
  assert.match(String(finishedTask.errorMessage ?? ""), /最新工令狀態/);
});

test("批次新增列寫入結果不明時 task 會標記 batchWriteIndeterminate", async () => {
  const formId = "104";
  const entryId = `indeterminate-create-${Date.now()}`;
  const clientRowKey = "indeterminate-row-key";
  const rowKeyRepository: BatchCreateRowKeyRepository = {
    lookup: async () => null,
    reservePending: async () => ({
      record: buildPendingRowKeyRecord({ clientRowKey, formId, entryId }),
      reserved: true,
    }),
    confirm: async () => {},
    markIndeterminate: async () => {},
    markStalePendingIndeterminate: async () => 0,
    releasePending: async () => 0,
    record: async () => {},
    deleteByRagicRowId: async () => 0,
    cleanupOlderThan: async () => 0,
  };
  const task = workReportBatchCreateTaskService.requestBatchCreate({
    formId,
    entryId,
    rows: [{ payload: { machineId: "P10" }, clientRowKey }],
    rowKeyRepository,
    createRow: async () => {
      throw new Error("ECONNABORTED");
    },
  });

  assert.ok(task.taskId);
  const finishedTask = await waitTaskFinished(task.taskId);
  assert.equal(finishedTask.status, "failed");
  assert.equal(finishedTask.errorCode, "BATCH_CREATE_PARTIAL_FAILURE");
  assert.equal(finishedTask.batchWriteIndeterminate, true);
  assert.match(String(finishedTask.errorMessage ?? ""), /寫入結果尚未確認/);
  assert.match(String(finishedTask.errorMessage ?? ""), /ECONNABORTED/);
});

test("批次刪除 worker 前置檢查失敗時不刪除任何列", async () => {
  let deleteRowCalls = 0;
  const task = workReportBatchDeleteTaskService.requestBatchDelete({
    formId: "105",
    entryId: `precondition-delete-${Date.now()}`,
    rowIds: ["1001", "1002"],
    beforeRun: async () => {
      throw new HttpError(409, "工單已被其他人更新", "ENTRY_CONFLICT");
    },
    deleteRow: async (rowId) => {
      deleteRowCalls += 1;
      return { rowId };
    },
  });

  assert.ok(task.taskId);
  const finishedTask = await waitTaskFinished(task.taskId);
  assert.equal(deleteRowCalls, 0);
  assert.equal(finishedTask.status, "failed");
  assert.equal(finishedTask.errorCode, "ENTRY_CONFLICT");
  assert.match(String(finishedTask.errorMessage ?? ""), /前置檢查失敗/);
});

test("單筆刪除 worker 成功時同步 delete-report registry shape", async () => {
  const task = workReportBatchDeleteTaskService.requestBatchDelete({
    taskType: "delete-report",
    formId: "105",
    entryId: `single-delete-${Date.now()}`,
    rowIds: ["1001"],
    deleteRow: async (rowId) => ({ rowId }),
    finalizeAfterDelete: async () => {},
  });

  assert.ok(task.taskId);
  const finishedTask = await waitTaskFinished(task.taskId);
  assert.equal(finishedTask.taskType, "delete-report");
  assert.equal(finishedTask.status, "success");
  assert.equal(finishedTask.rowId, "1001");
  assert.equal(finishedTask.queueKey, `${finishedTask.formId}:${finishedTask.entryId}`);
  assert.equal(finishedTask.message, "刪除報工完成");
});

test("批次刪除列刪完後 finalize 未完成前會顯示收尾中", async () => {
  let markFinalizeStarted!: () => void;
  let releaseFinalize!: () => void;
  const finalizeStarted = new Promise<void>((resolve) => {
    markFinalizeStarted = resolve;
  });
  const finalizeRelease = new Promise<void>((resolve) => {
    releaseFinalize = resolve;
  });

  const task = workReportBatchDeleteTaskService.requestBatchDelete({
    formId: "105",
    entryId: `finalizing-delete-${Date.now()}`,
    rowIds: ["1001", "1002"],
    deleteRow: async (rowId) => ({ rowId }),
    finalizeAfterDelete: async () => {
      markFinalizeStarted();
      await finalizeRelease;
    },
  });
  assert.ok(task.taskId);

  await finalizeStarted;
  const runningTask = workReportTaskRegistryService.getTask(task.taskId);
  assert.equal(runningTask?.status, "running");
  assert.equal(runningTask?.message, "批次刪除收尾中（已刪除 2/2，正在回算工令）");

  releaseFinalize();
  const finishedTask = await waitTaskFinished(task.taskId);
  assert.equal(finishedTask.status, "success");
  assert.equal(finishedTask.message, "批次刪除完成（2/2）");
});

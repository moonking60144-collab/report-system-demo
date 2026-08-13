import test from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../../src/utils/httpError";
import { env } from "../../src/config/env";
import { getFormConfig } from "../../src/config/forms";
import { ragicClient } from "../../src/ragic/client";
import { workReportBatchCreateTaskService } from "../../src/services/work-report/workReportBatchCreateTaskService";
import { workReportBatchDeleteTaskService } from "../../src/services/work-report/workReportBatchDeleteTaskService";
import { workReportService } from "../../src/services/workReportService";
import type {
  BatchCreateRowKeyRecord,
  BatchCreateRowKeyRepository,
} from "../../src/storage/sqlite/batchCreateRowKeyRepository";
import {
  workReportTaskRegistryService,
  type WorkReportQueueTaskRecord,
} from "../../src/services/work-report/workReportTaskRegistryService";
import { workReportEntryMutationQueue } from "../../src/services/work-report/workReportEntryMutationQueue";
import { createReportTaskService } from "../../src/services/createReportTaskService";
import { workReportMutationSyncCoordinator } from "../../src/services/work-report-sync/workReportMutationSyncCoordinator";
import { KeyedSerialQueueClosedError } from "../../src/utils/keyedSerialQueue";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test("queue admission 關閉時 batch create/delete 都不建立 ghost pending task", (t) => {
  const createInternals = workReportBatchCreateTaskService as unknown as {
    tasks: Map<string, unknown>;
  };
  const deleteInternals = workReportBatchDeleteTaskService as unknown as {
    tasks: Map<string, unknown>;
  };
  const beforeCreateCount = createInternals.tasks.size;
  const beforeDeleteCount = deleteInternals.tasks.size;
  t.mock.method(workReportEntryMutationQueue, "assertAccepting", () => {
    throw new KeyedSerialQueueClosedError();
  });

  assert.throws(
    () =>
      workReportBatchCreateTaskService.requestBatchCreate({
        formId: "104",
        entryId: "shutdown-entry",
        rows: [{ payload: { date: "2026/07/20" } }],
        createRow: async () => ({ rowId: "never" }),
      }),
    (error: unknown) => error instanceof KeyedSerialQueueClosedError
  );
  assert.throws(
    () =>
      workReportBatchDeleteTaskService.requestBatchDelete({
        formId: "104",
        entryId: "shutdown-entry",
        rowIds: ["1"],
        deleteRow: async () => ({ rowId: "never" }),
      }),
    (error: unknown) => error instanceof KeyedSerialQueueClosedError
  );
  assert.equal(createInternals.tasks.size, beforeCreateCount);
  assert.equal(deleteInternals.tasks.size, beforeDeleteCount);
});

async function waitTaskFinished(
  taskId: string,
  maxAttempts = 50
): Promise<WorkReportQueueTaskRecord> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const task = workReportTaskRegistryService.getTask(taskId);
    if (task?.status === "success" || task?.status === "failed") {
      return task;
    }
    await sleep(10);
  }
  const task = workReportTaskRegistryService.getTask(taskId);
  assert.fail(`task did not finish: ${taskId}, status=${task?.status ?? "missing"}`);
}

async function waitTaskWaitingForSync(taskId: string): Promise<WorkReportQueueTaskRecord> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const task = workReportTaskRegistryService.getTask(taskId);
    if (task?.status === "running" && task.message === "正在等待資料重新整理完成") {
      return task;
    }
    await sleep(10);
  }
  const task = workReportTaskRegistryService.getTask(taskId);
  assert.fail(
    `task did not wait for sync: ${taskId}, status=${task?.status ?? "missing"}, message=${task?.message ?? "missing"}`
  );
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

test("批次新增透過共用 mutation queue 等待 sync", async () => {
  await workReportTaskRegistryService.initialize();
  const formId = "104";
  const entryId = `wait-sync-create-${Date.now()}`;
  const clientRowKey = "wait-sync-row-key";
  let createRowCalls = 0;
  const rowKeyRepository: BatchCreateRowKeyRepository = {
    lookup: async () => null,
    reservePending: async () => ({
      record: buildPendingRowKeyRecord({ clientRowKey, formId, entryId }),
      reserved: true,
    }),
    confirm: async () => 1,
    markIndeterminate: async () => {},
    markStalePendingIndeterminate: async () => 0,
    releasePending: async () => 0,
    record: async () => 1,
    deleteByRagicRowId: async () => 0,
    cleanupOlderThan: async () => 0,
  };

  const releaseSync = await workReportMutationSyncCoordinator.acquireSyncSlot();
  let task!: ReturnType<typeof workReportBatchCreateTaskService.requestBatchCreate>;
  try {
    task = workReportBatchCreateTaskService.requestBatchCreate({
      formId,
      entryId,
      rows: [{ payload: { machineId: "P10" }, clientRowKey }],
      rowKeyRepository,
      createRow: async () => {
        createRowCalls += 1;
        return { rowId: "1001" };
      },
    });

    await waitTaskWaitingForSync(task.taskId);
    assert.equal(createRowCalls, 0);
  } finally {
    releaseSync();
  }
  const finishedTask = await waitTaskFinished(task.taskId);
  assert.equal(finishedTask.status, "success");
  assert.equal(createRowCalls, 1);
});

test("批次新增收尾重試等待 sync 時顯示實際等待狀態", async () => {
  await workReportTaskRegistryService.initialize();
  const formId = "104";
  const entryId = `wait-sync-finalize-retry-${Date.now()}`;
  const clientRowKey = `wait-sync-finalize-retry-row-${Date.now()}`;
  const rowKeyRepository: BatchCreateRowKeyRepository = {
    lookup: async () => null,
    reservePending: async () => ({
      record: buildPendingRowKeyRecord({ clientRowKey, formId, entryId }),
      reserved: true,
    }),
    confirm: async () => 1,
    markIndeterminate: async () => {},
    markStalePendingIndeterminate: async () => 0,
    releasePending: async () => 0,
    record: async () => 1,
    deleteByRagicRowId: async () => 0,
    cleanupOlderThan: async () => 0,
  };
  const sourceTask = workReportBatchCreateTaskService.requestBatchCreate({
    formId,
    entryId,
    rows: [{ payload: { machineId: "P10" }, clientRowKey }],
    rowKeyRepository,
    createRow: async () => ({ rowId: "1001" }),
    finalizeAfterCreate: async () => {
      throw new Error("Ragic formula recalculation failed");
    },
  });
  const failedSourceTask = await waitTaskFinished(sourceTask.taskId, 500);
  assert.equal(failedSourceTask.status, "failed");
  assert.equal(failedSourceTask.batchFinalizeFailed, true);

  let finalizeCalls = 0;
  const releaseSync = await workReportMutationSyncCoordinator.acquireSyncSlot();
  let retryTask!: ReturnType<
    typeof workReportBatchCreateTaskService.requestBatchCreateFinalizeRetry
  >;
  try {
    retryTask = workReportBatchCreateTaskService.requestBatchCreateFinalizeRetry({
      taskId: sourceTask.taskId,
      formId,
      entryId,
      finalizeAfterCreate: async () => {
        finalizeCalls += 1;
      },
    });

    await waitTaskWaitingForSync(retryTask.taskId);
    assert.equal(finalizeCalls, 0);
  } finally {
    releaseSync();
  }

  const finishedRetryTask = await waitTaskFinished(retryTask.taskId);
  assert.equal(finishedRetryTask.status, "success");
  assert.equal(finalizeCalls, 1);
});

test("獨立 modal 新增與編輯都透過共用 mutation queue 等待 sync", async () => {
  await workReportTaskRegistryService.initialize();
  const suffix = Date.now();
  let createWorkerCalls = 0;
  let updateWorkerCalls = 0;
  const releaseSync = await workReportMutationSyncCoordinator.acquireSyncSlot();
  let createTask!: ReturnType<typeof createReportTaskService.enqueue>;
  let updateTask!: ReturnType<typeof createReportTaskService.enqueue>;

  try {
    createTask = createReportTaskService.enqueue({
      taskType: "create-report",
      formId: "104",
      entryId: `modal-create-${suffix}`,
      queueKey: `104:modal-create-${suffix}`,
      worker: async () => {
        createWorkerCalls += 1;
        return { rowId: "2001" };
      },
    });
    updateTask = createReportTaskService.enqueue({
      taskType: "update-report",
      formId: "105",
      entryId: `modal-update-${suffix}`,
      queueKey: `105:modal-update-${suffix}`,
      worker: async () => {
        updateWorkerCalls += 1;
        return { rowId: "2002" };
      },
    });

    await Promise.all([
      waitTaskWaitingForSync(createTask.taskId),
      waitTaskWaitingForSync(updateTask.taskId),
    ]);
    assert.equal(createWorkerCalls, 0);
    assert.equal(updateWorkerCalls, 0);
  } finally {
    releaseSync();
  }

  const [created, updated] = await Promise.all([
    waitTaskFinished(createTask.taskId),
    waitTaskFinished(updateTask.taskId),
  ]);
  assert.equal(created.status, "success");
  assert.equal(updated.status, "success");
  assert.equal(createWorkerCalls, 1);
  assert.equal(updateWorkerCalls, 1);
});

test("單筆與批次刪除都透過共用 mutation queue 等待 sync", async () => {
  await workReportTaskRegistryService.initialize();
  const suffix = Date.now();
  let deleteWorkerCalls = 0;
  const releaseSync = await workReportMutationSyncCoordinator.acquireSyncSlot();
  let singleTask!: ReturnType<typeof workReportBatchDeleteTaskService.requestBatchDelete>;
  let batchTask!: ReturnType<typeof workReportBatchDeleteTaskService.requestBatchDelete>;

  try {
    singleTask = workReportBatchDeleteTaskService.requestBatchDelete({
      taskType: "delete-report",
      formId: "104",
      entryId: `single-delete-wait-${suffix}`,
      rowIds: ["3001"],
      deleteRow: async (rowId) => {
        deleteWorkerCalls += 1;
        return { rowId };
      },
    });
    batchTask = workReportBatchDeleteTaskService.requestBatchDelete({
      formId: "105",
      entryId: `batch-delete-wait-${suffix}`,
      rowIds: ["3002", "3003"],
      deleteRow: async (rowId) => {
        deleteWorkerCalls += 1;
        return { rowId };
      },
    });

    await Promise.all([
      waitTaskWaitingForSync(singleTask.taskId),
      waitTaskWaitingForSync(batchTask.taskId),
    ]);
    assert.equal(deleteWorkerCalls, 0);
  } finally {
    releaseSync();
  }

  const [singleDeleted, batchDeleted] = await Promise.all([
    waitTaskFinished(singleTask.taskId),
    waitTaskFinished(batchTask.taskId),
  ]);
  assert.equal(singleDeleted.status, "success");
  assert.equal(batchDeleted.status, "success");
  assert.equal(deleteWorkerCalls, 3);
});

test("批次新增狀態前置檢查會擋已結案工令", async (t) => {
  const config = getFormConfig("104");
  const readMock = t.mock.method(ragicClient, "getEntry", async () => ({
    [config.mainFields.status]: "已結案",
  }));

  await assert.rejects(
    () => workReportService.assertBatchCreateEntryAcceptsReports("104", "closed-entry"),
    (error: unknown) =>
      error instanceof HttpError &&
      error.statusCode === 409 &&
      error.code === "ENTRY_CLOSED"
  );
  assert.equal(readMock.mock.callCount(), 1);
  assert.deepEqual(readMock.mock.calls[0]?.arguments, [
    config.ragicPath,
    "closed-entry",
    false,
    {
      priority: "mutation",
      timeoutMs: env.RAGIC_MUTATION_READ_TIMEOUT_MS,
      maxRetries: env.RAGIC_MUTATION_READ_MAX_RETRIES,
    },
  ]);
});

test("批次新增狀態前置檢查允許未結案工令", async (t) => {
  const config = getFormConfig("104");
  const entry = { [config.mainFieldFallbacks?.status ?? ""]: "未結案" };
  const readMock = t.mock.method(ragicClient, "getEntry", async () => entry);

  const result = await workReportService.assertBatchCreateEntryAcceptsReports("104", "open-entry");
  assert.equal(readMock.mock.callCount(), 1);
  assert.equal(result, entry);
});

test("批次新增狀態前置檢查讀取失敗時會 fail closed", async (t) => {
  t.mock.method(ragicClient, "getEntry", async () => {
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
  t.mock.method(ragicClient, "getEntry", async () => {
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
    confirm: async () => 1,
    markIndeterminate: async () => {},
    markStalePendingIndeterminate: async () => 0,
    releasePending: async () => 0,
    record: async () => 1,
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

test("批次新增列已建立但 row key mapping 保存失敗時禁止整批重送", async () => {
  const formId = "104";
  const entryId = `row-key-record-failed-${Date.now()}`;
  const clientRowKey = "row-key-record-failed";
  const rowKeyRepository: BatchCreateRowKeyRepository = {
    lookup: async () => null,
    reservePending: async () => ({
      record: buildPendingRowKeyRecord({ clientRowKey, formId, entryId }),
      reserved: true,
    }),
    confirm: async () => 0,
    markIndeterminate: async () => {},
    markStalePendingIndeterminate: async () => 0,
    releasePending: async () => 0,
    record: async () => 1,
    deleteByRagicRowId: async () => 0,
    cleanupOlderThan: async () => 0,
  };
  const task = workReportBatchCreateTaskService.requestBatchCreate({
    formId,
    entryId,
    rows: [{ payload: { machineId: "P10" }, clientRowKey }],
    rowKeyRepository,
    createRow: async () => ({ rowId: "1001" }),
  });

  const finishedTask = await waitTaskFinished(task.taskId);

  assert.equal(finishedTask.status, "failed");
  assert.equal(finishedTask.errorCode, "BATCH_CREATE_PARTIAL_FAILURE");
  assert.equal(finishedTask.batchWriteIndeterminate, true);
  assert.match(String(finishedTask.errorMessage ?? ""), /reservation 已變更/);
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

test("單筆刪除實體完成但 finalize 失敗時 registry 保留已刪除結果", async () => {
  let deleteRowCalls = 0;
  const task = workReportBatchDeleteTaskService.requestBatchDelete({
    taskType: "delete-report",
    formId: "105",
    entryId: `single-delete-finalize-failed-${Date.now()}`,
    rowIds: ["1001"],
    deleteRow: async (rowId) => {
      deleteRowCalls += 1;
      return { rowId };
    },
    finalizeAfterDelete: async () => {
      throw new Error("Ragic formula recalculation failed");
    },
  });

  const finishedTask = await waitTaskFinished(task.taskId);
  assert.equal(deleteRowCalls, 1);
  assert.equal(finishedTask.status, "failed");
  assert.equal(finishedTask.deletedCount, 1);
  assert.equal(finishedTask.deleteFinalizeFailed, true);
  assert.equal(finishedTask.errorCode, "DELETE_REPORT_FINALIZE_FAILED");
  assert.equal(
    finishedTask.message,
    "報工已刪除，但工令回算或資料同步收尾失敗"
  );
  assert.match(
    String(finishedTask.errorMessage ?? ""),
    /Ragic formula recalculation failed/
  );
});

test("批次刪除部分成功時 registry 保留實際刪除筆數", async () => {
  const task = workReportBatchDeleteTaskService.requestBatchDelete({
    formId: "105",
    entryId: `batch-delete-partial-${Date.now()}`,
    rowIds: ["1001", "1002"],
    deleteRow: async (rowId) => {
      if (rowId === "1002") {
        throw new Error("Ragic delete rejected");
      }
      return { rowId };
    },
    finalizeAfterDelete: async () => {},
  });

  const finishedTask = await waitTaskFinished(task.taskId);
  assert.equal(finishedTask.status, "failed");
  assert.equal(finishedTask.deletedCount, 1);
  assert.equal(finishedTask.deleteFinalizeFailed, false);
  assert.equal(finishedTask.errorCode, "BATCH_DELETE_PARTIAL_FAILURE");
  assert.match(String(finishedTask.message ?? ""), /成功 1 \/ 2/);
});

test("批次刪除任一列寫入結果不明時 registry 不會誤判為可回滾失敗", async () => {
  const task = workReportBatchDeleteTaskService.requestBatchDelete({
    formId: "105",
    entryId: `batch-delete-indeterminate-${Date.now()}`,
    rowIds: ["1001", "1002"],
    deleteRow: async (rowId) => {
      if (rowId === "1002") {
        throw new HttpError(
          502,
          "無法確認 Ragic 是否已刪除",
          "RAGIC_DELETE_INDETERMINATE"
        );
      }
      return { rowId };
    },
    finalizeAfterDelete: async () => {},
  });

  const finishedTask = await waitTaskFinished(task.taskId);
  assert.equal(finishedTask.status, "failed");
  assert.equal(finishedTask.errorCode, "BATCH_DELETE_PARTIAL_FAILURE");
  assert.equal(finishedTask.batchWriteIndeterminate, true);
  assert.equal(finishedTask.lifecycleState, "indeterminate");
  assert.equal(finishedTask.confirmedAt, null);
});

test("刪除 worker 取得 queue 後才擷取 audit snapshot 並在成功刪除後回傳", async () => {
  const order: string[] = [];
  const snapshot = { operatorId: "A001", quantity: 10 };
  let observedSnapshot: unknown = null;

  const task = workReportBatchDeleteTaskService.requestBatchDelete({
    taskType: "delete-report",
    formId: "105",
    entryId: `delete-snapshot-${Date.now()}`,
    rowIds: ["1001"],
    beforeRun: async () => {
      order.push("precondition");
    },
    beforeDeleteRow: async (rowId) => {
      assert.equal(rowId, "1001");
      order.push("snapshot");
      return snapshot;
    },
    deleteRow: async (rowId) => {
      order.push("delete");
      return { rowId };
    },
    onRowDeleted: async (rowId, taskId, beforeSnapshot) => {
      assert.equal(rowId, "1001");
      assert.equal(taskId, task.taskId);
      order.push("audit");
      observedSnapshot = beforeSnapshot;
    },
  });

  const finishedTask = await waitTaskFinished(task.taskId);
  assert.equal(finishedTask.status, "success");
  assert.deepEqual(order, ["precondition", "snapshot", "delete", "audit"]);
  assert.deepEqual(observedSnapshot, snapshot);
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

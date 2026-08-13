import test from "node:test";
import assert from "node:assert/strict";
import {
  createReportTaskService,
  type CreateReportTask,
  type CreateReportTaskStatus,
} from "../../src/services/createReportTaskService";
import { env } from "../../src/config/env";
import {
  workReportTaskRegistryService,
  type WorkReportQueueTaskRecord,
} from "../../src/services/work-report/workReportTaskRegistryService";
import { HttpError } from "../../src/utils/httpError";
import { workReportEntryMutationQueue } from "../../src/services/work-report/workReportEntryMutationQueue";
import { KeyedSerialQueueClosedError } from "../../src/utils/keyedSerialQueue";
import { CircuitBreakerOpenError } from "../../src/infra/circuitBreaker";

async function waitForTaskStatus(
  taskId: string,
  expectedStatus: CreateReportTaskStatus
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (createReportTaskService.getTask(taskId)?.status === expectedStatus) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`task ${taskId} did not reach ${expectedStatus}`);
}

test("相同 clientMutationId 不會重複 enqueue 任務", async () => {
  let callCount = 0;

  const firstTask = createReportTaskService.enqueue({
    formId: "104",
    entryId: "E-100",
    queueKey: "104:E-100",
    clientMutationId: "mutation-dup-001",
    operationFingerprint: "fingerprint-create-E-100",
    worker: async () => {
      callCount += 1;
      return { rowId: "R-1" };
    },
  });

  const secondTask = createReportTaskService.enqueue({
    formId: "104",
    entryId: "E-100",
    queueKey: "104:E-100",
    clientMutationId: "mutation-dup-001",
    operationFingerprint: "fingerprint-create-E-100",
    worker: async () => {
      callCount += 1;
      return { rowId: "R-2" };
    },
  });

  assert.equal(firstTask.taskId, secondTask.taskId);

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(callCount, 1);
});

test("create worker 寫入結果不明時同步到 registry，禁止前端把它視為安全重送", async () => {
  const task = createReportTaskService.enqueue({
    taskType: "create-report",
    formId: "104",
    entryId: `E-INDETERMINATE-${Date.now()}`,
    queueKey: `104:E-INDETERMINATE-${Date.now()}`,
    clientMutationId: `mutation-indeterminate-${Date.now()}`,
    operationFingerprint: "fingerprint-indeterminate",
    worker: async () => {
      throw new HttpError(
        502,
        "建立 Ragic 紀錄失敗：Bad gateway",
        "RAGIC_WRITE_FAILED"
      );
    },
  });

  await waitForTaskStatus(task.taskId, "failed");

  assert.equal(createReportTaskService.getTask(task.taskId)?.writeIndeterminate, true);
  assert.equal(workReportTaskRegistryService.getTask(task.taskId)?.writeIndeterminate, true);
});

test("create worker 確定性失敗不標成 write indeterminate", async () => {
  const task = createReportTaskService.enqueue({
    taskType: "create-report",
    formId: "104",
    entryId: `E-DETERMINATE-${Date.now()}`,
    queueKey: `104:E-DETERMINATE-${Date.now()}`,
    clientMutationId: `mutation-determinate-${Date.now()}`,
    operationFingerprint: "fingerprint-determinate",
    worker: async () => {
      throw new HttpError(400, "欄位格式錯誤", "RAGIC_WRITE_FAILED");
    },
  });

  await waitForTaskStatus(task.taskId, "failed");

  assert.equal(createReportTaskService.getTask(task.taskId)?.writeIndeterminate, false);
  assert.equal(workReportTaskRegistryService.getTask(task.taskId)?.writeIndeterminate, false);
});

test("update worker circuit breaker fast-fail 會保留 typed error code 到 registry", async () => {
  const task = createReportTaskService.enqueue({
    taskType: "update-report",
    formId: "104",
    entryId: `E-CIRCUIT-${Date.now()}`,
    queueKey: `104:E-CIRCUIT-${Date.now()}`,
    clientMutationId: `mutation-circuit-${Date.now()}`,
    operationFingerprint: "fingerprint-circuit-open",
    worker: async () => {
      throw new CircuitBreakerOpenError("mutation", 11_155);
    },
  });

  await waitForTaskStatus(task.taskId, "failed");

  assert.equal(createReportTaskService.getTask(task.taskId)?.error?.code, "RAGIC_CIRCUIT_OPEN");
  assert.equal(
    workReportTaskRegistryService.getTask(task.taskId)?.errorCode,
    "RAGIC_CIRCUIT_OPEN"
  );
});

test("修改排序任務會把 operation 與本機名稱保存到 registry", async () => {
  const suffix = Date.now();
  const task = createReportTaskService.enqueue({
    taskType: "update-report",
    operationKind: "update-sort-order",
    formId: "104",
    entryId: `E-SORT-${suffix}`,
    workOrderNo: `WO-SORT-${suffix}`,
    queueKey: `104:E-SORT-${suffix}`,
    clientMutationId: `mutation-sort-${suffix}`,
    operationFingerprint: `fingerprint-sort-${suffix}`,
    actorLabel: "生管工作站",
    worker: async () => ({ rowId: `E-SORT-${suffix}` }),
  });

  await waitForTaskStatus(task.taskId, "success");

  const registryTask = workReportTaskRegistryService.getTask(task.taskId);
  assert.equal(registryTask?.operationKind, "update-sort-order");
  assert.equal(registryTask?.actorLabel, "生管工作站");
  assert.match(registryTask?.message ?? "", /修改工令排序任務完成/);
});

test("queue admission 關閉時不建立 ghost pending create task", (t) => {
  const internals = createReportTaskService as unknown as {
    tasks: Map<string, unknown>;
  };
  const beforeTaskCount = internals.tasks.size;
  t.mock.method(workReportEntryMutationQueue, "assertAccepting", () => {
    throw new KeyedSerialQueueClosedError();
  });

  assert.throws(
    () =>
      createReportTaskService.enqueue({
        formId: "104",
        entryId: "shutdown-entry",
        queueKey: "104:shutdown-entry",
        clientMutationId: `shutdown-${Date.now()}`,
        operationFingerprint: "shutdown-fingerprint",
        worker: async () => ({ rowId: "never" }),
      }),
    (error: unknown) => error instanceof KeyedSerialQueueClosedError
  );
  assert.equal(internals.tasks.size, beforeTaskCount);
});

test("相同 clientMutationId 但 operation fingerprint 不同時拒絕重用任務", async () => {
  const clientMutationId = `mutation-conflict-${Date.now()}`;
  const firstTask = createReportTaskService.enqueue({
    formId: "104",
    entryId: "E-200",
    queueKey: "104:E-200",
    clientMutationId,
    operationFingerprint: "fingerprint-create-E-200",
    worker: async () => ({ rowId: "R-200" }),
  });

  assert.throws(
    () =>
      createReportTaskService.enqueue({
        formId: "104",
        entryId: "E-201",
        queueKey: "104:E-201",
        clientMutationId,
        operationFingerprint: "fingerprint-create-E-201",
        worker: async () => ({ rowId: "R-201" }),
      }),
    (error) =>
      error instanceof HttpError &&
      error.statusCode === 409 &&
      error.code === "CLIENT_MUTATION_ID_CONFLICT"
  );

  assert.equal(createReportTaskService.getTask(firstTask.taskId)?.entryId, "E-200");
});

test("部署前 terminal task 缺 fingerprint 時沿用既有任務、不重複執行 worker", async () => {
  const clientMutationId = `mutation-legacy-terminal-${Date.now()}`;
  let workerCallCount = 0;
  const firstTask = createReportTaskService.enqueue({
    formId: "104",
    entryId: "E-LEGACY-TERMINAL",
    queueKey: "104:E-LEGACY-TERMINAL",
    clientMutationId,
    worker: async () => {
      workerCallCount += 1;
      return { rowId: "R-LEGACY-TERMINAL" };
    },
  });
  await waitForTaskStatus(firstTask.taskId, "success");

  const replayedTask = createReportTaskService.enqueue({
    formId: "104",
    entryId: "E-LEGACY-TERMINAL",
    queueKey: "104:E-LEGACY-TERMINAL",
    clientMutationId,
    operationFingerprint: "fingerprint-current-release",
    worker: async () => {
      workerCallCount += 1;
      return { rowId: "R-SHOULD-NOT-CREATE" };
    },
  });

  assert.equal(replayedTask.taskId, firstTask.taskId);
  assert.equal(replayedTask.status, "success");
  assert.equal(workerCallCount, 1);
});

test("部署前 recovered task 缺 fingerprint 時允許同 key 重新 enqueue", async () => {
  const clientMutationId = `mutation-legacy-recovered-${Date.now()}`;
  let retryWorkerCallCount = 0;
  const firstTask = createReportTaskService.enqueue({
    formId: "104",
    entryId: "E-LEGACY-RECOVERED",
    queueKey: "104:E-LEGACY-RECOVERED",
    clientMutationId,
    worker: async () => ({ rowId: "R-BEFORE-RESTART" }),
  });
  await waitForTaskStatus(firstTask.taskId, "success");

  const internals = createReportTaskService as unknown as {
    tasks: Map<string, CreateReportTask>;
  };
  const persistedTask = createReportTaskService.getTask(firstTask.taskId);
  assert.ok(persistedTask);
  const recoveredAt = new Date().toISOString();
  internals.tasks.set(firstTask.taskId, {
    ...persistedTask,
    status: "failed",
    updatedAt: recoveredAt,
    finishedAt: recoveredAt,
    error: {
      code: "TASK_RECOVERED_AFTER_RESTART",
      message: "服務重啟，原非完成任務已標記為失敗，請重新送出",
    },
  });

  const retriedTask = createReportTaskService.enqueue({
    formId: "104",
    entryId: "E-LEGACY-RECOVERED",
    queueKey: "104:E-LEGACY-RECOVERED",
    clientMutationId,
    operationFingerprint: "fingerprint-current-release",
    worker: async () => {
      retryWorkerCallCount += 1;
      return { rowId: "R-AFTER-RESTART" };
    },
  });

  assert.notEqual(retriedTask.taskId, firstTask.taskId);
  await waitForTaskStatus(retriedTask.taskId, "success");
  assert.equal(retryWorkerCallCount, 1);
  assert.equal(
    createReportTaskService.getTask(retriedTask.taskId)?.result?.rowId,
    "R-AFTER-RESTART"
  );
});

test("重啟只允許未開始的 create task 重送，running task 標記寫入結果不明", async () => {
  const pendingTask = createReportTaskService.enqueue({
    taskType: "create-report",
    formId: "104",
    entryId: `E-RECOVERY-PENDING-${Date.now()}`,
    queueKey: `104:E-RECOVERY-PENDING-${Date.now()}`,
    clientMutationId: `mutation-recovery-pending-${Date.now()}`,
    worker: async () => ({ rowId: "R-RECOVERY-PENDING" }),
  });
  const runningTask = createReportTaskService.enqueue({
    taskType: "create-report",
    formId: "104",
    entryId: `E-RECOVERY-RUNNING-${Date.now()}`,
    queueKey: `104:E-RECOVERY-RUNNING-${Date.now()}`,
    clientMutationId: `mutation-recovery-running-${Date.now()}`,
    worker: async () => ({ rowId: "R-RECOVERY-RUNNING" }),
  });
  await Promise.all([
    waitForTaskStatus(pendingTask.taskId, "success"),
    waitForTaskStatus(runningTask.taskId, "success"),
  ]);

  const internals = createReportTaskService as unknown as {
    tasks: Map<string, CreateReportTask>;
    recoverInterruptedTasks: () => number;
    syncAllTasksToRegistry: () => void;
  };
  const pendingSnapshot = createReportTaskService.getTask(pendingTask.taskId);
  const runningSnapshot = createReportTaskService.getTask(runningTask.taskId);
  assert.ok(pendingSnapshot);
  assert.ok(runningSnapshot);
  const registryInternals = workReportTaskRegistryService as unknown as {
    tasks: Map<string, WorkReportQueueTaskRecord>;
  };
  internals.tasks.set(pendingTask.taskId, {
    ...pendingSnapshot,
    status: "pending",
    writeIndeterminate: undefined,
    error: undefined,
  });
  internals.tasks.set(runningTask.taskId, {
    ...runningSnapshot,
    status: "running",
    writeIndeterminate: undefined,
    error: undefined,
  });

  assert.equal(internals.recoverInterruptedTasks(), 2);
  registryInternals.tasks.delete(pendingTask.taskId);
  registryInternals.tasks.delete(runningTask.taskId);
  internals.syncAllTasksToRegistry();

  const recoveredPending = createReportTaskService.getTask(pendingTask.taskId);
  const recoveredRunning = createReportTaskService.getTask(runningTask.taskId);
  assert.equal(recoveredPending?.status, "failed");
  assert.equal(recoveredPending?.writeIndeterminate, false);
  assert.match(recoveredPending?.error?.message ?? "", /請重新送出/);
  assert.equal(recoveredRunning?.status, "failed");
  assert.equal(recoveredRunning?.writeIndeterminate, true);
  assert.match(recoveredRunning?.error?.message ?? "", /不可直接重送/);
  assert.equal(
    workReportTaskRegistryService.getTask(runningTask.taskId)?.writeIndeterminate,
    true
  );

  const replayedRunning = createReportTaskService.enqueue({
    taskType: "create-report",
    formId: recoveredRunning!.formId,
    entryId: recoveredRunning!.entryId,
    queueKey: recoveredRunning!.queueKey,
    clientMutationId: recoveredRunning!.clientMutationId,
    worker: async () => ({ rowId: "R-MUST-NOT-RUN" }),
  });
  assert.equal(replayedRunning.taskId, runningTask.taskId);
});

test("create task flush 會等待目前 snapshot persist chain", async (t) => {
  const internals = createReportTaskService as unknown as {
    persistChain: Promise<void>;
  };
  const previousPersistChain = internals.persistChain;
  let persistFinished = false;

  internals.persistChain = new Promise<void>((resolve) => {
    setTimeout(() => {
      persistFinished = true;
      resolve();
    }, 10);
  });

  t.after(() => {
    internals.persistChain = previousPersistChain;
  });

  await createReportTaskService.flush();
  assert.equal(persistFinished, true);
});

test("task registry merge 不讓 recovered failed 覆蓋既有 success", (t) => {
  const taskId = `registry-merge-success-${Date.now()}`;
  const registryInternals = workReportTaskRegistryService as unknown as {
    tasks: Map<string, WorkReportQueueTaskRecord>;
  };
  const mutableEnv = env as unknown as {
    WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED: boolean;
  };
  const previousPersistEnabled = mutableEnv.WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED;
  mutableEnv.WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED = false;

  t.after(() => {
    registryInternals.tasks.delete(taskId);
    mutableEnv.WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED = previousPersistEnabled;
  });

  workReportTaskRegistryService.upsertTask({
    taskId,
    taskType: "create-report",
    status: "success",
    formId: "104",
    entryId: "E-104",
    rowId: "R-success",
    queueKey: "104:E-104",
    createdAt: "2026-07-06T10:00:00.000Z",
    startedAt: "2026-07-06T10:00:01.000Z",
    finishedAt: "2026-07-06T10:00:02.000Z",
    updatedAt: "2026-07-06T10:00:02.000Z",
    message: "新增報工背景任務完成（rowId: R-success）",
  });

  workReportTaskRegistryService.upsertTask({
    taskId,
    taskType: "create-report",
    status: "failed",
    formId: "104",
    entryId: "E-104",
    queueKey: "104:E-104",
    createdAt: "2026-07-06T10:00:00.000Z",
    finishedAt: "2026-07-06T10:10:00.000Z",
    updatedAt: "2026-07-06T10:10:00.000Z",
    errorCode: "TASK_REGISTRY_RECOVERED_AFTER_RESTART",
    errorMessage: "服務重啟，原未完成任務已標記為失敗",
    message: "服務重啟，原未完成任務已標記為失敗",
  });

  const task = workReportTaskRegistryService.getTask(taskId);
  assert.equal(task?.status, "success");
  assert.equal(task?.rowId, "R-success");
  assert.equal(task?.errorCode, null);
});

test("task registry 不會因 local running 與 registry pending 的 recovery 順序降級結果不明旗標", (t) => {
  const registryInternals = workReportTaskRegistryService as unknown as {
    tasks: Map<string, WorkReportQueueTaskRecord>;
  };
  const mutableEnv = env as unknown as {
    WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED: boolean;
  };
  const previousPersistEnabled = mutableEnv.WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED;
  const taskIds = [
    `registry-recovery-registry-first-${Date.now()}`,
    `registry-recovery-local-first-${Date.now()}`,
  ];
  mutableEnv.WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED = false;

  t.after(() => {
    for (const taskId of taskIds) {
      registryInternals.tasks.delete(taskId);
    }
    mutableEnv.WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED = previousPersistEnabled;
  });

  const registryPendingRecovery = (taskId: string) => ({
    taskId,
    taskType: "create-report" as const,
    status: "failed" as const,
    formId: "104",
    entryId: "E-RECOVERY-DRIFT",
    queueKey: "104:E-RECOVERY-DRIFT",
    createdAt: "2026-07-21T01:00:00.000Z",
    finishedAt: "2026-07-21T01:00:02.000Z",
    updatedAt: "2026-07-21T01:00:02.000Z",
    message: "服務重啟，原未完成任務已標記為失敗",
    errorCode: "TASK_REGISTRY_RECOVERED_AFTER_RESTART",
    errorMessage: "服務重啟，原未完成任務已標記為失敗",
    writeIndeterminate: false,
  });
  const localRunningRecovery = (taskId: string) => ({
    taskId,
    taskType: "create-report" as const,
    status: "failed" as const,
    formId: "104",
    entryId: "E-RECOVERY-DRIFT",
    queueKey: "104:E-RECOVERY-DRIFT",
    createdAt: "2026-07-21T01:00:00.000Z",
    finishedAt: "2026-07-21T01:00:01.000Z",
    updatedAt: "2026-07-21T01:00:01.000Z",
    message: "服務重啟時新增報工正在執行，寫入結果尚未確認；請先確認是否已建立，不可直接重送",
    errorCode: "TASK_RECOVERED_AFTER_RESTART",
    errorMessage: "服務重啟時新增報工正在執行，寫入結果尚未確認；請先確認是否已建立，不可直接重送",
    writeIndeterminate: true,
  });

  workReportTaskRegistryService.upsertTask(registryPendingRecovery(taskIds[0]));
  workReportTaskRegistryService.upsertTask(localRunningRecovery(taskIds[0]));
  workReportTaskRegistryService.upsertTask(localRunningRecovery(taskIds[1]));
  workReportTaskRegistryService.upsertTask(registryPendingRecovery(taskIds[1]));

  for (const taskId of taskIds) {
    const task = workReportTaskRegistryService.getTask(taskId);
    assert.equal(task?.status, "failed");
    assert.equal(task?.writeIndeterminate, true);
    assert.equal(task?.errorCode, "TASK_RECOVERED_AFTER_RESTART");
    assert.match(task?.errorMessage ?? "", /不可直接重送/);
  }
});

test("task registry failed 轉 success 時會清除舊錯誤", (t) => {
  const taskId = `registry-clear-error-${Date.now()}`;
  const registryInternals = workReportTaskRegistryService as unknown as {
    tasks: Map<string, WorkReportQueueTaskRecord>;
  };
  const mutableEnv = env as unknown as {
    WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED: boolean;
  };
  const previousPersistEnabled = mutableEnv.WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED;
  mutableEnv.WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED = false;

  t.after(() => {
    registryInternals.tasks.delete(taskId);
    mutableEnv.WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED = previousPersistEnabled;
  });

  workReportTaskRegistryService.upsertTask({
    taskId,
    taskType: "callback-refresh",
    status: "failed",
    formId: "104",
    entryId: "E-104",
    updatedAt: "2026-07-13T00:00:00.000Z",
    message: "callback refresh failed",
    errorCode: "CALLBACK_REFRESH_FAILED",
    errorMessage: "old callback failure",
  });

  workReportTaskRegistryService.upsertTask({
    taskId,
    taskType: "callback-refresh",
    status: "success",
    formId: "104",
    entryId: "E-104",
    updatedAt: "2026-07-13T00:00:01.000Z",
    finishedAt: "2026-07-13T00:00:01.000Z",
    message: "callback refresh success",
    errorCode: null,
    errorMessage: null,
  });

  const task = workReportTaskRegistryService.getTask(taskId);
  assert.equal(task?.status, "success");
  assert.equal(task?.errorCode, null);
  assert.equal(task?.errorMessage, null);
});

test("main-machine、close、reopen operation kind 會保存可辨識的任務名稱", async () => {
  const cases = [
    ["update-main-machine", "更新主表機台任務"],
    ["close-work-order", "人工結案工令任務"],
    ["reopen-work-order", "重新開啟工令任務"],
  ] as const;

  for (const [operationKind, expectedMessage] of cases) {
    const suffix = `${operationKind}-${Date.now()}`;
    const task = createReportTaskService.enqueue({
      taskType: "update-report",
      operationKind,
      formId: "104",
      entryId: `E-${suffix}`,
      queueKey: `104:E-${suffix}`,
      clientMutationId: `mutation-${suffix}`,
      operationFingerprint: `fingerprint-${suffix}`,
      worker: async () => ({}),
    });

    await waitForTaskStatus(task.taskId, "success");
    const registryTask = workReportTaskRegistryService.getTask(task.taskId);
    assert.equal(registryTask?.operationKind, operationKind);
    assert.match(registryTask?.message ?? "", new RegExp(`${expectedMessage}完成`));
  }
});

test("update worker 的 Ragic 5xx 寫入結果不明會禁止直接重送", async () => {
  const suffix = Date.now();
  const task = createReportTaskService.enqueue({
    taskType: "update-report",
    operationKind: "update-main-machine",
    formId: "104",
    entryId: `E-UPDATE-INDETERMINATE-${suffix}`,
    queueKey: `104:E-UPDATE-INDETERMINATE-${suffix}`,
    clientMutationId: `mutation-update-indeterminate-${suffix}`,
    operationFingerprint: `fingerprint-update-indeterminate-${suffix}`,
    worker: async () => {
      throw new HttpError(
        502,
        "更新 Ragic 紀錄失敗：Bad gateway",
        "RAGIC_WRITE_FAILED"
      );
    },
  });

  await waitForTaskStatus(task.taskId, "failed");
  const failedTask = createReportTaskService.getTask(task.taskId);
  assert.equal(failedTask?.writeIndeterminate, true);
  assert.equal(failedTask?.lifecycleState, "indeterminate");
  assert.equal(
    workReportTaskRegistryService.getTask(task.taskId)?.writeIndeterminate,
    true
  );
});

test("update 寫入後 verify 或回算未完成會標記 indeterminate", async () => {
  const errorCodes = [
    "RAGIC_WRITE_VERIFY_FAILED",
    "RAGIC_RECALCULATE_INCOMPLETE",
  ] as const;

  for (const errorCode of errorCodes) {
    const suffix = `${errorCode}-${Date.now()}`;
    const task = createReportTaskService.enqueue({
      taskType: "update-report",
      formId: "104",
      entryId: `E-${suffix}`,
      queueKey: `104:E-${suffix}`,
      clientMutationId: `mutation-${suffix}`,
      operationFingerprint: `fingerprint-${suffix}`,
      worker: async () => {
        throw new HttpError(502, `post-write outcome unknown: ${errorCode}`, errorCode);
      },
    });

    await waitForTaskStatus(task.taskId, "failed");
    const failedTask = createReportTaskService.getTask(task.taskId);
    assert.equal(failedTask?.writeIndeterminate, true);
    assert.equal(failedTask?.lifecycleState, "indeterminate");
  }
});

test("服務重啟時 running update task 會標記 Ragic 結果不明", async () => {
  const suffix = Date.now();
  const task = createReportTaskService.enqueue({
    taskType: "update-report",
    operationKind: "close-work-order",
    formId: "104",
    entryId: `E-UPDATE-RECOVERY-${suffix}`,
    queueKey: `104:E-UPDATE-RECOVERY-${suffix}`,
    clientMutationId: `mutation-update-recovery-${suffix}`,
    operationFingerprint: `fingerprint-update-recovery-${suffix}`,
    worker: async () => ({}),
  });
  await waitForTaskStatus(task.taskId, "success");

  const internals = createReportTaskService as unknown as {
    tasks: Map<string, CreateReportTask>;
    recoverInterruptedTasks: () => number;
  };
  const snapshot = createReportTaskService.getTask(task.taskId);
  assert.ok(snapshot);
  internals.tasks.set(task.taskId, {
    ...snapshot,
    status: "running",
    finishedAt: undefined,
    confirmedAt: undefined,
    writeIndeterminate: undefined,
    error: undefined,
  });

  assert.equal(internals.recoverInterruptedTasks(), 1);
  const recovered = createReportTaskService.getTask(task.taskId);
  assert.equal(recovered?.status, "failed");
  assert.equal(recovered?.writeIndeterminate, true);
  assert.equal(recovered?.lifecycleState, "indeterminate");
  assert.match(recovered?.error?.message ?? "", /不可直接重送/);
});

test("服務重啟時 Form16 running update freeze，尚未開始的 delete 可安全回滾", async () => {
  const suffix = Date.now();
  const updateTask = createReportTaskService.enqueue({
    taskType: "update-downtime",
    formId: "16",
    entryId: `E-DOWNTIME-UPDATE-${suffix}`,
    queueKey: "16:downtime:mutation",
    clientMutationId: `mutation-downtime-update-${suffix}`,
    operationFingerprint: `fingerprint-downtime-update-${suffix}`,
    worker: async () => ({}),
  });
  const deleteTask = createReportTaskService.enqueue({
    taskType: "delete-downtime",
    formId: "16",
    entryId: `E-DOWNTIME-DELETE-${suffix}`,
    queueKey: `16:downtime:delete-recovery:${suffix}`,
    clientMutationId: `mutation-downtime-delete-${suffix}`,
    operationFingerprint: `fingerprint-downtime-delete-${suffix}`,
    worker: async () => ({}),
  });
  await waitForTaskStatus(updateTask.taskId, "success");
  await waitForTaskStatus(deleteTask.taskId, "success");

  const internals = createReportTaskService as unknown as {
    tasks: Map<string, CreateReportTask>;
    recoverInterruptedTasks: () => number;
  };
  const updateSnapshot = createReportTaskService.getTask(updateTask.taskId);
  const deleteSnapshot = createReportTaskService.getTask(deleteTask.taskId);
  assert.ok(updateSnapshot);
  assert.ok(deleteSnapshot);
  internals.tasks.set(updateTask.taskId, {
    ...updateSnapshot,
    status: "running",
    finishedAt: undefined,
    confirmedAt: undefined,
    writeIndeterminate: undefined,
    error: undefined,
  });
  internals.tasks.set(deleteTask.taskId, {
    ...deleteSnapshot,
    status: "pending",
    startedAt: undefined,
    finishedAt: undefined,
    confirmedAt: undefined,
    writeIndeterminate: undefined,
    error: undefined,
  });

  assert.equal(internals.recoverInterruptedTasks(), 2);
  const recoveredUpdate = createReportTaskService.getTask(updateTask.taskId);
  const recoveredDelete = createReportTaskService.getTask(deleteTask.taskId);
  assert.equal(recoveredUpdate?.lifecycleState, "indeterminate");
  assert.equal(recoveredUpdate?.writeIndeterminate, true);
  assert.equal(recoveredUpdate?.confirmedAt, undefined);
  assert.equal(recoveredDelete?.lifecycleState, "failed");
  assert.equal(recoveredDelete?.writeIndeterminate, false);
  assert.ok(recoveredDelete?.confirmedAt);
});

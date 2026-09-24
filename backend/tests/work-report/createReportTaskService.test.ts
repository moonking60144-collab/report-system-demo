import test from "node:test";
import assert from "node:assert/strict";
import { AxiosError } from "axios";
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
import { HttpError, UpstreamError } from "../../src/utils/httpError";
import { workReportEntryMutationQueue } from "../../src/services/work-report/workReportEntryMutationQueue";
import { workReportMutationSyncCoordinator } from "../../src/services/work-report-sync/workReportMutationSyncCoordinator";
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
    formId: "901",
    entryId: "E-100",
    queueKey: "901:E-100",
    clientMutationId: "mutation-dup-001",
    operationFingerprint: "fingerprint-create-E-100",
    worker: async () => {
      callCount += 1;
      return { rowId: "R-1" };
    },
  });

  const secondTask = createReportTaskService.enqueue({
    formId: "901",
    entryId: "E-100",
    queueKey: "901:E-100",
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

test("entry-field task 無條件記錄 sync wait，並保留 Ragic 與 projection 分段 timing", async () => {
  const suffix = Date.now();
  const task = createReportTaskService.enqueue({
    taskType: "update-report",
    operationKind: "update-sort-order",
    formId: "901",
    entryId: `E-TIMING-${suffix}`,
    queueKey: `901:E-TIMING-${suffix}`,
    clientMutationId: `mutation-timing-${suffix}`,
    operationFingerprint: `fingerprint-timing-${suffix}`,
    worker: async () => ({
      writeStartedAt: "2026-08-31T01:00:00.000Z",
      mutationTimings: {
        currentReadMs: 10,
        writeMs: 20,
        verifyMs: 30,
        projectionEnqueueMs: 5,
      },
    }),
  });

  assert.deepEqual(task.timings, { syncWaitMs: 0 });
  await waitForTaskStatus(task.taskId, "success");

  const finishedTask = createReportTaskService.getTask(task.taskId);
  assert.equal(typeof finishedTask?.slotAcquiredAt, "string");
  assert.equal(finishedTask?.writeStartedAt, "2026-08-31T01:00:00.000Z");
  assert.deepEqual(finishedTask?.timings, {
    syncWaitMs: finishedTask?.timings?.syncWaitMs,
    entryQueueWaitMs: finishedTask?.timings?.entryQueueWaitMs,
    currentReadMs: 10,
    writeMs: 20,
    verifyMs: 30,
    projectionEnqueueMs: 5,
  });
  assert.equal(finishedTask?.timings?.syncWaitMs, 0);
  assert.ok((finishedTask?.timings?.entryQueueWaitMs ?? -1) >= 0);

  const registryTask = workReportTaskRegistryService.getTask(task.taskId);
  assert.equal(registryTask?.slotAcquiredAt, finishedTask?.slotAcquiredAt);
  assert.deepEqual(registryTask?.timings, finishedTask?.timings);
});

test("entry-field worker 失敗仍保留已完成 phase timing 與 failure phase", async () => {
  const suffix = Date.now();
  const task = createReportTaskService.enqueue({
    taskType: "update-report",
    operationKind: "update-urgent",
    formId: "901",
    entryId: `E-TIMING-FAILED-${suffix}`,
    queueKey: `901:E-TIMING-FAILED-${suffix}`,
    clientMutationId: `mutation-timing-failed-${suffix}`,
    operationFingerprint: `fingerprint-timing-failed-${suffix}`,
    worker: async (context) => {
      assert.ok(context);
      context.updateMutationTiming({
        writeStartedAt: "2026-09-01T02:00:00.000Z",
        mutationTimings: {
          currentReadMs: 11,
          currentReadLaneWaitMs: 2,
          currentReadUpstreamMs: 9,
          currentReadAttempts: 1,
          writeMs: 21,
          writeLaneWaitMs: 3,
          writeUpstreamMs: 18,
          writeAttempts: 1,
          verifyMs: 31,
          verifyLaneWaitMs: 4,
          verifyUpstreamMs: 27,
          verifyAttempts: 1,
        },
      });
      throw new HttpError(
        502,
        "Ragic write accepted but verify timed out",
        "RAGIC_WRITE_VERIFY_FAILED"
      );
    },
  });

  await waitForTaskStatus(task.taskId, "failed");
  const failedTask = createReportTaskService.getTask(task.taskId);
  assert.equal(failedTask?.lifecycleState, "indeterminate");
  assert.equal(failedTask?.writeStartedAt, "2026-09-01T02:00:00.000Z");
  assert.equal(failedTask?.timings?.failurePhase, "verify");
  assert.equal(failedTask?.timings?.currentReadAttempts, 1);
  assert.equal(failedTask?.timings?.writeAttempts, 1);
  assert.equal(failedTask?.timings?.verifyAttempts, 1);
  assert.deepEqual(
    workReportTaskRegistryService.getTask(task.taskId)?.timings,
    failedTask?.timings
  );
});

test("entry-field 寫入前 current-read timeout 是確定失敗且不阻擋安全重試", async () => {
  const suffix = Date.now();
  const entryId = `E-CURRENT-READ-TIMEOUT-${suffix}`;
  const failedTask = createReportTaskService.enqueue({
    taskType: "update-report",
    operationKind: "update-urgent",
    formId: "901",
    entryId,
    queueKey: `901:${entryId}`,
    clientMutationId: `mutation-current-read-timeout-${suffix}`,
    operationFingerprint: `fingerprint-current-read-timeout-${suffix}`,
    worker: async (context) => {
      assert.ok(context);
      context.updateMutationTiming({
        writeStartedAt: null,
        mutationTimings: {
          currentReadMs: 20_240,
          currentReadLaneWaitMs: 0,
          currentReadUpstreamMs: 20_018,
          currentReadAttempts: 2,
          writeMs: 0,
          writeLaneWaitMs: 0,
          writeUpstreamMs: 0,
          writeAttempts: 0,
          verifyMs: 0,
          verifyLaneWaitMs: 0,
          verifyUpstreamMs: 0,
          verifyAttempts: 0,
        },
      });
      throw new AxiosError(
        "timeout of 10000ms exceeded",
        "ECONNABORTED"
      );
    },
  });

  await waitForTaskStatus(failedTask.taskId, "failed");
  const terminalTask = createReportTaskService.getTask(failedTask.taskId);
  assert.equal(terminalTask?.timings?.failurePhase, "current-read");
  assert.equal(terminalTask?.writeIndeterminate, false);
  assert.equal(terminalTask?.lifecycleState, "failed");
  assert.equal(typeof terminalTask?.confirmedAt, "string");
  assert.equal(
    workReportTaskRegistryService.getTask(failedTask.taskId)?.writeIndeterminate,
    false
  );

  const retryTask = createReportTaskService.enqueue({
    taskType: "update-report",
    operationKind: "update-urgent",
    formId: "901",
    entryId,
    queueKey: `901:${entryId}`,
    clientMutationId: `mutation-current-read-retry-${suffix}`,
    operationFingerprint: `fingerprint-current-read-retry-${suffix}`,
    worker: async () => ({}),
  });
  await waitForTaskStatus(retryTask.taskId, "success");
});

test("worker 明確標記 projection failure 時不被既有 verify timing 覆蓋", async () => {
  const suffix = Date.now();
  const task = createReportTaskService.enqueue({
    taskType: "update-report",
    operationKind: "update-sort-order",
    formId: "901",
    entryId: `E-PROJECTION-FAILED-${suffix}`,
    queueKey: `901:E-PROJECTION-FAILED-${suffix}`,
    clientMutationId: `mutation-projection-failed-${suffix}`,
    operationFingerprint: `fingerprint-projection-failed-${suffix}`,
    worker: async (context) => {
      assert.ok(context);
      context.updateMutationTiming({
        mutationTimings: {
          currentReadMs: 5,
          currentReadAttempts: 1,
          writeMs: 6,
          writeAttempts: 1,
          verifyMs: 7,
          verifyAttempts: 1,
        },
      });
      context.markFailurePhase("projection");
      throw new Error("projection enqueue failed");
    },
  });

  await waitForTaskStatus(task.taskId, "failed");
  assert.equal(
    createReportTaskService.getTask(task.taskId)?.timings?.failurePhase,
    "projection"
  );
});

test("entry-field task 保留已驗證的 compact observation 供 settlement 重用", async () => {
  const suffix = Date.now();
  const entryId = `E-CONFIRMED-${suffix}`;
  const observedAt = "2026-09-01T01:00:00.000Z";
  const task = createReportTaskService.enqueue({
    taskType: "update-report",
    operationKind: "update-urgent",
    formId: "901",
    entryId,
    queueKey: `901:${entryId}`,
    clientMutationId: `mutation-confirmed-${suffix}`,
    operationFingerprint: `fingerprint-confirmed-${suffix}`,
    worker: async () => ({
      confirmedEntry: {
        entryId,
        operation: "work-report-urgent",
        observedAt,
        patch: { urgent: "Yes" },
      },
    }),
  });

  await waitForTaskStatus(task.taskId, "success");
  assert.deepEqual(createReportTaskService.getTask(task.taskId)?.result?.confirmedEntry, {
    entryId,
    operation: "work-report-urgent",
    observedAt,
    patch: { urgent: "Yes" },
  });
});

test("full-sync barrier 等待會寫入非零 syncWaitMs", async () => {
  const releaseSync = await workReportMutationSyncCoordinator.acquireSyncSlot();
  const suffix = Date.now();
  try {
    const task = createReportTaskService.enqueue({
      taskType: "update-report",
      operationKind: "update-sort-order",
      formId: "901",
      entryId: `E-SYNC-WAIT-${suffix}`,
      queueKey: `901:E-SYNC-WAIT-${suffix}`,
      clientMutationId: `mutation-sync-wait-${suffix}`,
      operationFingerprint: `fingerprint-sync-wait-${suffix}`,
      worker: async () => ({}),
    });

    await waitForTaskStatus(task.taskId, "running");
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseSync();
    await waitForTaskStatus(task.taskId, "success");

    const finishedTask = createReportTaskService.getTask(task.taskId);
    assert.ok((finishedTask?.timings?.syncWaitMs ?? 0) >= 5);
    assert.equal(typeof finishedTask?.slotAcquiredAt, "string");
  } catch (error) {
    releaseSync();
    throw error;
  }
});

test("create worker 寫入結果不明時同步到 registry，禁止前端把它視為安全重送", async () => {
  const task = createReportTaskService.enqueue({
    taskType: "create-report",
    formId: "901",
    entryId: `E-INDETERMINATE-${Date.now()}`,
    queueKey: `901:E-INDETERMINATE-${Date.now()}`,
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
    formId: "901",
    entryId: `E-DETERMINATE-${Date.now()}`,
    queueKey: `901:E-DETERMINATE-${Date.now()}`,
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

test("planned-end-date 寫入前舊值格式錯誤維持確定性 failed lifecycle", async () => {
  const suffix = Date.now();
  const task = createReportTaskService.enqueue({
    taskType: "update-report",
    operationKind: "update-planned-end-date",
    formId: "901",
    entryId: `E-DATE-UNPARSEABLE-${suffix}`,
    queueKey: `901:E-DATE-UNPARSEABLE-${suffix}`,
    clientMutationId: `mutation-date-unparseable-${suffix}`,
    operationFingerprint: `fingerprint-date-unparseable-${suffix}`,
    worker: async () => {
      throw new HttpError(
        502,
        "Ragic 目前的指定結束日期格式無法辨識，未執行寫入。",
        "RAGIC_PLANNED_END_DATE_UNPARSEABLE"
      );
    },
  });

  await waitForTaskStatus(task.taskId, "failed");
  const failedTask = createReportTaskService.getTask(task.taskId);
  assert.equal(failedTask?.writeIndeterminate, false);
  assert.equal(failedTask?.lifecycleState, "failed");
  assert.equal(
    workReportTaskRegistryService.getTask(task.taskId)?.writeIndeterminate,
    false
  );
});

test("update worker circuit breaker fast-fail 會保留 typed error code 到 registry", async () => {
  const task = createReportTaskService.enqueue({
    taskType: "update-report",
    formId: "901",
    entryId: `E-CIRCUIT-${Date.now()}`,
    queueKey: `901:E-CIRCUIT-${Date.now()}`,
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
    formId: "901",
    entryId: `E-SORT-${suffix}`,
    workOrderNo: `WO-SORT-${suffix}`,
    queueKey: `901:E-SORT-${suffix}`,
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

test("修改排序任務失敗時記錄完整 task、actor 與錯誤 context", async (t) => {
  const failureLogs: Array<[unknown, unknown]> = [];
  t.mock.method(console, "error", (label: unknown, detail: unknown) => {
    failureLogs.push([label, detail]);
  });
  const suffix = Date.now();
  const task = createReportTaskService.enqueue({
    taskType: "update-report",
    operationKind: "update-sort-order",
    formId: "901",
    entryId: `E-SORT-FAILED-${suffix}`,
    workOrderNo: "DEMO-100503",
    queueKey: `901:E-SORT-FAILED-${suffix}`,
    clientMutationId: `mutation-sort-failed-${suffix}`,
    operationFingerprint: `fingerprint-sort-failed-${suffix}`,
    actorClientId: "client-1",
    actorTabId: "tab-1",
    actorIp: "203.0.113.30",
    actorLabel: "生管工作站",
    worker: async () => {
      throw new UpstreamError(
        "Ragic 拒絕修改工令排序：必填欄位為空 (code: 202)",
        "RAGIC_WRITE_FAILED",
        {
          status: 400,
          ragicStatus: "ERROR",
          ragicCode: 202,
        }
      );
    },
  });

  await waitForTaskStatus(task.taskId, "failed");

  const failure = failureLogs.find(([label]) => label === "[create-task][failed]");
  assert.ok(failure);
  const logged = failure[1] as Record<string, unknown>;
  assert.equal(logged.taskId, task.taskId);
  assert.equal(logged.taskType, "update-report");
  assert.equal(logged.operationKind, "update-sort-order");
  assert.equal(logged.formId, "901");
  assert.equal(logged.entryId, `E-SORT-FAILED-${suffix}`);
  assert.equal(logged.workOrderNo, "DEMO-100503");
  assert.equal(logged.clientMutationId, `mutation-sort-failed-${suffix}`);
  assert.equal(logged.actorClientId, "client-1");
  assert.equal(logged.actorTabId, "tab-1");
  assert.equal(logged.actorIp, "203.0.113.30");
  assert.equal(logged.actorLabel, "生管工作站");
  assert.equal(logged.lifecycleState, "failed");
  assert.equal(logged.writeIndeterminate, false);
  assert.deepEqual(logged.error, {
    code: "RAGIC_WRITE_FAILED",
    message: "Ragic 拒絕修改工令排序：必填欄位為空 (code: 202)",
  });
});

test("排序 code 202 包裝後的 httpStatus 仍維持確定性 failed lifecycle", async () => {
  const suffix = Date.now();
  const task = createReportTaskService.enqueue({
    taskType: "update-report",
    operationKind: "update-sort-order",
    formId: "901",
    entryId: `E-SORT-CODE-202-${suffix}`,
    workOrderNo: "DEMO-100503",
    queueKey: `901:E-SORT-CODE-202-${suffix}`,
    clientMutationId: `mutation-sort-code-202-${suffix}`,
    operationFingerprint: `fingerprint-sort-code-202-${suffix}`,
    worker: async () => {
      throw new UpstreamError(
        "Ragic 拒絕修改工令排序：必填欄位為空 (code: 202)",
        "RAGIC_WRITE_FAILED",
        {
          httpStatus: 400,
          ragicStatus: "ERROR",
          ragicCode: 202,
        }
      );
    },
  });

  await waitForTaskStatus(task.taskId, "failed");

  const failedTask = createReportTaskService.getTask(task.taskId);
  assert.equal(failedTask?.lifecycleState, "failed");
  assert.equal(failedTask?.writeIndeterminate, false);
});

test("同工令已有 indeterminate 排程 mutation 時阻擋不同 clientMutationId", async () => {
  const suffix = Date.now();
  const entryId = `E-SCHEDULE-BLOCK-${suffix}`;
  const firstTask = createReportTaskService.enqueue({
    taskType: "update-report",
    operationKind: "update-sort-order",
    formId: "901",
    entryId,
    queueKey: `901:${entryId}`,
    clientMutationId: `mutation-schedule-first-${suffix}`,
    operationFingerprint: `fingerprint-schedule-first-${suffix}`,
    worker: async () => {
      throw new UpstreamError(
        "更新 Ragic 紀錄失敗：Bad gateway",
        "RAGIC_WRITE_FAILED",
        { status: 502 }
      );
    },
  });

  await waitForTaskStatus(firstTask.taskId, "failed");
  assert.equal(createReportTaskService.getTask(firstTask.taskId)?.lifecycleState, "indeterminate");

  assert.throws(
    () =>
      createReportTaskService.enqueue({
        taskType: "update-report",
        operationKind: "update-planned-end-date",
        formId: "901",
        entryId,
        queueKey: `901:${entryId}`,
        clientMutationId: `mutation-schedule-second-${suffix}`,
        operationFingerprint: `fingerprint-schedule-second-${suffix}`,
        worker: async () => ({ plannedEndDate: "2026-09-01" }),
      }),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.code, "SCHEDULE_MUTATION_PENDING_CONFIRMATION");
      return true;
    }
  );

  assert.equal(
    createReportTaskService.acknowledgeScheduleMutationObservation("901", entryId),
    1
  );
  assert.equal(
    createReportTaskService.getTask(firstTask.taskId)?.writeIndeterminate,
    false
  );
  const reconciledRetry = createReportTaskService.enqueue({
    taskType: "update-report",
    operationKind: "update-sort-order",
    formId: "901",
    entryId,
    queueKey: `901:${entryId}`,
    clientMutationId: `mutation-schedule-after-observation-${suffix}`,
    operationFingerprint: `fingerprint-schedule-after-observation-${suffix}`,
    worker: async () => ({ sortOrder: 12 }),
  });
  await waitForTaskStatus(reconciledRetry.taskId, "success");
});

test("同工令 generic row update 不阻擋新的 schedule mutation", async () => {
  const suffix = Date.now();
  const entryId = `E-ROW-NONBLOCK-${suffix}`;
  let releaseRowUpdate!: () => void;
  const rowWorkerGate = new Promise<void>((resolve) => {
    releaseRowUpdate = resolve;
  });
  const rowTask = createReportTaskService.enqueue({
    taskType: "update-report",
    operationKind: "update-report-row",
    formId: "901",
    entryId,
    queueKey: `901:${entryId}`,
    clientMutationId: `mutation-row-${suffix}`,
    operationFingerprint: `fingerprint-row-${suffix}`,
    worker: async () => {
      await rowWorkerGate;
      return { rowId: "R-1" };
    },
  });
  await waitForTaskStatus(rowTask.taskId, "running");

  const sortTask = createReportTaskService.enqueue({
    taskType: "update-report",
    operationKind: "update-sort-order",
    formId: "901",
    entryId,
    queueKey: `901:${entryId}`,
    clientMutationId: `mutation-sort-after-row-${suffix}`,
    operationFingerprint: `fingerprint-sort-after-row-${suffix}`,
    worker: async () => ({ sortOrder: 12 }),
  });

  assert.equal(sortTask.status, "pending");
  releaseRowUpdate();
  await waitForTaskStatus(rowTask.taskId, "success");
  await waitForTaskStatus(sortTask.taskId, "success");
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
        formId: "901",
        entryId: "shutdown-entry",
        queueKey: "901:shutdown-entry",
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
    formId: "901",
    entryId: "E-200",
    queueKey: "901:E-200",
    clientMutationId,
    operationFingerprint: "fingerprint-create-E-200",
    worker: async () => ({ rowId: "R-200" }),
  });

  assert.throws(
    () =>
      createReportTaskService.enqueue({
        formId: "901",
        entryId: "E-201",
        queueKey: "901:E-201",
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
    formId: "901",
    entryId: "E-LEGACY-TERMINAL",
    queueKey: "901:E-LEGACY-TERMINAL",
    clientMutationId,
    worker: async () => {
      workerCallCount += 1;
      return { rowId: "R-LEGACY-TERMINAL" };
    },
  });
  await waitForTaskStatus(firstTask.taskId, "success");

  const replayedTask = createReportTaskService.enqueue({
    formId: "901",
    entryId: "E-LEGACY-TERMINAL",
    queueKey: "901:E-LEGACY-TERMINAL",
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
    formId: "901",
    entryId: "E-LEGACY-RECOVERED",
    queueKey: "901:E-LEGACY-RECOVERED",
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
    formId: "901",
    entryId: "E-LEGACY-RECOVERED",
    queueKey: "901:E-LEGACY-RECOVERED",
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
    formId: "901",
    entryId: `E-RECOVERY-PENDING-${Date.now()}`,
    queueKey: `901:E-RECOVERY-PENDING-${Date.now()}`,
    clientMutationId: `mutation-recovery-pending-${Date.now()}`,
    worker: async () => ({ rowId: "R-RECOVERY-PENDING" }),
  });
  const runningTask = createReportTaskService.enqueue({
    taskType: "create-report",
    formId: "901",
    entryId: `E-RECOVERY-RUNNING-${Date.now()}`,
    queueKey: `901:E-RECOVERY-RUNNING-${Date.now()}`,
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
    formId: "901",
    entryId: "E-901",
    rowId: "R-success",
    queueKey: "901:E-901",
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
    formId: "901",
    entryId: "E-901",
    queueKey: "901:E-901",
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
    formId: "901",
    entryId: "E-RECOVERY-DRIFT",
    queueKey: "901:E-RECOVERY-DRIFT",
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
    formId: "901",
    entryId: "E-RECOVERY-DRIFT",
    queueKey: "901:E-RECOVERY-DRIFT",
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
    formId: "901",
    entryId: "E-901",
    updatedAt: "2026-07-13T00:00:00.000Z",
    message: "callback refresh failed",
    errorCode: "CALLBACK_REFRESH_FAILED",
    errorMessage: "old callback failure",
    timings: { syncWaitMs: 0, failurePhase: "projection" },
  });

  workReportTaskRegistryService.upsertTask({
    taskId,
    taskType: "callback-refresh",
    status: "success",
    formId: "901",
    entryId: "E-901",
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
  assert.equal(task?.timings?.failurePhase, undefined);
});

test("entry-field、close、reopen operation kind 會保存可辨識的任務名稱", async () => {
  const cases = [
    ["update-start-schedule", "修改開始排程狀態任務"],
    ["update-main-machine", "更新主表機台任務"],
    ["update-urgent", "修改急件狀態任務"],
    ["update-sort-order", "修改工令排序任務"],
    ["update-planned-end-date", "修改指定結束日期任務"],
    ["close-work-order", "人工結案工令任務"],
    ["reopen-work-order", "重新開啟工令任務"],
  ] as const;

  for (const [operationKind, expectedMessage] of cases) {
    const suffix = `${operationKind}-${Date.now()}`;
    const task = createReportTaskService.enqueue({
      taskType: "update-report",
      operationKind,
      formId: "901",
      entryId: `E-${suffix}`,
      queueKey: `901:E-${suffix}`,
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
    formId: "901",
    entryId: `E-UPDATE-INDETERMINATE-${suffix}`,
    queueKey: `901:E-UPDATE-INDETERMINATE-${suffix}`,
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

test("本站機台寫後驗證失敗保留有界目標與回讀值供任務診斷", async () => {
  const suffix = Date.now();
  const task = createReportTaskService.enqueue({
    taskType: "update-report", operationKind: "update-main-machine",
    formId: "901", entryId: `E-MACHINE-DIAG-${suffix}`, queueKey: `901:E-MACHINE-DIAG-${suffix}`,
    clientMutationId: `machine-diag-${suffix}`, operationFingerprint: `machine-diag-${suffix}`,
    worker: async () => { throw new UpstreamError("回讀值不一致", "RAGIC_WRITE_VERIFY_FAILED",
      { expectedMachineCode: "MA51", confirmedMachineCode: "MA52" }); },
  });
  await waitForTaskStatus(task.taskId, "failed");
  const expected = { expectedMachineCode: "MA51", confirmedMachineCode: "MA52" };
  assert.deepEqual(createReportTaskService.getTask(task.taskId)?.error?.mainMachineVerification, expected);
  assert.deepEqual(workReportTaskRegistryService.getTask(task.taskId)?.mainMachineVerification, expected);
  workReportTaskRegistryService.upsertTask({
    taskId: task.taskId,
    taskType: "update-report",
    status: "success",
    formId: "901",
    entryId: `E-MACHINE-DIAG-${suffix}`,
    updatedAt: new Date(Date.now() + 1).toISOString(),
  });
  assert.equal(workReportTaskRegistryService.getTask(task.taskId)?.mainMachineVerification, null);
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
      formId: "901",
      entryId: `E-${suffix}`,
      queueKey: `901:E-${suffix}`,
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
    formId: "901",
    entryId: `E-UPDATE-RECOVERY-${suffix}`,
    queueKey: `901:E-UPDATE-RECOVERY-${suffix}`,
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

test("服務重啟時 ActivityLog running update freeze，尚未開始的 delete 可安全回滾", async () => {
  const suffix = Date.now();
  const updateTask = createReportTaskService.enqueue({
    taskType: "update-downtime",
    formId: "903",
    entryId: `E-DOWNTIME-UPDATE-${suffix}`,
    queueKey: "903:downtime:mutation",
    clientMutationId: `mutation-downtime-update-${suffix}`,
    operationFingerprint: `fingerprint-downtime-update-${suffix}`,
    worker: async () => ({}),
  });
  const deleteTask = createReportTaskService.enqueue({
    taskType: "delete-downtime",
    formId: "903",
    entryId: `E-DOWNTIME-DELETE-${suffix}`,
    queueKey: `903:downtime:delete-recovery:${suffix}`,
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

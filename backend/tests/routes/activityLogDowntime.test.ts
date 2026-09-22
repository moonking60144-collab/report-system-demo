import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import activityLogDowntimeRouter from "../../src/routes/activityLogDowntime";
import { errorHandler } from "../../src/middleware/errorHandler";
import {
  activityLogDowntimeService,
  type ActivityLogDowntimeMutationOptions,
  type UpdateActivityLogDowntimeInput,
} from "../../src/services/activityLog/activityLogDowntimeService";
import { activityLogDowntimeCallbackRefreshService } from "../../src/services/activityLog/activityLogDowntimeCallbackRefreshService";
import {
  ACTIVITY_LOG_DOWNTIME_MUTATION_QUEUE_KEY,
  runActivityLogDowntimeMutationExclusive,
} from "../../src/services/activityLog/activityLogDowntimeMutationQueue";
import { getWorkReportEntryMutationQueueStats } from "../../src/services/work-report/workReportEntryMutationQueue";
import { workReportTaskRegistryService } from "../../src/services/work-report/workReportTaskRegistryService";
import type { ActivityLogDowntimeRecord } from "../../src/types/activityLogDowntime";
import {
  recordAuditLogRepository,
  type RecordAuditLogInsertInput,
} from "../../src/storage/sqlite/recordAuditLogRepository";

async function withTestServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use("/api", activityLogDowntimeRouter);
  app.use(errorHandler);

  const server = await new Promise<Server>((resolve) => {
    const nextServer = app.listen(0, () => resolve(nextServer));
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

async function waitForTask(
  baseUrl: string,
  taskId: string,
  expectedStatus: string
): Promise<{
  taskId: string;
  taskType: string;
  status: string;
  entryId: string | null;
  queueKey?: string | null;
  lifecycleState?: string;
  acceptedAt?: string | null;
  confirmedAt?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}> {
  let lastTask: {
    taskId: string;
    taskType: string;
    status: string;
    entryId: string | null;
    queueKey?: string | null;
    lifecycleState?: string;
    acceptedAt?: string | null;
    confirmedAt?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  } | null = null;
  for (let i = 0; i < 200; i += 1) {
    const taskResponse = await fetch(`${baseUrl}/api/downtime/tasks/${taskId}`);
    assert.equal(taskResponse.status, 200);
    const taskPayload = (await taskResponse.json()) as {
      data: {
        taskId: string;
        taskType: string;
        status: string;
        entryId: string | null;
        queueKey?: string | null;
        lifecycleState?: string;
        acceptedAt?: string | null;
        confirmedAt?: string | null;
        errorCode?: string | null;
        errorMessage?: string | null;
      };
    };
    if (taskPayload.data.status === expectedStatus) {
      return taskPayload.data;
    }
    lastTask = taskPayload.data;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `task ${taskId} did not reach ${expectedStatus}; last=${JSON.stringify(lastTask)}`
  );
}

async function waitForPendingMutationTasks(expectedMinimum: number): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (getWorkReportEntryMutationQueueStats().pendingTaskCount >= expectedMinimum) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`mutation queue pending task count did not reach ${expectedMinimum}`);
}

function percentile(values: number[], ratio: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)] ?? 0;
}

test("POST /api/downtime/records 回 pending taskId，不等待 Ragic mutation 完成", async (t) => {
  let resolveCreate: (() => void) | null = null;
  t.mock.method(
    activityLogDowntimeService,
    "createRecord",
    () =>
      new Promise<{ created: true; entryId: string }>((resolve) => {
        resolveCreate = () => resolve({ created: true, entryId: "123456" });
      })
  );

  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/downtime/records`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: "2026-06-30",
        machineId: "MB50",
        processCode: "A01",
        clientRowKey: "row-key-1",
      }),
    });
    const payload = (await response.json()) as {
      data: {
        taskId: string;
        status: string;
        lifecycleState: string;
        acceptedAt: string;
        confirmedAt: string | null;
      };
    };

    assert.equal(response.status, 202);
    assert.equal(payload.data.status, "pending");
    assert.equal(payload.data.lifecycleState, "accepted");
    assert.ok(payload.data.acceptedAt);
    assert.equal(payload.data.confirmedAt, null);

    const runningTask = await waitForTask(baseUrl, payload.data.taskId, "running");
    assert.equal(runningTask.entryId, null);
    assert.equal(runningTask.taskType, "create-downtime");
    assert.equal(runningTask.queueKey, ACTIVITY_LOG_DOWNTIME_MUTATION_QUEUE_KEY);
    assert.equal(runningTask.lifecycleState, "running");
    assert.equal(runningTask.acceptedAt, payload.data.acceptedAt);
    assert.equal(runningTask.confirmedAt, null);

    assert.ok(resolveCreate);
    resolveCreate();

    const successTask = await waitForTask(baseUrl, payload.data.taskId, "success");
    assert.equal(successTask.entryId, "123456");
    assert.equal(successTask.lifecycleState, "success");
    assert.equal(successTask.acceptedAt, payload.data.acceptedAt);
    assert.ok(successTask.confirmedAt);
  });
});

test("POST /api/downtime/records 缺 clientRowKey 時回 400", async () => {
  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/downtime/records`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: "2026-07-06",
        machineId: "MB50",
        processCode: "A03",
      }),
    });
    const payload = (await response.json()) as { error: { code: string; message: string } };

    assert.equal(response.status, 400);
    assert.equal(payload.error.code, "DOWNTIME_CLIENT_ROW_KEY_REQUIRED");
  });
});

test("POST /api/downtime/records 建立失敗時 task 會標 failed 並保留 Ragic 具體錯誤", async (t) => {
  t.mock.method(activityLogDowntimeService, "createRecord", async () => {
    throw new Error("Field demo_report_type contains empty value (code: 202)");
  });

  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/downtime/records`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: "2026-07-06",
        machineId: "MB50",
        processCode: "A03",
        clientRowKey: "row-key-failed",
      }),
    });
    const payload = (await response.json()) as { data: { taskId: string; status: string } };

    assert.equal(response.status, 202);
    assert.equal(payload.data.status, "pending");

    const failedTask = await waitForTask(baseUrl, payload.data.taskId, "failed");
    assert.equal(failedTask.entryId, null);
    assert.equal(failedTask.errorCode, "CREATE_DOWNTIME_FAILED");
    assert.match(
      String(failedTask.errorMessage ?? ""),
      /Field demo_report_type contains empty value \(code: 202\)/
    );
  });
});

test("POST /api/downtime/records 相同 clientRowKey 未完成時回同一個 task", async (t) => {
  let resolveCreate: (() => void) | null = null;
  let createCallCount = 0;
  t.mock.method(
    activityLogDowntimeService,
    "createRecord",
    () =>
      new Promise<{ created: true; entryId: string }>((resolve) => {
        createCallCount += 1;
        resolveCreate = () => resolve({ created: true, entryId: "123457" });
      })
  );

  await withTestServer(async (baseUrl) => {
    const body = {
      date: "2026-07-06",
      machineId: "MB50",
      processCode: "A03",
      clientRowKey: "row-key-dedup-route",
    };
    const firstResponse = await fetch(`${baseUrl}/api/downtime/records`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const firstPayload = (await firstResponse.json()) as {
      data: { taskId: string; status: string };
    };
    await waitForTask(baseUrl, firstPayload.data.taskId, "running");

    const secondResponse = await fetch(`${baseUrl}/api/downtime/records`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const secondPayload = (await secondResponse.json()) as {
      data: { taskId: string; status: string };
    };

    assert.equal(secondResponse.status, 202);
    assert.equal(secondPayload.data.taskId, firstPayload.data.taskId);
    assert.equal(createCallCount, 1);

    assert.ok(resolveCreate);
    resolveCreate();
    await waitForTask(baseUrl, firstPayload.data.taskId, "success");

    const completedRetryResponse = await fetch(`${baseUrl}/api/downtime/records`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const completedRetryPayload = (await completedRetryResponse.json()) as {
      data: {
        taskId: string;
        status: string;
        lifecycleState: string;
        acceptedAt: string | null;
        confirmedAt: string | null;
      };
    };
    assert.equal(completedRetryResponse.status, 202);
    assert.equal(completedRetryPayload.data.taskId, firstPayload.data.taskId);
    assert.equal(completedRetryPayload.data.status, "success");
    assert.equal(completedRetryPayload.data.lifecycleState, "success");
    assert.ok(completedRetryPayload.data.acceptedAt);
    assert.ok(completedRetryPayload.data.confirmedAt);
    assert.equal(createCallCount, 1);
  });
});

test("POST /api/downtime/records 同 clientRowKey failed 後可重送成新 task", async (t) => {
  let createCallCount = 0;
  t.mock.method(activityLogDowntimeService, "createRecord", async () => {
    createCallCount += 1;
    if (createCallCount === 1) {
      throw new Error("Ragic transient failure");
    }
    return { created: true, entryId: "123458" };
  });

  await withTestServer(async (baseUrl) => {
    const body = {
      date: "2026-07-06",
      machineId: "MA51",
      processCode: "A03",
      clientRowKey: "row-key-retry-route",
    };
    const firstResponse = await fetch(`${baseUrl}/api/downtime/records`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const firstPayload = (await firstResponse.json()) as {
      data: { taskId: string; status: string };
    };
    await waitForTask(baseUrl, firstPayload.data.taskId, "failed");

    const secondResponse = await fetch(`${baseUrl}/api/downtime/records`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const secondPayload = (await secondResponse.json()) as {
      data: { taskId: string; status: string };
    };

    assert.equal(secondResponse.status, 202);
    assert.notEqual(secondPayload.data.taskId, firstPayload.data.taskId);

    const successTask = await waitForTask(baseUrl, secondPayload.data.taskId, "success");
    assert.equal(successTask.entryId, "123458");
  });
});

test("PATCH /api/downtime/records/:entryId?async=1 先回 accepted，再由共用 barrier 執行 authoritative update", async (t) => {
  const clientMutationId = `downtime-update-${randomUUID()}`;
  let resolveUpdate: (() => void) | null = null;
  let receivedOptions: Record<string, unknown> | null = null;
  t.mock.method(recordAuditLogRepository, "insert", async () => undefined);
  t.mock.method(
    activityLogDowntimeService,
    "updateRecord",
    (
      _entryId: string,
      _patch: UpdateActivityLogDowntimeInput,
      options: ActivityLogDowntimeMutationOptions
    ) => {
      receivedOptions = options as Record<string, unknown>;
      return new Promise<{ id: string; beforeSnapshot: ActivityLogDowntimeRecord }>((resolve) => {
        resolveUpdate = () =>
          resolve({
            id: "123480",
            beforeSnapshot: {
              id: "123480",
              snapshotHash: "before-hash",
              date: "2026/08/12",
              machineId: "MB50",
              processCode: "A01",
              operatorId: null,
              operatorName: null,
              reportType: "PROC-A",
              startTime: "08:00",
              endTime: "17:00",
              breakTime: "1.00",
              plannedIdleMinutes: 480,
              remark: "before",
              workOrderNo: null,
            },
          });
      });
    }
  );

  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/downtime/records/123480?async=1`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-client-mutation-id": clientMutationId,
      },
      body: JSON.stringify({
        remark: "after",
        expectedSnapshotHash: "before-hash",
      }),
    });
    const payload = (await response.json()) as {
      data: {
        taskId: string;
        status: string;
        lifecycleState: string;
        acceptedAt: string;
        confirmedAt: string | null;
      };
    };

    assert.equal(response.status, 202);
    assert.ok(["pending", "running"].includes(payload.data.status));
    assert.ok(["accepted", "running"].includes(payload.data.lifecycleState));
    assert.ok(payload.data.acceptedAt);
    assert.equal(payload.data.confirmedAt, null);
    await waitForTask(baseUrl, payload.data.taskId, "running");
    assert.deepEqual(receivedOptions, {
      expectedSnapshotHash: "before-hash",
      deferProjection: true,
    });

    assert.ok(resolveUpdate);
    resolveUpdate();
    const terminal = await waitForTask(baseUrl, payload.data.taskId, "success");
    assert.equal(terminal.taskType, "update-downtime");
    assert.equal(terminal.lifecycleState, "success");
    assert.ok(terminal.confirmedAt);
  });
});

test("DELETE /api/downtime/records/:entryId?async=1 相同 mutation id 不會排入第二次刪除", async (t) => {
  const clientMutationId = `downtime-delete-${randomUUID()}`;
  let resolveDelete: (() => void) | null = null;
  let deleteCallCount = 0;
  t.mock.method(recordAuditLogRepository, "insert", async () => undefined);
  t.mock.method(
    activityLogDowntimeService,
    "deleteRecord",
    () => {
      deleteCallCount += 1;
      return new Promise<{ deleted: true; beforeSnapshot: ActivityLogDowntimeRecord }>((resolve) => {
        resolveDelete = () =>
          resolve({
            deleted: true,
            beforeSnapshot: {
              id: "123481",
              snapshotHash: "delete-hash",
              date: "2026/08/12",
              machineId: "MA51",
              processCode: "A01",
              operatorId: null,
              operatorName: null,
              reportType: "PROC-A",
              startTime: "08:00",
              endTime: "17:00",
              breakTime: "1.00",
              plannedIdleMinutes: 480,
              remark: null,
              workOrderNo: null,
            },
          });
      });
    }
  );

  await withTestServer(async (baseUrl) => {
    const sendDelete = () =>
      fetch(`${baseUrl}/api/downtime/records/123481?async=1`, {
        method: "DELETE",
        headers: {
          "x-client-mutation-id": clientMutationId,
          "x-downtime-snapshot-hash": "delete-hash",
        },
      });
    const firstResponse = await sendDelete();
    const firstPayload = (await firstResponse.json()) as { data: { taskId: string } };
    await waitForTask(baseUrl, firstPayload.data.taskId, "running");
    const secondResponse = await sendDelete();
    const secondPayload = (await secondResponse.json()) as { data: { taskId: string } };

    assert.equal(firstResponse.status, 202);
    assert.equal(secondResponse.status, 202);
    assert.equal(secondPayload.data.taskId, firstPayload.data.taskId);
    assert.equal(deleteCallCount, 1);

    assert.ok(resolveDelete);
    resolveDelete();
    const terminal = await waitForTask(baseUrl, firstPayload.data.taskId, "success");
    assert.equal(terminal.taskType, "delete-downtime");
  });
});

test("ActivityLog async route 的受控 accepted latency 不等待 terminal worker", async (t) => {
  let releaseFirstWorker: () => void = () => {
    throw new Error("first ActivityLog latency worker has not started");
  };
  let workerCallCount = 0;
  t.mock.method(recordAuditLogRepository, "insert", async () => undefined);
  t.mock.method(activityLogDowntimeService, "updateRecord", async (entryId: string) => {
    workerCallCount += 1;
    if (workerCallCount === 1) {
      await new Promise<void>((resolve) => {
        releaseFirstWorker = resolve;
      });
    }
    return {
      id: entryId,
      beforeSnapshot: {
        id: entryId,
        snapshotHash: "latency-hash",
        date: "2026/08/12",
        machineId: "MB50",
        processCode: "A01",
        operatorId: null,
        operatorName: null,
        reportType: "PROC-A",
        startTime: "08:00",
        endTime: "17:00",
        breakTime: "1.00",
        plannedIdleMinutes: 480,
        remark: "latency",
        workOrderNo: null,
      },
    };
  });

  const samples: number[] = [];
  let lastTaskId = "";
  await withTestServer(async (baseUrl) => {
    for (let index = 0; index < 20; index += 1) {
      const startedAt = performance.now();
      const response = await fetch(`${baseUrl}/api/downtime/records/123490?async=1`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "x-client-mutation-id": `downtime-latency-${randomUUID()}`,
        },
        body: JSON.stringify({
          remark: `latency-${index}`,
          expectedSnapshotHash: "latency-hash",
        }),
      });
      samples.push(performance.now() - startedAt);
      assert.equal(response.status, 202);
      const payload = (await response.json()) as { data: { taskId: string } };
      lastTaskId = payload.data.taskId;
    }

    assert.equal(workerCallCount, 1);
    const p50 = percentile(samples, 0.5);
    const p95 = percentile(samples, 0.95);
    console.info("[accepted-latency][activityLog-mock-http]", {
      samples: samples.length,
      p50Ms: Number(p50.toFixed(2)),
      p95Ms: Number(p95.toFixed(2)),
    });
    assert.ok(p50 < 500, `controlled accepted p50 ${p50}ms should stay below 500ms`);
    assert.ok(p95 < 1000, `controlled accepted p95 ${p95}ms should stay below 1000ms`);

    releaseFirstWorker();
    await waitForTask(baseUrl, lastTaskId, "success");
  });
});

test("activity log create 與同步 update 共用同一個 mutation barrier", async (t) => {
  let resolveCreate: (() => void) | null = null;
  let updateStarted = false;
  t.mock.method(recordAuditLogRepository, "insert", async () => undefined);
  t.mock.method(
    activityLogDowntimeService,
    "createRecord",
    () =>
      new Promise<{ created: true; entryId: string }>((resolve) => {
        resolveCreate = () => resolve({ created: true, entryId: "123470" });
      })
  );
  t.mock.method(activityLogDowntimeService, "updateRecord", async () => {
    updateStarted = true;
    return {
      id: "123470",
      beforeSnapshot: {
        id: "123470",
        snapshotHash: null,
        date: "2026/07/20",
        machineId: "MB50",
        processCode: "A01",
        operatorId: null,
        operatorName: null,
        reportType: null,
        startTime: null,
        endTime: null,
        breakTime: null,
        plannedIdleMinutes: 480,
        remark: null,
        workOrderNo: null,
      },
    };
  });

  await withTestServer(async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/api/downtime/records`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: "2026-07-20",
        machineId: "MB50",
        processCode: "A01",
        clientRowKey: "row-key-shared-mutation-barrier",
      }),
    });
    const createPayload = (await createResponse.json()) as {
      data: { taskId: string };
    };
    await waitForTask(baseUrl, createPayload.data.taskId, "running");

    const updateResponsePromise = fetch(`${baseUrl}/api/downtime/records/123470`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remark: "queued update" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(updateStarted, false);

    assert.ok(resolveCreate);
    resolveCreate();
    await waitForTask(baseUrl, createPayload.data.taskId, "success");

    const updateResponse = await updateResponsePromise;
    assert.equal(updateResponse.status, 200);
    assert.equal(updateStarted, true);
  });
});

test("activity log update 與 delete 在同一個 mutation barrier 依序執行", async (t) => {
  let releaseBlocker: (() => void) | null = null;
  const executionOrder: string[] = [];
  t.mock.method(recordAuditLogRepository, "insert", async () => undefined);
  const blocker = runActivityLogDowntimeMutationExclusive(
    () =>
      new Promise<void>((resolve) => {
        releaseBlocker = resolve;
      })
  );
  t.mock.method(activityLogDowntimeService, "updateRecord", async () => {
    executionOrder.push("update");
    return {
      id: "123471",
      beforeSnapshot: {
        id: "123471",
        snapshotHash: null,
        date: "2026/07/20",
        machineId: "MB50",
        processCode: "A01",
        operatorId: null,
        operatorName: null,
        reportType: null,
        startTime: null,
        endTime: null,
        breakTime: null,
        plannedIdleMinutes: 480,
        remark: null,
        workOrderNo: null,
      },
    };
  });
  t.mock.method(activityLogDowntimeService, "deleteRecord", async () => {
    executionOrder.push("delete");
    return {
      deleted: true as const,
      beforeSnapshot: {
        id: "123471",
        snapshotHash: null,
        date: "2026/07/20",
        machineId: "MB50",
        processCode: "A01",
        operatorId: null,
        operatorName: null,
        reportType: null,
        startTime: null,
        endTime: null,
        breakTime: null,
        plannedIdleMinutes: 480,
        remark: null,
        workOrderNo: null,
      },
    };
  });

  await withTestServer(async (baseUrl) => {
    const updateResponsePromise = fetch(`${baseUrl}/api/downtime/records/123471`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remark: "first" }),
    });
    await waitForPendingMutationTasks(2);
    const deleteResponsePromise = fetch(`${baseUrl}/api/downtime/records/123471`, {
      method: "DELETE",
    });
    await waitForPendingMutationTasks(3);
    assert.deepEqual(executionOrder, []);

    assert.ok(releaseBlocker);
    releaseBlocker();
    await blocker;

    const [updateResponse, deleteResponse] = await Promise.all([
      updateResponsePromise,
      deleteResponsePromise,
    ]);
    assert.equal(updateResponse.status, 200);
    assert.equal(deleteResponse.status, 200);
    const updatePayload = (await updateResponse.json()) as {
      data: {
        lifecycleState: string;
        acceptedAt: string;
        confirmedAt: string | null;
      };
    };
    const deletePayload = (await deleteResponse.json()) as {
      data: {
        lifecycleState: string;
        acceptedAt: string;
        confirmedAt: string | null;
      };
    };
    assert.equal(updatePayload.data.lifecycleState, "success");
    assert.ok(updatePayload.data.acceptedAt);
    assert.ok(updatePayload.data.confirmedAt);
    assert.equal(deletePayload.data.lifecycleState, "success");
    assert.ok(deletePayload.data.acceptedAt);
    assert.ok(deletePayload.data.confirmedAt);
    assert.deepEqual(executionOrder, ["update", "delete"]);
  });
});

test("activity log update audit 使用 worker 內即時讀到的 mutation preimage", async (t) => {
  const authoritativeBeforeSnapshot = {
    id: "123472",
    snapshotHash: null,
    date: "2026/07/20",
    machineId: "P12",
    processCode: "A01",
    operatorId: null,
    operatorName: null,
    reportType: "PROC-A",
    startTime: "08:00",
    endTime: "17:00",
    breakTime: "1.00",
    plannedIdleMinutes: 480,
    remark: "authoritative-before",
    workOrderNo: null,
  };
  let auditInput: RecordAuditLogInsertInput | null = null;
  t.mock.method(activityLogDowntimeService, "updateRecord", async () => ({
    id: "123472",
    beforeSnapshot: authoritativeBeforeSnapshot,
  }));
  t.mock.method(recordAuditLogRepository, "insert", async (input: RecordAuditLogInsertInput) => {
    auditInput = input;
  });

  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/downtime/records/123472`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remark: "after" }),
    });

    assert.equal(response.status, 200);
    assert.ok(auditInput);
    assert.deepEqual(auditInput.beforeSnapshot, authoritativeBeforeSnapshot);
    assert.deepEqual(auditInput.afterPatch, {
      date: undefined,
      machineId: undefined,
      processCode: undefined,
      operatorId: undefined,
      plannedIdleMinutes: undefined,
      remark: "after",
    });
  });
});

test("GET /api/downtime/tasks 可依 actorClientId 列出 downtime tasks", async (t) => {
  t.mock.method(activityLogDowntimeService, "createRecord", async () => ({
    created: true,
    entryId: "123459",
  }));

  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/downtime/records`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-debug-client-id": "client-downtime-task-list",
      },
      body: JSON.stringify({
        date: "2026-07-06",
        machineId: "P12",
        processCode: "A03",
        clientRowKey: "row-key-list-route",
      }),
    });
    const payload = (await response.json()) as { data: { taskId: string; status: string } };
    await waitForTask(baseUrl, payload.data.taskId, "success");

    const listResponse = await fetch(
      `${baseUrl}/api/downtime/tasks?actorClientId=client-downtime-task-list&taskType=create-downtime`
    );
    const listPayload = (await listResponse.json()) as {
      data: Array<{ taskId: string; taskType: string; entryId: string | null }>;
    };

    assert.equal(listResponse.status, 200);
    assert.ok(listPayload.data.some((task) => task.taskId === payload.data.taskId));
  });
});

test("GET /api/downtime/tasks 預設只看本機，scope=all 可列出全部 actor", async (t) => {
  let createIndex = 0;
  t.mock.method(activityLogDowntimeService, "createRecord", async () => ({
    created: true,
    entryId: `12346${(createIndex += 1)}`,
  }));

  await withTestServer(async (baseUrl) => {
    const postTask = async (actorClientId: string, clientRowKey: string) => {
      const response = await fetch(`${baseUrl}/api/downtime/records`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-debug-client-id": actorClientId,
        },
        body: JSON.stringify({
          date: "2026-07-06",
          machineId: "P12",
          processCode: "A03",
          clientRowKey,
        }),
      });
      const payload = (await response.json()) as {
        data: { taskId: string; status: string };
      };
      assert.equal(response.status, 202);
      await waitForTask(baseUrl, payload.data.taskId, "success");
      return payload.data.taskId;
    };

    const ownTaskId = await postTask(
      "client-downtime-default-list-own",
      "row-key-default-list-own"
    );
    const otherTaskId = await postTask(
      "client-downtime-default-list-other",
      "row-key-default-list-other"
    );

    const ownListResponse = await fetch(
      `${baseUrl}/api/downtime/tasks?taskType=create-downtime`,
      {
        headers: { "x-debug-client-id": "client-downtime-default-list-own" },
      }
    );
    const ownListPayload = (await ownListResponse.json()) as {
      data: Array<{ taskId: string; actorClientId: string | null }>;
      meta: { actorClientId: string | null; scope: string };
    };

    assert.equal(ownListResponse.status, 200);
    assert.equal(ownListPayload.meta.scope, "mine");
    assert.equal(ownListPayload.meta.actorClientId, "client-downtime-default-list-own");
    assert.ok(ownListPayload.data.some((task) => task.taskId === ownTaskId));
    assert.equal(
      ownListPayload.data.some((task) => task.taskId === otherTaskId),
      false
    );
    assert.ok(
      ownListPayload.data.every(
        (task) => task.actorClientId === "client-downtime-default-list-own"
      )
    );

    const noActorListResponse = await fetch(
      `${baseUrl}/api/downtime/tasks?taskType=create-downtime`
    );
    const noActorListPayload = (await noActorListResponse.json()) as {
      data: Array<{ taskId: string }>;
      meta: { actorClientId: string | null; scope: string };
    };

    assert.equal(noActorListResponse.status, 200);
    assert.equal(noActorListPayload.meta.scope, "mine");
    assert.equal(noActorListPayload.meta.actorClientId, null);
    assert.deepEqual(noActorListPayload.data, []);

    const allListResponse = await fetch(
      `${baseUrl}/api/downtime/tasks?taskType=create-downtime&scope=all`,
      {
        headers: { "x-debug-client-id": "client-downtime-default-list-own" },
      }
    );
    const allListPayload = (await allListResponse.json()) as {
      data: Array<{ taskId: string; actorClientId: string | null }>;
      meta: { actorClientId: string | null; scope: string };
    };

    assert.equal(allListResponse.status, 200);
    assert.equal(allListPayload.meta.scope, "all");
    assert.equal(allListPayload.meta.actorClientId, "client-downtime-default-list-own");
    assert.ok(allListPayload.data.some((task) => task.taskId === ownTaskId));
    assert.ok(allListPayload.data.some((task) => task.taskId === otherTaskId));
    assert.ok(
      allListPayload.data.some(
        (task) => task.actorClientId === "client-downtime-default-list-other"
      )
    );

    const invalidScopeResponse = await fetch(
      `${baseUrl}/api/downtime/tasks?scope=everyone`,
      { headers: { "x-debug-client-id": "client-downtime-default-list-own" } }
    );
    const invalidScopePayload = (await invalidScopeResponse.json()) as {
      error: { code: string };
    };
    assert.equal(invalidScopeResponse.status, 400);
    assert.equal(invalidScopePayload.error.code, "TASK_SCOPE_INVALID");
  });
});

test("POST /api/forms/903/ragic-callback 在 shutdown admission 關閉後回 503 且不建立 task", async () => {
  const previousToken = process.env.RAGIC_CALLBACK_TOKEN;
  process.env.RAGIC_CALLBACK_TOKEN = "activityLog-callback-shutdown-test";
  const entryId = "1600000001";
  const beforeCount = workReportTaskRegistryService.listTasks({
    formId: "903",
    entryId,
    taskType: "callback-refresh",
    limit: 200,
  }).length;
  activityLogDowntimeCallbackRefreshService.closeAdmission();

  try {
    await withTestServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/forms/903/ragic-callback`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-ragic-callback-token": "activityLog-callback-shutdown-test",
        },
        body: JSON.stringify({
          entryId,
          eventType: "entry-updated",
          source: "test",
        }),
      });
      const payload = (await response.json()) as {
        error: { code: string };
      };

      assert.equal(response.status, 503);
      assert.equal(payload.error.code, "RAGIC_CALLBACK_QUEUE_CLOSED");
    });

    const afterCount = workReportTaskRegistryService.listTasks({
      formId: "903",
      entryId,
      taskType: "callback-refresh",
      limit: 200,
    }).length;
    assert.equal(afterCount, beforeCount);
  } finally {
    if (previousToken === undefined) {
      delete process.env.RAGIC_CALLBACK_TOKEN;
    } else {
      process.env.RAGIC_CALLBACK_TOKEN = previousToken;
    }
  }
});

for (const useAsync of [false, true]) {
  test(`ActivityLog ${useAsync ? "背景" : "同步"} route 保留 sparse 欄位原值`, async (t) => {
    t.mock.method(recordAuditLogRepository, "insert", async () => undefined);
    const update = t.mock.method(activityLogDowntimeService, "updateRecord", async (_id: string, patch: UpdateActivityLogDowntimeInput, options: Parameters<typeof activityLogDowntimeService.updateRecord>[2]) => {
      assert.equal(patch.remark, "after");
      assert.equal(patch.machineId, undefined);
      assert.deepEqual(options?.expectedValues, { remark: "before" });
      assert.equal(options?.fieldPreconditionVersion, 1);
      return { id: "123490", beforeSnapshot: { id: "123490" } as ActivityLogDowntimeRecord };
    });
    await withTestServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/downtime/records/123490${useAsync ? "?async=1" : ""}`, {
        method: "PATCH", headers: { "Content-Type": "application/json", "x-client-mutation-id": randomUUID() },
        body: JSON.stringify({ remark: "after", fieldPreconditionVersion: 1, expectedValues: { remark: "before" } }),
      });
      assert.equal(response.status, useAsync ? 202 : 200);
      if (useAsync) await waitForTask(baseUrl, (await response.json()).data.taskId, "success");
      assert.equal(update.mock.callCount(), 1);
      const invalid = await fetch(`${baseUrl}/api/downtime/records/123490`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remark: "after", fieldPreconditionVersion: 1 }),
      });
      assert.equal(invalid.status, 400);
      assert.equal(update.mock.callCount(), 1);
    });
  });
}

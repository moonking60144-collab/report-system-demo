import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import form16DowntimeRouter from "../../src/routes/form16Downtime";
import { errorHandler } from "../../src/middleware/errorHandler";
import { form16DowntimeService } from "../../src/services/form16/form16DowntimeService";

async function withTestServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use("/api", form16DowntimeRouter);
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
  errorCode?: string | null;
  errorMessage?: string | null;
}> {
  let lastTask: {
    taskId: string;
    taskType: string;
    status: string;
    entryId: string | null;
    queueKey?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  } | null = null;
  for (let i = 0; i < 20; i += 1) {
    const taskResponse = await fetch(`${baseUrl}/api/downtime/tasks/${taskId}`);
    assert.equal(taskResponse.status, 200);
    const taskPayload = (await taskResponse.json()) as {
      data: {
        taskId: string;
        taskType: string;
        status: string;
        entryId: string | null;
        queueKey?: string | null;
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

test("POST /api/downtime/records 回 pending taskId，不等待 Ragic mutation 完成", async (t) => {
  let resolveCreate: (() => void) | null = null;
  t.mock.method(
    form16DowntimeService,
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
        machineId: "P10",
        processCode: "TI01",
        clientRowKey: "row-key-1",
      }),
    });
    const payload = (await response.json()) as { data: { taskId: string; status: string } };

    assert.equal(response.status, 202);
    assert.equal(payload.data.status, "pending");

    const runningTask = await waitForTask(baseUrl, payload.data.taskId, "running");
    assert.equal(runningTask.entryId, null);
    assert.equal(runningTask.taskType, "create-downtime");
    assert.equal(runningTask.queueKey, "16:downtime:create");

    assert.ok(resolveCreate);
    resolveCreate();

    const successTask = await waitForTask(baseUrl, payload.data.taskId, "success");
    assert.equal(successTask.entryId, "123456");
  });
});

test("POST /api/downtime/records 缺 clientRowKey 時回 400", async () => {
  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/downtime/records`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: "2026-07-06",
        machineId: "P10",
        processCode: "BU01",
      }),
    });
    const payload = (await response.json()) as { error: { code: string; message: string } };

    assert.equal(response.status, 400);
    assert.equal(payload.error.code, "DOWNTIME_CLIENT_ROW_KEY_REQUIRED");
  });
});

test("POST /api/downtime/records 建立失敗時 task 會標 failed 並保留 Ragic 具體錯誤", async (t) => {
  t.mock.method(form16DowntimeService, "createRecord", async () => {
    throw new Error("Field Type報工類別 contains empty value (code: 202)");
  });

  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/downtime/records`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: "2026-07-06",
        machineId: "P10",
        processCode: "BU01",
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
      /Field Type報工類別 contains empty value \(code: 202\)/
    );
  });
});

test("POST /api/downtime/records 相同 clientRowKey 未完成時回同一個 task", async (t) => {
  let resolveCreate: (() => void) | null = null;
  let createCallCount = 0;
  t.mock.method(
    form16DowntimeService,
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
      machineId: "P10",
      processCode: "BU01",
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
  });
});

test("POST /api/downtime/records 同 clientRowKey failed 後可重送成新 task", async (t) => {
  let createCallCount = 0;
  t.mock.method(form16DowntimeService, "createRecord", async () => {
    createCallCount += 1;
    if (createCallCount === 1) {
      throw new Error("Ragic transient failure");
    }
    return { created: true, entryId: "123458" };
  });

  await withTestServer(async (baseUrl) => {
    const body = {
      date: "2026-07-06",
      machineId: "P11",
      processCode: "BU01",
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

test("GET /api/downtime/tasks 可依 actorClientId 列出 downtime tasks", async (t) => {
  t.mock.method(form16DowntimeService, "createRecord", async () => ({
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
        processCode: "BU01",
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

test("GET /api/downtime/tasks 預設依 request actorClientId 過濾，不支援 allActors 查全部", async (t) => {
  let createIndex = 0;
  t.mock.method(form16DowntimeService, "createRecord", async () => ({
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
          processCode: "BU01",
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
      meta: { actorClientId: string | null };
    };

    assert.equal(ownListResponse.status, 200);
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
      meta: { actorClientId: string | null };
    };

    assert.equal(noActorListResponse.status, 200);
    assert.equal(noActorListPayload.meta.actorClientId, null);
    assert.deepEqual(noActorListPayload.data, []);

    const bypassListResponse = await fetch(
      `${baseUrl}/api/downtime/tasks?taskType=create-downtime&allActors=1`,
      {
        headers: { "x-debug-client-id": "client-downtime-default-list-own" },
      }
    );
    const bypassListPayload = (await bypassListResponse.json()) as {
      data: Array<{ taskId: string; actorClientId: string | null }>;
      meta: { actorClientId: string | null };
    };

    assert.equal(bypassListResponse.status, 200);
    assert.equal(bypassListPayload.meta.actorClientId, "client-downtime-default-list-own");
    assert.ok(bypassListPayload.data.some((task) => task.taskId === ownTaskId));
    assert.equal(
      bypassListPayload.data.some((task) => task.taskId === otherTaskId),
      false
    );
    assert.ok(
      bypassListPayload.data.every(
        (task) => task.actorClientId === "client-downtime-default-list-own"
      )
    );
  });
});

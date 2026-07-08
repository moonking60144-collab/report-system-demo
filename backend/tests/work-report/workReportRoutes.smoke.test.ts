import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { errorHandler } from "../../src/middleware/errorHandler";
import { HttpError } from "../../src/utils/httpError";
import {
  createWorkReportRouter,
  type WorkReportRouterDeps,
} from "../../src/routes/workReportRouterFactory";
import type { WorkReportQueueTaskRecord } from "../../src/services/work-report/workReportTaskRegistryService";
import { workReportEditingPresenceService } from "../../src/services/workReportEditingPresenceService";

function createDeps(): WorkReportRouterDeps {
  return {
    requestSync: async (_formId, _options) => ({ accepted: true }),
    listTasks: (_options) => [],
    getTaskRecord: (_taskId) => null,
    getSyncStatus: async (_formId) => null,
    getReports: async (_formId, _query) => ({ data: [], count: 0, totalCount: 0, hasMore: false }),
    getFullReports: async (_formId, _options) => ({ data: [], meta: {} }),
    getReportFacets: async (_formId, _fields, _query) => ({}),
    getReportAnalysis: async (_formId, _query) => ({}),
    getFormOptions: async (_formId, _fields) => ({}),
    getRawPreview: async (_formId, _limit) => [],
    getReportByEntryId: async (_formId, _entryId, _options) => null,
    createReport: async (_formId, _entryId, _payload, _options) => ({ rowId: "" }),
    assertCreateEntryAcceptsReports: async (_formId, _entryId) => {},
    enqueueCreateTask: (_input) => ({
      taskId: "task",
      status: "pending",
      createdAt: "2026-03-09T00:00:00.000Z",
      accepted: true,
    }),
    getCreateTask: (_taskId) => null,
    requestBatchCreate: async (_input) => ({
      taskId: "batch-create-task",
      status: "pending",
      createdAt: "2026-03-30T00:00:00.000Z",
      requestedCount: 2,
    }),
    requestBatchCreateFinalizeRetry: async (_input) => ({
      taskId: "batch-create-finalize-retry-task",
      status: "pending",
      createdAt: "2026-03-30T00:00:00.000Z",
      requestedCount: 2,
    }),
    requestBatchDelete: async (_input) => ({
      taskId: "batch-delete-task",
      status: "pending",
      createdAt: "2026-03-30T00:00:00.000Z",
      requestedCount: 2,
    }),
    updateReport: async (_formId, _entryId, _rowId, _payload, _options) => ({ rowId: "" }),
    updateMainMachine: async (_formId, _entryId, machineCode, _options) => ({ machineCode }),
    manualCloseWorkOrder: async (_formId, _entryId, action, _options) => ({ action }),
    deleteReport: async (_formId, _entryId, _rowId, _options) => ({ rowId: "" }),
    assertEntryNotModified: async (_formId, _entryId, _expectedEntryLastUpdatedAt) => {},
    assertEntryEditableBySession: async (_input) => {},
    assertEntryLockVersion: async (_input) => {},
    upsertEditingPresence: async (_input) => ({
      hasOtherEditors: false,
      otherEditorCount: 0,
      observedAt: "2026-03-19T00:00:00.000Z",
      canEdit: true,
      isCurrentSessionOwner: true,
    }),
    getEditingPresenceSnapshot: async (_input) => ({
      hasOtherEditors: false,
      otherEditorCount: 0,
      observedAt: "2026-03-19T00:00:00.000Z",
      canEdit: true,
      isCurrentSessionOwner: true,
    }),
    requestRagicCallbackRefresh: async (input) => ({
      accepted: true,
      taskId: `callback-${input.formId}-${input.entryId}`,
      status: "pending",
      createdAt: "2026-03-17T00:00:00.000Z",
    }),
    projectSqliteAfterMutation: async (_formId, _entryId, _reason) => {},
  };
}

async function withTestServer(
  deps: ReturnType<typeof createDeps>,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use("/api/forms", createWorkReportRouter(deps));
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
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

function createRegistryTask(
  overrides: Partial<WorkReportQueueTaskRecord> & Pick<WorkReportQueueTaskRecord, "taskId">
): WorkReportQueueTaskRecord {
  return {
    taskId: overrides.taskId,
    taskType: overrides.taskType ?? "create-report",
    status: overrides.status ?? "pending",
    formId: overrides.formId ?? "104",
    workOrderNo: overrides.workOrderNo ?? "WO-104",
    entryId: overrides.entryId ?? "E-104",
    rowId: overrides.rowId ?? null,
    queueKey: overrides.queueKey ?? "104:E-104",
    createdAt: overrides.createdAt ?? "2026-07-06T10:00:00.000Z",
    startedAt: overrides.startedAt ?? null,
    finishedAt: overrides.finishedAt ?? null,
    updatedAt: overrides.updatedAt ?? "2026-07-06T10:00:00.000Z",
    message: overrides.message ?? null,
    errorCode: overrides.errorCode ?? null,
    errorMessage: overrides.errorMessage ?? null,
    actorClientId: overrides.actorClientId ?? null,
    actorTabId: overrides.actorTabId ?? null,
    actorIp: overrides.actorIp ?? null,
    actorLabel: overrides.actorLabel ?? null,
    source: overrides.source ?? null,
  };
}

test("GET /api/forms/105/reports/:entryId?refresh=1 會走 detail refresh 讀取並允許 UI fallback", async (t) => {
  const deps = createDeps();
  deps.getReportByEntryId = async (
    formId: string,
    entryId: string,
    options?: {
      refresh?: boolean;
      allowSqliteFallbackOnRefresh?: boolean;
      ragicReadMaxRetries?: number;
      persistRefreshToSqlite?: boolean;
    }
  ) => {
    assert.equal(formId, "105");
    assert.equal(entryId, "E-105");
    assert.deepEqual(options, {
      refresh: true,
      allowSqliteFallbackOnRefresh: true,
      ragicReadMaxRetries: 0,
      persistRefreshToSqlite: true,
    });
    return {
      id: "E-105",
      workOrderNo: "WO-105",
      customerPartNo: null,
      erpPartNo: null,
      status: "未結案",
      reports: [],
    };
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/105/reports/E-105?refresh=1`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.id, "E-105");
  });
});

test("POST /api/forms/105/sync?async=1 會啟動 105 sync task", async (t) => {
  const deps = createDeps();
  deps.requestSync = async (formId: string, options: { triggeredBy: string; waitForCompletion: boolean }) => {
      assert.equal(formId, "105");
      assert.equal(options.triggeredBy, "toolbar-refresh");
      assert.equal(options.waitForCompletion, false);
      return {
        taskId: "sync-105",
        formId,
        status: "pending",
        accepted: true,
        triggeredBy: options.triggeredBy,
        createdAt: "2026-03-09T00:00:00.000Z",
        updatedAt: "2026-03-09T00:00:00.000Z",
        scannedEntries: 0,
        syncedEntries: 0,
        syncedRows: 0,
      };
    };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/105/sync?async=1`, {
      method: "POST",
      headers: {
        "x-sync-triggered-by": "toolbar-refresh",
      },
    });
    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.data.taskId, "sync-105");
    assert.equal(payload.meta.formId, "105");
    assert.equal(payload.meta.async, true);
  });
});

test("GET /api/forms/105/sync/status 會回傳最近 sync 狀態", async (t) => {
  const deps = createDeps();
  deps.getSyncStatus = async (formId: string) => {
      assert.equal(formId, "105");
      return {
        formId,
        status: "success",
        taskId: "sync-105",
        startedAt: "2026-03-09T00:00:00.000Z",
        finishedAt: "2026-03-09T00:01:00.000Z",
        snapshotAt: "2026-03-09T00:01:00.000Z",
        totalEntries: 12,
        totalRows: 34,
        message: "同步完成",
        updatedAt: "2026-03-09T00:01:00.000Z",
      };
    };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/105/sync/status`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.formId, "105");
    assert.equal(payload.data.status, "success");
  });
});

test("GET /api/forms/:formId/reports/tasks/:taskId 會 fallback registry create task", async () => {
  const deps = createDeps();
  deps.getCreateTask = (_taskId) => null;
  deps.getTaskRecord = (taskId: string): WorkReportQueueTaskRecord | null =>
    taskId === "registry-create-success"
      ? {
          taskId,
          taskType: "create-report",
          status: "success",
          formId: "104",
          workOrderNo: "WO-104",
          entryId: "E-104",
          rowId: "R-104",
          queueKey: "104:E-104",
          createdAt: "2026-07-06T10:00:00.000Z",
          startedAt: "2026-07-06T10:00:01.000Z",
          finishedAt: "2026-07-06T10:00:02.000Z",
          updatedAt: "2026-07-06T10:00:02.000Z",
          message: "新增報工背景任務完成（rowId: R-104）",
          errorCode: null,
          errorMessage: null,
          actorClientId: "client-1",
          actorTabId: "tab-1",
          actorIp: "::ffff:127.0.0.1",
          actorLabel: null,
          source: null,
        }
      : null;

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/104/reports/tasks/registry-create-success`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.status, "success");
    assert.equal(payload.data.result.rowId, "R-104");
    assert.equal(payload.data.taskType, "create-report");
  });
});

test("GET /api/forms/:formId/reports/tasks/:taskId 以 registry success 覆蓋 local recovered failed", async () => {
  const deps = createDeps();
  deps.getCreateTask = (_taskId) => ({
    taskId: "registry-wins-success",
    taskType: "create-report",
    formId: "104",
    entryId: "E-104",
    queueKey: "104:E-104",
    status: "failed",
    createdAt: "2026-07-06T10:00:00.000Z",
    updatedAt: "2026-07-06T10:10:00.000Z",
    error: {
      code: "TASK_RECOVERED_AFTER_RESTART",
      message: "服務重啟，原非完成任務已標記為失敗，請重新送出",
    },
  });
  deps.getTaskRecord = (taskId: string): WorkReportQueueTaskRecord | null =>
    taskId === "registry-wins-success"
      ? {
          taskId,
          taskType: "create-report",
          status: "success",
          formId: "104",
          workOrderNo: "WO-104",
          entryId: "E-104",
          rowId: "R-104-success",
          queueKey: "104:E-104",
          createdAt: "2026-07-06T10:00:00.000Z",
          startedAt: "2026-07-06T10:00:01.000Z",
          finishedAt: "2026-07-06T10:00:02.000Z",
          updatedAt: "2026-07-06T10:00:02.000Z",
          message: "新增報工背景任務完成（rowId: R-104-success）",
          errorCode: null,
          errorMessage: null,
          actorClientId: "client-1",
          actorTabId: "tab-1",
          actorIp: "::ffff:127.0.0.1",
          actorLabel: null,
          source: null,
        }
      : null;

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/104/reports/tasks/registry-wins-success`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.status, "success");
    assert.equal(payload.data.result.rowId, "R-104-success");
    assert.equal(payload.data.error, undefined);
  });
});

test("GET /api/forms/:formId/reports/tasks/:taskId 以 registry failed 覆蓋 local running", async () => {
  const deps = createDeps();
  deps.getCreateTask = (_taskId) => ({
    taskId: "registry-wins-failed",
    taskType: "update-report",
    formId: "104",
    entryId: "E-104",
    queueKey: "104:E-104",
    status: "running",
    createdAt: "2026-07-06T10:00:00.000Z",
    updatedAt: "2026-07-06T10:00:10.000Z",
  });
  deps.getTaskRecord = (taskId: string): WorkReportQueueTaskRecord | null =>
    taskId === "registry-wins-failed"
      ? createRegistryTask({
          taskId,
          taskType: "update-report",
          status: "failed",
          updatedAt: "2026-07-06T10:00:05.000Z",
          errorCode: "UPDATE_FAILED",
          errorMessage: "Ragic transient failure",
        })
      : null;

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/104/reports/tasks/registry-wins-failed`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.status, "failed");
    assert.equal(payload.data.error.code, "UPDATE_FAILED");
  });
});

test("GET /api/forms/:formId/reports/tasks/:taskId 同 rank 取 updatedAt 較新的 task", async () => {
  const deps = createDeps();
  deps.getCreateTask = (_taskId) => ({
    taskId: "route-merge-newer-local",
    taskType: "create-report",
    formId: "104",
    entryId: "E-104",
    queueKey: "104:E-104",
    status: "running",
    createdAt: "2026-07-06T10:00:00.000Z",
    updatedAt: "2026-07-06T10:01:00.000Z",
  });
  deps.getTaskRecord = (taskId: string): WorkReportQueueTaskRecord | null =>
    taskId === "route-merge-newer-local"
      ? createRegistryTask({
          taskId,
          taskType: "create-report",
          status: "running",
          updatedAt: "2026-07-06T10:00:30.000Z",
          message: "較舊 registry running",
        })
      : null;

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/104/reports/tasks/route-merge-newer-local`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.status, "running");
    assert.equal(payload.data.updatedAt, "2026-07-06T10:01:00.000Z");
  });
});

test("GET /api/forms/:formId/reports/tasks/:taskId registry 無效時 fallback local task", async () => {
  const deps = createDeps();
  deps.getCreateTask = (_taskId) => ({
    taskId: "route-merge-local-fallback",
    taskType: "create-report",
    formId: "104",
    entryId: "E-104",
    queueKey: "104:E-104",
    status: "pending",
    createdAt: "2026-07-06T10:00:00.000Z",
    updatedAt: "2026-07-06T10:00:00.000Z",
  });
  deps.getTaskRecord = (taskId: string): WorkReportQueueTaskRecord | null =>
    taskId === "route-merge-local-fallback"
      ? createRegistryTask({
          taskId,
          taskType: "sync",
          status: "success",
          entryId: null,
          queueKey: "sync:104",
        })
      : null;

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/104/reports/tasks/route-merge-local-fallback`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.status, "pending");
    assert.equal(payload.data.taskType, "create-report");
  });
});

test("POST /api/forms/105/reports/:entryId 會執行 105 create", async (t) => {
  const deps = createDeps();
  deps.createReport = async (formId: string, entryId: string, _payload, options) => {
      assert.equal(formId, "105");
      assert.equal(entryId, "E-105");
      assert.equal(options?.expectedEntryLastUpdatedAt, "2026-03-19T12:00:00.000Z");
      return { rowId: "R-1" };
    };
  deps.projectSqliteAfterMutation = async (
    formId: string,
    entryId: string,
    reason: "create" | "update" | "delete"
  ) => {
      assert.equal(formId, "105");
      assert.equal(entryId, "E-105");
      assert.equal(reason, "create");
    };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/105/reports/E-105`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-entry-last-updated-at": "2026-03-19T12:00:00.000Z",
      },
      body: JSON.stringify({ operatorId: "A001" }),
    });
    assert.equal(response.status, 201);
    const payload = await response.json();
    assert.equal(payload.data.rowId, "R-1");
  });
});

test("POST /api/forms/105/reports/:entryId async create 不用 stale timestamp 擋新增", async () => {
  const deps = createDeps();
  let staleCheckCalls = 0;
  let statusCheckCalls = 0;
  let capturedWorker: (() => Promise<unknown>) | null = null;

  deps.assertEntryNotModified = async () => {
    staleCheckCalls += 1;
    throw new HttpError(
      409,
      "這筆工令在你編輯期間已被其他人更新，請先刷新後再重新送出。",
      "ENTRY_CONFLICT"
    );
  };
  deps.assertCreateEntryAcceptsReports = async (formId, entryId) => {
    statusCheckCalls += 1;
    assert.equal(formId, "105");
    assert.equal(entryId, "E-105");
  };
  deps.enqueueCreateTask = (input) => {
    capturedWorker = input.worker;
    return {
      taskId: "create-async-no-stale",
      status: "pending",
      createdAt: "2026-03-30T00:00:00.000Z",
      accepted: true,
    };
  };
  deps.createReport = async (_formId, _entryId, _payload, options) => {
    assert.equal(options?.expectedEntryLastUpdatedAt, undefined);
    assert.equal(options?.skipEntryPreflight, true);
    return { rowId: "R-async" };
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/105/reports/E-105?async=1`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-client-mutation-id": "client-mutation-1",
        "x-entry-last-updated-at": "2026-03-19T12:00:00.000Z",
      },
      body: JSON.stringify({ operatorId: "A001" }),
    });
    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.data.taskId, "create-async-no-stale");
    assert.equal(payload.meta.preconditionCheck, "skipped");
    assert.equal(staleCheckCalls, 0);
  });

  const worker = capturedWorker as (() => Promise<unknown>) | null;
  assert.ok(worker);
  const result = await worker();
  assert.deepEqual(result, { rowId: "R-async" });
  assert.equal(statusCheckCalls, 1);
  assert.equal(staleCheckCalls, 0);
});

test("POST /api/forms/104/reports/:entryId async create 狀態讀取逾時會自動重試後再寫入", async () => {
  const deps = createDeps();
  let statusCheckCalls = 0;
  let createCalls = 0;
  let capturedWorker: (() => Promise<unknown>) | null = null;
  const sleepCalls: number[] = [];

  deps.sleep = async (ms) => {
    sleepCalls.push(ms);
  };
  deps.assertCreateEntryAcceptsReports = async (formId, entryId) => {
    statusCheckCalls += 1;
    assert.equal(formId, "104");
    assert.equal(entryId, "E-104");
    if (statusCheckCalls <= 2) {
      throw new HttpError(
        409,
        "暫時無法從 Ragic 取得最新工令狀態，這筆報工尚未寫入；請稍後重送。",
        "ENTRY_STATUS_UNKNOWN"
      );
    }
  };
  deps.enqueueCreateTask = (input) => {
    capturedWorker = input.worker;
    return {
      taskId: "create-async-status-retry",
      status: "pending",
      createdAt: "2026-03-30T00:00:00.000Z",
      accepted: true,
    };
  };
  deps.createReport = async (_formId, _entryId, _payload, options) => {
    createCalls += 1;
    assert.equal(options?.skipEntryPreflight, true);
    return { rowId: "R-after-status-retry" };
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/104/reports/E-104?async=1`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-client-mutation-id": "client-mutation-status-retry",
      },
      body: JSON.stringify({ operatorId: "A001" }),
    });
    assert.equal(response.status, 202);
  });

  const worker = capturedWorker as (() => Promise<unknown>) | null;
  assert.ok(worker);
  const result = await worker();
  assert.deepEqual(result, { rowId: "R-after-status-retry" });
  assert.equal(statusCheckCalls, 3);
  assert.equal(createCalls, 1);
  assert.deepEqual(sleepCalls, [5_000, 10_000]);
});

test("POST /api/forms/104/reports/:entryId async create 狀態讀取持續逾時會在上限後中止且不寫入", async () => {
  const deps = createDeps();
  let statusCheckCalls = 0;
  let createCalls = 0;
  let capturedWorker: (() => Promise<unknown>) | null = null;
  const sleepCalls: number[] = [];

  deps.sleep = async (ms) => {
    sleepCalls.push(ms);
  };
  deps.assertCreateEntryAcceptsReports = async () => {
    statusCheckCalls += 1;
    throw new HttpError(
      409,
      "暫時無法從 Ragic 取得最新工令狀態，這筆報工尚未寫入；請稍後重送。",
      "ENTRY_STATUS_UNKNOWN"
    );
  };
  deps.enqueueCreateTask = (input) => {
    capturedWorker = input.worker;
    return {
      taskId: "create-async-status-retry-exhausted",
      status: "pending",
      createdAt: "2026-03-30T00:00:00.000Z",
      accepted: true,
    };
  };
  deps.createReport = async () => {
    createCalls += 1;
    return { rowId: "should-not-create" };
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/104/reports/E-104?async=1`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-client-mutation-id": "client-mutation-status-retry-exhausted",
      },
      body: JSON.stringify({ operatorId: "A001" }),
    });
    assert.equal(response.status, 202);
  });

  const worker = capturedWorker as (() => Promise<unknown>) | null;
  assert.ok(worker);
  await assert.rejects(
    () => worker(),
    (error: unknown) =>
      error instanceof HttpError &&
      error.statusCode === 409 &&
      error.code === "ENTRY_STATUS_UNKNOWN"
  );
  assert.equal(statusCheckCalls, 4);
  assert.equal(createCalls, 0);
  assert.deepEqual(sleepCalls, [5_000, 10_000, 20_000]);
});

test("GET /api/forms/104/reports/:entryId/editing-presence 會回 presence snapshot", async () => {
  const deps = createDeps();
  deps.getEditingPresenceSnapshot = async (input) => {
    assert.equal(input.formId, "104");
    assert.equal(input.entryId, "E-104");
    assert.equal(input.sessionId, "tab-1");
    return {
      hasOtherEditors: true,
      otherEditorCount: 2,
      observedAt: "2026-03-19T00:00:00.000Z",
      canEdit: false,
      isCurrentSessionOwner: false,
    };
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/forms/104/reports/E-104/editing-presence?sessionId=tab-1`
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.hasOtherEditors, true);
    assert.equal(payload.data.otherEditorCount, 2);
  });
});

test("PUT /api/forms/104/reports/:entryId/editing-presence 會更新 presence", async () => {
  const deps = createDeps();
  deps.upsertEditingPresence = async (input) => {
    assert.equal(input.formId, "104");
    assert.equal(input.entryId, "E-104");
    assert.equal(input.sessionId, "tab-1");
    assert.equal(input.active, true);
    assert.equal(input.state, "editing");
    return {
      hasOtherEditors: false,
      otherEditorCount: 0,
      observedAt: "2026-03-19T00:00:00.000Z",
      canEdit: true,
      isCurrentSessionOwner: true,
    };
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/104/reports/E-104/editing-presence`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionId: "tab-1",
        active: true,
        state: "editing",
      }),
    });
    assert.equal(response.status, 200);
  });
});

test("POST /api/forms/105/reports/:entryId/batch-delete 會受理批次刪除任務", async () => {
  const deps = createDeps();
  let observedExpectedEntryLastUpdatedAt = "";
  deps.assertEntryNotModified = async (formId, entryId, expectedEntryLastUpdatedAt) => {
    assert.equal(formId, "105");
    assert.equal(entryId, "E-105");
    observedExpectedEntryLastUpdatedAt = expectedEntryLastUpdatedAt ?? "";
  };
  deps.requestBatchDelete = async (input) => {
    assert.equal(input.formId, "105");
    assert.equal(input.entryId, "E-105");
    assert.deepEqual(input.rowIds, ["1001", "1002"]);
    assert.equal(input.expectedEntryLastUpdatedAt, "2026-03-30T12:00:00.000Z");
    return {
      taskId: "batch-delete-105",
      status: "pending",
      createdAt: "2026-03-30T00:00:00.000Z",
      requestedCount: 2,
    };
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/105/reports/E-105/batch-delete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-entry-last-updated-at": "2026-03-30T12:00:00.000Z",
      },
      body: JSON.stringify({ rowIds: ["1001", "1002"] }),
    });
    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.data.taskId, "batch-delete-105");
    assert.equal(payload.meta.requestedCount, 2);
    assert.equal(observedExpectedEntryLastUpdatedAt, "2026-03-30T12:00:00.000Z");
  });
});

test("POST /api/forms/105/reports/:entryId/batch-create 會受理批次新增任務", async () => {
  const deps = createDeps();
  const preconditionCalls: string[] = [];
  deps.assertEntryEditableBySession = async (input) => {
    preconditionCalls.push(`editable:${input.formId}:${input.entryId}:${input.editSessionId ?? ""}`);
  };
  deps.assertEntryLockVersion = async (input) => {
    preconditionCalls.push(`lock:${input.formId}:${input.entryId}:${input.editLockVersion ?? ""}`);
  };
  deps.assertEntryNotModified = async (formId, entryId, expectedEntryLastUpdatedAt) => {
    preconditionCalls.push(`stale:${formId}:${entryId}:${expectedEntryLastUpdatedAt ?? ""}`);
  };
  deps.requestBatchCreate = async (input) => {
    assert.equal(input.formId, "105");
    assert.equal(input.entryId, "E-105");
    assert.equal(input.rows.length, 2);
    assert.equal(input.rows[0].clientRowKey, "batch-row-1");
    assert.equal(input.rows[1].clientRowKey, "batch-row-2");
    assert.equal(input.expectedEntryLastUpdatedAt, "2026-03-30T12:00:00.000Z");
    assert.equal(input.editSessionId, "edit-session-1");
    assert.equal(input.editLockVersion, 7);
    return {
      taskId: "batch-create-105",
      status: "pending",
      createdAt: "2026-03-30T00:00:00.000Z",
      requestedCount: 2,
    };
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/105/reports/E-105/batch-create`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-entry-last-updated-at": "2026-03-30T12:00:00.000Z",
        "x-edit-session-id": "edit-session-1",
        "x-edit-lock-version": "7",
      },
      body: JSON.stringify({
        rows: [
          { payload: { machineId: "P10" }, clientRowKey: "batch-row-1" },
          { payload: { machineId: "P11" }, clientRowKey: "batch-row-2" },
        ],
      }),
    });
    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.data.taskId, "batch-create-105");
    assert.equal(payload.meta.accepted, true);
    assert.deepEqual(preconditionCalls, [
      "editable:105:E-105:edit-session-1",
      "lock:105:E-105:7",
    ]);
    assert.equal(payload.meta.preconditionCheck, "skipped");
  });
});

test("POST /api/forms/105/reports/:entryId/batch-create 不用 stale timestamp 擋新增", async () => {
  const deps = createDeps();
  let requestBatchCreateCalled = false;
  let staleCheckCalls = 0;
  deps.assertEntryNotModified = async () => {
    staleCheckCalls += 1;
    throw new HttpError(
      409,
      "這筆工令在你編輯期間已被其他人更新，請先刷新後再重新送出。",
      "ENTRY_CONFLICT"
    );
  };
  deps.requestBatchCreate = async (input) => {
    requestBatchCreateCalled = true;
    assert.equal(input.expectedEntryLastUpdatedAt, "2026-03-30T12:00:00.000Z");
    return {
      taskId: "batch-create-stale-deferred",
      status: "pending",
      createdAt: "2026-03-30T00:00:00.000Z",
      requestedCount: 1,
    };
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/105/reports/E-105/batch-create`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-entry-last-updated-at": "2026-03-30T12:00:00.000Z",
      },
      body: JSON.stringify({
        rows: [{ payload: { machineId: "P10" }, clientRowKey: "batch-row-1" }],
      }),
    });
    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.data.taskId, "batch-create-stale-deferred");
    assert.equal(payload.meta.accepted, true);
    assert.equal(payload.meta.preconditionCheck, "skipped");
    assert.equal(requestBatchCreateCalled, true);
    assert.equal(staleCheckCalls, 0);
  });
});

test("POST /api/forms/105/reports/:entryId/batch-create 跳過 stale precheck timeout", async () => {
  const deps = createDeps();
  let requestBatchCreateCalled = false;
  let staleCheckCalls = 0;
  deps.assertEntryNotModified = async () => {
    staleCheckCalls += 1;
    throw new Error("ECONNABORTED");
  };
  deps.requestBatchCreate = async (input) => {
    requestBatchCreateCalled = true;
    assert.equal(input.formId, "105");
    assert.equal(input.entryId, "E-105");
    assert.equal(input.expectedEntryLastUpdatedAt, "2026-03-30T12:00:00.000Z");
    return {
      taskId: "batch-create-deferred-precheck",
      status: "pending",
      createdAt: "2026-03-30T00:00:00.000Z",
      requestedCount: input.rows.length,
    };
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/105/reports/E-105/batch-create`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-entry-last-updated-at": "2026-03-30T12:00:00.000Z",
      },
      body: JSON.stringify({
        rows: [{ payload: { machineId: "P10" }, clientRowKey: "batch-row-1" }],
      }),
    });
    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.data.taskId, "batch-create-deferred-precheck");
    assert.equal(payload.meta.preconditionCheck, "skipped");
    assert.equal(requestBatchCreateCalled, true);
    assert.equal(staleCheckCalls, 0);
  });
});

test("同一列 rowId 只能被一個 session 取得編輯鎖", async () => {
  const entryId = "E-104-row-lock";
  const rowId = "112708";

  const first = workReportEditingPresenceService.upsertPresence({
    formId: "104",
    entryId,
    rowId,
    sessionId: "tab-A",
    active: true,
    state: "editing",
  });
  assert.equal(first.canEdit, true);
  assert.equal(first.isCurrentSessionOwner, true);

  const second = workReportEditingPresenceService.upsertPresence({
    formId: "104",
    entryId,
    rowId,
    sessionId: "tab-B",
    active: true,
    state: "editing",
  });
  assert.equal(second.canEdit, false);
  assert.equal(second.isCurrentSessionOwner, false);
  assert.equal(second.hasOtherEditors, true);
  assert.equal(second.otherEditorCount, 1);

  workReportEditingPresenceService.upsertPresence({
    formId: "104",
    entryId,
    rowId,
    sessionId: "tab-A",
    active: false,
  });
});

test("GET editing-presence 不帶 rowId 時會回工令層級的編輯摘要", async () => {
  const entryId = "E-104-summary";

  workReportEditingPresenceService.upsertPresence({
    formId: "104",
    entryId,
    rowId: "112708",
    sessionId: "tab-A",
    active: true,
    state: "editing",
  });

  const summary = workReportEditingPresenceService.getSnapshot({
    formId: "104",
    entryId,
    sessionId: "tab-B",
  });
  assert.equal(summary.hasOtherEditors, true);
  assert.equal(summary.otherEditorCount, 1);
  assert.equal(summary.canEdit, true);

  workReportEditingPresenceService.upsertPresence({
    formId: "104",
    entryId,
    rowId: "112708",
    sessionId: "tab-A",
    active: false,
  });
});

test("POST /api/forms/105/reports/:entryId conflict 會回 409", async () => {
  const deps = createDeps();
  deps.createReport = async () => {
    throw new HttpError(
      409,
      "這筆工令在你編輯期間已被其他人更新，請先刷新後再重新送出。",
      "ENTRY_CONFLICT"
    );
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/105/reports/E-105`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-entry-last-updated-at": "2026-03-19T12:00:00.000Z",
      },
      body: JSON.stringify({ operatorId: "A001" }),
    });
    assert.equal(response.status, 409);
    const payload = await response.json();
    assert.equal(payload.error.code, "ENTRY_CONFLICT");
  });
});

test("POST /api/forms/105/reports/:entryId lock version 不符會回 409", async () => {
  const deps = createDeps();
  deps.assertEntryLockVersion = async () => {
    throw new HttpError(
      409,
      "你已失去這筆工令的編輯權，請重新整理或稍後再試。",
      "ENTRY_EDIT_LOCKED"
    );
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/105/reports/E-105`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-edit-session-id": "tab-1",
        "x-edit-lock-version": "3",
      },
      body: JSON.stringify({ operatorId: "A001" }),
    });
    assert.equal(response.status, 409);
    const payload = await response.json();
    assert.equal(payload.error.code, "ENTRY_EDIT_LOCKED");
  });
});

test("POST /api/forms/104/ragic-callback 帶 token 與 entryId 可接受 callback", async () => {
  const deps = createDeps();
  deps.requestRagicCallbackRefresh = async (input) => {
    assert.equal(input.formId, "104");
    assert.equal(input.entryId, "E-104");
    assert.equal(input.eventType, "row-updated");
    assert.equal(input.rowId, "R-99");
    assert.equal(input.source, "ragic");
    return {
      accepted: true,
      taskId: "callback-104",
      status: "pending",
      createdAt: "2026-03-17T00:00:00.000Z",
    };
  };

  const originalToken = process.env.RAGIC_CALLBACK_TOKEN;
  process.env.RAGIC_CALLBACK_TOKEN = "callback-secret";

  try {
    await withTestServer(deps, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/forms/104/ragic-callback`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ragic-callback-token": "callback-secret",
        },
        body: JSON.stringify({
          entryId: "E-104",
          eventType: "row-updated",
          rowId: "R-99",
          source: "ragic",
        }),
      });
      assert.equal(response.status, 202);
      const payload = await response.json();
      assert.equal(payload.data.accepted, true);
      assert.equal(payload.data.formId, "104");
      assert.equal(payload.data.entryId, "E-104");
      assert.equal(payload.data.eventType, "row-updated");
    });
  } finally {
    process.env.RAGIC_CALLBACK_TOKEN = originalToken;
  }
});

test("POST /api/forms/104/ragic-callback token 錯誤會回 403", async () => {
  const deps = createDeps();
  const originalToken = process.env.RAGIC_CALLBACK_TOKEN;
  process.env.RAGIC_CALLBACK_TOKEN = "callback-secret";

  try {
    await withTestServer(deps, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/forms/104/ragic-callback`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ragic-callback-token": "wrong-token",
        },
        body: JSON.stringify({
          entryId: "E-104",
          eventType: "entry-updated",
        }),
      });
      assert.equal(response.status, 403);
    });
  } finally {
    process.env.RAGIC_CALLBACK_TOKEN = originalToken;
  }
});

test("POST /api/forms/104/ragic-callback 缺 entryId 會回 400", async () => {
  const deps = createDeps();
  const originalToken = process.env.RAGIC_CALLBACK_TOKEN;
  process.env.RAGIC_CALLBACK_TOKEN = "callback-secret";

  try {
    await withTestServer(deps, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/forms/104/ragic-callback`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ragic-callback-token": "callback-secret",
        },
        body: JSON.stringify({
          eventType: "entry-updated",
        }),
      });
      assert.equal(response.status, 400);
    });
  } finally {
    process.env.RAGIC_CALLBACK_TOKEN = originalToken;
  }
});

test("PUT /api/forms/104/reports/:entryId/main-machine 會更新主表機台", async () => {
  const deps = createDeps();
  let projectionCalled = false;
  deps.updateMainMachine = async (formId, entryId, machineCode) => {
    assert.equal(formId, "104");
    assert.equal(entryId, "E-104");
    assert.equal(machineCode, "P11");
    return { machineCode };
  };
  deps.projectSqliteAfterMutation = async (formId, entryId, reason) => {
    assert.equal(formId, "104");
    assert.equal(entryId, "E-104");
    assert.equal(reason, "update");
    projectionCalled = true;
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/104/reports/E-104/main-machine`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        machineCode: "P11",
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.machineCode, "P11");
    assert.equal(payload.meta.formId, "104");
    assert.equal(projectionCalled, true);
  });
});

test("PUT /api/forms/105/reports/:entryId/:rowId 會執行 105 update", async (t) => {
  const deps = createDeps();
  deps.assertEntryEditableBySession = async (input) => {
      assert.equal(input.formId, "105");
      assert.equal(input.entryId, "E-105");
      assert.equal(input.rowId, "12");
    };
  deps.assertEntryLockVersion = async (input) => {
      assert.equal(input.formId, "105");
      assert.equal(input.entryId, "E-105");
      assert.equal(input.rowId, "12");
    };
  deps.updateReport = async (formId: string, entryId: string, rowId: string) => {
      assert.equal(formId, "105");
      assert.equal(entryId, "E-105");
      assert.equal(rowId, "12");
      return { rowId };
    };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/105/reports/E-105/12`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ operatorId: "A001" }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.rowId, "12");
  });
});

test("DELETE /api/forms/105/reports/:entryId/:rowId 會受理單筆刪除任務", async (t) => {
  const deps = createDeps();
  deps.assertEntryEditableBySession = async (input) => {
      assert.equal(input.formId, "105");
      assert.equal(input.entryId, "E-105");
      assert.equal(input.rowId, "12");
    };
  deps.assertEntryLockVersion = async (input) => {
      assert.equal(input.formId, "105");
      assert.equal(input.entryId, "E-105");
      assert.equal(input.rowId, "12");
    };
  deps.requestBatchDelete = async (input) => {
      assert.equal(input.taskType, "delete-report");
      assert.equal(input.formId, "105");
      assert.equal(input.entryId, "E-105");
      assert.deepEqual(input.rowIds, ["12"]);
      return {
        taskId: "delete-105",
        status: "pending",
        createdAt: "2026-03-30T00:00:00.000Z",
        requestedCount: 1,
      };
    };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/105/reports/E-105/12`, {
      method: "DELETE",
    });
    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.data.taskId, "delete-105");
    assert.equal(payload.meta.accepted, true);
    assert.equal(payload.meta.requestedCount, 1);
    assert.equal(payload.meta.rowId, "12");
  });
});

test("DELETE /api/forms/104/reports/:entryId/:rowId stale check 逾時會 defer 到刪除任務", async () => {
  const deps = createDeps();
  deps.assertEntryNotModified = async () => {
    throw new HttpError(
      504,
      "確認工令最新狀態逾時，尚未執行寫入，請重新整理後重試。",
      "RAGIC_STALE_CHECK_UNAVAILABLE"
    );
  };
  deps.requestBatchDelete = async (input) => {
    assert.equal(input.taskType, "delete-report");
    assert.equal(input.formId, "104");
    assert.equal(input.entryId, "E-104");
    assert.deepEqual(input.rowIds, ["122298"]);
    assert.equal(input.expectedEntryLastUpdatedAt, "2026-03-30T12:00:00.000Z");
    return {
      taskId: "delete-104-deferred",
      status: "pending",
      createdAt: "2026-03-30T00:00:00.000Z",
      requestedCount: 1,
    };
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/104/reports/E-104/122298`, {
      method: "DELETE",
      headers: {
        "x-entry-last-updated-at": "2026-03-30T12:00:00.000Z",
      },
    });
    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.data.taskId, "delete-104-deferred");
    assert.equal(payload.meta.preconditionCheck, "deferred");
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { errorHandler } from "../../src/middleware/errorHandler";
import { env } from "../../src/config/env";
import { HttpError } from "../../src/utils/httpError";
import {
  createWorkReportRouter,
  type WorkReportRouterDeps,
} from "../../src/routes/workReportRouterFactory";
import type { WorkReportQueueTaskRecord } from "../../src/services/work-report/workReportTaskRegistryService";
import { workReportEditingPresenceService } from "../../src/services/workReportEditingPresenceService";
import { runWorkReportEntryMutationExclusive } from "../../src/services/work-report/workReportEntryMutationQueue";
import { realtimeEventBus } from "../../src/events/realtimeEventBus";

function createDeps(): WorkReportRouterDeps {
  return {
    runEntryMutationExclusive: async (_formId, _entryId, worker) => worker(),
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
    assertCreateEntryAcceptsReports: async (_formId, _entryId) => ({}),
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
    updateSortOrder: async (_formId, _entryId, sortOrder, _options) => ({
      sortOrder,
      previousSortOrder: null,
      changed: true,
    }),
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
    enqueueSqliteProjectionAfterMutation: async (_formId, _entryId, _reason) => 0,
    applyQueuedSqliteProjectionAfterMutation: async (
      _formId,
      _entryId,
      _reason,
      _enqueuedSeq
    ) => "applied",
    applyQueuedSortOrderSqliteAfterMutation: async (
      _formId,
      _entryId,
      _sortOrder,
      _enqueuedSeq
    ) => "applied",
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

function percentile(values: number[], ratio: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)] ?? 0;
}

test("GET /api/forms/105/reports/:entryId?refresh=1 會走 detail refresh 讀取並允許 UI fallback", async (t) => {
  const deps = createDeps();
  deps.getReportByEntryId = async (
    formId: string,
    entryId: string,
    options?: {
      refresh?: boolean;
      allowSqliteFallbackOnRefresh?: boolean;
      ragicReadTimeoutMs?: number;
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

test("GET /api/forms/104/reports/:entryId strict refresh 不會以 SQLite 舊快照冒充 mutation 對帳結果", async () => {
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
    assert.equal(formId, "104");
    assert.equal(entryId, "E-104");
    assert.deepEqual(options, {
      refresh: true,
      allowSqliteFallbackOnRefresh: false,
      ragicReadTimeoutMs: Math.min(env.RAGIC_MUTATION_READ_TIMEOUT_MS, 10_000),
      ragicReadMaxRetries: 1,
      persistRefreshToSqlite: true,
    });
    return {
      id: "E-104",
      workOrderNo: "WO-104",
      customerPartNo: null,
      erpPartNo: null,
      status: "未結案",
      reports: [],
    };
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/forms/104/reports/E-104?refresh=1&strictRefresh=1`
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.id, "E-104");
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
  deps.enqueueSqliteProjectionAfterMutation = async (
    formId: string,
    entryId: string,
    reason: "create" | "update" | "delete"
  ) => {
      assert.equal(formId, "105");
      assert.equal(entryId, "E-105");
      assert.equal(reason, "create");
      return 0;
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

test("同一 entry 的同步新增與主機台更新會依序執行", async () => {
  const deps = createDeps();
  deps.runEntryMutationExclusive = runWorkReportEntryMutationExclusive;

  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  let markCreateStarted!: () => void;
  const createStarted = new Promise<void>((resolve) => {
    markCreateStarted = resolve;
  });
  let mainMachineStarted = false;

  deps.createReport = async () => {
    markCreateStarted();
    await createGate;
    return { rowId: "R-queue" };
  };
  deps.updateMainMachine = async (_formId, _entryId, machineCode) => {
    mainMachineStarted = true;
    return { machineCode };
  };

  await withTestServer(deps, async (baseUrl) => {
    const createResponsePromise = fetch(`${baseUrl}/api/forms/104/reports/E-QUEUE`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operatorId: "A001" }),
    });
    await createStarted;

    const mainMachineResponsePromise = fetch(
      `${baseUrl}/api/forms/104/reports/E-QUEUE/main-machine`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ machineCode: "P11" }),
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(mainMachineStarted, false);

    releaseCreate();
    const [createResponse, mainMachineResponse] = await Promise.all([
      createResponsePromise,
      mainMachineResponsePromise,
    ]);
    assert.equal(createResponse.status, 201);
    assert.equal(mainMachineResponse.status, 200);
    assert.equal(mainMachineStarted, true);
  });
});

test("同一 entry 排隊中的同步 mutation 在 client abort 後不會稍後執行", async () => {
  const deps = createDeps();
  let exclusiveCalls = 0;
  let markSecondQueued!: () => void;
  const secondQueued = new Promise<void>((resolve) => {
    markSecondQueued = resolve;
  });
  let markServerObservedAbort!: () => void;
  const serverObservedAbort = new Promise<void>((resolve) => {
    markServerObservedAbort = resolve;
  });
  deps.runEntryMutationExclusive = async (formId, entryId, worker, options) => {
    exclusiveCalls += 1;
    if (exclusiveCalls === 2) {
      markSecondQueued();
      options?.signal?.addEventListener("abort", markServerObservedAbort, { once: true });
    }
    return runWorkReportEntryMutationExclusive(formId, entryId, worker, options);
  };

  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  let markCreateStarted!: () => void;
  const createStarted = new Promise<void>((resolve) => {
    markCreateStarted = resolve;
  });
  let mainMachineStarted = false;

  deps.createReport = async () => {
    markCreateStarted();
    await createGate;
    return { rowId: "R-abort-queue" };
  };
  deps.updateMainMachine = async (_formId, _entryId, machineCode) => {
    mainMachineStarted = true;
    return { machineCode };
  };

  await withTestServer(deps, async (baseUrl) => {
    const createResponsePromise = fetch(`${baseUrl}/api/forms/104/reports/E-ABORT-QUEUE`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operatorId: "A001" }),
    });
    await createStarted;

    const controller = new AbortController();
    const mainMachineRequest = fetch(
      `${baseUrl}/api/forms/104/reports/E-ABORT-QUEUE/main-machine`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ machineCode: "P11" }),
        signal: controller.signal,
      }
    );
    await secondQueued;
    controller.abort();
    await assert.rejects(() => mainMachineRequest, (error: unknown) => {
      return error instanceof Error && error.name === "AbortError";
    });
    await serverObservedAbort;

    releaseCreate();
    const createResponse = await createResponsePromise;
    assert.equal(createResponse.status, 201);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(mainMachineStarted, false);
  });
});

test("POST /api/forms/105/reports/:entryId async create 不用 stale timestamp 擋新增", async () => {
  const deps = createDeps();
  const preconditionEntrySnapshot = { "工令狀態": "未結案" };
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
    return preconditionEntrySnapshot;
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
    assert.equal(options?.clientMutationId, "client-mutation-1");
    assert.equal(options?.createIdempotencyKey, "stable-create-key-1");
    assert.equal(statusCheckCalls, 0);
    assert.equal(
      await options?.loadPreconditionEntrySnapshot?.(),
      preconditionEntrySnapshot
    );
    return { rowId: "R-async" };
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/105/reports/E-105?async=1`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-client-mutation-id": "client-mutation-1",
        "x-create-idempotency-key": "stable-create-key-1",
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
  const preconditionEntrySnapshot = { "工令狀態": "未結案" };
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
    return preconditionEntrySnapshot;
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
    assert.equal(
      await options?.loadPreconditionEntrySnapshot?.(),
      preconditionEntrySnapshot
    );
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
  deps.createReport = async (_formId, _entryId, _payload, options) => {
    createCalls += 1;
    await options?.loadPreconditionEntrySnapshot?.();
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
  assert.equal(createCalls, 1);
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
  let routeStaleCheckCalls = 0;
  deps.assertEntryNotModified = async () => {
    routeStaleCheckCalls += 1;
    throw new Error("route 不應執行 Ragic stale precheck");
  };
  deps.requestBatchDelete = async (input) => {
    assert.equal(input.formId, "105");
    assert.equal(input.entryId, "E-105");
    assert.deepEqual(input.rowIds, ["1001", "1002"]);
    assert.equal(input.expectedEntryLastUpdatedAt, "2026-03-30T12:00:00.000Z");
    assert.equal(input.editLockVersion, 7);
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
        "x-edit-lock-version": "7",
      },
      body: JSON.stringify({ rowIds: ["1001", "1002"] }),
    });
    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.data.taskId, "batch-delete-105");
    assert.equal(payload.data.lifecycleState, "accepted");
    assert.equal(payload.data.acceptedAt, "2026-03-30T00:00:00.000Z");
    assert.equal(payload.data.confirmedAt, null);
    assert.equal(payload.meta.requestedCount, 2);
    assert.equal(payload.meta.preconditionCheck, "deferred");
    assert.equal(routeStaleCheckCalls, 0);
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
    assert.equal(payload.data.lifecycleState, "accepted");
    assert.equal(payload.data.acceptedAt, "2026-03-30T00:00:00.000Z");
    assert.equal(payload.data.confirmedAt, null);
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
  deps.enqueueSqliteProjectionAfterMutation = async (formId, entryId, reason) => {
    assert.equal(formId, "104");
    assert.equal(entryId, "E-104");
    assert.equal(reason, "update");
    projectionCalled = true;
    return 0;
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

test("PUT /api/forms/104/reports/:entryId/sort-order 缺少 mutation id 時拒絕排入", async () => {
  const deps = createDeps();
  let enqueueCalled = false;
  deps.enqueueCreateTask = (_input) => {
    enqueueCalled = true;
    return {
      taskId: "sort-order-task",
      status: "pending",
      createdAt: "2026-08-04T00:00:00.000Z",
    };
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/forms/104/reports/E-104/sort-order`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sortOrder: 4 }),
      }
    );
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error.code, "CLIENT_MUTATION_ID_REQUIRED");
    assert.equal(enqueueCalled, false);
  });
});

test("PUT /api/forms/104/reports/:entryId/sort-order 拒絕非數字排序碼", async () => {
  const deps = createDeps();
  let enqueueCalled = false;
  deps.enqueueCreateTask = (_input) => {
    enqueueCalled = true;
    return {
      taskId: "sort-order-task",
      status: "pending",
      createdAt: "2026-08-04T00:00:00.000Z",
    };
  };

  await withTestServer(deps, async (baseUrl) => {
    for (const sortOrder of [false, "   "]) {
      const response = await fetch(
        `${baseUrl}/api/forms/104/reports/E-104/sort-order`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "x-client-mutation-id": "sort-order-invalid",
          },
          body: JSON.stringify({ sortOrder }),
        }
      );
      assert.equal(response.status, 400);
      const payload = await response.json();
      assert.equal(payload.error.code, "INVALID_PAYLOAD");
    }
    assert.equal(enqueueCalled, false);
  });
});

test("PUT /api/forms/104/reports/:entryId/sort-order 以同工令 queue 建立可追蹤更新任務", async () => {
  const deps = createDeps();
  let capturedWorker: (() => Promise<unknown>) | null = null;
  let updateCalls = 0;
  let projectionCalls = 0;
  deps.enqueueCreateTask = (input) => {
    assert.equal(input.taskType, "update-report");
    assert.equal(input.formId, "104");
    assert.equal(input.entryId, "E-104");
    assert.equal(input.queueKey, "104:E-104");
    assert.equal(input.clientMutationId, "sort-order-mutation-1");
    assert.equal(input.workOrderNo, "WO-104");
    assert.equal(input.operationKind, "update-sort-order");
    assert.equal(input.actorLabel, "生管工作站");
    assert.match(input.operationFingerprint, /^[a-f0-9]{64}$/);
    capturedWorker = input.worker;
    return {
      taskId: "sort-order-task",
      status: "pending",
      createdAt: "2026-08-04T00:00:00.000Z",
    };
  };
  deps.updateSortOrder = async (formId, entryId, sortOrder, options) => {
    updateCalls += 1;
    assert.equal(formId, "104");
    assert.equal(entryId, "E-104");
    assert.equal(sortOrder, 4);
    assert.equal(options?.expectedEntryLastUpdatedAt, undefined);
    return {
      sortOrder,
      previousSortOrder: 2,
      changed: true,
    };
  };
  deps.enqueueSqliteProjectionAfterMutation = async () => 23;
  deps.applyQueuedSortOrderSqliteAfterMutation = async (
    formId,
    entryId,
    sortOrder,
    enqueuedSeq
  ) => {
    projectionCalls += 1;
    assert.equal(formId, "104");
    assert.equal(entryId, "E-104");
    assert.equal(sortOrder, 4);
    assert.equal(enqueuedSeq, 23);
    return "applied";
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/forms/104/reports/E-104/sort-order`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-client-mutation-id": "sort-order-mutation-1",
          "x-debug-work-order-no": "WO-104",
          "x-debug-device-label": encodeURIComponent("生管工作站"),
        },
        body: JSON.stringify({ sortOrder: 4 }),
      }
    );
    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.data.taskId, "sort-order-task");
    assert.equal(payload.data.status, "pending");
    assert.equal(payload.data.lifecycleState, "accepted");
    assert.equal(payload.data.acceptedAt, "2026-08-04T00:00:00.000Z");
    assert.equal(payload.data.confirmedAt, null);
    assert.equal(payload.meta.accepted, true);
    assert.equal(payload.meta.preconditionCheck, "skipped");
    assert.ok(capturedWorker);

    await capturedWorker!();
    assert.equal(updateCalls, 1);
    assert.equal(projectionCalls, 1);
  });
});

test("PUT /api/forms/104/reports/:entryId/sort-order 不執行整筆 Ragic stale precheck", async () => {
  const deps = createDeps();
  let routePrecheckCalls = 0;
  let capturedWorker: (() => Promise<unknown>) | null = null;
  deps.assertEntryNotModified = async () => {
    routePrecheckCalls += 1;
    throw new Error("route 不應執行 Ragic stale precheck");
  };
  deps.enqueueCreateTask = (input) => {
    capturedWorker = input.worker;
    return {
      taskId: "sort-order-worker-precheck-task",
      status: "pending",
      createdAt: "2026-08-07T00:00:00.000Z",
    };
  };
  deps.updateSortOrder = async (_formId, _entryId, sortOrder, options) => {
    assert.equal(options?.expectedEntryLastUpdatedAt, "2026-08-07T01:00:00.000Z");
    return {
      sortOrder,
      previousSortOrder: 2,
      changed: true,
    };
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/forms/104/reports/E-104/sort-order`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-client-mutation-id": "sort-order-worker-precheck-1",
          "x-entry-last-updated-at": "2026-08-07T01:00:00.000Z",
        },
        body: JSON.stringify({ sortOrder: 4 }),
      }
    );

    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.meta.preconditionCheck, "skipped");
    assert.equal(routePrecheckCalls, 0);
    assert.ok(capturedWorker);
    await capturedWorker!();
  });
});

test("PUT /api/forms/104/reports/:entryId/sort-order no-op 仍刷新 projection", async () => {
  const deps = createDeps();
  let capturedWorker: (() => Promise<unknown>) | null = null;
  let projectionCalls = 0;
  deps.enqueueCreateTask = (input) => {
    capturedWorker = input.worker;
    return {
      taskId: "sort-order-noop-task",
      status: "pending",
      createdAt: "2026-08-04T00:00:00.000Z",
    };
  };
  deps.updateSortOrder = async (_formId, _entryId, sortOrder) => ({
    sortOrder,
    previousSortOrder: sortOrder,
    changed: false,
  });
  deps.enqueueSqliteProjectionAfterMutation = async () => 24;
  deps.applyQueuedSortOrderSqliteAfterMutation = async () => {
    projectionCalls += 1;
    return "applied";
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/forms/104/reports/E-104/sort-order`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-client-mutation-id": "sort-order-noop-1",
        },
        body: JSON.stringify({ sortOrder: 2 }),
      }
    );
    assert.equal(response.status, 202);
    assert.ok(capturedWorker);
    await capturedWorker!();
    assert.equal(projectionCalls, 1);
  });
});

test("PUT /api/forms/104/reports/:entryId/sort-order projection 延後時不發布舊 SQLite refresh 事件", async () => {
  const deps = createDeps();
  let capturedWorker: (() => Promise<unknown>) | null = null;
  const publishedTypes: string[] = [];
  deps.enqueueCreateTask = (input) => {
    capturedWorker = input.worker;
    return {
      taskId: "sort-order-deferred-projection-task",
      status: "pending",
      createdAt: "2026-08-07T00:00:00.000Z",
    };
  };
  deps.updateSortOrder = async (_formId, _entryId, sortOrder) => ({
    sortOrder,
    previousSortOrder: 2,
    changed: true,
  });
  deps.enqueueSqliteProjectionAfterMutation = async () => 25;
  deps.applyQueuedSortOrderSqliteAfterMutation = async () => "deferred";
  const unsubscribe = realtimeEventBus.subscribe((event) => {
    if (event.formId === "104") {
      publishedTypes.push(event.type);
    }
  });

  try {
    await withTestServer(deps, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/forms/104/reports/E-104/sort-order`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "x-client-mutation-id": "sort-order-deferred-projection-1",
          },
          body: JSON.stringify({ sortOrder: 4 }),
        }
      );
      assert.equal(response.status, 202);
      assert.ok(capturedWorker);
      await capturedWorker!();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(publishedTypes, []);
    });
  } finally {
    unsubscribe();
  }
});

test("PUT /api/forms/104/reports/:entryId/sort-order projection 失敗時不發布舊 SQLite refresh 事件", async () => {
  const deps = createDeps();
  let capturedWorker: (() => Promise<unknown>) | null = null;
  const publishedTypes: string[] = [];
  deps.enqueueCreateTask = (input) => {
    capturedWorker = input.worker;
    return {
      taskId: "sort-order-failed-projection-task",
      status: "pending",
      createdAt: "2026-08-07T00:00:00.000Z",
    };
  };
  deps.updateSortOrder = async (_formId, _entryId, sortOrder) => ({
    sortOrder,
    previousSortOrder: 2,
    changed: true,
  });
  deps.enqueueSqliteProjectionAfterMutation = async () => 26;
  deps.applyQueuedSortOrderSqliteAfterMutation = async () => "failed";
  const unsubscribe = realtimeEventBus.subscribe((event) => {
    if (event.formId === "104") {
      publishedTypes.push(event.type);
    }
  });

  try {
    await withTestServer(deps, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/forms/104/reports/E-104/sort-order`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "x-client-mutation-id": "sort-order-failed-projection-1",
          },
          body: JSON.stringify({ sortOrder: 4 }),
        }
      );
      assert.equal(response.status, 202);
      assert.ok(capturedWorker);
      await capturedWorker!();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(publishedTypes, []);
    });
  } finally {
    unsubscribe();
  }
});

test("DELETE /api/forms/104/reports/:entryId/:rowId 不等待 route stale check，交由刪除 worker 驗證", async () => {
  const deps = createDeps();
  let routeStaleCheckCalls = 0;
  deps.assertEntryNotModified = async () => {
    routeStaleCheckCalls += 1;
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
    assert.equal(input.editLockVersion, 3);
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
        "x-edit-lock-version": "3",
      },
    });
    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.data.taskId, "delete-104-deferred");
    assert.equal(payload.meta.preconditionCheck, "deferred");
    assert.equal(routeStaleCheckCalls, 0);
  });
});

test("main-machine async variant 先受理再由同 entry worker 更新", async () => {
  const deps = createDeps();
  let capturedWorker: (() => Promise<unknown>) | null = null;
  let updateCalls = 0;
  deps.enqueueCreateTask = (input) => {
    assert.equal(input.taskType, "update-report");
    assert.equal(input.operationKind, "update-main-machine");
    assert.equal(input.queueKey, "104:E-104");
    assert.equal(input.clientMutationId, "main-machine-mutation-1");
    assert.match(input.operationFingerprint, /^[a-f0-9]{64}$/);
    capturedWorker = input.worker;
    return {
      taskId: "main-machine-task",
      status: "pending",
      createdAt: "2026-08-12T01:00:00.000Z",
    };
  };
  deps.updateMainMachine = async (formId, entryId, machineCode, options) => {
    updateCalls += 1;
    assert.equal(formId, "104");
    assert.equal(entryId, "E-104");
    assert.equal(machineCode, "P11");
    assert.equal(options?.expectedEntryLastUpdatedAt, "2026-08-12T00:00:00.000Z");
    return { machineCode };
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/forms/104/reports/E-104/main-machine?async=1`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-client-mutation-id": "main-machine-mutation-1",
          "x-entry-last-updated-at": "2026-08-12T00:00:00.000Z",
        },
        body: JSON.stringify({ machineCode: "P11" }),
      }
    );

    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.data.taskId, "main-machine-task");
    assert.equal(payload.data.lifecycleState, "accepted");
    assert.equal(payload.meta.accepted, true);
    assert.equal(payload.meta.preconditionCheck, "deferred");
    assert.equal(updateCalls, 0);
  });

  const mainMachineWorker = capturedWorker as (() => Promise<unknown>) | null;
  assert.ok(mainMachineWorker);
  await mainMachineWorker();
  assert.equal(updateCalls, 1);
});

test("Work Report async route 的受控 accepted latency 不等待 terminal worker", async () => {
  const deps = createDeps();
  let taskIndex = 0;
  let workerCallCount = 0;
  deps.enqueueCreateTask = (input) => {
    taskIndex += 1;
    assert.equal(input.operationKind, "update-main-machine");
    return {
      taskId: `accepted-latency-${taskIndex}`,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
  };
  deps.updateMainMachine = async (_formId, _entryId, machineCode) => {
    workerCallCount += 1;
    return { machineCode };
  };

  const samples: number[] = [];
  await withTestServer(deps, async (baseUrl) => {
    for (let index = 0; index < 30; index += 1) {
      const startedAt = performance.now();
      const response = await fetch(
        `${baseUrl}/api/forms/104/reports/E-LATENCY-${index}/main-machine?async=1`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "x-client-mutation-id": `main-machine-latency-${index}`,
          },
          body: JSON.stringify({ machineCode: "P11" }),
        }
      );
      samples.push(performance.now() - startedAt);
      assert.equal(response.status, 202);
      const payload = await response.json();
      assert.equal(payload.data.lifecycleState, "accepted");
    }
  });

  const p50 = percentile(samples, 0.5);
  const p95 = percentile(samples, 0.95);
  console.info("[accepted-latency][work-report-mock-http]", {
    samples: samples.length,
    p50Ms: Number(p50.toFixed(2)),
    p95Ms: Number(p95.toFixed(2)),
  });
  assert.equal(workerCallCount, 0);
  assert.ok(p50 < 500, `controlled accepted p50 ${p50}ms should stay below 500ms`);
  assert.ok(p95 < 1000, `controlled accepted p95 ${p95}ms should stay below 1000ms`);
});

test("close/reopen async variant 都先受理，Ragic stale guard 留在 worker", async () => {
  const cases = [
    {
      path: "close",
      action: "close" as const,
      operationKind: "close-work-order" as const,
    },
    {
      path: "reopen",
      action: "reopen" as const,
      operationKind: "reopen-work-order" as const,
    },
  ];

  for (const item of cases) {
    const deps = createDeps();
    let capturedWorker: (() => Promise<unknown>) | null = null;
    let staleCheckCalls = 0;
    let actionCalls = 0;
    deps.assertEntryNotModified = async (
      formId,
      entryId,
      expectedEntryLastUpdatedAt
    ) => {
      staleCheckCalls += 1;
      assert.equal(formId, "104");
      assert.equal(entryId, "E-104");
      assert.equal(expectedEntryLastUpdatedAt, "2026-08-12T00:00:00.000Z");
    };
    deps.enqueueCreateTask = (input) => {
      assert.equal(input.taskType, "update-report");
      assert.equal(input.operationKind, item.operationKind);
      assert.equal(input.queueKey, "104:E-104");
      assert.equal(input.clientMutationId, `${item.path}-mutation-1`);
      assert.match(input.operationFingerprint, /^[a-f0-9]{64}$/);
      capturedWorker = input.worker;
      return {
        taskId: `${item.path}-task`,
        status: "pending",
        createdAt: "2026-08-12T01:00:00.000Z",
      };
    };
    deps.manualCloseWorkOrder = async (formId, entryId, action, options) => {
      actionCalls += 1;
      assert.equal(formId, "104");
      assert.equal(entryId, "E-104");
      assert.equal(action, item.action);
      assert.equal(options?.expectedEntryLastUpdatedAt, "2026-08-12T00:00:00.000Z");
      return { action };
    };

    await withTestServer(deps, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/forms/104/reports/E-104/${item.path}?async=1`,
        {
          method: "POST",
          headers: {
            "x-client-mutation-id": `${item.path}-mutation-1`,
            "x-entry-last-updated-at": "2026-08-12T00:00:00.000Z",
          },
        }
      );

      assert.equal(response.status, 202);
      const payload = await response.json();
      assert.equal(payload.data.taskId, `${item.path}-task`);
      assert.equal(payload.meta.preconditionCheck, "deferred");
      assert.equal(staleCheckCalls, 0);
      assert.equal(actionCalls, 0);
    });

    const actionWorker = capturedWorker as (() => Promise<unknown>) | null;
    assert.ok(actionWorker);
    await actionWorker();
    assert.equal(staleCheckCalls, 1);
    assert.equal(actionCalls, 1);
  }
});

test("single update async variant 不等待 route Ragic precheck", async () => {
  const deps = createDeps();
  let capturedWorker: (() => Promise<unknown>) | null = null;
  let routeStaleCheckCalls = 0;
  let updateCalls = 0;
  deps.assertEntryNotModified = async () => {
    routeStaleCheckCalls += 1;
    throw new Error("route 不應執行 Ragic stale precheck");
  };
  deps.enqueueCreateTask = (input) => {
    assert.equal(input.taskType, "update-report");
    assert.equal(input.queueKey, "105:E-105");
    assert.equal(input.clientMutationId, "update-report-mutation-1");
    capturedWorker = input.worker;
    return {
      taskId: "update-report-task",
      status: "pending",
      createdAt: "2026-08-12T01:00:00.000Z",
    };
  };
  deps.updateReport = async (formId, entryId, rowId, _payload, options) => {
    updateCalls += 1;
    assert.equal(formId, "105");
    assert.equal(entryId, "E-105");
    assert.equal(rowId, "12");
    assert.equal(options?.expectedEntryLastUpdatedAt, "2026-08-12T00:00:00.000Z");
    return { rowId };
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/forms/105/reports/E-105/12?async=1`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-client-mutation-id": "update-report-mutation-1",
          "x-entry-last-updated-at": "2026-08-12T00:00:00.000Z",
        },
        body: JSON.stringify({ operatorId: "A001" }),
      }
    );

    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.data.taskId, "update-report-task");
    assert.equal(payload.meta.preconditionCheck, "deferred");
    assert.equal(routeStaleCheckCalls, 0);
    assert.equal(updateCalls, 0);
  });

  const updateWorker = capturedWorker as (() => Promise<unknown>) | null;
  assert.ok(updateWorker);
  await updateWorker();
  assert.equal(routeStaleCheckCalls, 0);
  assert.equal(updateCalls, 1);
});

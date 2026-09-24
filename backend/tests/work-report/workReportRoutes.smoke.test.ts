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
import { WorkReportTaskRegistryService } from "../../src/services/work-report/workReportTaskRegistryService";
import { workReportTaskRegistryService } from "../../src/services/work-report/workReportTaskRegistryService";
import { createReportTaskService } from "../../src/services/createReportTaskService";
import { workReportEditingPresenceService } from "../../src/services/workReportEditingPresenceService";
import { runWorkReportEntryMutationExclusive } from "../../src/services/work-report/workReportEntryMutationQueue";
import { realtimeEventBus } from "../../src/events/realtimeEventBus";
import {
  recordAuditLogRepository,
  type RecordAuditLogInsertInput,
} from "../../src/storage/sqlite/recordAuditLogRepository";

function createDeps(): WorkReportRouterDeps {
  return {
    runEntryMutationExclusive: async (_formId, _entryId, worker) => worker(),
    requestSync: async (_formId, _options) => ({ accepted: true }),
    listTasks: (_options) => [],
    getBlockingScheduleMutationSummary: (_formId) => ({
      hasBlockingScheduleMutation: false,
      count: 0,
    }),
    getUnresolvedScheduleMutationTaskIds: (_formId, _entryId) => [],
    acknowledgeScheduleMutationObservation: (_formId, _entryId, _taskIds) => 0,
    getTaskRecord: (_taskId) => null,
    getSyncStatus: async (_formId) => null,
    getReports: async (_formId, _query) => ({
      data: [],
      count: 0,
      totalCount: 0,
      hasMore: false,
      meta: { cacheSource: "sqlite", cacheState: "fresh", snapshotAt: null },
    }),
    getFullReports: async (formId, _options) => ({
      data: [],
      meta: {
        formId,
        count: 0,
        cacheSource: "sqlite",
        cacheState: "fresh",
        snapshotAt: null,
        expiresAt: null,
        refreshTriggered: false,
        truncated: false,
      },
    }),
    getReportFacets: async (_formId, _fields, _query) => ({
      data: {},
      meta: { cacheSource: "sqlite", cacheState: "fresh", snapshotAt: null },
    }),
    getReportAnalysis: async (_formId, _query) => ({
      data: { totalCount: 0, nonEmptyCount: 0, blankCount: 0, distinctCount: 0 },
      meta: { cacheSource: "sqlite", cacheState: "fresh", snapshotAt: null },
    }),
    getFormOptions: async (_formId, _fields) => ({}),
    getRawPreview: async (_formId, _limit) => [],
    getReportByEntryId: async (_formId, entryId, _options) => ({
      data: { id: entryId, reports: [] },
      meta: { cacheSource: "sqlite", cacheState: "fresh", snapshotAt: null },
    }),
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
    updateReport: async (_formId, _entryId, _rowId, _payload, _options) => ({
      rowId: "",
      beforeSnapshot: {},
    }),
    updateMainMachine: async (_formId, _entryId, machineCode, _options) => ({
      machineCode,
      previousMachineCode: null,
      changed: true,
    }),
    updateSortOrder: async (_formId, _entryId, sortOrder, _options) => ({
      sortOrder,
      previousSortOrder: null,
      changed: true,
    }),
    updatePlannedEndDate: async (_formId, _entryId, plannedEndDate, _options) => ({
      plannedEndDate,
      previousPlannedEndDate: null,
      changed: true,
    }),
    updateUrgent: async (_formId, _entryId, urgent, _options) => ({
      urgent,
      previousUrgent: false,
      changed: true,
    }),
    updateStartSchedule: async (_formId, _entryId, startSchedule, _options) => ({
      startSchedule,
      previousStartSchedule: false,
      changed: true,
    }),
    manualCloseWorkOrder: async (_formId, _entryId, action, _options) => ({
      action,
      previousStatus: null,
    }),
    deleteReport: async (_formId, _entryId, _rowId, _options) => ({
      rowId: "",
      beforeSnapshot: {},
    }),
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
    formId: overrides.formId ?? "901",
    workOrderNo: overrides.workOrderNo ?? "WO-901",
    entryId: overrides.entryId ?? "E-901",
    rowId: overrides.rowId ?? null,
    queueKey: overrides.queueKey ?? "901:E-901",
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

test("GET /api/forms/902/reports/:entryId?refresh=1 會走 detail refresh 讀取並允許 UI fallback", async (t) => {
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
    assert.equal(formId, "902");
    assert.equal(entryId, "E-902");
    assert.deepEqual(options, {
      refresh: true,
      allowSqliteFallbackOnRefresh: true,
      ragicReadMaxRetries: 0,
      persistRefreshToSqlite: true,
    });
    return {
      data: {
        id: "E-902",
        workOrderNo: "WO-902",
        customerPartNo: null,
        erpPartNo: null,
        status: "未結案",
        reports: [],
      },
      meta: {
        cacheSource: "sqlite",
        cacheState: "building",
        snapshotAt: "2026-03-09T00:00:00.000Z",
      },
    };
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/902/reports/E-902?refresh=1`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.id, "E-902");
    assert.equal(payload.meta.cacheState, "building");
    assert.equal(payload.meta.snapshotAt, "2026-03-09T00:00:00.000Z");
  });
});

test("POST /api/forms/902/sync?async=1 會啟動 902 sync task", async (t) => {
  const deps = createDeps();
  deps.requestSync = async (formId: string, options: { triggeredBy: string; waitForCompletion: boolean }) => {
      assert.equal(formId, "902");
      assert.equal(options.triggeredBy, "toolbar-refresh");
      assert.equal(options.waitForCompletion, false);
      return {
        taskId: "sync-902",
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
    const response = await fetch(`${baseUrl}/api/forms/902/sync?async=1`, {
      method: "POST",
      headers: {
        "x-sync-triggered-by": "toolbar-refresh",
      },
    });
    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.data.taskId, "sync-902");
    assert.equal(payload.meta.formId, "902");
    assert.equal(payload.meta.async, true);
  });
});

test("GET /api/forms/902/sync/status 會回傳最近 sync 狀態", async (t) => {
  const deps = createDeps();
  deps.getSyncStatus = async (formId: string) => {
      assert.equal(formId, "902");
      return {
        formId,
        status: "success",
        taskId: "sync-902",
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
    const response = await fetch(`${baseUrl}/api/forms/902/sync/status`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.formId, "902");
    assert.equal(payload.data.status, "success");
  });
});

test("同步分段耗時經 registry 保留並由任務列表與詳細 API 回傳", async () => {
  const registry = new WorkReportTaskRegistryService();
  const timings = {
    scanMs: 11, snapshotWriteMs: 23, promotionWaitMs: 250,
    finalReplayMs: 300, promotionSlotHeldMs: 307,
  };
  registry.upsertTask({
    taskId: "sync-timing-api", taskType: "sync", status: "running", formId: "902",
    ...timings,
  });
  registry.upsertTask({
    taskId: "sync-timing-api", taskType: "sync", status: "success", formId: "902",
  });
  const deps = createDeps();
  deps.listTasks = (options) => registry.listTasks(options);
  deps.getTaskRecord = (taskId) => registry.getTask(taskId);
  await withTestServer(deps, async (baseUrl) => {
    for (const path of ["tasks", "tasks/sync-timing-api"]) {
      const response = await fetch(`${baseUrl}/api/forms/902/${path}`);
      assert.equal(response.status, 200);
      const payload = await response.json();
      const task = Array.isArray(payload.data) ? payload.data[0] : payload.data;
      for (const [key, value] of Object.entries(timings)) {
        assert.equal(task[key], value, `${path} ${key}`);
      }
    }
  });
});

test("列表、facet 與 analysis read endpoints 都揭露 SQLite snapshot 狀態", async () => {
  const deps = createDeps();
  const readMeta = {
    cacheSource: "sqlite" as const,
    cacheState: "stale" as const,
    snapshotAt: "2026-08-14T00:00:00.000Z",
  };
  deps.getReports = async () => ({
    data: [],
    count: 0,
    totalCount: 0,
    hasMore: false,
    meta: readMeta,
  });
  deps.getReportFacets = async () => ({
    data: { status: [{ token: "未結案", count: 1 }] },
    meta: readMeta,
  });
  deps.getReportAnalysis = async () => ({
    data: { totalCount: 1, nonEmptyCount: 1, blankCount: 0, distinctCount: 1 },
    meta: readMeta,
  });

  await withTestServer(deps, async (baseUrl) => {
    const responses = await Promise.all([
      fetch(`${baseUrl}/api/forms/901/reports`),
      fetch(`${baseUrl}/api/forms/901/reports/facets?fields=status`),
      fetch(`${baseUrl}/api/forms/901/reports/analysis?field=status&columnType=text`),
    ]);
    for (const response of responses) {
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.meta.cacheSource, "sqlite");
      assert.equal(payload.meta.cacheState, "stale");
      assert.equal(payload.meta.snapshotAt, "2026-08-14T00:00:00.000Z");
    }
  });
});

test("GET /api/forms/901/reports/:entryId strict refresh 不會以 SQLite 舊快照冒充 mutation 對帳結果", async () => {
  const deps = createDeps();
  let acknowledgedEntryId: string | null = null;
  deps.acknowledgeScheduleMutationObservation = (_formId, entryId) => {
    acknowledgedEntryId = entryId;
    return 1;
  };
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
    assert.equal(formId, "901");
    assert.equal(entryId, "E-901");
    assert.deepEqual(options, {
      refresh: true,
      allowSqliteFallbackOnRefresh: false,
      ragicReadTimeoutMs: Math.min(env.RAGIC_MUTATION_READ_TIMEOUT_MS, 10_000),
      ragicReadMaxRetries: 1,
      persistRefreshToSqlite: true,
    });
    return {
      data: {
        id: "E-901",
        workOrderNo: "WO-901",
        customerPartNo: null,
        erpPartNo: null,
        status: "未結案",
        reports: [],
      },
      meta: {
        cacheSource: "ragic-live",
        cacheState: "fresh",
        snapshotAt: "2026-03-09T00:00:00.000Z",
      },
    };
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/forms/901/reports/E-901?refresh=1&strictRefresh=1`
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.id, "E-901");
    assert.equal(payload.meta.cacheSource, "ragic-live");
    assert.equal(acknowledgedEntryId, "E-901");
  });
});

test("strict refresh 只解除讀取開始前的未決任務，晚到失敗須再刷新", async () => {
  const deps = createDeps();
  const entryId = "E-REFRESH-OBSERVATION-RACE";
  const failMutation = async (key: string) => {
    const task = createReportTaskService.enqueue({
      taskType: "update-report", operationKind: "update-sort-order", formId: "901", entryId,
      queueKey: `901:${entryId}`, clientMutationId: key, operationFingerprint: key,
      worker: async () => { throw new HttpError(502, "write outcome unknown", "RAGIC_WRITE_VERIFY_FAILED"); },
    });
    await runWorkReportEntryMutationExclusive("901", entryId, async () => undefined);
    assert.equal(createReportTaskService.getTask(task.taskId)?.writeIndeterminate, true);
    return task.taskId;
  };
  let releaseRead!: () => void;
  const readBlocked = new Promise<void>((resolve) => { releaseRead = resolve; });
  let markReadStarted!: () => void;
  const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
  deps.getUnresolvedScheduleMutationTaskIds = workReportTaskRegistryService.getUnresolvedScheduleMutationTaskIds.bind(workReportTaskRegistryService);
  deps.acknowledgeScheduleMutationObservation = createReportTaskService.acknowledgeScheduleMutationObservation.bind(createReportTaskService);
  let readCount = 0;
  deps.getReportByEntryId = async () => {
    if (++readCount === 1) {
      markReadStarted();
      await readBlocked;
    }
    return { data: { id: entryId, reports: [] }, meta: { cacheSource: "ragic-live", cacheState: "fresh", snapshotAt: null } };
  };
  await withTestServer(deps, async (baseUrl) => {
    const url = `${baseUrl}/api/forms/901/reports/${entryId}?refresh=1&strictRefresh=1`;
    const oldRefresh = fetch(url);
    await readStarted;
    let laterId: string;
    try {
      laterId = await failMutation("refresh-race-later");
    } finally {
      releaseRead();
    }
    assert.equal((await oldRefresh).status, 200);
    assert.equal(createReportTaskService.getTask(laterId)?.writeIndeterminate, true, "OLD_REFRESH_MUST_NOT_SETTLE_LATER_WRITE");
    assert.deepEqual(deps.getUnresolvedScheduleMutationTaskIds("901", entryId), [laterId]);
    assert.equal((await fetch(url)).status, 200);
    assert.equal(createReportTaskService.getTask(laterId)?.writeIndeterminate, false);
    assert.deepEqual(deps.getUnresolvedScheduleMutationTaskIds("901", entryId), []);
  });
});

test("strict refresh 讀取失敗不解除未決任務", async () => {
  const deps = createDeps();
  let acknowledgements = 0;
  deps.getUnresolvedScheduleMutationTaskIds = () => ["unresolved"];
  deps.getReportByEntryId = async () => { throw new HttpError(503, "read failed", "RAGIC_STALE_CHECK_UNAVAILABLE"); };
  deps.acknowledgeScheduleMutationObservation = () => { acknowledgements += 1; return 1; };
  await withTestServer(deps, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/api/forms/901/reports/E-901?refresh=1&strictRefresh=1`)).status, 503);
    assert.equal(acknowledgements, 0);
  });
});

test("strictRefresh 未搭配 refresh 時不確認未決 schedule mutation", async () => {
  const deps = createDeps();
  let acknowledgeCount = 0;
  deps.acknowledgeScheduleMutationObservation = () => {
    acknowledgeCount += 1;
    return 1;
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/forms/901/reports/E-901?strictRefresh=1`
    );
    assert.equal(response.status, 200);
    assert.equal(acknowledgeCount, 0);
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
          formId: "901",
          workOrderNo: "WO-901",
          entryId: "E-901",
          rowId: "R-901",
          queueKey: "901:E-901",
          createdAt: "2026-07-06T10:00:00.000Z",
          startedAt: "2026-07-06T10:00:01.000Z",
          finishedAt: "2026-07-06T10:00:02.000Z",
          updatedAt: "2026-07-06T10:00:02.000Z",
          message: "新增報工背景任務完成（rowId: R-901）",
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
    const response = await fetch(`${baseUrl}/api/forms/901/reports/tasks/registry-create-success`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.status, "success");
    assert.equal(payload.data.result.rowId, "R-901");
    assert.equal(payload.data.taskType, "create-report");
  });
});

test("GET create task 會保留 entry-field confirmed observation", async () => {
  const deps = createDeps();
  deps.getTaskRecord = () => null;
  deps.getCreateTask = (taskId) => ({
    taskId,
    formId: "901",
    status: "success",
    createdAt: "2026-09-01T00:00:00.000Z",
    confirmedAt: "2026-09-01T00:00:01.000Z",
    result: {
      confirmedEntry: {
        entryId: "E-901",
        operation: "work-report-urgent",
        observedAt: "2026-09-01T00:00:01.000Z",
        patch: { urgent: "Yes" },
      },
    },
  });

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/forms/901/reports/tasks/confirmed-entry-task`
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.data.result.confirmedEntry, {
      entryId: "E-901",
      operation: "work-report-urgent",
      observedAt: "2026-09-01T00:00:01.000Z",
      patch: { urgent: "Yes" },
    });
  });
});

test("GET /reports/tasks/:taskId registry-only indeterminate task 保留完整 lifecycle wire contract", async () => {
  const deps = createDeps();
  deps.getCreateTask = () => null;
  deps.getTaskRecord = (taskId: string): WorkReportQueueTaskRecord | null => ({
    taskId,
    taskType: "update-report",
    status: "failed",
    formId: "901",
    workOrderNo: "WO-901",
    entryId: "E-901",
    rowId: null,
    queueKey: "901:E-901",
    createdAt: "2026-08-31T00:00:00.000Z",
    startedAt: "2026-08-31T00:00:01.000Z",
    slotAcquiredAt: "2026-08-31T00:00:01.250Z",
    writeStartedAt: "2026-08-31T00:00:01.500Z",
    finishedAt: "2026-08-31T00:00:02.000Z",
    lifecycleState: "indeterminate",
    acceptedAt: "2026-08-31T00:00:00.000Z",
    confirmedAt: null,
    updatedAt: "2026-08-31T00:00:02.000Z",
    message: "寫入結果尚未確認",
    errorCode: "TASK_REGISTRY_RECOVERED_AFTER_RESTART",
    errorMessage: "寫入結果尚未確認",
    actorClientId: "client-1",
    actorTabId: "tab-1",
    actorIp: "127.0.0.1",
    actorLabel: null,
    operationKind: "update-sort-order",
    source: null,
    writeIndeterminate: true,
    timings: {
      syncWaitMs: 1_250,
      entryQueueWaitMs: 250,
      currentReadMs: 100,
      currentReadLaneWaitMs: 10,
      currentReadUpstreamMs: 90,
      currentReadAttempts: 1,
      writeMs: 300,
      writeLaneWaitMs: 20,
      writeUpstreamMs: 280,
      writeAttempts: 1,
      verifyMs: 200,
      verifyLaneWaitMs: 30,
      verifyUpstreamMs: 170,
      verifyAttempts: 1,
      projectionEnqueueMs: 5,
      failurePhase: "verify",
    },
  });

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/forms/901/reports/tasks/registry-only-indeterminate`
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.status, "failed");
    assert.equal(payload.data.lifecycleState, "indeterminate");
    assert.equal(payload.data.acceptedAt, "2026-08-31T00:00:00.000Z");
    assert.equal(payload.data.confirmedAt, null);
    assert.equal(payload.data.writeIndeterminate, true);
    assert.equal(payload.data.slotAcquiredAt, "2026-08-31T00:00:01.250Z");
    assert.equal(payload.data.writeStartedAt, "2026-08-31T00:00:01.500Z");
    assert.deepEqual(payload.data.timings, {
      syncWaitMs: 1_250,
      entryQueueWaitMs: 250,
      currentReadMs: 100,
      currentReadLaneWaitMs: 10,
      currentReadUpstreamMs: 90,
      currentReadAttempts: 1,
      writeMs: 300,
      writeLaneWaitMs: 20,
      writeUpstreamMs: 280,
      writeAttempts: 1,
      verifyMs: 200,
      verifyLaneWaitMs: 30,
      verifyUpstreamMs: 170,
      verifyAttempts: 1,
      projectionEnqueueMs: 5,
      failurePhase: "verify",
    });
  });
});

test("GET /api/forms/:formId/reports/tasks/:taskId 以 registry success 覆蓋 local recovered failed", async () => {
  const deps = createDeps();
  deps.getCreateTask = (_taskId) => ({
    taskId: "registry-wins-success",
    taskType: "create-report",
    formId: "901",
    entryId: "E-901",
    queueKey: "901:E-901",
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
          formId: "901",
          workOrderNo: "WO-901",
          entryId: "E-901",
          rowId: "R-901-success",
          queueKey: "901:E-901",
          createdAt: "2026-07-06T10:00:00.000Z",
          startedAt: "2026-07-06T10:00:01.000Z",
          finishedAt: "2026-07-06T10:00:02.000Z",
          updatedAt: "2026-07-06T10:00:02.000Z",
          message: "新增報工背景任務完成（rowId: R-901-success）",
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
    const response = await fetch(`${baseUrl}/api/forms/901/reports/tasks/registry-wins-success`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.status, "success");
    assert.equal(payload.data.result.rowId, "R-901-success");
    assert.equal(payload.data.error, undefined);
  });
});

test("GET /api/forms/:formId/reports/tasks/:taskId 以 registry failed 覆蓋 local running", async () => {
  const deps = createDeps();
  deps.getCreateTask = (_taskId) => ({
    taskId: "registry-wins-failed",
    taskType: "update-report",
    formId: "901",
    entryId: "E-901",
    queueKey: "901:E-901",
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
    const response = await fetch(`${baseUrl}/api/forms/901/reports/tasks/registry-wins-failed`);
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
    formId: "901",
    entryId: "E-901",
    queueKey: "901:E-901",
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
    const response = await fetch(`${baseUrl}/api/forms/901/reports/tasks/route-merge-newer-local`);
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
    formId: "901",
    entryId: "E-901",
    queueKey: "901:E-901",
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
          queueKey: "sync:901",
        })
      : null;

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/901/reports/tasks/route-merge-local-fallback`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.status, "pending");
    assert.equal(payload.data.taskType, "create-report");
  });
});

test("POST /api/forms/902/reports/:entryId 會執行 902 create", async (t) => {
  const deps = createDeps();
  deps.createReport = async (formId: string, entryId: string, _payload, options) => {
      assert.equal(formId, "902");
      assert.equal(entryId, "E-902");
      assert.equal(options?.expectedEntryLastUpdatedAt, undefined);
      assert.equal(options?.skipEntryPreflight, true);
      assert.ok(options?.loadPreconditionEntrySnapshot);
      await options.loadPreconditionEntrySnapshot();
      return { rowId: "R-1" };
    };
  deps.enqueueSqliteProjectionAfterMutation = async (
    formId: string,
    entryId: string,
    reason: "create" | "update" | "delete"
  ) => {
      assert.equal(formId, "902");
      assert.equal(entryId, "E-902");
      assert.equal(reason, "create");
      return 0;
    };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/902/reports/E-902`, {
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
    return { machineCode, previousMachineCode: null, changed: true };
  };

  await withTestServer(deps, async (baseUrl) => {
    const createResponsePromise = fetch(`${baseUrl}/api/forms/901/reports/E-QUEUE`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operatorId: "A001" }),
    });
    await createStarted;

    const mainMachineResponsePromise = fetch(
      `${baseUrl}/api/forms/901/reports/E-QUEUE/main-machine`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ machineCode: "MA51" }),
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
    return { machineCode, previousMachineCode: null, changed: true };
  };

  await withTestServer(deps, async (baseUrl) => {
    const createResponsePromise = fetch(`${baseUrl}/api/forms/901/reports/E-ABORT-QUEUE`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operatorId: "A001" }),
    });
    await createStarted;

    const controller = new AbortController();
    const mainMachineRequest = fetch(
      `${baseUrl}/api/forms/901/reports/E-ABORT-QUEUE/main-machine`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ machineCode: "MA51" }),
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

test("POST /api/forms/902/reports/:entryId async create 不用 stale timestamp 擋新增", async () => {
  const deps = createDeps();
  const preconditionEntrySnapshot = { "demo_status": "未結案" };
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
    assert.equal(formId, "902");
    assert.equal(entryId, "E-902");
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
    const response = await fetch(`${baseUrl}/api/forms/902/reports/E-902?async=1`, {
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

test("POST /api/forms/901/reports/:entryId async create 狀態讀取逾時會自動重試後再寫入", async () => {
  const deps = createDeps();
  const preconditionEntrySnapshot = { "demo_status": "未結案" };
  let statusCheckCalls = 0;
  let createCalls = 0;
  let capturedWorker: (() => Promise<unknown>) | null = null;
  const sleepCalls: number[] = [];

  deps.sleep = async (ms) => {
    sleepCalls.push(ms);
  };
  deps.assertCreateEntryAcceptsReports = async (formId, entryId) => {
    statusCheckCalls += 1;
    assert.equal(formId, "901");
    assert.equal(entryId, "E-901");
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
    const response = await fetch(`${baseUrl}/api/forms/901/reports/E-901?async=1`, {
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

test("POST /api/forms/901/reports/:entryId async create 狀態讀取持續逾時會在上限後中止且不寫入", async () => {
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
    const response = await fetch(`${baseUrl}/api/forms/901/reports/E-901?async=1`, {
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

test("GET /api/forms/901/reports/:entryId/editing-presence 會回 presence snapshot", async () => {
  const deps = createDeps();
  deps.getEditingPresenceSnapshot = async (input) => {
    assert.equal(input.formId, "901");
    assert.equal(input.entryId, "E-901");
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
      `${baseUrl}/api/forms/901/reports/E-901/editing-presence?sessionId=tab-1`
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.hasOtherEditors, true);
    assert.equal(payload.data.otherEditorCount, 2);
  });
});

test("PUT /api/forms/901/reports/:entryId/editing-presence 會更新 presence", async () => {
  const deps = createDeps();
  deps.upsertEditingPresence = async (input) => {
    assert.equal(input.formId, "901");
    assert.equal(input.entryId, "E-901");
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
    const response = await fetch(`${baseUrl}/api/forms/901/reports/E-901/editing-presence`, {
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

test("POST /api/forms/902/reports/:entryId/batch-delete 會受理批次刪除任務", async () => {
  const deps = createDeps();
  let routeStaleCheckCalls = 0;
  deps.assertEntryNotModified = async () => {
    routeStaleCheckCalls += 1;
    throw new Error("route 不應執行 Ragic stale precheck");
  };
  deps.requestBatchDelete = async (input) => {
    assert.equal(input.formId, "902");
    assert.equal(input.entryId, "E-902");
    assert.deepEqual(input.rowIds, ["1001", "1002"]);
    assert.equal(input.expectedEntryLastUpdatedAt, "2026-03-30T12:00:00.000Z");
    assert.equal(input.editLockVersion, 7);
    return {
      taskId: "batch-delete-902",
      status: "pending",
      createdAt: "2026-03-30T00:00:00.000Z",
      requestedCount: 2,
    };
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/902/reports/E-902/batch-delete`, {
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
    assert.equal(payload.data.taskId, "batch-delete-902");
    assert.equal(payload.data.lifecycleState, "accepted");
    assert.equal(payload.data.acceptedAt, "2026-03-30T00:00:00.000Z");
    assert.equal(payload.data.confirmedAt, null);
    assert.equal(payload.meta.requestedCount, 2);
    assert.equal(payload.meta.preconditionCheck, "deferred");
    assert.equal(routeStaleCheckCalls, 0);
  });
});

test("POST /api/forms/902/reports/:entryId/batch-create 會受理批次新增任務", async () => {
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
    assert.equal(input.formId, "902");
    assert.equal(input.entryId, "E-902");
    assert.equal(input.rows.length, 2);
    assert.equal(input.rows[0].clientRowKey, "batch-row-1");
    assert.equal(input.rows[1].clientRowKey, "batch-row-2");
    assert.equal(input.expectedEntryLastUpdatedAt, "2026-03-30T12:00:00.000Z");
    assert.equal(input.editSessionId, "edit-session-1");
    assert.equal(input.editLockVersion, 7);
    return {
      taskId: "batch-create-902",
      status: "pending",
      createdAt: "2026-03-30T00:00:00.000Z",
      requestedCount: 2,
    };
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/902/reports/E-902/batch-create`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-entry-last-updated-at": "2026-03-30T12:00:00.000Z",
        "x-edit-session-id": "edit-session-1",
        "x-edit-lock-version": "7",
      },
      body: JSON.stringify({
        rows: [
          { payload: { machineId: "MB50" }, clientRowKey: "batch-row-1" },
          { payload: { machineId: "MA51" }, clientRowKey: "batch-row-2" },
        ],
      }),
    });
    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.data.taskId, "batch-create-902");
    assert.equal(payload.data.lifecycleState, "accepted");
    assert.equal(payload.data.acceptedAt, "2026-03-30T00:00:00.000Z");
    assert.equal(payload.data.confirmedAt, null);
    assert.equal(payload.meta.accepted, true);
    assert.deepEqual(preconditionCalls, [
      "editable:902:E-902:edit-session-1",
      "lock:902:E-902:7",
    ]);
    assert.equal(payload.meta.preconditionCheck, "skipped");
  });
});

test("POST /api/forms/902/reports/:entryId/batch-create 不用 stale timestamp 擋新增", async () => {
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
    const response = await fetch(`${baseUrl}/api/forms/902/reports/E-902/batch-create`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-entry-last-updated-at": "2026-03-30T12:00:00.000Z",
      },
      body: JSON.stringify({
        rows: [{ payload: { machineId: "MB50" }, clientRowKey: "batch-row-1" }],
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

test("POST /api/forms/902/reports/:entryId/batch-create 跳過 stale precheck timeout", async () => {
  const deps = createDeps();
  let requestBatchCreateCalled = false;
  let staleCheckCalls = 0;
  deps.assertEntryNotModified = async () => {
    staleCheckCalls += 1;
    throw new Error("ECONNABORTED");
  };
  deps.requestBatchCreate = async (input) => {
    requestBatchCreateCalled = true;
    assert.equal(input.formId, "902");
    assert.equal(input.entryId, "E-902");
    assert.equal(input.expectedEntryLastUpdatedAt, "2026-03-30T12:00:00.000Z");
    return {
      taskId: "batch-create-deferred-precheck",
      status: "pending",
      createdAt: "2026-03-30T00:00:00.000Z",
      requestedCount: input.rows.length,
    };
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/902/reports/E-902/batch-create`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-entry-last-updated-at": "2026-03-30T12:00:00.000Z",
      },
      body: JSON.stringify({
        rows: [{ payload: { machineId: "MB50" }, clientRowKey: "batch-row-1" }],
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
  const entryId = "E-901-row-lock";
  const rowId = "112708";

  const first = workReportEditingPresenceService.upsertPresence({
    formId: "901",
    entryId,
    rowId,
    sessionId: "tab-A",
    active: true,
    state: "editing",
  });
  assert.equal(first.canEdit, true);
  assert.equal(first.isCurrentSessionOwner, true);

  const second = workReportEditingPresenceService.upsertPresence({
    formId: "901",
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
    formId: "901",
    entryId,
    rowId,
    sessionId: "tab-A",
    active: false,
  });
});

test("同一列重新取得 lock 時會換 fencing version，舊 lease 不可沿用", () => {
  const entryId = "E-901-row-lock-version";
  const rowId = "112709";
  const first = workReportEditingPresenceService.upsertPresence({
    formId: "901",
    entryId,
    rowId,
    sessionId: "tab-A",
    active: true,
  });
  assert.equal(typeof first.lockVersion, "number");

  workReportEditingPresenceService.upsertPresence({
    formId: "901",
    entryId,
    rowId,
    sessionId: "tab-A",
    active: false,
  });
  const second = workReportEditingPresenceService.upsertPresence({
    formId: "901",
    entryId,
    rowId,
    sessionId: "tab-B",
    active: true,
  });

  assert.ok(second.lockVersion! > first.lockVersion!);
  assert.throws(() =>
    workReportEditingPresenceService.assertLockVersion({
      formId: "901",
      entryId,
      rowId,
      sessionId: "tab-B",
      expectedLockVersion: first.lockVersion,
    })
  );
  assert.doesNotThrow(() =>
    workReportEditingPresenceService.assertLockVersion({
      formId: "901",
      entryId,
      rowId,
      sessionId: "tab-B",
      expectedLockVersion: second.lockVersion,
    })
  );

  workReportEditingPresenceService.upsertPresence({
    formId: "901",
    entryId,
    rowId,
    sessionId: "tab-B",
    active: false,
  });
});

test("GET editing-presence 不帶 rowId 時會回工令層級的編輯摘要", async () => {
  const entryId = "E-901-summary";

  workReportEditingPresenceService.upsertPresence({
    formId: "901",
    entryId,
    rowId: "112708",
    sessionId: "tab-A",
    active: true,
    state: "editing",
  });

  const summary = workReportEditingPresenceService.getSnapshot({
    formId: "901",
    entryId,
    sessionId: "tab-B",
  });
  assert.equal(summary.hasOtherEditors, true);
  assert.equal(summary.otherEditorCount, 1);
  assert.equal(summary.canEdit, true);

  workReportEditingPresenceService.upsertPresence({
    formId: "901",
    entryId,
    rowId: "112708",
    sessionId: "tab-A",
    active: false,
  });
});

test("POST /api/forms/902/reports/:entryId conflict 會回 409", async () => {
  const deps = createDeps();
  deps.createReport = async () => {
    throw new HttpError(
      409,
      "這筆工令在你編輯期間已被其他人更新，請先刷新後再重新送出。",
      "ENTRY_CONFLICT"
    );
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/902/reports/E-902`, {
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

test("POST /api/forms/902/reports/:entryId lock version 不符會回 409", async () => {
  const deps = createDeps();
  deps.assertEntryLockVersion = async () => {
    throw new HttpError(
      409,
      "你已失去這筆工令的編輯權，請重新整理或稍後再試。",
      "ENTRY_EDIT_LOCKED"
    );
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/902/reports/E-902`, {
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

test("POST /api/forms/901/ragic-callback 帶 token 與 entryId 可接受 callback", async () => {
  const deps = createDeps();
  deps.requestRagicCallbackRefresh = async (input) => {
    assert.equal(input.formId, "901");
    assert.equal(input.entryId, "E-901");
    assert.equal(input.eventType, "row-updated");
    assert.equal(input.rowId, "R-99");
    assert.equal(input.source, "ragic");
    return {
      accepted: true,
      taskId: "callback-901",
      status: "pending",
      createdAt: "2026-03-17T00:00:00.000Z",
    };
  };

  const originalToken = process.env.RAGIC_CALLBACK_TOKEN;
  process.env.RAGIC_CALLBACK_TOKEN = "callback-secret";

  try {
    await withTestServer(deps, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/forms/901/ragic-callback`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ragic-callback-token": "callback-secret",
        },
        body: JSON.stringify({
          entryId: "E-901",
          eventType: "row-updated",
          rowId: "R-99",
          source: "ragic",
        }),
      });
      assert.equal(response.status, 202);
      const payload = await response.json();
      assert.equal(payload.data.accepted, true);
      assert.equal(payload.data.formId, "901");
      assert.equal(payload.data.entryId, "E-901");
      assert.equal(payload.data.eventType, "row-updated");
    });
  } finally {
    process.env.RAGIC_CALLBACK_TOKEN = originalToken;
  }
});

test("POST /api/forms/901/ragic-callback token 錯誤會回 403", async () => {
  const deps = createDeps();
  const originalToken = process.env.RAGIC_CALLBACK_TOKEN;
  process.env.RAGIC_CALLBACK_TOKEN = "callback-secret";

  try {
    await withTestServer(deps, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/forms/901/ragic-callback`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ragic-callback-token": "wrong-token",
        },
        body: JSON.stringify({
          entryId: "E-901",
          eventType: "entry-updated",
        }),
      });
      assert.equal(response.status, 403);
    });
  } finally {
    process.env.RAGIC_CALLBACK_TOKEN = originalToken;
  }
});

test("POST /api/forms/901/ragic-callback 缺 entryId 會回 400", async () => {
  const deps = createDeps();
  const originalToken = process.env.RAGIC_CALLBACK_TOKEN;
  process.env.RAGIC_CALLBACK_TOKEN = "callback-secret";

  try {
    await withTestServer(deps, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/forms/901/ragic-callback`, {
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

test("PUT /api/forms/901/reports/:entryId/main-machine 會更新主表機台並寫 audit", async (t) => {
  const deps = createDeps();
  const audits: RecordAuditLogInsertInput[] = [];
  t.mock.method(recordAuditLogRepository, "insert", async (input: RecordAuditLogInsertInput) => {
    audits.push(input);
  });
  let projectionCalled = false;
  deps.updateMainMachine = async (formId, entryId, machineCode) => {
    assert.equal(formId, "901");
    assert.equal(entryId, "E-901");
    assert.equal(machineCode, "MA51");
    return { machineCode, previousMachineCode: "MB50", changed: true };
  };
  deps.enqueueSqliteProjectionAfterMutation = async (formId, entryId, reason) => {
    assert.equal(formId, "901");
    assert.equal(entryId, "E-901");
    assert.equal(reason, "update");
    projectionCalled = true;
    return 0;
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/901/reports/E-901/main-machine`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        machineCode: "MA51",
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.machineCode, "MA51");
    assert.equal(payload.meta.formId, "901");
    assert.equal(projectionCalled, true);
    assert.deepEqual(audits[0]?.beforeSnapshot, { machineCode: "MB50" });
    assert.deepEqual(audits[0]?.afterPatch, { machineCode: "MA51" });
  });
});

test("PUT /api/forms/902/reports/:entryId/:rowId 會執行 902 update", async (t) => {
  const deps = createDeps();
  const audits: RecordAuditLogInsertInput[] = [];
  t.mock.method(recordAuditLogRepository, "insert", async (input: RecordAuditLogInsertInput) => {
    audits.push(input);
  });
  deps.assertEntryEditableBySession = async (input) => {
      assert.equal(input.formId, "902");
      assert.equal(input.entryId, "E-902");
      assert.equal(input.rowId, "12");
    };
  deps.assertEntryLockVersion = async (input) => {
      assert.equal(input.formId, "902");
      assert.equal(input.entryId, "E-902");
      assert.equal(input.rowId, "12");
    };
  deps.updateReport = async (formId: string, entryId: string, rowId: string) => {
      assert.equal(formId, "902");
      assert.equal(entryId, "E-902");
      assert.equal(rowId, "12");
      return { rowId, beforeSnapshot: { operatorId: "A000" } };
    };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/902/reports/E-902/12`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ operatorId: "A001" }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.rowId, "12");
    assert.deepEqual(audits[0]?.beforeSnapshot, { operatorId: "A000" });
    assert.deepEqual(audits[0]?.afterPatch, { operatorId: "A001" });
  });
});

test("DELETE /api/forms/902/reports/:entryId/:rowId 會受理單筆刪除任務", async (t) => {
  const deps = createDeps();
  deps.assertEntryEditableBySession = async (input) => {
      assert.equal(input.formId, "902");
      assert.equal(input.entryId, "E-902");
      assert.equal(input.rowId, "12");
    };
  deps.assertEntryLockVersion = async (input) => {
      assert.equal(input.formId, "902");
      assert.equal(input.entryId, "E-902");
      assert.equal(input.rowId, "12");
    };
  deps.requestBatchDelete = async (input) => {
      assert.equal(input.taskType, "delete-report");
      assert.equal(input.formId, "902");
      assert.equal(input.entryId, "E-902");
      assert.deepEqual(input.rowIds, ["12"]);
      return {
        taskId: "delete-902",
        status: "pending",
        createdAt: "2026-03-30T00:00:00.000Z",
        requestedCount: 1,
      };
    };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/902/reports/E-902/12`, {
      method: "DELETE",
    });
    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.data.taskId, "delete-902");
    assert.equal(payload.meta.accepted, true);
    assert.equal(payload.meta.requestedCount, 1);
    assert.equal(payload.meta.rowId, "12");
  });
});

test("PUT /api/forms/901/reports/:entryId/sort-order 缺少 mutation id 時拒絕排入", async () => {
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
      `${baseUrl}/api/forms/901/reports/E-901/sort-order`,
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

test("新版排序 identity 不可被舊分頁降級成沒有 expected 的請求", async () => {
  const deps = createDeps();
  let enqueued = false;
  deps.enqueueCreateTask = () => { enqueued = true; throw new Error("must not enqueue"); };
  await withTestServer(deps, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/forms/901/reports/E-901/sort-order`, {
      method: "PUT", headers: { "content-type": "application/json", "x-client-mutation-id": "sort-field-v1:test" },
      body: JSON.stringify({ sortOrder: 7 }),
    });
    assert.equal(response.status, 409);
    assert.equal(enqueued, false);
  });
});

test("PUT /api/forms/901/reports/:entryId/sort-order 拒絕非數字排序碼", async () => {
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
        `${baseUrl}/api/forms/901/reports/E-901/sort-order`,
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

test("PUT /api/forms/901/reports/:entryId/sort-order 以同工令 queue 建立可追蹤更新任務", async () => {
  const deps = createDeps();
  let capturedWorker: (() => Promise<unknown>) | null = null;
  let updateCalls = 0;
  let projectionCalls = 0;
  deps.enqueueCreateTask = (input) => {
    assert.equal(input.taskType, "update-report");
    assert.equal(input.formId, "901");
    assert.equal(input.entryId, "E-901");
    assert.equal(input.queueKey, "901:E-901");
    assert.equal(input.clientMutationId, "sort-order-mutation-1");
    assert.equal(input.workOrderNo, "WO-901");
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
    assert.equal(formId, "901");
    assert.equal(entryId, "E-901");
    assert.equal(sortOrder, 4);
    assert.equal(options?.expectedEntryLastUpdatedAt, undefined);
    assert.equal(options?.expectedSortOrder, 2);
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
    assert.equal(formId, "901");
    assert.equal(entryId, "E-901");
    assert.equal(sortOrder, 4);
    assert.equal(enqueuedSeq, 23);
    return "applied";
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/forms/901/reports/E-901/sort-order`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-client-mutation-id": "sort-order-mutation-1",
          "x-debug-work-order-no": "WO-901",
          "x-debug-device-label": encodeURIComponent("生管工作站"),
        },
        body: JSON.stringify({ sortOrder: 4, expectedSortOrder: 2 }),
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

test("PUT /api/forms/:formId/reports/:entryId/planned-end-date 共用 queue 與 strict timestamp contract", async () => {
  for (const formId of ["901", "902"] as const) {
    const deps = createDeps();
    let capturedWorker: (() => Promise<unknown>) | null = null;
    let projectionCalls = 0;
    deps.enqueueCreateTask = (input) => {
      assert.equal(input.taskType, "update-report");
      assert.equal(input.operationKind, "update-planned-end-date");
      assert.equal(input.formId, formId);
      assert.equal(input.entryId, `E-${formId}`);
      assert.equal(input.queueKey, `${formId}:E-${formId}`);
      assert.equal(input.clientMutationId, `planned-date-${formId}`);
      assert.match(input.operationFingerprint, /^[a-f0-9]{64}$/);
      capturedWorker = input.worker;
      return {
        taskId: `planned-date-task-${formId}`,
        status: "pending",
        createdAt: "2026-08-28T00:00:00.000Z",
      };
    };
    deps.updatePlannedEndDate = async (
      actualFormId,
      entryId,
      plannedEndDate,
      options
    ) => {
      assert.equal(actualFormId, formId);
      assert.equal(entryId, `E-${formId}`);
      assert.equal(plannedEndDate, "2026-09-05");
      assert.equal(options?.expectedEntryLastUpdatedAt, "2026-08-28T01:00:00.000Z");
      return {
        plannedEndDate,
        previousPlannedEndDate: "2026-09-01",
        changed: true,
      };
    };
    deps.enqueueSqliteProjectionAfterMutation = async () => 0;
    deps.applyQueuedSqliteProjectionAfterMutation = async () => {
      projectionCalls += 1;
      return "applied";
    };

    await withTestServer(deps, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/forms/${formId}/reports/E-${formId}/planned-end-date`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "x-client-mutation-id": `planned-date-${formId}`,
            "x-entry-last-updated-at": "2026-08-28T01:00:00.000Z",
          },
          body: JSON.stringify({ plannedEndDate: "2026-09-05" }),
        }
      );
      assert.equal(response.status, 202);
      const payload = await response.json();
      assert.equal(payload.data.taskId, `planned-date-task-${formId}`);
      assert.equal(payload.meta.accepted, true);
      assert.equal(payload.meta.preconditionCheck, "deferred");
      assert.ok(capturedWorker);
      await capturedWorker!();
      assert.equal(projectionCalls, 0);
    });
  }
});

test("PUT urgent 在 901/902 共用 checkbox queue 與 strict timestamp contract", async () => {
  for (const formId of ["901", "902"] as const) {
    const deps = createDeps();
    let capturedWorker: (() => Promise<unknown>) | null = null;
    deps.enqueueCreateTask = (input) => {
      assert.equal(input.operationKind, "update-urgent");
      assert.equal(input.queueKey, `${formId}:E-${formId}`);
      assert.equal(input.clientMutationId, `urgent-${formId}`);
      assert.match(input.operationFingerprint, /^[a-f0-9]{64}$/);
      capturedWorker = input.worker;
      return {
        taskId: `urgent-task-${formId}`,
        status: "pending",
        createdAt: "2026-08-31T00:00:00.000Z",
      };
    };
    deps.updateUrgent = async (actualFormId, entryId, urgent, options) => {
      assert.equal(actualFormId, formId);
      assert.equal(entryId, `E-${formId}`);
      assert.equal(urgent, true);
      assert.equal(options?.expectedEntryLastUpdatedAt, "2026-08-31T01:00:00.000Z");
      options?.onConfirmedEntry?.({
        entryId,
        observedAt: "2026-09-01T01:00:00.000Z",
        entryLastUpdatedAt: null,
        rawEntry: { _ragicId: entryId, "9001088": "Yes" },
      });
      return { urgent, previousUrgent: false, changed: true };
    };
    deps.enqueueSqliteProjectionAfterMutation = async () => 0;

    await withTestServer(deps, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/forms/${formId}/reports/E-${formId}/urgent`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "x-client-mutation-id": `urgent-${formId}`,
            "x-entry-last-updated-at": "2026-08-31T01:00:00.000Z",
          },
          body: JSON.stringify({ urgent: true }),
        }
      );
      assert.equal(response.status, 202);
      const payload = await response.json();
      assert.equal(payload.data.taskId, `urgent-task-${formId}`);
      assert.equal(payload.meta.preconditionCheck, "deferred");
      assert.ok(capturedWorker);
      const workerResult = (await capturedWorker!()) as {
        confirmedEntry?: unknown;
      };
      assert.deepEqual(workerResult.confirmedEntry, {
        entryId: `E-${formId}`,
        operation: "work-report-urgent",
        observedAt: "2026-09-01T01:00:00.000Z",
        patch: { urgent: "Yes" },
      });
    });
  }
});

test("PUT start-schedule 只在 Form 901 建立可追蹤 checkbox task", async () => {
  const deps = createDeps();
  let capturedWorker: (() => Promise<unknown>) | null = null;
  deps.enqueueCreateTask = (input) => {
    assert.equal(input.operationKind, "update-start-schedule");
    assert.equal(input.queueKey, "901:E-901");
    capturedWorker = input.worker;
    return {
      taskId: "start-schedule-task",
      status: "pending",
      createdAt: "2026-08-31T00:00:00.000Z",
    };
  };
  deps.updateStartSchedule = async (formId, entryId, startSchedule, options) => {
    assert.equal(formId, "901");
    assert.equal(entryId, "E-901");
    assert.equal(startSchedule, true);
    assert.equal(options?.expectedEntryLastUpdatedAt, "2026-08-31T01:00:00.000Z");
    return { startSchedule, previousStartSchedule: false, changed: true };
  };
  deps.enqueueSqliteProjectionAfterMutation = async () => 0;

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/forms/901/reports/E-901/start-schedule`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-client-mutation-id": "start-schedule-901",
          "x-entry-last-updated-at": "2026-08-31T01:00:00.000Z",
        },
        body: JSON.stringify({ startSchedule: true }),
      }
    );
    assert.equal(response.status, 202);
    assert.ok(capturedWorker);
    await capturedWorker!();
  });
});

test("PUT planned-end-date 缺 entry timestamp 時拒絕排入", async () => {
  const deps = createDeps();
  let enqueueCalled = false;
  deps.enqueueCreateTask = (_input) => {
    enqueueCalled = true;
    return {
      taskId: "unexpected",
      status: "pending",
      createdAt: "2026-08-28T00:00:00.000Z",
    };
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/forms/901/reports/E-901/planned-end-date`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-client-mutation-id": "planned-date-without-timestamp",
        },
        body: JSON.stringify({ plannedEndDate: "2026-09-05" }),
      }
    );
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error.code, "ENTRY_PRECONDITION_REQUIRED");
    assert.equal(enqueueCalled, false);
  });
});

test("PUT planned-end-date no-op 仍刷新 authoritative projection", async () => {
  const deps = createDeps();
  let capturedWorker: (() => Promise<unknown>) | null = null;
  let projectionCalls = 0;
  deps.enqueueCreateTask = (input) => {
    capturedWorker = input.worker;
    return {
      taskId: "planned-date-noop-task",
      status: "pending",
      createdAt: "2026-08-28T00:00:00.000Z",
    };
  };
  deps.updatePlannedEndDate = async (_formId, _entryId, plannedEndDate) => ({
    plannedEndDate,
    previousPlannedEndDate: plannedEndDate,
    changed: false,
  });
  deps.enqueueSqliteProjectionAfterMutation = async () => 24;
  deps.applyQueuedSqliteProjectionAfterMutation = async () => {
    projectionCalls += 1;
    return "applied";
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/forms/901/reports/E-901/planned-end-date`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-client-mutation-id": "planned-date-noop-1",
          "x-entry-last-updated-at": "2026-08-28T01:00:00.000Z",
        },
        body: JSON.stringify({ plannedEndDate: "2026-09-05" }),
      }
    );
    assert.equal(response.status, 202);
    assert.ok(capturedWorker);
    await capturedWorker!();
    assert.equal(projectionCalls, 1);
  });
});

test("GET blocking-schedule-mutations 回傳 registry 無截斷 aggregate", async () => {
  const deps = createDeps();
  deps.getBlockingScheduleMutationSummary = (formId) => {
    assert.equal(formId, "901");
    return {
      hasBlockingScheduleMutation: true,
      count: 201,
    };
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/forms/901/tasks/blocking-schedule-mutations`
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.data, {
      hasBlockingScheduleMutation: true,
      count: 201,
    });
    assert.equal(payload.meta.formId, "901");
  });
});

test("PUT /api/forms/901/reports/:entryId/sort-order 不執行整筆 Ragic stale precheck", async () => {
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
      `${baseUrl}/api/forms/901/reports/E-901/sort-order`,
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

test("PUT /api/forms/901/reports/:entryId/sort-order no-op 仍刷新 projection", async () => {
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
      `${baseUrl}/api/forms/901/reports/E-901/sort-order`,
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

test("PUT /api/forms/901/reports/:entryId/sort-order projection 延後時不發布舊 SQLite refresh 事件", async () => {
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
    if (event.formId === "901") {
      publishedTypes.push(event.type);
    }
  });

  try {
    await withTestServer(deps, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/forms/901/reports/E-901/sort-order`,
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

test("PUT /api/forms/901/reports/:entryId/sort-order projection 失敗時不發布舊 SQLite refresh 事件", async () => {
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
    if (event.formId === "901") {
      publishedTypes.push(event.type);
    }
  });

  try {
    await withTestServer(deps, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/forms/901/reports/E-901/sort-order`,
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

test("DELETE /api/forms/901/reports/:entryId/:rowId 不等待 route stale check，交由刪除 worker 驗證", async () => {
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
    assert.equal(input.formId, "901");
    assert.equal(input.entryId, "E-901");
    assert.deepEqual(input.rowIds, ["122298"]);
    assert.equal(input.expectedEntryLastUpdatedAt, "2026-03-30T12:00:00.000Z");
    assert.equal(input.editLockVersion, 3);
    return {
      taskId: "delete-901-deferred",
      status: "pending",
      createdAt: "2026-03-30T00:00:00.000Z",
      requestedCount: 1,
    };
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/901/reports/E-901/122298`, {
      method: "DELETE",
      headers: {
        "x-entry-last-updated-at": "2026-03-30T12:00:00.000Z",
        "x-edit-lock-version": "3",
      },
    });
    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.data.taskId, "delete-901-deferred");
    assert.equal(payload.meta.preconditionCheck, "deferred");
    assert.equal(routeStaleCheckCalls, 0);
  });
});

test("main-machine async variant 先受理再由同 entry worker 更新並寫 audit", async (t) => {
  const deps = createDeps();
  const audits: RecordAuditLogInsertInput[] = [];
  t.mock.method(recordAuditLogRepository, "insert", async (input: RecordAuditLogInsertInput) => {
    audits.push(input);
  });
  let capturedWorker: (() => Promise<unknown>) | null = null;
  let updateCalls = 0;
  deps.enqueueCreateTask = (input) => {
    assert.equal(input.taskType, "update-report");
    assert.equal(input.operationKind, "update-main-machine");
    assert.equal(input.queueKey, "901:E-901");
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
    assert.equal(formId, "901");
    assert.equal(entryId, "E-901");
    assert.equal(machineCode, "MA51");
    assert.equal(options?.expectedEntryLastUpdatedAt, "2026-08-12T00:00:00.000Z");
    return { machineCode, previousMachineCode: "MB50", changed: true };
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/forms/901/reports/E-901/main-machine?async=1`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-client-mutation-id": "main-machine-mutation-1",
          "x-entry-last-updated-at": "2026-08-12T00:00:00.000Z",
        },
        body: JSON.stringify({ machineCode: "MA51" }),
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
  assert.equal(audits[0]?.taskId, "main-machine-task");
  assert.deepEqual(audits[0]?.beforeSnapshot, { machineCode: "MB50" });
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
    return { machineCode, previousMachineCode: null, changed: true };
  };

  const samples: number[] = [];
  await withTestServer(deps, async (baseUrl) => {
    for (let index = 0; index < 30; index += 1) {
      const startedAt = performance.now();
      const response = await fetch(
        `${baseUrl}/api/forms/901/reports/E-LATENCY-${index}/main-machine?async=1`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "x-client-mutation-id": `main-machine-latency-${index}`,
          },
          body: JSON.stringify({ machineCode: "MA51" }),
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

test("close/reopen async variant 都先受理並在 worker 寫 audit", async (t) => {
  const audits: RecordAuditLogInsertInput[] = [];
  t.mock.method(recordAuditLogRepository, "insert", async (input: RecordAuditLogInsertInput) => {
    audits.push(input);
  });
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
      expectedEntryLastUpdatedAt,
      options
    ) => {
      staleCheckCalls += 1;
      assert.equal(formId, "901");
      assert.equal(entryId, "E-901");
      assert.equal(expectedEntryLastUpdatedAt, "2026-08-12T00:00:00.000Z");
      assert.equal(options?.expectedEntrySnapshotHash, `sha256:${"a".repeat(64)}`);
    };
    deps.enqueueCreateTask = (input) => {
      assert.equal(input.taskType, "update-report");
      assert.equal(input.operationKind, item.operationKind);
      assert.equal(input.queueKey, "901:E-901");
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
      assert.equal(formId, "901");
      assert.equal(entryId, "E-901");
      assert.equal(action, item.action);
      assert.equal(options?.expectedEntryLastUpdatedAt, "2026-08-12T00:00:00.000Z");
      return {
        action,
        previousStatus: action === "close" ? "未結案" : "已結案",
      };
    };

    await withTestServer(deps, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/forms/901/reports/E-901/${item.path}?async=1`,
        {
          method: "POST",
          headers: {
            "x-client-mutation-id": `${item.path}-mutation-1`,
            "x-entry-last-updated-at": "2026-08-12T00:00:00.000Z",
            "x-entry-snapshot-hash": `sha256:${"a".repeat(64)}`,
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
    const audit = audits.at(-1);
    assert.equal(audit?.taskId, `${item.path}-task`);
    assert.deepEqual(audit?.afterPatch, { action: item.action });
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
    assert.equal(input.operationKind, "update-report-row");
    assert.equal(input.queueKey, "902:E-902");
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
    assert.equal(formId, "902");
    assert.equal(entryId, "E-902");
    assert.equal(rowId, "12");
    assert.equal(options?.expectedEntryLastUpdatedAt, "2026-08-12T00:00:00.000Z");
    return { rowId, beforeSnapshot: {} };
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/forms/902/reports/E-902/12?async=1`,
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

for (const [endpoint, value, expectedKey, expectedValue, method] of [
  ["planned-end-date", "2026-09-17", "expectedPlannedEndDate", null, "updatePlannedEndDate"],
  ["main-machine", "MA51", "expectedMachineCode", "MB50", "updateMainMachine"],
  ["urgent", true, "expectedUrgent", false, "updateUrgent"],
  ["start-schedule", true, "expectedStartSchedule", false, "updateStartSchedule"],
] as const) {
  test(`${endpoint} route 在 worker 保留原值且不用舊 timestamp`, async () => {
    const deps = createDeps();
    let observed = false;
    const original = deps[method] as (...args: unknown[]) => Promise<unknown>;
    (deps as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
      assert.equal((args[3] as Record<string, unknown>)[expectedKey], expectedValue);
      observed = true;
      return original(...args);
    };
    let work: (() => Promise<unknown>) | undefined;
    deps.enqueueCreateTask = (input) => {
      work = input.worker;
      return { taskId: `field-${endpoint}`, status: "pending", createdAt: new Date().toISOString(), accepted: true };
    };
    await withTestServer(deps, async (baseUrl) => {
      const key = expectedKey[8].toLowerCase() + expectedKey.slice(9);
      const response = await fetch(`${baseUrl}/api/forms/901/reports/1/${endpoint}?async=1`, {
        method: "PUT", headers: { "Content-Type": "application/json", "x-client-mutation-id": `entry-field-v1:${endpoint}` },
        body: JSON.stringify({ [key]: value, [expectedKey]: expectedValue }),
      });
      assert.equal(response.status, 202);
      assert.ok(work); await work();
      assert.equal(observed, true);
      const missing = await fetch(`${baseUrl}/api/forms/901/reports/1/${endpoint}?async=1`, {
        method: "PUT", headers: { "Content-Type": "application/json", "x-client-mutation-id": `entry-field-v1:missing-${endpoint}` },
        body: JSON.stringify({ [key]: value }),
      });
      assert.equal(missing.status, 400);
    });
  });
}

for (const useAsync of [false, true]) {
  test(`明細 ${useAsync ? "背景" : "同步"} route 把原始 hash 傳入 service 並從寫入 payload 分離`, async () => {
    const deps = createDeps();
    let observed = false;
    deps.updateReport = async (_form, _entry, row, payload, options) => {
      assert.equal(options?.expectedRowSnapshotHash, "a".repeat(64));
      assert.equal(payload.expectedRowSnapshotHash, undefined);
      observed = true; return { rowId: row, beforeSnapshot: {} };
    };
    let work: (() => Promise<unknown>) | undefined;
    deps.enqueueCreateTask = input => { work = input.worker; return { taskId: "row-scope", status: "pending", createdAt: new Date().toISOString(), accepted: true }; };
    await withTestServer(deps, async baseUrl => {
      const response = await fetch(`${baseUrl}/api/forms/901/reports/1/42${useAsync ? "?async=1" : ""}`, {
        method: "PUT", headers: { "Content-Type": "application/json", "x-client-mutation-id": "row-scope" },
        body: JSON.stringify({ remark: "next", expectedRowSnapshotHash: "a".repeat(64) }),
      });
      assert.equal(response.status, useAsync ? 202 : 200);
      if (useAsync) { assert.ok(work); await work(); }
      assert.equal(observed, true);
    });
  });
}

test("批次刪除原值須完整對應選取列，單筆刪除也傳遞列版本", async () => {
  const deps = createDeps();
  const calls: Array<Record<string, string> | undefined> = [];
  deps.requestBatchDelete = async input => {
    calls.push(input.expectedRowSnapshotHashes);
    return { taskId: "delete-scope", status: "pending", createdAt: new Date().toISOString() };
  };
  await withTestServer(deps, async baseUrl => {
    for (const [suffix, method, body, status] of [
      ["42", "DELETE", { expectedRowSnapshotHash: "a".repeat(64) }, 202],
      ["batch-delete", "POST", { rowIds: ["42", "43"], expectedRowSnapshotHashes: { "42": "a".repeat(64), "43": "b".repeat(64) } }, 202],
      ["batch-delete", "POST", { rowIds: ["42", "43"], expectedRowSnapshotHashes: { "42": "a".repeat(64) } }, 400],
    ] as const) {
      const response = await fetch(`${baseUrl}/api/forms/901/reports/1/${suffix}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(response.status, status);
    }
    assert.deepEqual(calls, [{ "42": "a".repeat(64) }, { "42": "a".repeat(64), "43": "b".repeat(64) }]);
  });
});

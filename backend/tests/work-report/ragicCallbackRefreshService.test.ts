import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HttpError } from "../../src/utils/httpError";
import {
  RagicCallbackRefreshService,
  type CallbackTask,
} from "../../src/services/ragicCallbackRefreshServiceFactory";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function waitForTaskCompletion(
  service: RagicCallbackRefreshService,
  taskId: string
): Promise<CallbackTask> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const task = service.getTask(taskId);
    if (task && (task.status === "success" || task.status === "failed")) {
      return task;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`callback task did not finish in time: ${taskId}`);
}

async function waitForCondition(
  predicate: () => boolean,
  message: string
): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(message);
}

test("persisted pending/running callback 重啟後會重排 refresh，而不是直接標失敗", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ragic-callback-refresh-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const storeFile = join(tempDir, "tasks.json");
  const now = "2026-07-03T00:00:00.000Z";
  await writeFile(
    storeFile,
    JSON.stringify({
      version: "v1",
      savedAt: now,
      tasks: [
        {
          taskId: "persisted-callback-1",
          formId: "104",
          entryId: "E-104",
          eventType: "entry-updated",
          source: "ragic-post-workflow-104",
          status: "running",
          createdAt: now,
          updatedAt: now,
          latestCallbackAt: now,
          latestCallbackSeq: 1,
          coalescedCount: 0,
        },
      ],
    }),
    "utf-8"
  );

  let refreshCount = 0;
  let publishedEntryId = "";
  let publishedFormId = "";

  const service = new RagicCallbackRefreshService({
    delayMs: 0,
    dedupeWindowMs: 5_000,
    taskPersistEnabled: true,
    taskStoreFile: storeFile,
    shouldUseSqliteReadForForm: () => true,
    getSyncState: async () => ({ status: "success" }),
    projectEntryAfterMutation: async () => undefined,
    refreshEntry: async (_formId, entryId) => {
      refreshCount += 1;
      return {
        id: entryId,
        workOrderNo: "WO-1",
        customerPartNo: null,
        erpPartNo: null,
        status: "未結案",
        reports: [],
      };
    },
    upsertEntrySnapshot: async () => ({ rowCount: 1 }),
    touchSyncStateSnapshot: async () => undefined,
    deleteEntrySnapshot: async () => undefined,
    publishWorkReportUpdated: (_formId, entryId) => {
      publishedEntryId = entryId;
    },
    publishWorkReportFormUpdated: (formId) => {
      publishedFormId = formId;
    },
    getRecentMutationProjection: () => null,
  });

  await service.initialize();

  const finishedTask = await waitForTaskCompletion(service, "persisted-callback-1");
  await service.drain();
  await service.flush();
  assert.equal(finishedTask.status, "success", finishedTask.error?.message);
  assert.equal(refreshCount, 1);
  assert.equal(publishedEntryId, "E-104");
  assert.equal(publishedFormId, "104");
});

test("callback 在 sync running 時會先入 replay queue，再直接刷新 entry snapshot", async () => {
  let projectionReason = "";
  let refreshedEntryId = "";
  let publishedEntryId = "";
  let publishedFormId = "";
  let touchedMessage = "";

  const service = new RagicCallbackRefreshService({
    delayMs: 0,
    dedupeWindowMs: 5_000,
    taskPersistEnabled: false,
    shouldUseSqliteReadForForm: () => true,
    getSyncState: async () => ({ status: "running" }),
    projectEntryAfterMutation: async (_formId, _entryId, reason) => {
      projectionReason = reason;
    },
    refreshEntry: async (_formId, entryId) => {
      refreshedEntryId = entryId;
      return {
        id: entryId,
        workOrderNo: "WO-1",
        customerPartNo: null,
        erpPartNo: null,
        status: "未結案",
        reports: [],
      };
    },
    upsertEntrySnapshot: async () => ({ rowCount: 3 }),
    touchSyncStateSnapshot: async (_formId, _snapshotAt, message) => {
      touchedMessage = String(message ?? "");
    },
    deleteEntrySnapshot: async () => undefined,
    publishWorkReportUpdated: (_formId, entryId) => {
      publishedEntryId = entryId;
    },
    publishWorkReportFormUpdated: (formId) => {
      publishedFormId = formId;
    },
    getRecentMutationProjection: () => null,
  });

  const task = service.enqueue({
    formId: "105",
    entryId: "E-105",
    eventType: "row-updated",
    rowId: "R-1",
    source: "ragic",
  });

  const finishedTask = await waitForTaskCompletion(service, task.taskId);
  assert.equal(finishedTask.status, "success");
  assert.equal(projectionReason, "update");
  assert.equal(refreshedEntryId, "E-105");
  assert.equal(touchedMessage, "ragic-callback:row-updated:E-105");
  assert.equal(publishedEntryId, "E-105");
  assert.equal(publishedFormId, "105");
});

test("同 entry/event 的 callback pending 期間會合併為同一筆任務", async () => {
  let refreshCount = 0;

  const service = new RagicCallbackRefreshService({
    delayMs: 30,
    dedupeWindowMs: 5_000,
    taskPersistEnabled: false,
    shouldUseSqliteReadForForm: () => true,
    getSyncState: async () => ({ status: "success" }),
    projectEntryAfterMutation: async () => undefined,
    refreshEntry: async (_formId, entryId) => {
      refreshCount += 1;
      return {
        id: entryId,
        workOrderNo: "WO-1",
        customerPartNo: null,
        erpPartNo: null,
        status: "未結案",
        reports: [],
      };
    },
    upsertEntrySnapshot: async () => ({ rowCount: 1 }),
    touchSyncStateSnapshot: async () => undefined,
    deleteEntrySnapshot: async () => undefined,
    publishWorkReportUpdated: () => undefined,
    publishWorkReportFormUpdated: () => undefined,
    getRecentMutationProjection: () => null,
  });
  await service.initialize();
  const beforeStats = service.getStats();

  const firstTask = service.enqueue({
    formId: "104",
    entryId: "E-200",
    eventType: "entry-updated",
    source: "ragic-post-workflow-104",
  });
  const secondTask = service.enqueue({
    formId: "104",
    entryId: "E-200",
    eventType: "entry-updated",
    source: "ragic-post-workflow-104",
  });

  assert.equal(secondTask.taskId, firstTask.taskId);
  assert.equal(secondTask.coalescedCount, 1);

  const finishedTask = await waitForTaskCompletion(service, firstTask.taskId);
  assert.equal(finishedTask.status, "success", finishedTask.error?.message);
  assert.equal(finishedTask.coalescedCount, 1);
  assert.equal(refreshCount, 1);
  const afterStats = service.getStats();
  assert.equal(afterStats.total, beforeStats.total + 1);
  assert.equal(afterStats.success, beforeStats.success + 1);
  assert.equal(afterStats.pending, beforeStats.pending);
  assert.equal(afterStats.running, beforeStats.running);
  assert.equal(afterStats.failed, beforeStats.failed);
  assert.equal(afterStats.activeCoalescingKeys, beforeStats.activeCoalescingKeys);
  assert.equal(afterStats.coalescedCallbacks, beforeStats.coalescedCallbacks + 1);
});

test("callback running 期間又收到同 entry/event 會用同一任務補跑一輪 refresh", async () => {
  let service!: RagicCallbackRefreshService;
  let refreshCount = 0;
  let coalescedTaskId = "";

  service = new RagicCallbackRefreshService({
    delayMs: 0,
    dedupeWindowMs: 5_000,
    taskPersistEnabled: false,
    shouldUseSqliteReadForForm: () => true,
    getSyncState: async () => ({ status: "success" }),
    projectEntryAfterMutation: async () => undefined,
    refreshEntry: async (_formId, entryId) => {
      refreshCount += 1;
      if (refreshCount === 1) {
        const task = service.enqueue({
          formId: "104",
          entryId,
          eventType: "entry-updated",
          source: "ragic-post-workflow-104",
        });
        coalescedTaskId = task.taskId;
      }
      return {
        id: entryId,
        workOrderNo: "WO-1",
        customerPartNo: null,
        erpPartNo: null,
        status: "未結案",
        reports: [],
      };
    },
    upsertEntrySnapshot: async () => ({ rowCount: 1 }),
    touchSyncStateSnapshot: async () => undefined,
    deleteEntrySnapshot: async () => undefined,
    publishWorkReportUpdated: () => undefined,
    publishWorkReportFormUpdated: () => undefined,
    getRecentMutationProjection: () => null,
  });

  const firstTask = service.enqueue({
    formId: "104",
    entryId: "E-200",
    eventType: "entry-updated",
    source: "ragic-post-workflow-104",
  });

  const finishedTask = await waitForTaskCompletion(service, firstTask.taskId);
  assert.equal(coalescedTaskId, firstTask.taskId);
  assert.equal(finishedTask.status, "success", finishedTask.error?.message);
  assert.equal(finishedTask.coalescedCount, 1);
  assert.equal(refreshCount, 2);
});

test("已合併 callback 的 refresh 若失敗，會保留後續 refresh 機會", async () => {
  let service!: RagicCallbackRefreshService;
  let refreshCount = 0;
  let coalescedTaskId = "";
  let entryUpdatedPublished = false;
  let formUpdatedPublished = false;

  service = new RagicCallbackRefreshService({
    delayMs: 0,
    dedupeWindowMs: 5_000,
    taskPersistEnabled: false,
    shouldUseSqliteReadForForm: () => true,
    getSyncState: async () => ({ status: "success" }),
    projectEntryAfterMutation: async () => undefined,
    refreshEntry: async (_formId, entryId) => {
      refreshCount += 1;
      if (refreshCount === 1) {
        const task = service.enqueue({
          formId: "104",
          entryId,
          eventType: "entry-updated",
          source: "ragic-post-workflow-104",
        });
        coalescedTaskId = task.taskId;
        throw new Error("temporary read failure");
      }
      return {
        id: entryId,
        workOrderNo: "WO-1",
        customerPartNo: null,
        erpPartNo: null,
        status: "未結案",
        reports: [],
      };
    },
    upsertEntrySnapshot: async () => ({ rowCount: 1 }),
    touchSyncStateSnapshot: async () => undefined,
    deleteEntrySnapshot: async () => undefined,
    publishWorkReportUpdated: () => {
      entryUpdatedPublished = true;
    },
    publishWorkReportFormUpdated: () => {
      formUpdatedPublished = true;
    },
    getRecentMutationProjection: () => null,
  });
  await service.initialize();
  const beforeStats = service.getStats();

  const firstTask = service.enqueue({
    formId: "104",
    entryId: "E-200",
    eventType: "entry-updated",
    source: "ragic-post-workflow-104",
  });

  const failedTask = await waitForTaskCompletion(service, firstTask.taskId);
  assert.equal(coalescedTaskId, firstTask.taskId);
  assert.equal(failedTask.status, "failed");
  assert.equal(failedTask.coalescedCount, 1);

  await waitForCondition(
    () => refreshCount === 2 && entryUpdatedPublished && formUpdatedPublished,
    "coalesced callback follow-up refresh did not run"
  );

  const afterStats = service.getStats();
  assert.equal(afterStats.total, beforeStats.total + 2);
  assert.equal(afterStats.failed, beforeStats.failed + 1);
  assert.equal(afterStats.success, beforeStats.success + 1);
  assert.equal(afterStats.activeCoalescingKeys, beforeStats.activeCoalescingKeys);
});

test("delete 類 callback 遇到 REPORT_NOT_FOUND 會刪除 entry snapshot 並視為成功", async () => {
  let deletedEntryId = "";
  let publishedEntryId = "";

  const service = new RagicCallbackRefreshService({
    delayMs: 0,
    dedupeWindowMs: 5_000,
    taskPersistEnabled: false,
    shouldUseSqliteReadForForm: () => true,
    getSyncState: async () => ({ status: "success" }),
    projectEntryAfterMutation: async () => undefined,
    refreshEntry: async () => {
      throw new HttpError(404, "找不到報工資料：E-404", "REPORT_NOT_FOUND");
    },
    upsertEntrySnapshot: async () => ({ rowCount: 0 }),
    touchSyncStateSnapshot: async () => undefined,
    deleteEntrySnapshot: async (_formId, entryId) => {
      deletedEntryId = entryId;
    },
    publishWorkReportUpdated: (_formId, entryId) => {
      publishedEntryId = entryId;
    },
    publishWorkReportFormUpdated: () => undefined,
    getRecentMutationProjection: () => null,
  });

  const task = service.enqueue({
    formId: "104",
    entryId: "E-404",
    eventType: "entry-deleted",
    source: "ragic",
  });

  const finishedTask = await waitForTaskCompletion(service, task.taskId);
  assert.equal(finishedTask.status, "success");
  assert.equal(deletedEntryId, "E-404");
  assert.equal(publishedEntryId, "E-404");
});

test("callback 命中近期 internal mutation projection 時仍刷新 snapshot，但內容未變可抑制 SSE", async () => {
  let refreshCalled = false;
  let upsertCalled = false;
  let touchedMessage = "";
  let entryUpdatedPublished = false;
  let formUpdatedPublished = false;
  const currentRecord = {
    id: "E-105",
    workOrderNo: "WO-1",
    customerPartNo: null,
    erpPartNo: null,
    status: "未結案",
    reports: [],
  };

  const service = new RagicCallbackRefreshService({
    delayMs: 0,
    dedupeWindowMs: 5_000,
    taskPersistEnabled: false,
    shouldUseSqliteReadForForm: () => true,
    getSyncState: async () => ({ status: "success" }),
    projectEntryAfterMutation: async () => undefined,
    refreshEntry: async () => {
      refreshCalled = true;
      return { ...currentRecord };
    },
    upsertEntrySnapshot: async () => {
      upsertCalled = true;
      return { rowCount: 1 };
    },
    touchSyncStateSnapshot: async (_formId, _snapshotAt, message) => {
      touchedMessage = String(message ?? "");
    },
    deleteEntrySnapshot: async () => undefined,
    publishWorkReportUpdated: () => {
      entryUpdatedPublished = true;
    },
    publishWorkReportFormUpdated: () => {
      formUpdatedPublished = true;
    },
    getEntrySnapshot: async () => ({ ...currentRecord }),
    getRecentMutationProjection: () => ({
      projectedAt: "2026-03-23T03:00:00.000Z",
      reason: "update",
    }),
  });

  const task = service.enqueue({
    formId: "105",
    entryId: "E-105",
    eventType: "entry-updated",
    source: "ragic",
  });

  const finishedTask = await waitForTaskCompletion(service, task.taskId);
  assert.equal(finishedTask.status, "success");
  assert.equal(refreshCalled, true);
  assert.equal(upsertCalled, true);
  assert.equal(touchedMessage, "ragic-callback:entry-updated:E-105:deduped");
  // dedupe 命中且 snapshot 內容不變時不發 SSE，避免前端被多餘通知反覆觸發 list refresh
  assert.equal(entryUpdatedPublished, false);
  assert.equal(formUpdatedPublished, false);
});

test("callback 命中近期 internal mutation projection 但 Ragic 內容已變時會補發 SSE", async () => {
  let entryUpdatedPublished = false;
  let formUpdatedPublished = false;

  const service = new RagicCallbackRefreshService({
    delayMs: 0,
    dedupeWindowMs: 5_000,
    taskPersistEnabled: false,
    shouldUseSqliteReadForForm: () => true,
    getSyncState: async () => ({ status: "success" }),
    projectEntryAfterMutation: async () => undefined,
    refreshEntry: async () => ({
      id: "E-105",
      workOrderNo: "WO-1",
      customerPartNo: null,
      erpPartNo: null,
      status: "已結案",
      reports: [],
    }),
    upsertEntrySnapshot: async () => ({ rowCount: 0 }),
    touchSyncStateSnapshot: async () => undefined,
    deleteEntrySnapshot: async () => undefined,
    publishWorkReportUpdated: () => {
      entryUpdatedPublished = true;
    },
    publishWorkReportFormUpdated: () => {
      formUpdatedPublished = true;
    },
    getEntrySnapshot: async () => ({
      id: "E-105",
      workOrderNo: "WO-1",
      customerPartNo: null,
      erpPartNo: null,
      status: "未結案",
      reports: [],
    }),
    getRecentMutationProjection: () => ({
      projectedAt: "2026-03-23T03:00:00.000Z",
      reason: "update",
    }),
  });

  const task = service.enqueue({
    formId: "105",
    entryId: "E-105",
    eventType: "entry-updated",
    source: "ragic",
  });

  const finishedTask = await waitForTaskCompletion(service, task.taskId);
  assert.equal(finishedTask.status, "success");
  assert.equal(entryUpdatedPublished, true);
  assert.equal(formUpdatedPublished, true);
});

test("delete callback 不會被近期 update projection dedupe 掉", async () => {
  let refreshCalled = false;
  let deletedEntryId = "";
  let entryUpdatedPublished = false;
  let formUpdatedPublished = false;

  const service = new RagicCallbackRefreshService({
    delayMs: 0,
    dedupeWindowMs: 5_000,
    taskPersistEnabled: false,
    shouldUseSqliteReadForForm: () => true,
    getSyncState: async () => ({ status: "success" }),
    projectEntryAfterMutation: async () => undefined,
    refreshEntry: async () => {
      refreshCalled = true;
      throw new HttpError(404, "找不到報工資料：E-105", "REPORT_NOT_FOUND");
    },
    upsertEntrySnapshot: async () => ({ rowCount: 0 }),
    touchSyncStateSnapshot: async () => undefined,
    deleteEntrySnapshot: async (_formId, entryId) => {
      deletedEntryId = entryId;
    },
    publishWorkReportUpdated: () => {
      entryUpdatedPublished = true;
    },
    publishWorkReportFormUpdated: () => {
      formUpdatedPublished = true;
    },
    getRecentMutationProjection: () => ({
      projectedAt: "2026-03-23T03:00:00.000Z",
      reason: "update",
    }),
  });

  const task = service.enqueue({
    formId: "105",
    entryId: "E-105",
    eventType: "entry-deleted",
    source: "ragic",
  });

  const finishedTask = await waitForTaskCompletion(service, task.taskId);
  assert.equal(finishedTask.status, "success");
  assert.equal(refreshCalled, true);
  assert.equal(deletedEntryId, "E-105");
  assert.equal(entryUpdatedPublished, true);
  assert.equal(formUpdatedPublished, true);
});

test("SQLite 停用時沒有 dedupe 機制，SSE 仍照發（保留原行為）", async () => {
  let entryUpdatedPublished = false;
  let formUpdatedPublished = false;

  const service = new RagicCallbackRefreshService({
    delayMs: 0,
    dedupeWindowMs: 5_000,
    taskPersistEnabled: false,
    shouldUseSqliteReadForForm: () => false,
    getSyncState: async () => ({ status: "success" }),
    projectEntryAfterMutation: async () => undefined,
    refreshEntry: async () => ({
      id: "E-X",
      workOrderNo: "WO",
      customerPartNo: null,
      erpPartNo: null,
      status: "未結案",
      reports: [],
    }),
    upsertEntrySnapshot: async () => ({ rowCount: 0 }),
    touchSyncStateSnapshot: async () => undefined,
    deleteEntrySnapshot: async () => undefined,
    publishWorkReportUpdated: () => {
      entryUpdatedPublished = true;
    },
    publishWorkReportFormUpdated: () => {
      formUpdatedPublished = true;
    },
    // dedupe 檢查永遠回 null；SQLite 停用路徑根本不會呼叫這條，但給一個 stub 以防萬一
    getRecentMutationProjection: () => null,
  });

  const task = service.enqueue({
    formId: "104",
    entryId: "E-200",
    eventType: "row-updated",
    source: "ragic",
  });

  const finishedTask = await waitForTaskCompletion(service, task.taskId);
  assert.equal(finishedTask.status, "success");
  assert.equal(entryUpdatedPublished, true);
  assert.equal(formUpdatedPublished, true);
});

test("callback queue 關閉 admission 後拒絕新任務且不留下 ghost task", async () => {
  const refreshGate = deferred();
  const refreshStarted = deferred();
  const service = new RagicCallbackRefreshService({
    delayMs: 0,
    dedupeWindowMs: 5_000,
    taskPersistEnabled: false,
    shouldUseSqliteReadForForm: () => true,
    getSyncState: async () => ({ status: "success" }),
    projectEntryAfterMutation: async () => undefined,
    refreshEntry: async (_formId, entryId) => {
      refreshStarted.resolve();
      await refreshGate.promise;
      return {
        id: entryId,
        workOrderNo: "WO-TEST",
        customerPartNo: null,
        erpPartNo: null,
        status: "未結案",
        reports: [],
      };
    },
    upsertEntrySnapshot: async () => ({ rowCount: 1 }),
    touchSyncStateSnapshot: async () => undefined,
    deleteEntrySnapshot: async () => undefined,
    publishWorkReportUpdated: () => undefined,
    publishWorkReportFormUpdated: () => undefined,
    getRecentMutationProjection: () => null,
  });

  const acceptedTask = service.enqueue({
    formId: "104",
    entryId: "E-TEST",
    eventType: "entry-updated",
    source: "test",
  });
  await refreshStarted.promise;
  service.closeAdmission();

  const statsBeforeRejectedEnqueue = service.getQueueStats();
  assert.deepEqual(statsBeforeRejectedEnqueue, {
    accepting: false,
    activeKeyCount: 1,
    pendingTaskCount: 1,
  });
  assert.throws(
    () =>
      service.enqueue({
        formId: "104",
        entryId: "E-LATE",
        eventType: "entry-updated",
        source: "test",
      }),
    (error: unknown) =>
      error instanceof HttpError &&
      error.statusCode === 503 &&
      error.code === "RAGIC_CALLBACK_QUEUE_CLOSED"
  );
  assert.equal(service.getStats().total, 1);
  assert.deepEqual(service.getQueueStats(), statsBeforeRejectedEnqueue);

  let drainCompleted = false;
  const drainPromise = service.drain().then(() => {
    drainCompleted = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drainCompleted, false);

  refreshGate.resolve();
  await drainPromise;
  assert.equal(service.getTask(acceptedTask.taskId)?.status, "success");
  assert.deepEqual(service.getQueueStats(), {
    accepting: false,
    activeKeyCount: 0,
    pendingTaskCount: 0,
  });
});

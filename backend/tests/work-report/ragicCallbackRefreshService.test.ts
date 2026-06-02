import assert from "node:assert/strict";
import test from "node:test";
import { HttpError } from "../../src/utils/httpError";
import {
  RagicCallbackRefreshService,
  type CallbackTask,
} from "../../src/services/ragicCallbackRefreshServiceFactory";

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

test("callback 在 sync running 時會先入 replay queue，再直接刷新 entry snapshot", async () => {
  let projectionReason = "";
  let refreshedEntryId = "";
  let publishedEntryId = "";
  let publishedFormId = "";
  let touchedMessage = "";

  const service = new RagicCallbackRefreshService({
    delayMs: 0,
    dedupeWindowMs: 5_000,
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

test("delete 類 callback 遇到 REPORT_NOT_FOUND 會刪除 entry snapshot 並視為成功", async () => {
  let deletedEntryId = "";
  let publishedEntryId = "";

  const service = new RagicCallbackRefreshService({
    delayMs: 0,
    dedupeWindowMs: 5_000,
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

test("callback 命中近期 internal mutation projection 時會略過 refreshEntry、upsert 與 SSE publish", async () => {
  let refreshCalled = false;
  let upsertCalled = false;
  let touchedMessage = "";
  let entryUpdatedPublished = false;
  let formUpdatedPublished = false;

  const service = new RagicCallbackRefreshService({
    delayMs: 0,
    dedupeWindowMs: 5_000,
    shouldUseSqliteReadForForm: () => true,
    getSyncState: async () => ({ status: "success" }),
    projectEntryAfterMutation: async () => undefined,
    refreshEntry: async () => {
      refreshCalled = true;
      throw new Error("should skip callback refresh");
    },
    upsertEntrySnapshot: async () => {
      upsertCalled = true;
      return { rowCount: 0 };
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
  assert.equal(refreshCalled, false);
  assert.equal(upsertCalled, false);
  assert.equal(touchedMessage, "ragic-callback:entry-updated:E-105:deduped");
  // dedupe 命中時不發 SSE，避免前端被多餘通知反覆觸發 list refresh
  assert.equal(entryUpdatedPublished, false);
  assert.equal(formUpdatedPublished, false);
});

test("SQLite 停用時沒有 dedupe 機制，SSE 仍照發（保留原行為）", async () => {
  let entryUpdatedPublished = false;
  let formUpdatedPublished = false;

  const service = new RagicCallbackRefreshService({
    delayMs: 0,
    dedupeWindowMs: 5_000,
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

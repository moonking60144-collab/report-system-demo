import assert from "node:assert/strict";
import test from "node:test";
import { Form16DowntimeCallbackRefreshService } from "../../../src/services/form16/form16DowntimeCallbackRefreshService";
import { HttpError } from "../../../src/utils/httpError";
import type { WorkReportQueueTaskRecord } from "../../../src/services/work-report/workReportTaskRegistryService";

function createRegistry(initialTasks: WorkReportQueueTaskRecord[] = []) {
  const tasks = new Map(initialTasks.map((task) => [task.taskId, task]));
  return {
    tasks,
    async initialize(): Promise<void> {},
    listTasksForReplay(options: {
      formId: string;
      taskType: string;
      errorCode: string;
    }): WorkReportQueueTaskRecord[] {
      return Array.from(tasks.values()).filter(
        (task) =>
          task.formId === options.formId &&
          task.taskType === options.taskType &&
          task.status === "failed" &&
          task.errorCode === options.errorCode
      );
    },
    upsertTask(input: unknown): WorkReportQueueTaskRecord {
      const next = input as WorkReportQueueTaskRecord;
      const existing = tasks.get(next.taskId);
      const record = {
        ...existing,
        ...next,
      } as WorkReportQueueTaskRecord;
      tasks.set(record.taskId, record);
      return record;
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

test("Form 16 callback queue 關閉 admission 後拒絕新任務且不留下 pending work", () => {
  const registry = createRegistry();
  const service = new Form16DowntimeCallbackRefreshService({
    delayMs: 0,
    refreshEntrySnapshotFromRagic: async () => undefined,
    registry,
  });

  service.closeAdmission();

  assert.throws(
    () =>
      service.enqueue({
        entryId: "16-TEST-CLOSED",
        eventType: "entry-updated",
        source: "test",
      }),
    (error: unknown) =>
      error instanceof HttpError &&
      error.statusCode === 503 &&
      error.code === "RAGIC_CALLBACK_QUEUE_CLOSED"
  );
  assert.deepEqual(service.getQueueStats(), {
    accepting: false,
    activeKeyCount: 0,
    pendingTaskCount: 0,
  });
});

test("Form 16 callback drain 會等待已接受的 refresh 完成", async () => {
  const refreshStarted = deferred();
  const refreshGate = deferred();
  const service = new Form16DowntimeCallbackRefreshService({
    delayMs: 0,
    refreshEntrySnapshotFromRagic: async () => {
      refreshStarted.resolve();
      await refreshGate.promise;
    },
    registry: createRegistry(),
  });

  service.enqueue({
    entryId: "16-TEST-DRAIN",
    eventType: "entry-updated",
    source: "test",
  });
  await refreshStarted.promise;
  service.closeAdmission();

  let drainCompleted = false;
  const drainPromise = service.drain().then(() => {
    drainCompleted = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drainCompleted, false);

  refreshGate.resolve();
  await drainPromise;
  assert.equal(drainCompleted, true);
  assert.deepEqual(service.getQueueStats(), {
    accepting: false,
    activeKeyCount: 0,
    pendingTaskCount: 0,
  });
});

test("Form 16 callback recovery 不受一般 task list 的 200 筆上限影響", async () => {
  const recoveredTasks = Array.from({ length: 201 }, (_, index) => {
    const entryId = String(1_600_000_002 + index);
    return {
      taskId: `form16-callback-before-restart-${index}`,
      taskType: "callback-refresh",
      status: "failed",
      formId: "16",
      workOrderNo: null,
      entryId,
      rowId: null,
      queueKey: `form16:${entryId}`,
      createdAt: `2026-07-20T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
      startedAt: "2026-07-20T00:01:00.000Z",
      finishedAt: "2026-07-20T00:02:00.000Z",
      updatedAt: "2026-07-20T00:02:00.000Z",
      message: "服務重啟，原未完成任務已標記為失敗",
      errorCode: "TASK_REGISTRY_RECOVERED_AFTER_RESTART",
      errorMessage: "服務重啟，原未完成任務已標記為失敗",
      actorClientId: null,
      actorTabId: null,
      actorIp: "127.0.0.1",
      actorLabel: "TEST callback",
      source: "ragic-callback-16",
    } satisfies WorkReportQueueTaskRecord;
  });
  const registry = createRegistry(recoveredTasks);
  const refreshGate = deferred();
  const refreshedEntryIds: string[] = [];
  const service = new Form16DowntimeCallbackRefreshService({
    delayMs: 0,
    refreshEntrySnapshotFromRagic: async (entryId) => {
      refreshedEntryIds.push(entryId);
      await refreshGate.promise;
    },
    registry,
  });

  await service.initialize();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(refreshedEntryIds.length, 201);
  assert.equal(
    recoveredTasks.every(
      (task) =>
        registry.tasks.get(task.taskId)?.errorCode ===
        "FORM16_CALLBACK_REPLAY_SCHEDULED"
    ),
    true
  );
  assert.equal(service.getQueueStats().pendingTaskCount, 201);

  refreshGate.resolve();
  await service.drain();
  assert.equal(service.getQueueStats().pendingTaskCount, 0);
});

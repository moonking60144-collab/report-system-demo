import test from "node:test";
import assert from "node:assert/strict";
import { createReportTaskService } from "../../src/services/createReportTaskService";
import { env } from "../../src/config/env";
import {
  workReportTaskRegistryService,
  type WorkReportQueueTaskRecord,
} from "../../src/services/work-report/workReportTaskRegistryService";

test("相同 clientMutationId 不會重複 enqueue 任務", async () => {
  let callCount = 0;

  const firstTask = createReportTaskService.enqueue({
    formId: "104",
    entryId: "E-100",
    queueKey: "104:E-100",
    clientMutationId: "mutation-dup-001",
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
    worker: async () => {
      callCount += 1;
      return { rowId: "R-2" };
    },
  });

  assert.equal(firstTask.taskId, secondTask.taskId);

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(callCount, 1);
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

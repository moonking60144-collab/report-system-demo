import test from "node:test";
import assert from "node:assert/strict";
import { env } from "../../src/config/env";
import {
  resolveMutationLifecycleState,
} from "../../src/types/mutationLifecycle";
import {
  WorkReportTaskRegistryService,
  type WorkReportQueueTaskRecord,
} from "../../src/services/work-report/workReportTaskRegistryService";

test("mutation lifecycle 會區分 conflict、indeterminate 與一般失敗", () => {
  assert.equal(
    resolveMutationLifecycleState({ status: "failed", errorCode: "ENTRY_CONFLICT" }),
    "conflict"
  );
  assert.equal(
    resolveMutationLifecycleState({
      status: "failed",
      errorCode: "RAGIC_DELETE_INDETERMINATE",
    }),
    "indeterminate"
  );
  assert.equal(
    resolveMutationLifecycleState({ status: "failed", errorCode: "INVALID_PAYLOAD" }),
    "failed"
  );
});

test("registry 會分開 acceptedAt 與 confirmedAt，舊 task shape 仍可讀", (t) => {
  const mutableEnv = env as unknown as {
    WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED: boolean;
  };
  const previousPersistEnabled = mutableEnv.WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED;
  mutableEnv.WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED = false;
  t.after(() => {
    mutableEnv.WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED = previousPersistEnabled;
  });

  const registry = new WorkReportTaskRegistryService();
  const createdAt = "2026-08-12T06:00:00.000Z";
  const finishedAt = "2026-08-12T06:00:05.000Z";
  const pending = registry.upsertTask({
    taskId: "lifecycle-success",
    taskType: "create-report",
    status: "pending",
    formId: "104",
    entryId: "17382",
    createdAt,
    updatedAt: createdAt,
  });
  assert.equal(pending.lifecycleState, "accepted");
  assert.equal(pending.acceptedAt, createdAt);
  assert.equal(pending.confirmedAt, null);

  const directlyRunning = registry.upsertTask({
    taskId: "lifecycle-running",
    taskType: "update-report",
    status: "running",
    formId: "104",
    entryId: "17382",
    createdAt,
    startedAt: createdAt,
    updatedAt: createdAt,
  });
  assert.equal(directlyRunning.lifecycleState, "running");
  assert.equal(directlyRunning.acceptedAt, createdAt);
  assert.equal(directlyRunning.confirmedAt, null);

  const success = registry.upsertTask({
    taskId: pending.taskId,
    taskType: "create-report",
    status: "success",
    formId: "104",
    entryId: "17382",
    finishedAt,
    updatedAt: finishedAt,
  });
  assert.equal(success.lifecycleState, "success");
  assert.equal(success.acceptedAt, createdAt);
  assert.equal(success.confirmedAt, finishedAt);

  const legacyTask = {
    taskId: "legacy-task",
    taskType: "update-report",
    status: "success",
    formId: "104",
    workOrderNo: null,
    entryId: "17382",
    rowId: "1001",
    queueKey: "104:17382",
    createdAt,
    startedAt: createdAt,
    finishedAt,
    updatedAt: finishedAt,
    message: null,
    errorCode: null,
    errorMessage: null,
    actorClientId: null,
    actorTabId: null,
    actorIp: null,
    actorLabel: null,
    source: null,
  } satisfies WorkReportQueueTaskRecord;
  const internals = registry as unknown as {
    isValidTask(task: unknown): boolean;
  };
  assert.equal(internals.isValidTask(legacyTask), true);
});

test("indeterminate task 不會偽造 confirmedAt", (t) => {
  const mutableEnv = env as unknown as {
    WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED: boolean;
  };
  const previousPersistEnabled = mutableEnv.WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED;
  mutableEnv.WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED = false;
  t.after(() => {
    mutableEnv.WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED = previousPersistEnabled;
  });

  const registry = new WorkReportTaskRegistryService();
  const task = registry.upsertTask({
    taskId: "lifecycle-indeterminate",
    taskType: "create-report",
    status: "failed",
    formId: "104",
    entryId: "17382",
    createdAt: "2026-08-12T06:00:00.000Z",
    finishedAt: "2026-08-12T06:00:05.000Z",
    updatedAt: "2026-08-12T06:00:05.000Z",
    errorCode: "RAGIC_WRITE_FAILED",
    writeIndeterminate: true,
  });
  assert.equal(task.lifecycleState, "indeterminate");
  assert.equal(task.confirmedAt, null);
});

test("registry 重啟會凍結所有執行中的 mutation，尚未執行的任務可安全失敗", (t) => {
  const mutableEnv = env as unknown as {
    WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED: boolean;
  };
  const previousPersistEnabled = mutableEnv.WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED;
  mutableEnv.WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED = false;
  t.after(() => {
    mutableEnv.WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED = previousPersistEnabled;
  });

  const registry = new WorkReportTaskRegistryService();
  registry.upsertTask({
    taskId: "restart-running-update-downtime",
    taskType: "update-downtime",
    status: "running",
    formId: "16",
    entryId: "D-1001",
  });
  registry.upsertTask({
    taskId: "restart-running-batch-delete",
    taskType: "delete-report-batch",
    status: "running",
    formId: "105",
    entryId: "E-1001",
  });
  registry.upsertTask({
    taskId: "restart-pending-delete-report",
    taskType: "delete-report",
    status: "pending",
    formId: "104",
    entryId: "E-1002",
  });

  const internals = registry as unknown as {
    recoverInterruptedTasks(): void;
  };
  internals.recoverInterruptedTasks();

  const runningUpdate = registry.getTask("restart-running-update-downtime");
  const runningBatchDelete = registry.getTask("restart-running-batch-delete");
  const pendingDelete = registry.getTask("restart-pending-delete-report");
  assert.equal(runningUpdate?.lifecycleState, "indeterminate");
  assert.equal(runningUpdate?.writeIndeterminate, true);
  assert.equal(runningUpdate?.confirmedAt, null);
  assert.equal(runningBatchDelete?.lifecycleState, "indeterminate");
  assert.equal(runningBatchDelete?.batchWriteIndeterminate, true);
  assert.equal(runningBatchDelete?.confirmedAt, null);
  assert.equal(pendingDelete?.lifecycleState, "failed");
  assert.equal(pendingDelete?.writeIndeterminate, false);
  assert.ok(pendingDelete?.confirmedAt);
});

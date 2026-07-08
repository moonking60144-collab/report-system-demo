import test from "node:test";
import assert from "node:assert/strict";
import {
  FORM16_DOWNTIME_CREATE_QUEUE_KEY,
  Form16DowntimeCreateTaskService,
  type Form16DowntimeCreateTaskPayload,
} from "../../../src/services/form16/form16DowntimeCreateTaskService";
import { createKeyedSerialQueue } from "../../../src/utils/keyedSerialQueue";
import type {
  WorkReportQueueTaskRecord,
  WorkReportQueueTaskStatus,
  WorkReportQueueTaskType,
} from "../../../src/services/work-report/workReportTaskRegistryService";
import { WORK_REPORT_LOCAL_TERMINAL_TASK_HISTORY_LIMIT } from "../../../src/services/work-report/localTaskHistory";

class FakeRegistry {
  readonly tasks = new Map<string, WorkReportQueueTaskRecord>();

  async initialize(): Promise<void> {}

  upsertTask(input: {
    taskId: string;
    taskType: WorkReportQueueTaskType;
    status: WorkReportQueueTaskStatus;
    formId: string;
    workOrderNo?: string | null;
    entryId?: string | null;
    rowId?: string | null;
    queueKey?: string | null;
    createdAt?: string;
    startedAt?: string | null;
    finishedAt?: string | null;
    updatedAt?: string;
    message?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    actorClientId?: string | null;
    actorTabId?: string | null;
    actorIp?: string | null;
    actorLabel?: string | null;
  }): WorkReportQueueTaskRecord {
    const existing = this.tasks.get(input.taskId);
    const now = input.updatedAt ?? new Date().toISOString();
    const task: WorkReportQueueTaskRecord = {
      taskId: input.taskId,
      taskType: input.taskType,
      status: input.status,
      formId: input.formId,
      workOrderNo: input.workOrderNo ?? existing?.workOrderNo ?? null,
      entryId: input.entryId ?? existing?.entryId ?? null,
      rowId: input.rowId ?? existing?.rowId ?? null,
      queueKey: input.queueKey ?? existing?.queueKey ?? null,
      createdAt: input.createdAt ?? existing?.createdAt ?? now,
      startedAt: input.startedAt ?? existing?.startedAt ?? null,
      finishedAt: input.finishedAt ?? existing?.finishedAt ?? null,
      updatedAt: now,
      message: input.message ?? existing?.message ?? null,
      errorCode: input.errorCode ?? existing?.errorCode ?? null,
      errorMessage: input.errorMessage ?? existing?.errorMessage ?? null,
      actorClientId: input.actorClientId ?? existing?.actorClientId ?? null,
      actorTabId: input.actorTabId ?? existing?.actorTabId ?? null,
      actorIp: input.actorIp ?? existing?.actorIp ?? null,
      actorLabel: input.actorLabel ?? existing?.actorLabel ?? null,
      source: null,
    };
    this.tasks.set(task.taskId, task);
    return { ...task };
  }

  getTask(taskId: string): WorkReportQueueTaskRecord | null {
    const task = this.tasks.get(taskId);
    return task ? { ...task } : null;
  }

  listTasks(options: {
    formId: string;
    status?: WorkReportQueueTaskStatus;
    taskType?: WorkReportQueueTaskType;
    taskTypes?: WorkReportQueueTaskType[];
    actorClientId?: string;
    limit?: number;
  }): WorkReportQueueTaskRecord[] {
    return Array.from(this.tasks.values())
      .filter((task) => {
        if (task.formId !== options.formId) return false;
        if (options.status && task.status !== options.status) return false;
        if (options.taskType && task.taskType !== options.taskType) return false;
        if (options.taskTypes && !options.taskTypes.includes(task.taskType)) return false;
        if (options.actorClientId && task.actorClientId !== options.actorClientId) return false;
        return true;
      })
      .slice(0, options.limit ?? 50)
      .map((task) => ({ ...task }));
  }
}

function payload(clientRowKey: string): Form16DowntimeCreateTaskPayload {
  return {
    date: "2026-07-06",
    machineId: "P10",
    processCode: "BU01",
    clientRowKey,
  };
}

async function waitForTaskStatus(
  registry: FakeRegistry,
  taskId: string,
  status: WorkReportQueueTaskStatus
): Promise<WorkReportQueueTaskRecord> {
  let lastTask: WorkReportQueueTaskRecord | null = null;
  for (let i = 0; i < 50; i += 1) {
    const task = registry.getTask(taskId);
    if (task?.status === status) {
      return task;
    }
    lastTask = task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`task ${taskId} did not reach ${status}; last=${JSON.stringify(lastTask)}`);
}

test("停機 create task 會 pending -> running -> success 並同步 registry entryId", async () => {
  const registry = new FakeRegistry();
  const service = new Form16DowntimeCreateTaskService({
    registry,
    queue: createKeyedSerialQueue(),
    createTaskId: () => "task-success-1",
    createRecord: async (input) => {
      assert.equal(input.clientRowKey, "row-key-success");
      return { created: true, entryId: "990001" };
    },
  });

  const accepted = service.enqueue({
    payload: payload("row-key-success"),
    actorClientId: "client-a",
  });

  assert.equal(accepted.taskId, "task-success-1");
  assert.equal(accepted.status, "pending");

  const successTask = await waitForTaskStatus(registry, accepted.taskId, "success");
  assert.equal(successTask.taskType, "create-downtime");
  assert.equal(successTask.entryId, "990001");
  assert.equal(successTask.rowId, null);
  assert.equal(successTask.queueKey, FORM16_DOWNTIME_CREATE_QUEUE_KEY);
  assert.equal(successTask.actorClientId, "client-a");
});

test("停機 create task 使用固定 queue key 串行建立", async () => {
  const registry = new FakeRegistry();
  const createOrder: string[] = [];
  let resolveFirst: () => void = () => {
    throw new Error("resolveFirst not assigned");
  };
  const service = new Form16DowntimeCreateTaskService({
    registry,
    queue: createKeyedSerialQueue(),
    createTaskId: (() => {
      let index = 0;
      return () => `task-serial-${(index += 1)}`;
    })(),
    createRecord: async (input) => {
      createOrder.push(String(input.clientRowKey));
      if (input.clientRowKey === "row-key-first") {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return {
        created: true,
        entryId: input.clientRowKey === "row-key-first" ? "990001" : "990002",
      };
    },
  });

  const first = service.enqueue({ payload: payload("row-key-first") });
  const second = service.enqueue({ payload: payload("row-key-second") });

  await waitForTaskStatus(registry, first.taskId, "running");
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(createOrder, ["row-key-first"]);
  assert.equal(registry.getTask(second.taskId)?.status, "pending");

  resolveFirst();

  await waitForTaskStatus(registry, first.taskId, "success");
  await waitForTaskStatus(registry, second.taskId, "success");
  assert.deepEqual(createOrder, ["row-key-first", "row-key-second"]);
});

test("相同 clientRowKey 的 pending/running/success task 不重複 enqueue", async () => {
  const registry = new FakeRegistry();
  let callCount = 0;
  let resolveCreate: () => void = () => {
    throw new Error("resolveCreate not assigned");
  };
  const service = new Form16DowntimeCreateTaskService({
    registry,
    queue: createKeyedSerialQueue(),
    createTaskId: () => "task-dedup-1",
    createRecord: async () => {
      callCount += 1;
      await new Promise<void>((resolve) => {
        resolveCreate = resolve;
      });
      return { created: true, entryId: "990001" };
    },
  });

  const first = service.enqueue({ payload: payload("row-key-dedup") });
  const second = service.enqueue({ payload: payload("row-key-dedup") });

  assert.equal(first.taskId, second.taskId);
  await waitForTaskStatus(registry, first.taskId, "running");
  assert.equal(callCount, 1);

  resolveCreate();
  await waitForTaskStatus(registry, first.taskId, "success");

  const third = service.enqueue({ payload: payload("row-key-dedup") });
  assert.equal(third.taskId, first.taskId);
  assert.equal(callCount, 1);
});

test("相同 clientRowKey failed 後允許重新 enqueue 新 task", async () => {
  const registry = new FakeRegistry();
  let callCount = 0;
  const service = new Form16DowntimeCreateTaskService({
    registry,
    queue: createKeyedSerialQueue(),
    createTaskId: (() => {
      let index = 0;
      return () => `task-retry-${(index += 1)}`;
    })(),
    createRecord: async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("Field Type報工類別 contains empty value (code: 202)");
      }
      return { created: true, entryId: "990003" };
    },
  });

  const failed = service.enqueue({ payload: payload("row-key-retry") });
  const failedTask = await waitForTaskStatus(registry, failed.taskId, "failed");
  assert.equal(failedTask.errorCode, "CREATE_DOWNTIME_FAILED");

  const retried = service.enqueue({ payload: payload("row-key-retry") });
  assert.notEqual(retried.taskId, failed.taskId);
  const successTask = await waitForTaskStatus(registry, retried.taskId, "success");

  assert.equal(callCount, 2);
  assert.equal(successTask.entryId, "990003");
});

test("terminal local history 只保留最近任務並清掉 stale clientRowKey index", async () => {
  const registry = new FakeRegistry();
  let taskIndex = 0;
  const service = new Form16DowntimeCreateTaskService({
    registry,
    queue: createKeyedSerialQueue(),
    createTaskId: () => `task-history-${(taskIndex += 1)}`,
    createRecord: async (input) => ({
      created: true,
      entryId: `entry-${input.clientRowKey}`,
    }),
  });

  const totalTasks = WORK_REPORT_LOCAL_TERMINAL_TASK_HISTORY_LIMIT + 5;
  for (let i = 1; i <= totalTasks; i += 1) {
    service.enqueue({ payload: payload(`row-key-history-${i}`) });
  }

  await waitForTaskStatus(registry, `task-history-${totalTasks}`, "success");

  const internals = service as unknown as {
    tasks: Map<string, unknown>;
    taskIdByClientRowKey: Map<string, string>;
  };

  assert.equal(internals.tasks.size, WORK_REPORT_LOCAL_TERMINAL_TASK_HISTORY_LIMIT);
  assert.equal(
    internals.taskIdByClientRowKey.size,
    WORK_REPORT_LOCAL_TERMINAL_TASK_HISTORY_LIMIT
  );
  assert.equal(service.getTask("task-history-1"), null);
  assert.equal(internals.taskIdByClientRowKey.has("row-key-history-1"), false);
  assert.ok(service.getTask(`task-history-${totalTasks}`));
});

test("initialize 會把 registry 裡未完成的 downtime create task 標 failed", async () => {
  const registry = new FakeRegistry();
  registry.upsertTask({
    taskId: "task-recovered-pending",
    taskType: "create-downtime",
    status: "pending",
    formId: "16",
    queueKey: FORM16_DOWNTIME_CREATE_QUEUE_KEY,
  });
  registry.upsertTask({
    taskId: "task-recovered-running",
    taskType: "create-downtime",
    status: "running",
    formId: "16",
    queueKey: FORM16_DOWNTIME_CREATE_QUEUE_KEY,
  });

  const service = new Form16DowntimeCreateTaskService({
    registry,
    queue: createKeyedSerialQueue(),
    createRecord: async () => ({ created: true, entryId: "never-called" }),
  });

  await service.initialize();

  assert.equal(registry.getTask("task-recovered-pending")?.status, "failed");
  assert.equal(registry.getTask("task-recovered-running")?.status, "failed");
  assert.equal(
    registry.getTask("task-recovered-pending")?.errorCode,
    "TASK_RECOVERED_AFTER_RESTART"
  );
});

test("initialize 失敗後會清掉 cached promise 讓下一次請求可重試", async () => {
  let initializeAttempts = 0;
  class FlakyRegistry extends FakeRegistry {
    override async initialize(): Promise<void> {
      initializeAttempts += 1;
      if (initializeAttempts === 1) {
        throw new Error("temporary sqlite lock");
      }
    }
  }

  const registry = new FlakyRegistry();
  const service = new Form16DowntimeCreateTaskService({
    registry,
    queue: createKeyedSerialQueue(),
    createRecord: async () => ({ created: true, entryId: "never-called" }),
  });

  await assert.rejects(() => service.initialize(), /temporary sqlite lock/);
  await service.initialize();

  assert.equal(initializeAttempts, 2);
});

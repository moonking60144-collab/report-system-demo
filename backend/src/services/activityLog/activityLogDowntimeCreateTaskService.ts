import { randomUUID } from "crypto";
import { HttpError } from "../../utils/httpError";
import { workReportEntryMutationQueue } from "../work-report/workReportEntryMutationQueue";
import {
  workReportTaskRegistryService,
  type WorkReportQueueTaskRecord,
  type WorkReportQueueTaskStatus,
  type WorkReportQueueTaskType,
} from "../work-report/workReportTaskRegistryService";
import {
  activityLogDowntimeService,
  type CreateActivityLogDowntimeInput,
} from "./activityLogDowntimeService";
import { pruneTerminalTaskHistory } from "../work-report/localTaskHistory";
import type { KeyedSerialQueue } from "../../utils/keyedSerialQueue";
import { ACTIVITY_LOG_DOWNTIME_MUTATION_QUEUE_KEY } from "./activityLogDowntimeMutationQueue";
import { isActivityLogCreateWriteIndeterminateError } from "./activityLogIdempotencyService";

export const ACTIVITY_LOG_DOWNTIME_CREATE_QUEUE_KEY = ACTIVITY_LOG_DOWNTIME_MUTATION_QUEUE_KEY;

type DowntimeCreateTaskType = Extract<WorkReportQueueTaskType, "create-downtime">;

export type ActivityLogDowntimeCreateTaskStatus = WorkReportQueueTaskStatus;

export type ActivityLogDowntimeCreateTaskPayload = CreateActivityLogDowntimeInput & {
  clientRowKey: string;
};

export interface ActivityLogDowntimeCreateTask {
  taskId: string;
  taskType: DowntimeCreateTaskType;
  formId: "903";
  entryId: string | null;
  queueKey: string;
  clientRowKey: string;
  payload: ActivityLogDowntimeCreateTaskPayload;
  actorClientId?: string;
  actorTabId?: string;
  actorIp?: string;
  actorLabel?: string;
  status: ActivityLogDowntimeCreateTaskStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  writeIndeterminate?: boolean;
  error?: {
    code: string;
    message: string;
  };
}

export interface EnqueueActivityLogDowntimeCreateTaskInput {
  payload: ActivityLogDowntimeCreateTaskPayload;
  actorClientId?: string | null;
  actorTabId?: string | null;
  actorIp?: string | null;
  actorLabel?: string | null;
}

interface RegistryUpsertTaskInput {
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
  writeIndeterminate?: boolean | null;
  actorClientId?: string | null;
  actorTabId?: string | null;
  actorIp?: string | null;
  actorLabel?: string | null;
  source?: string | null;
}

interface ActivityLogDowntimeCreateTaskRegistry {
  initialize?: () => Promise<void>;
  upsertTask(input: RegistryUpsertTaskInput): WorkReportQueueTaskRecord;
  getTask(taskId: string): WorkReportQueueTaskRecord | null;
  listTasks(options: {
    formId: string;
    status?: WorkReportQueueTaskStatus;
    taskType?: WorkReportQueueTaskType;
    taskTypes?: WorkReportQueueTaskType[];
    actorClientId?: string;
    limit?: number;
  }): WorkReportQueueTaskRecord[];
}

interface ActivityLogDowntimeCreateTaskServiceDeps {
  registry?: ActivityLogDowntimeCreateTaskRegistry;
  queue?: KeyedSerialQueue;
  createRecord?: (
    input: CreateActivityLogDowntimeInput
  ) => Promise<{ created: true; entryId: string }>;
  createTaskId?: () => string;
  now?: () => string;
}

function normalizeOptionalString(value: string | null | undefined): string | undefined {
  const normalized = String(value ?? "").trim();
  return normalized || undefined;
}

function normalizeCreateError(error: unknown): { code: string; message: string } {
  if (error instanceof HttpError) {
    return {
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof Error) {
    const code =
      typeof (error as { code?: unknown }).code === "string"
        ? String((error as { code?: unknown }).code)
        : "CREATE_DOWNTIME_FAILED";
    return {
      code,
      message: error.message,
    };
  }
  return {
    code: "CREATE_DOWNTIME_FAILED",
    message: String(error),
  };
}

function isActiveOrSuccess(status: WorkReportQueueTaskStatus): boolean {
  return status === "pending" || status === "running" || status === "success";
}

export class ActivityLogDowntimeCreateTaskService {
  private readonly tasks = new Map<string, ActivityLogDowntimeCreateTask>();
  private readonly taskIdByClientRowKey = new Map<string, string>();
  private readonly registry: ActivityLogDowntimeCreateTaskRegistry;
  private readonly queue: KeyedSerialQueue;
  private readonly createRecord: (
    input: CreateActivityLogDowntimeInput
  ) => Promise<{ created: true; entryId: string }>;
  private readonly createTaskId: () => string;
  private readonly now: () => string;
  private initializedPromise: Promise<void> | null = null;

  constructor(deps: ActivityLogDowntimeCreateTaskServiceDeps = {}) {
    this.registry = deps.registry ?? workReportTaskRegistryService;
    this.queue = deps.queue ?? workReportEntryMutationQueue;
    this.createRecord =
      deps.createRecord ??
      ((input) => activityLogDowntimeService.createRecord(input, { deferProjection: true }));
    this.createTaskId = deps.createTaskId ?? randomUUID;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async initialize(): Promise<void> {
    if (this.initializedPromise) {
      await this.initializedPromise;
      return;
    }

    this.initializedPromise = (async () => {
      try {
        await this.registry.initialize?.();
        this.recoverInterruptedRegistryTasks();
      } catch (error) {
        this.initializedPromise = null;
        throw error;
      }
    })();
    await this.initializedPromise;
  }

  enqueue(input: EnqueueActivityLogDowntimeCreateTaskInput): Pick<
    ActivityLogDowntimeCreateTask,
    "taskId" | "status" | "createdAt" | "entryId"
  > {
    const clientRowKey = String(input.payload.clientRowKey ?? "").trim();
    if (!clientRowKey) {
      throw new HttpError(
        400,
        "停機紀錄背景建立必須提供 clientRowKey，才能安全處理重送。",
        "DOWNTIME_CLIENT_ROW_KEY_REQUIRED"
      );
    }

    const existingTaskId = this.taskIdByClientRowKey.get(clientRowKey);
    if (existingTaskId) {
      const existingTask = this.tasks.get(existingTaskId);
      if (existingTask && isActiveOrSuccess(existingTask.status)) {
        return this.toAcceptedTask(existingTask);
      }
      this.taskIdByClientRowKey.delete(clientRowKey);
    }

    this.queue.assertAccepting(ACTIVITY_LOG_DOWNTIME_CREATE_QUEUE_KEY);

    const createdAt = this.now();
    const task: ActivityLogDowntimeCreateTask = {
      taskId: this.createTaskId(),
      taskType: "create-downtime",
      formId: "903",
      entryId: null,
      queueKey: ACTIVITY_LOG_DOWNTIME_CREATE_QUEUE_KEY,
      clientRowKey,
      payload: {
        ...input.payload,
        clientRowKey,
      },
      ...(normalizeOptionalString(input.actorClientId) ? { actorClientId: normalizeOptionalString(input.actorClientId) } : {}),
      ...(normalizeOptionalString(input.actorTabId) ? { actorTabId: normalizeOptionalString(input.actorTabId) } : {}),
      ...(normalizeOptionalString(input.actorIp) ? { actorIp: normalizeOptionalString(input.actorIp) } : {}),
      ...(normalizeOptionalString(input.actorLabel) ? { actorLabel: normalizeOptionalString(input.actorLabel) } : {}),
      status: "pending",
      createdAt,
      updatedAt: createdAt,
    };

    this.tasks.set(task.taskId, task);
    this.taskIdByClientRowKey.set(clientRowKey, task.taskId);
    this.syncTaskToRegistry(task);

    void this.queue.enqueue(task.queueKey, () => this.runTask(task.taskId));

    return this.toAcceptedTask(task);
  }

  getTask(taskId: string): ActivityLogDowntimeCreateTask | null {
    const task = this.tasks.get(taskId);
    return task ? this.copyTask(task) : null;
  }

  private async runTask(taskId: string): Promise<void> {
    const startedAt = this.now();
    this.updateTask(taskId, {
      status: "running",
      startedAt,
      updatedAt: startedAt,
    });

    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }

    try {
      const result = await this.createRecord(task.payload);
      const finishedAt = this.now();
      this.updateTask(taskId, {
        status: "success",
        entryId: result.entryId,
        finishedAt,
        updatedAt: finishedAt,
      });
    } catch (error) {
      const finishedAt = this.now();
      const normalizedError = normalizeCreateError(error);
      this.updateTask(taskId, {
        status: "failed",
        finishedAt,
        updatedAt: finishedAt,
        error: normalizedError,
        writeIndeterminate: isActivityLogCreateWriteIndeterminateError(error),
      });
    }
  }

  private updateTask(
    taskId: string,
    patch: Partial<ActivityLogDowntimeCreateTask>
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }
    const nextTask = {
      ...task,
      ...patch,
    };
    this.tasks.set(taskId, nextTask);
    this.syncTaskToRegistry(nextTask);
    this.pruneLocalTaskHistory();
  }

  private pruneLocalTaskHistory(): void {
    const prunedCount = pruneTerminalTaskHistory(this.tasks);
    if (prunedCount > 0) {
      this.rebuildClientRowKeyIndex();
    }
  }

  private rebuildClientRowKeyIndex(): void {
    this.taskIdByClientRowKey.clear();
    for (const task of this.tasks.values()) {
      this.taskIdByClientRowKey.set(task.clientRowKey, task.taskId);
    }
  }

  private recoverInterruptedRegistryTasks(): void {
    const interruptedTasks = [
      ...this.registry.listTasks({
        formId: "903",
        taskType: "create-downtime",
        status: "pending",
        limit: 200,
      }),
      ...this.registry.listTasks({
        formId: "903",
        taskType: "create-downtime",
        status: "running",
        limit: 200,
      }),
    ];
    const recoveredAt = this.now();
    for (const task of interruptedTasks) {
      const writeIndeterminate = task.status === "running";
      const recoveryMessage = writeIndeterminate
        ? "服務重啟時停機紀錄建立正在執行，寫入結果尚未確認；請先確認是否已建立，不可直接重送。"
        : "服務重啟，停機紀錄建立任務尚未開始，已標記為失敗，請重送。";
      this.registry.upsertTask({
        taskId: task.taskId,
        taskType: "create-downtime",
        status: "failed",
        formId: "903",
        entryId: task.entryId,
        rowId: null,
        queueKey: task.queueKey ?? ACTIVITY_LOG_DOWNTIME_CREATE_QUEUE_KEY,
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        finishedAt: recoveredAt,
        updatedAt: recoveredAt,
        message: recoveryMessage,
        errorCode: "TASK_RECOVERED_AFTER_RESTART",
        errorMessage: recoveryMessage,
        writeIndeterminate,
        actorClientId: task.actorClientId,
        actorTabId: task.actorTabId,
        actorIp: task.actorIp,
        actorLabel: task.actorLabel,
      });
    }
  }

  private syncTaskToRegistry(task: ActivityLogDowntimeCreateTask): void {
    this.registry.upsertTask({
      taskId: task.taskId,
      taskType: "create-downtime",
      status: task.status,
      formId: "903",
      entryId: task.entryId,
      rowId: null,
      queueKey: task.queueKey,
      createdAt: task.createdAt,
      startedAt: task.startedAt ?? null,
      finishedAt: task.finishedAt ?? null,
      updatedAt: task.updatedAt,
      message: this.getTaskMessage(task),
      errorCode: task.error?.code ?? null,
      errorMessage: task.error?.message ?? null,
      writeIndeterminate: task.writeIndeterminate ?? null,
      actorClientId: task.actorClientId ?? null,
      actorTabId: task.actorTabId ?? null,
      actorIp: task.actorIp ?? null,
      actorLabel: task.actorLabel ?? null,
    });
  }

  private getTaskMessage(task: ActivityLogDowntimeCreateTask): string {
    if (task.status === "pending") {
      return "停機紀錄建立排隊中";
    }
    if (task.status === "running") {
      return "停機紀錄建立中";
    }
    if (task.status === "success") {
      return task.entryId
        ? `停機紀錄已建立（Entry ${task.entryId}）`
        : "停機紀錄已建立";
    }
    return task.error?.message ?? "停機紀錄建立失敗";
  }

  private toAcceptedTask(task: ActivityLogDowntimeCreateTask): Pick<
    ActivityLogDowntimeCreateTask,
    "taskId" | "status" | "createdAt" | "entryId"
  > {
    return {
      taskId: task.taskId,
      status: task.status,
      createdAt: task.createdAt,
      entryId: task.entryId,
    };
  }

  private copyTask(task: ActivityLogDowntimeCreateTask): ActivityLogDowntimeCreateTask {
    return {
      ...task,
      payload: { ...task.payload },
      error: task.error ? { ...task.error } : undefined,
    };
  }
}

export const activityLogDowntimeCreateTaskService =
  new ActivityLogDowntimeCreateTaskService();

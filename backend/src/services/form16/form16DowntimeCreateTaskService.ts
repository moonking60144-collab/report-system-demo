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
  form16DowntimeService,
  type CreateForm16DowntimeInput,
} from "./form16DowntimeService";
import { pruneTerminalTaskHistory } from "../work-report/localTaskHistory";
import type { KeyedSerialQueue } from "../../utils/keyedSerialQueue";

export const FORM16_DOWNTIME_CREATE_QUEUE_KEY = "16:downtime:create";

type DowntimeCreateTaskType = Extract<WorkReportQueueTaskType, "create-downtime">;

export type Form16DowntimeCreateTaskStatus = WorkReportQueueTaskStatus;

export type Form16DowntimeCreateTaskPayload = CreateForm16DowntimeInput & {
  clientRowKey: string;
};

export interface Form16DowntimeCreateTask {
  taskId: string;
  taskType: DowntimeCreateTaskType;
  formId: "16";
  entryId: string | null;
  queueKey: string;
  clientRowKey: string;
  payload: Form16DowntimeCreateTaskPayload;
  actorClientId?: string;
  actorTabId?: string;
  actorIp?: string;
  actorLabel?: string;
  status: Form16DowntimeCreateTaskStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: {
    code: string;
    message: string;
  };
}

export interface EnqueueForm16DowntimeCreateTaskInput {
  payload: Form16DowntimeCreateTaskPayload;
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
  actorClientId?: string | null;
  actorTabId?: string | null;
  actorIp?: string | null;
  actorLabel?: string | null;
  source?: string | null;
}

interface Form16DowntimeCreateTaskRegistry {
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

interface Form16DowntimeCreateTaskServiceDeps {
  registry?: Form16DowntimeCreateTaskRegistry;
  queue?: KeyedSerialQueue;
  createRecord?: (
    input: CreateForm16DowntimeInput
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

export class Form16DowntimeCreateTaskService {
  private readonly tasks = new Map<string, Form16DowntimeCreateTask>();
  private readonly taskIdByClientRowKey = new Map<string, string>();
  private readonly registry: Form16DowntimeCreateTaskRegistry;
  private readonly queue: KeyedSerialQueue;
  private readonly createRecord: (
    input: CreateForm16DowntimeInput
  ) => Promise<{ created: true; entryId: string }>;
  private readonly createTaskId: () => string;
  private readonly now: () => string;
  private initializedPromise: Promise<void> | null = null;

  constructor(deps: Form16DowntimeCreateTaskServiceDeps = {}) {
    this.registry = deps.registry ?? workReportTaskRegistryService;
    this.queue = deps.queue ?? workReportEntryMutationQueue;
    this.createRecord =
      deps.createRecord ?? ((input) => form16DowntimeService.createRecord(input));
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

  enqueue(input: EnqueueForm16DowntimeCreateTaskInput): Pick<
    Form16DowntimeCreateTask,
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

    const createdAt = this.now();
    const task: Form16DowntimeCreateTask = {
      taskId: this.createTaskId(),
      taskType: "create-downtime",
      formId: "16",
      entryId: null,
      queueKey: FORM16_DOWNTIME_CREATE_QUEUE_KEY,
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

  getTask(taskId: string): Form16DowntimeCreateTask | null {
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
      });
    }
  }

  private updateTask(
    taskId: string,
    patch: Partial<Form16DowntimeCreateTask>
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
        formId: "16",
        taskType: "create-downtime",
        status: "pending",
        limit: 200,
      }),
      ...this.registry.listTasks({
        formId: "16",
        taskType: "create-downtime",
        status: "running",
        limit: 200,
      }),
    ];
    const recoveredAt = this.now();
    for (const task of interruptedTasks) {
      this.registry.upsertTask({
        taskId: task.taskId,
        taskType: "create-downtime",
        status: "failed",
        formId: "16",
        entryId: task.entryId,
        rowId: null,
        queueKey: task.queueKey ?? FORM16_DOWNTIME_CREATE_QUEUE_KEY,
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        finishedAt: recoveredAt,
        updatedAt: recoveredAt,
        message: "服務重啟，停機紀錄建立任務已標記為失敗，請重送。",
        errorCode: "TASK_RECOVERED_AFTER_RESTART",
        errorMessage: "服務重啟，停機紀錄建立任務已標記為失敗，請重送。",
        actorClientId: task.actorClientId,
        actorTabId: task.actorTabId,
        actorIp: task.actorIp,
        actorLabel: task.actorLabel,
      });
    }
  }

  private syncTaskToRegistry(task: Form16DowntimeCreateTask): void {
    this.registry.upsertTask({
      taskId: task.taskId,
      taskType: "create-downtime",
      status: task.status,
      formId: "16",
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
      actorClientId: task.actorClientId ?? null,
      actorTabId: task.actorTabId ?? null,
      actorIp: task.actorIp ?? null,
      actorLabel: task.actorLabel ?? null,
    });
  }

  private getTaskMessage(task: Form16DowntimeCreateTask): string {
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

  private toAcceptedTask(task: Form16DowntimeCreateTask): Pick<
    Form16DowntimeCreateTask,
    "taskId" | "status" | "createdAt" | "entryId"
  > {
    return {
      taskId: task.taskId,
      status: task.status,
      createdAt: task.createdAt,
      entryId: task.entryId,
    };
  }

  private copyTask(task: Form16DowntimeCreateTask): Form16DowntimeCreateTask {
    return {
      ...task,
      payload: { ...task.payload },
      error: task.error ? { ...task.error } : undefined,
    };
  }
}

export const form16DowntimeCreateTaskService =
  new Form16DowntimeCreateTaskService();

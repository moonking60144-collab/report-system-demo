import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import { env } from "../config/env";
import {
  workReportTaskRegistryService,
  type WorkReportQueueTaskType,
} from "./work-report/workReportTaskRegistryService";

const TASK_SNAPSHOT_VERSION = "v1";

export type CreateReportTaskStatus = "pending" | "running" | "success" | "failed";

export interface CreateReportTaskResult {
  rowId?: string;
}

export interface CreateReportTaskError {
  code?: string;
  message: string;
}

export interface CreateReportTask {
  taskId: string;
  taskType?: Extract<WorkReportQueueTaskType, "create-report" | "update-report">;
  formId: string;
  entryId: string;
  workOrderNo?: string;
  queueKey: string;
  clientMutationId?: string;
  actorClientId?: string;
  actorTabId?: string;
  actorIp?: string;
  actorLabel?: string;
  status: CreateReportTaskStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: CreateReportTaskResult;
  error?: CreateReportTaskError;
}

interface EnqueueCreateReportTaskInput {
  taskType?: Extract<WorkReportQueueTaskType, "create-report" | "update-report">;
  formId: string;
  entryId: string;
  workOrderNo?: string;
  queueKey: string;
  clientMutationId?: string;
  actorClientId?: string;
  actorTabId?: string;
  actorIp?: string;
  actorLabel?: string;
  worker: () => Promise<unknown>;
}

interface TaskSnapshotPayload {
  version: string;
  savedAt: string;
  tasks: CreateReportTask[];
}

class CreateReportTaskService {
  private readonly tasks = new Map<string, CreateReportTask>();
  private readonly queueChainByKey = new Map<string, Promise<void>>();
  private readonly taskIdByClientMutationId = new Map<string, string>();
  private persistChain: Promise<void> = Promise.resolve();
  private initializedPromise: Promise<void> | null = null;

  constructor() {
    void this.initialize();
  }

  async initialize(): Promise<void> {
    if (!env.CREATE_TASK_PERSIST_ENABLED) {
      return;
    }

    if (this.initializedPromise) {
      await this.initializedPromise;
      return;
    }

    this.initializedPromise = this.loadFromDisk();
    await this.initializedPromise;
  }

  enqueue(input: EnqueueCreateReportTaskInput): CreateReportTask {
    const clientMutationId = String(input.clientMutationId ?? "").trim();
    if (clientMutationId) {
      const existingTaskId = this.taskIdByClientMutationId.get(clientMutationId);
      if (existingTaskId) {
        const existingTask = this.tasks.get(existingTaskId);
        if (existingTask) {
          const canRetryRecoveredTask =
            existingTask.status === "failed" &&
            existingTask.error?.code === "TASK_RECOVERED_AFTER_RESTART";
          if (!canRetryRecoveredTask) {
            return this.copyTask(existingTask);
          }
        }
        this.taskIdByClientMutationId.delete(clientMutationId);
      }
    }

    const taskId = randomUUID();
    const createdAt = new Date().toISOString();
    const task: CreateReportTask = {
      taskId,
      taskType: input.taskType ?? "create-report",
      formId: input.formId,
      entryId: input.entryId,
      ...(typeof input.workOrderNo === "string" && input.workOrderNo.trim()
        ? { workOrderNo: input.workOrderNo.trim() }
        : {}),
      queueKey: input.queueKey,
      ...(clientMutationId ? { clientMutationId } : {}),
      ...(input.actorClientId ? { actorClientId: input.actorClientId } : {}),
      ...(input.actorTabId ? { actorTabId: input.actorTabId } : {}),
      ...(input.actorIp ? { actorIp: input.actorIp } : {}),
      ...(input.actorLabel ? { actorLabel: input.actorLabel } : {}),
      status: "pending",
      createdAt,
      updatedAt: createdAt,
    };
    this.tasks.set(taskId, task);
    if (clientMutationId) {
      this.taskIdByClientMutationId.set(clientMutationId, taskId);
    }
    this.syncTaskToRegistry(task);
    this.pruneHistory();
    this.schedulePersist();

    const currentChain = this.queueChainByKey.get(input.queueKey) ?? Promise.resolve();
    const nextChain = currentChain
      .catch(() => {
        // NOTE: 保持 queue 持續可用，避免前一筆失敗中斷後續任務。
      })
      .then(async () => {
        await this.runTask(taskId, input.worker);
      });

    this.queueChainByKey.set(input.queueKey, nextChain);
    void nextChain.finally(() => {
      if (this.queueChainByKey.get(input.queueKey) === nextChain) {
        this.queueChainByKey.delete(input.queueKey);
      }
    });

    return this.copyTask(task);
  }

  getTask(taskId: string): CreateReportTask | null {
    const task = this.tasks.get(taskId);
    if (!task) {
      return null;
    }
    return this.copyTask(task);
  }

  getStats(): {
    total: number;
    pending: number;
    running: number;
    success: number;
    failed: number;
    activeQueueKeyCount: number;
  } {
    const counts = {
      total: this.tasks.size,
      pending: 0,
      running: 0,
      success: 0,
      failed: 0,
      activeQueueKeyCount: this.queueChainByKey.size,
    };

    for (const task of this.tasks.values()) {
      if (task.status === "pending") {
        counts.pending += 1;
      } else if (task.status === "running") {
        counts.running += 1;
      } else if (task.status === "success") {
        counts.success += 1;
      } else if (task.status === "failed") {
        counts.failed += 1;
      }
    }

    return counts;
  }

  private async runTask(
    taskId: string,
    worker: () => Promise<unknown>
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    this.updateTask(taskId, {
      status: "running",
      startedAt,
      updatedAt: startedAt,
    });

    try {
      const result = this.normalizeTaskResult(await worker());
      const finishedAt = new Date().toISOString();
      this.updateTask(taskId, {
        status: "success",
        finishedAt,
        updatedAt: finishedAt,
        result,
      });
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const normalizedError =
        error instanceof Error
          ? {
              code:
                typeof (error as { code?: unknown }).code === "string"
                  ? String((error as { code?: unknown }).code)
                  : undefined,
              message: error.message,
            }
          : { message: String(error) };

      this.updateTask(taskId, {
        status: "failed",
        finishedAt,
        updatedAt: finishedAt,
        error: normalizedError,
      });
    }
  }

  private updateTask(taskId: string, patch: Partial<CreateReportTask>): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }

    this.tasks.set(taskId, {
      ...task,
      ...patch,
    });

    this.syncTaskToRegistry(this.tasks.get(taskId)!);
    this.pruneHistory();
    this.schedulePersist();
  }

  private copyTask(task: CreateReportTask): CreateReportTask {
    return {
      ...task,
      result: task.result ? { ...task.result } : undefined,
      error: task.error ? { ...task.error } : undefined,
    };
  }

  private normalizeTaskResult(value: unknown): CreateReportTaskResult {
    if (!value || typeof value !== "object") {
      return {};
    }
    const rowId = String((value as { rowId?: unknown }).rowId ?? "").trim();
    return rowId ? { rowId } : {};
  }

  private async loadFromDisk(): Promise<void> {
    if (!env.CREATE_TASK_PERSIST_ENABLED) {
      return;
    }

    const filePath = this.resolveStoreFilePath();
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as TaskSnapshotPayload;
      if (!this.isValidSnapshotPayload(parsed)) {
        console.warn("[create-task][snapshot-invalid]", { filePath });
        return;
      }

      for (const task of parsed.tasks) {
        this.tasks.set(task.taskId, {
          ...task,
          taskType: task.taskType ?? "create-report",
        });
        if (typeof task.clientMutationId === "string" && task.clientMutationId.trim()) {
          this.taskIdByClientMutationId.set(task.clientMutationId.trim(), task.taskId);
        }
      }

      const recoveredCount = this.recoverInterruptedTasks();
      this.syncAllTasksToRegistry();
      this.pruneHistory();
      this.schedulePersist();
      console.info("[create-task][snapshot-loaded]", {
        filePath,
        count: parsed.tasks.length,
        recoveredCount,
      });
    } catch (error) {
      const errnoError = error as NodeJS.ErrnoException;
      if (errnoError.code === "ENOENT") {
        return;
      }
      console.warn("[create-task][snapshot-load-failed]", {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private recoverInterruptedTasks(): number {
    const recoveredAt = new Date().toISOString();
    let recoveredCount = 0;

    for (const [taskId, task] of this.tasks.entries()) {
      if (task.status !== "pending" && task.status !== "running") {
        continue;
      }

      recoveredCount += 1;
      this.tasks.set(taskId, {
        ...task,
        status: "failed",
        updatedAt: recoveredAt,
        finishedAt: recoveredAt,
        error: {
          code: "TASK_RECOVERED_AFTER_RESTART",
          message: "服務重啟，原非完成任務已標記為失敗，請重新送出",
        },
      });
    }

    if (recoveredCount > 0) {
      console.warn("[create-task][recovered-interrupted]", { recoveredCount });
    }

    return recoveredCount;
  }

  private pruneHistory(): void {
    const maxTasks = env.CREATE_TASK_HISTORY_LIMIT;
    if (this.tasks.size <= maxTasks) {
      return;
    }

    const completedTasks = Array.from(this.tasks.values())
      .filter((task) => task.status === "success" || task.status === "failed")
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

    for (const task of completedTasks) {
      if (this.tasks.size <= maxTasks) {
        break;
      }
      this.tasks.delete(task.taskId);
      if (
        typeof task.clientMutationId === "string" &&
        task.clientMutationId.trim() &&
        this.taskIdByClientMutationId.get(task.clientMutationId.trim()) === task.taskId
      ) {
        this.taskIdByClientMutationId.delete(task.clientMutationId.trim());
      }
    }
  }

  private schedulePersist(): void {
    if (!env.CREATE_TASK_PERSIST_ENABLED) {
      return;
    }

    this.persistChain = this.persistChain
      .catch(() => {
        // NOTE: keep chain alive
      })
      .then(async () => {
        await this.persistToDisk();
      })
      .catch((error) => {
        console.warn("[create-task][snapshot-save-failed]", {
          filePath: this.resolveStoreFilePath(),
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private async persistToDisk(): Promise<void> {
    const filePath = this.resolveStoreFilePath();
    const dirPath = path.dirname(filePath);
    await fs.mkdir(dirPath, { recursive: true });

    const snapshot: TaskSnapshotPayload = {
      version: TASK_SNAPSHOT_VERSION,
      savedAt: new Date().toISOString(),
      tasks: Array.from(this.tasks.values())
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((task) => this.copyTask(task)),
    };

    const tempFilePath = `${filePath}.tmp`;
    await fs.writeFile(tempFilePath, JSON.stringify(snapshot), "utf-8");
    await fs.rename(tempFilePath, filePath);
  }

  private resolveStoreFilePath(): string {
    return path.resolve(env.CREATE_TASK_STORE_FILE);
  }

  private syncTaskToRegistry(task: CreateReportTask): void {
    const taskType = task.taskType ?? "create-report";
    const baseMessage =
      taskType === "update-report" ? "更新報工背景任務" : "新增報工背景任務";
    const message =
      task.status === "pending"
        ? `${baseMessage}排隊中`
        : task.status === "running"
          ? `${baseMessage}處理中`
          : task.status === "success"
            ? task.result?.rowId
              ? `${baseMessage}完成（rowId: ${task.result.rowId}）`
              : `${baseMessage}完成`
            : task.error?.message ?? `${baseMessage}失敗`;

    workReportTaskRegistryService.upsertTask({
      taskId: task.taskId,
      taskType,
      status: task.status,
      formId: task.formId,
      workOrderNo: task.workOrderNo ?? null,
      entryId: task.entryId,
      rowId: task.result?.rowId ?? null,
      queueKey: task.queueKey,
      createdAt: task.createdAt,
      startedAt: task.startedAt ?? null,
      finishedAt: task.finishedAt ?? null,
      updatedAt: task.updatedAt,
      message,
      errorCode: task.error?.code ?? null,
      errorMessage: task.error?.message ?? null,
      actorClientId: task.actorClientId ?? null,
      actorTabId: task.actorTabId ?? null,
      actorIp: task.actorIp ?? null,
      actorLabel: task.actorLabel ?? null,
    });
  }

  private syncAllTasksToRegistry(): void {
    for (const task of this.tasks.values()) {
      this.syncTaskToRegistry(task);
    }
  }

  private isValidSnapshotPayload(payload: unknown): payload is TaskSnapshotPayload {
    if (!payload || typeof payload !== "object") {
      return false;
    }

    const maybeSnapshot = payload as Partial<TaskSnapshotPayload>;
    return (
      maybeSnapshot.version === TASK_SNAPSHOT_VERSION &&
      Array.isArray(maybeSnapshot.tasks) &&
      maybeSnapshot.tasks.every((task) => this.isValidTask(task))
    );
  }

  private isValidTask(task: unknown): task is CreateReportTask {
    if (!task || typeof task !== "object") {
      return false;
    }

    const t = task as Partial<CreateReportTask>;
    return (
      typeof t.taskId === "string" &&
      typeof t.formId === "string" &&
      typeof t.entryId === "string" &&
      typeof t.queueKey === "string" &&
      (t.taskType === undefined || t.taskType === "create-report" || t.taskType === "update-report") &&
      (t.clientMutationId === undefined || typeof t.clientMutationId === "string") &&
      (t.actorClientId === undefined || typeof t.actorClientId === "string") &&
      (t.actorTabId === undefined || typeof t.actorTabId === "string") &&
      (t.actorIp === undefined || typeof t.actorIp === "string") &&
      (t.actorLabel === undefined || typeof t.actorLabel === "string") &&
      typeof t.status === "string" &&
      typeof t.createdAt === "string" &&
      typeof t.updatedAt === "string"
    );
  }
}

export const createReportTaskService = new CreateReportTaskService();

import fs from "fs/promises";
import path from "path";
import { env } from "../../config/env";
import {
  getWorkReportTaskStatusMergeRank,
  parseWorkReportTaskTimestamp,
} from "./workReportTaskStatusMerge";
import {
  isConfirmedMutationLifecycleState,
  isMutationLifecycleState,
  resolveMutationLifecycleState,
  type MutationLifecycleState,
} from "../../types/mutationLifecycle";

const TASK_REGISTRY_SNAPSHOT_VERSION = "v1";

export type WorkReportQueueTaskType =
  | "create-report"
  | "update-report"
  | "create-report-batch"
  | "delete-report"
  | "delete-report-batch"
  | "sync"
  | "callback-refresh"
  | "create-downtime"
  | "update-downtime"
  | "delete-downtime";

export type WorkReportQueueTaskStatus = "pending" | "running" | "success" | "failed";

const SINGLE_MUTATION_TASK_TYPES: ReadonlySet<WorkReportQueueTaskType> = new Set([
  "create-report",
  "update-report",
  "delete-report",
  "create-downtime",
  "update-downtime",
  "delete-downtime",
]);

const BATCH_MUTATION_TASK_TYPES: ReadonlySet<WorkReportQueueTaskType> = new Set([
  "create-report-batch",
  "delete-report-batch",
]);

export type WorkReportQueueTaskOperationKind =
  | "update-sort-order"
  | "update-main-machine"
  | "close-work-order"
  | "reopen-work-order";

export interface WorkReportQueueTaskRecord {
  taskId: string;
  taskType: WorkReportQueueTaskType;
  status: WorkReportQueueTaskStatus;
  formId: string;
  workOrderNo: string | null;
  entryId: string | null;
  rowId: string | null;
  queueKey: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lifecycleState?: MutationLifecycleState;
  acceptedAt?: string | null;
  confirmedAt?: string | null;
  updatedAt: string;
  message: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  actorClientId: string | null;
  actorTabId: string | null;
  actorIp: string | null;
  /** 使用者端裝置 label（x-debug-device-label header）；只該存真正的裝置/人員資訊 */
  actorLabel: string | null;
  operationKind?: WorkReportQueueTaskOperationKind | null;
  /** 系統事件來源（e.g. ragic-callback-16、ragic-form-save）；跟 actorLabel 分流，避免把 callback tag 誤當裝置名 */
  source: string | null;
  batchCreatedRowIds?: string[] | null;
  batchFinalizeFailed?: boolean | null;
  batchWriteIndeterminate?: boolean | null;
  writeIndeterminate?: boolean | null;
  deletedCount?: number | null;
  deleteFinalizeFailed?: boolean | null;
  retriedFromTaskId?: string | null;
}

interface UpsertWorkReportQueueTaskInput {
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
  acceptedAt?: string | null;
  confirmedAt?: string | null;
  updatedAt?: string;
  message?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  actorClientId?: string | null;
  actorTabId?: string | null;
  actorIp?: string | null;
  actorLabel?: string | null;
  operationKind?: WorkReportQueueTaskOperationKind | null;
  source?: string | null;
  batchCreatedRowIds?: string[] | null;
  batchFinalizeFailed?: boolean | null;
  batchWriteIndeterminate?: boolean | null;
  writeIndeterminate?: boolean | null;
  deletedCount?: number | null;
  deleteFinalizeFailed?: boolean | null;
  retriedFromTaskId?: string | null;
}

interface WorkReportTaskRegistrySnapshotPayload {
  version: string;
  savedAt: string;
  tasks: WorkReportQueueTaskRecord[];
}

interface ListWorkReportQueueTasksOptions {
  formId: string;
  entryId?: string;
  status?: WorkReportQueueTaskStatus;
  taskType?: WorkReportQueueTaskType;
  taskTypes?: WorkReportQueueTaskType[];
  actorClientId?: string;
  limit?: number;
}

interface ListReplayableWorkReportQueueTasksOptions {
  formId: string;
  taskType: WorkReportQueueTaskType;
  errorCode: string;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

const PERSIST_DEBOUNCE_MS = 200;

export class WorkReportTaskRegistryService {
  private readonly tasks = new Map<string, WorkReportQueueTaskRecord>();
  private persistChain: Promise<void> = Promise.resolve();
  private persistTimer: NodeJS.Timeout | null = null;
  private persistDirty = false;
  private initializedPromise: Promise<void> | null = null;

  constructor() {
    void this.initialize();
  }

  async initialize(): Promise<void> {
    if (!env.WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED) {
      return;
    }
    if (this.initializedPromise) {
      await this.initializedPromise;
      return;
    }
    this.initializedPromise = this.loadFromDisk();
    await this.initializedPromise;
  }

  upsertTask(input: UpsertWorkReportQueueTaskInput): WorkReportQueueTaskRecord {
    const existing = this.tasks.get(input.taskId);
    const createdAt = input.createdAt ?? existing?.createdAt ?? new Date().toISOString();
    const next: WorkReportQueueTaskRecord = {
      taskId: input.taskId,
      taskType: input.taskType,
      status: input.status,
      formId: input.formId,
      workOrderNo:
        normalizeOptionalString(input.workOrderNo) ??
        existing?.workOrderNo ??
        null,
      entryId:
        normalizeOptionalString(input.entryId) ??
        existing?.entryId ??
        null,
      rowId:
        normalizeOptionalString(input.rowId) ??
        existing?.rowId ??
        null,
      queueKey:
        normalizeOptionalString(input.queueKey) ??
        existing?.queueKey ??
        null,
      createdAt,
      startedAt:
        normalizeOptionalString(input.startedAt) ??
        existing?.startedAt ??
        null,
      finishedAt:
        normalizeOptionalString(input.finishedAt) ??
        existing?.finishedAt ??
        null,
      acceptedAt:
        input.acceptedAt === null
          ? null
          : normalizeOptionalString(input.acceptedAt) ??
            existing?.acceptedAt ??
            (!existing ? createdAt : null),
      confirmedAt:
        input.confirmedAt === null
          ? null
          : normalizeOptionalString(input.confirmedAt) ??
            existing?.confirmedAt ??
            null,
      updatedAt: input.updatedAt ?? new Date().toISOString(),
      message:
        normalizeOptionalString(input.message) ??
        existing?.message ??
        null,
      errorCode:
        input.errorCode === undefined
          ? existing?.errorCode ?? null
          : normalizeOptionalString(input.errorCode),
      errorMessage:
        input.errorMessage === undefined
          ? existing?.errorMessage ?? null
          : normalizeOptionalString(input.errorMessage),
      actorClientId:
        normalizeOptionalString(input.actorClientId) ??
        existing?.actorClientId ??
        null,
      actorTabId:
        normalizeOptionalString(input.actorTabId) ??
        existing?.actorTabId ??
        null,
      actorIp:
        normalizeOptionalString(input.actorIp) ??
        existing?.actorIp ??
        null,
      actorLabel:
        normalizeOptionalString(input.actorLabel) ??
        existing?.actorLabel ??
        null,
      operationKind:
        input.operationKind === "update-sort-order" ||
        input.operationKind === "update-main-machine" ||
        input.operationKind === "close-work-order" ||
        input.operationKind === "reopen-work-order"
          ? input.operationKind
          : existing?.operationKind ?? null,
      source:
        normalizeOptionalString(input.source) ??
        existing?.source ??
        null,
      batchCreatedRowIds:
        input.batchCreatedRowIds
          ? input.batchCreatedRowIds
              .map((rowId) => String(rowId ?? "").trim())
              .filter((rowId) => /^\d+$/.test(rowId))
          : existing?.batchCreatedRowIds ?? null,
      batchFinalizeFailed:
        typeof input.batchFinalizeFailed === "boolean"
          ? input.batchFinalizeFailed
          : existing?.batchFinalizeFailed ?? null,
      batchWriteIndeterminate:
        typeof input.batchWriteIndeterminate === "boolean"
          ? input.batchWriteIndeterminate
          : existing?.batchWriteIndeterminate ?? null,
      writeIndeterminate:
        typeof input.writeIndeterminate === "boolean"
          ? input.writeIndeterminate
          : input.writeIndeterminate === null
            ? null
            : existing?.writeIndeterminate ?? null,
      deletedCount:
        typeof input.deletedCount === "number" && Number.isFinite(input.deletedCount)
          ? Math.max(0, Math.trunc(input.deletedCount))
          : input.deletedCount === null
            ? null
            : existing?.deletedCount ?? null,
      deleteFinalizeFailed:
        typeof input.deleteFinalizeFailed === "boolean"
          ? input.deleteFinalizeFailed
          : input.deleteFinalizeFailed === null
            ? null
            : existing?.deleteFinalizeFailed ?? null,
      retriedFromTaskId:
        normalizeOptionalString(input.retriedFromTaskId) ??
        existing?.retriedFromTaskId ??
        null,
    };

    next.lifecycleState = resolveMutationLifecycleState(next);
    if (
      input.confirmedAt === undefined &&
      normalizeOptionalString(input.finishedAt) &&
      isConfirmedMutationLifecycleState(next.lifecycleState)
    ) {
      next.confirmedAt = normalizeOptionalString(input.finishedAt);
    }
    if (next.lifecycleState === "indeterminate" || next.lifecycleState === "unknown") {
      next.confirmedAt = null;
    }

    const merged = this.normalizeTaskLifecycle(this.mergeTaskRecords(existing, next));
    this.tasks.set(merged.taskId, merged);
    this.pruneHistory();
    this.schedulePersist();
    return this.copyTask(merged);
  }

  getTask(taskId: string): WorkReportQueueTaskRecord | null {
    const task = this.tasks.get(taskId);
    return task ? this.copyTask(task) : null;
  }

  listTasks(options: ListWorkReportQueueTasksOptions): WorkReportQueueTaskRecord[] {
    const entryId = normalizeOptionalString(options.entryId);
    const actorClientId = normalizeOptionalString(options.actorClientId);
    const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 50)));

    return Array.from(this.tasks.values())
      .filter((task) => {
        if (task.formId !== options.formId) {
          return false;
        }
        if (entryId && task.entryId !== entryId) {
          return false;
        }
        if (options.status && task.status !== options.status) {
          return false;
        }
        if (options.taskType && task.taskType !== options.taskType) {
          return false;
        }
        if (
          options.taskTypes &&
          options.taskTypes.length > 0 &&
          !options.taskTypes.includes(task.taskType)
        ) {
          return false;
        }
        if (actorClientId && task.actorClientId !== actorClientId) {
          return false;
        }
        return true;
      })
      .sort((left, right) => {
        const updatedCompare = right.updatedAt.localeCompare(left.updatedAt);
        if (updatedCompare !== 0) {
          return updatedCompare;
        }
        return right.createdAt.localeCompare(left.createdAt);
      })
      .slice(0, limit)
      .map((task) => this.copyTask(task));
  }

  listTasksForReplay(
    options: ListReplayableWorkReportQueueTasksOptions
  ): WorkReportQueueTaskRecord[] {
    return Array.from(this.tasks.values())
      .filter(
        (task) =>
          task.formId === options.formId &&
          task.taskType === options.taskType &&
          task.status === "failed" &&
          task.errorCode === options.errorCode
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((task) => this.copyTask(task));
  }

  private async loadFromDisk(): Promise<void> {
    if (!env.WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED) {
      return;
    }

    const filePath = this.resolveStoreFilePath();
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as WorkReportTaskRegistrySnapshotPayload;
      if (!this.isValidSnapshotPayload(parsed)) {
        console.warn("[task-registry][snapshot-invalid]", { filePath });
        return;
      }

      for (const task of parsed.tasks) {
        const existing = this.tasks.get(task.taskId);
        this.tasks.set(
          task.taskId,
          this.normalizeTaskLifecycle(this.mergeTaskRecords(existing, task))
        );
      }

      this.recoverInterruptedTasks();
      this.pruneHistory();
      this.schedulePersist();
    } catch (error) {
      const errnoError = error as NodeJS.ErrnoException;
      if (errnoError.code === "ENOENT") {
        return;
      }
      console.warn("[task-registry][snapshot-load-failed]", {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private recoverInterruptedTasks(): void {
    const recoveredAt = new Date().toISOString();
    for (const [taskId, task] of this.tasks.entries()) {
      if (task.status !== "pending" && task.status !== "running") {
        continue;
      }
      const isRunningSingleMutation =
        task.status === "running" && SINGLE_MUTATION_TASK_TYPES.has(task.taskType);
      const isRunningBatchMutation =
        task.status === "running" && BATCH_MUTATION_TASK_TYPES.has(task.taskType);
      const isRunningMutation = isRunningSingleMutation || isRunningBatchMutation;
      const recoveryMessage =
        isRunningMutation
          ? "服務重啟時寫入任務正在執行，結果尚未確認；請先重新整理確認，不可直接重送"
          : "服務重啟，原未完成任務已標記為失敗";
      const recoveredTask: WorkReportQueueTaskRecord = {
        ...task,
        status: "failed",
        updatedAt: recoveredAt,
        finishedAt: recoveredAt,
        confirmedAt: isRunningMutation ? null : recoveredAt,
        errorCode: "TASK_REGISTRY_RECOVERED_AFTER_RESTART",
        errorMessage: recoveryMessage,
        message: recoveryMessage,
        ...(SINGLE_MUTATION_TASK_TYPES.has(task.taskType)
          ? { writeIndeterminate: isRunningSingleMutation }
          : {}),
        ...(BATCH_MUTATION_TASK_TYPES.has(task.taskType)
          ? { batchWriteIndeterminate: isRunningBatchMutation }
          : {}),
      };
      this.tasks.set(taskId, this.normalizeTaskLifecycle(recoveredTask));
    }
  }

  private mergeTaskRecords(
    existing: WorkReportQueueTaskRecord | undefined,
    next: WorkReportQueueTaskRecord
  ): WorkReportQueueTaskRecord {
    if (!existing) {
      return next;
    }

    const existingRank = getWorkReportTaskStatusMergeRank(existing.status);
    const nextRank = getWorkReportTaskStatusMergeRank(next.status);
    let selected: WorkReportQueueTaskRecord;
    if (existingRank !== nextRank) {
      selected = nextRank > existingRank ? next : existing;
    } else {
      const existingUpdatedAt = parseWorkReportTaskTimestamp(existing.updatedAt);
      const nextUpdatedAt = parseWorkReportTaskTimestamp(next.updatedAt);
      selected = existingUpdatedAt > nextUpdatedAt ? existing : next;
    }

    if (selected.status !== "failed") {
      return selected;
    }

    const indeterminateSource =
      next.writeIndeterminate === true
        ? next
        : existing.writeIndeterminate === true
          ? existing
          : null;
    if (
      indeterminateSource &&
      SINGLE_MUTATION_TASK_TYPES.has(selected.taskType)
    ) {
      return {
        ...selected,
        writeIndeterminate: true,
        message: indeterminateSource.message ?? selected.message,
        errorCode: indeterminateSource.errorCode ?? selected.errorCode,
        errorMessage: indeterminateSource.errorMessage ?? selected.errorMessage,
      };
    }

    const indeterminateBatchSource =
      next.batchWriteIndeterminate === true
        ? next
        : existing.batchWriteIndeterminate === true
          ? existing
          : null;
    if (
      indeterminateBatchSource &&
      BATCH_MUTATION_TASK_TYPES.has(selected.taskType)
    ) {
      return {
        ...selected,
        batchWriteIndeterminate: true,
        message: indeterminateBatchSource.message ?? selected.message,
        errorCode: indeterminateBatchSource.errorCode ?? selected.errorCode,
        errorMessage: indeterminateBatchSource.errorMessage ?? selected.errorMessage,
      };
    }

    return selected;
  }

  private pruneHistory(): void {
    const maxTasks = env.WORK_REPORT_TASK_REGISTRY_HISTORY_LIMIT;
    if (this.tasks.size <= maxTasks) {
      return;
    }

    const completedTasks = Array.from(this.tasks.values())
      .filter(
        (task) =>
          (task.status === "success" || task.status === "failed") &&
          !(
            task.formId === "16" &&
            task.taskType === "callback-refresh" &&
            task.errorCode === "TASK_REGISTRY_RECOVERED_AFTER_RESTART"
          )
      )
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

    for (const task of completedTasks) {
      if (this.tasks.size <= maxTasks) {
        break;
      }
      this.tasks.delete(task.taskId);
    }
  }

  // 關機前呼叫：清掉 pending debounce timer，把尚未落盤的 task 狀態立即寫完，
  // 並等進行中的寫盤鏈結束，避免 graceful shutdown 退出時丟掉最後一批變更。
  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!env.WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED || !this.persistDirty) {
      await this.persistChain.catch(() => {});
      return;
    }
    this.persistDirty = false;
    this.persistChain = this.persistChain
      .catch(() => {})
      .then(() => this.persistToDisk());
    await this.persistChain.catch((error) => {
      console.warn("[task-registry][flush-failed]", {
        filePath: this.resolveStoreFilePath(),
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private schedulePersist(): void {
    if (!env.WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED) {
      return;
    }

    // 以 trailing debounce 合併 burst 內的多次 upsert：批次操作時 N 次狀態轉換
    // 原本會觸發 N 次整檔 stringify + temp file rename，現在壓成 1 次
    this.persistDirty = true;
    if (this.persistTimer) {
      return;
    }
    const timer = setTimeout(() => {
      this.persistTimer = null;
      if (!this.persistDirty) {
        return;
      }
      this.persistDirty = false;
      this.persistChain = this.persistChain
        .catch(() => {
          // keep chain alive
        })
        .then(async () => {
          await this.persistToDisk();
        })
        .catch((error) => {
          console.warn("[task-registry][snapshot-save-failed]", {
            filePath: this.resolveStoreFilePath(),
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }, PERSIST_DEBOUNCE_MS);
    timer.unref?.();
    this.persistTimer = timer;
  }

  private async persistToDisk(): Promise<void> {
    const filePath = this.resolveStoreFilePath();
    const dirPath = path.dirname(filePath);
    await fs.mkdir(dirPath, { recursive: true });

    const snapshot: WorkReportTaskRegistrySnapshotPayload = {
      version: TASK_REGISTRY_SNAPSHOT_VERSION,
      savedAt: new Date().toISOString(),
      tasks: Array.from(this.tasks.values())
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((task) => this.copyTask(task)),
    };

    const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempFilePath, JSON.stringify(snapshot), "utf-8");
    await fs.rename(tempFilePath, filePath);
  }

  private resolveStoreFilePath(): string {
    return path.resolve(env.WORK_REPORT_TASK_REGISTRY_STORE_FILE);
  }

  private copyTask(task: WorkReportQueueTaskRecord): WorkReportQueueTaskRecord {
    return this.normalizeTaskLifecycle(task);
  }

  private normalizeTaskLifecycle(
    task: WorkReportQueueTaskRecord
  ): WorkReportQueueTaskRecord {
    const lifecycleState = resolveMutationLifecycleState(task);
    return {
      ...task,
      lifecycleState,
      acceptedAt: normalizeOptionalString(task.acceptedAt),
      confirmedAt:
        lifecycleState === "indeterminate" || lifecycleState === "unknown"
          ? null
          : normalizeOptionalString(task.confirmedAt),
    };
  }

  private isValidSnapshotPayload(payload: unknown): payload is WorkReportTaskRegistrySnapshotPayload {
    if (!payload || typeof payload !== "object") {
      return false;
    }

    const maybeSnapshot = payload as Partial<WorkReportTaskRegistrySnapshotPayload>;
    return (
      maybeSnapshot.version === TASK_REGISTRY_SNAPSHOT_VERSION &&
      Array.isArray(maybeSnapshot.tasks) &&
      maybeSnapshot.tasks.every((task) => this.isValidTask(task))
    );
  }

  private isValidTask(task: unknown): task is WorkReportQueueTaskRecord {
    if (!task || typeof task !== "object") {
      return false;
    }

    const candidate = task as Partial<WorkReportQueueTaskRecord>;
    return (
      typeof candidate.taskId === "string" &&
      typeof candidate.taskType === "string" &&
      typeof candidate.status === "string" &&
      typeof candidate.formId === "string" &&
      (candidate.workOrderNo === null || candidate.workOrderNo === undefined || typeof candidate.workOrderNo === "string") &&
      (candidate.batchCreatedRowIds === null ||
        candidate.batchCreatedRowIds === undefined ||
        (Array.isArray(candidate.batchCreatedRowIds) &&
          candidate.batchCreatedRowIds.every((rowId) => typeof rowId === "string"))) &&
      (candidate.batchFinalizeFailed === null ||
        candidate.batchFinalizeFailed === undefined ||
        typeof candidate.batchFinalizeFailed === "boolean") &&
      (candidate.batchWriteIndeterminate === null ||
        candidate.batchWriteIndeterminate === undefined ||
        typeof candidate.batchWriteIndeterminate === "boolean") &&
      (candidate.writeIndeterminate === null ||
        candidate.writeIndeterminate === undefined ||
        typeof candidate.writeIndeterminate === "boolean") &&
      (candidate.deletedCount === null ||
        candidate.deletedCount === undefined ||
        (typeof candidate.deletedCount === "number" &&
          Number.isInteger(candidate.deletedCount) &&
          candidate.deletedCount >= 0)) &&
      (candidate.deleteFinalizeFailed === null ||
        candidate.deleteFinalizeFailed === undefined ||
        typeof candidate.deleteFinalizeFailed === "boolean") &&
      (candidate.retriedFromTaskId === null ||
        candidate.retriedFromTaskId === undefined ||
        typeof candidate.retriedFromTaskId === "string") &&
      (candidate.operationKind === null ||
        candidate.operationKind === undefined ||
        candidate.operationKind === "update-sort-order" ||
        candidate.operationKind === "update-main-machine" ||
        candidate.operationKind === "close-work-order" ||
        candidate.operationKind === "reopen-work-order") &&
      (candidate.lifecycleState === undefined ||
        isMutationLifecycleState(candidate.lifecycleState)) &&
      (candidate.acceptedAt === undefined ||
        candidate.acceptedAt === null ||
        typeof candidate.acceptedAt === "string") &&
      (candidate.confirmedAt === undefined ||
        candidate.confirmedAt === null ||
        typeof candidate.confirmedAt === "string") &&
      typeof candidate.createdAt === "string" &&
      typeof candidate.updatedAt === "string"
    );
  }
}

export const workReportTaskRegistryService = new WorkReportTaskRegistryService();

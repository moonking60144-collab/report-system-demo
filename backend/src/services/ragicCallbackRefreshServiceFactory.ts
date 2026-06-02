import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import { env } from "../config/env";
import { workReportDebugLog } from "../observability/workReportDebugLog";
import type { WorkReportRecord } from "../types/workReport";
import { HttpError } from "../utils/httpError";
import { workReportTaskRegistryService } from "./work-report/workReportTaskRegistryService";

export type RagicCallbackEventType =
  | "entry-created"
  | "entry-updated"
  | "entry-deleted"
  | "row-created"
  | "row-updated"
  | "row-deleted";

type CallbackProjectionReason = "create" | "update" | "delete";
type CallbackTaskStatus = "pending" | "running" | "success" | "failed";
const CALLBACK_TASK_SNAPSHOT_VERSION = "v1";

export interface CallbackTask {
  taskId: string;
  formId: string;
  entryId: string;
  eventType: RagicCallbackEventType;
  rowId?: string;
  source?: string;
  status: CallbackTaskStatus;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  error?: {
    code?: string;
    message: string;
  };
}

interface CallbackTaskSnapshotPayload {
  version: string;
  savedAt: string;
  tasks: CallbackTask[];
}

export interface EnqueueRagicCallbackInput {
  formId: string;
  entryId: string;
  eventType: RagicCallbackEventType;
  rowId?: string;
  source?: string;
  actorIp?: string;
  actorLabel?: string;
}

export interface RagicCallbackRefreshServiceDeps {
  delayMs: number;
  dedupeWindowMs: number;
  shouldUseSqliteReadForForm(formId: string): boolean;
  getSyncState(formId: string): Promise<{ status: string } | null>;
  projectEntryAfterMutation(
    formId: string,
    entryId: string,
    reason: CallbackProjectionReason
  ): Promise<void>;
  refreshEntry(formId: string, entryId: string): Promise<WorkReportRecord>;
  upsertEntrySnapshot(
    formId: string,
    record: WorkReportRecord,
    snapshotAt: string
  ): Promise<{ rowCount: number }>;
  touchSyncStateSnapshot(
    formId: string,
    snapshotAt: string,
    message: string | null
  ): Promise<void>;
  deleteEntrySnapshot(formId: string, entryId: string): Promise<void>;
  publishWorkReportUpdated(formId: string, entryId: string): void;
  publishWorkReportFormUpdated(formId: string): void;
  getRecentMutationProjection(
    formId: string,
    entryId: string,
    windowMs: number
  ): { projectedAt: string; reason: CallbackProjectionReason } | null;
}

function mapEventTypeToProjectionReason(eventType: RagicCallbackEventType): CallbackProjectionReason {
  if (eventType === "entry-created" || eventType === "row-created") {
    return "create";
  }
  if (eventType === "entry-deleted" || eventType === "row-deleted") {
    return "delete";
  }
  return "update";
}

export class RagicCallbackRefreshService {
  private readonly tasks = new Map<string, CallbackTask>();
  private readonly queueChainByEntryKey = new Map<string, Promise<void>>();
  private persistChain: Promise<void> = Promise.resolve();
  private initializedPromise: Promise<void> | null = null;

  constructor(private readonly deps: RagicCallbackRefreshServiceDeps) {
    void this.initialize();
  }

  async initialize(): Promise<void> {
    if (!env.RAGIC_CALLBACK_TASK_PERSIST_ENABLED) {
      return;
    }
    if (this.initializedPromise) {
      await this.initializedPromise;
      return;
    }
    this.initializedPromise = this.loadFromDisk();
    await this.initializedPromise;
  }

  enqueue(input: EnqueueRagicCallbackInput): CallbackTask {
    const taskId = randomUUID();
    const createdAt = new Date().toISOString();
    const task: CallbackTask = {
      taskId,
      formId: input.formId,
      entryId: input.entryId,
      eventType: input.eventType,
      ...(input.rowId ? { rowId: input.rowId } : {}),
      ...(input.source ? { source: input.source } : {}),
      status: "pending",
      createdAt,
      updatedAt: createdAt,
    };
    this.tasks.set(taskId, task);
    this.syncTaskToRegistry(task, input);
    this.pruneHistory();
    this.schedulePersist();

    const queueKey = `${input.formId}:${input.entryId}`;
    const currentChain = this.queueChainByEntryKey.get(queueKey) ?? Promise.resolve();
    const nextChain = currentChain
      .catch(() => {
        // NOTE: 保持 queue 可持續接受後續 callback。
      })
      .then(async () => {
        await this.runTask(taskId);
      });

    this.queueChainByEntryKey.set(queueKey, nextChain);
    void nextChain.finally(() => {
      if (this.queueChainByEntryKey.get(queueKey) === nextChain) {
        this.queueChainByEntryKey.delete(queueKey);
      }
    });

    workReportDebugLog("callback", "accepted", {
      taskId,
      formId: input.formId,
      entryId: input.entryId,
      eventType: input.eventType,
      rowId: input.rowId ?? null,
      source: input.source ?? "ragic",
    });

    return { ...task };
  }

  getTask(taskId: string): CallbackTask | null {
    const task = this.tasks.get(taskId);
    return task ? { ...task } : null;
  }

  private async runTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }

    const startedAt = new Date().toISOString();
    this.tasks.set(taskId, {
      ...task,
      status: "running",
      updatedAt: startedAt,
    });
    this.syncTaskToRegistry(this.tasks.get(taskId)!, task);
    this.schedulePersist();

    try {
      if (this.deps.delayMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, this.deps.delayMs);
        });
      }

      const projectionReason = mapEventTypeToProjectionReason(task.eventType);
      const sqliteEnabled = this.deps.shouldUseSqliteReadForForm(task.formId);

      // 預設要通知 client；若這筆 callback 被 dedupe（近期 projection 已覆蓋），連 SSE 都不發，
      // 不然前端會被多餘通知連續觸發 refresh（batch create 20 筆會連閃）。
      // SQLite 沒啟用時沒 dedupe 機制，維持原行為照發。
      let notifyClients = true;

      if (sqliteEnabled) {
        const syncState = await this.deps.getSyncState(task.formId);
        if (syncState?.status === "running") {
          await this.deps.projectEntryAfterMutation(task.formId, task.entryId, projectionReason);
        }
        const snapshotAt = new Date().toISOString();
        const recentProjection = this.deps.getRecentMutationProjection(
          task.formId,
          task.entryId,
          this.deps.dedupeWindowMs
        );

        if (recentProjection) {
          await this.deps.touchSyncStateSnapshot(
            task.formId,
            snapshotAt,
            `ragic-callback:${task.eventType}:${task.entryId}:deduped`
          );
          notifyClients = false;
          workReportDebugLog("callback", "refresh-skipped-recent-projection", {
            taskId,
            formId: task.formId,
            entryId: task.entryId,
            eventType: task.eventType,
            projectionReason: recentProjection.reason,
            projectedAt: recentProjection.projectedAt,
            dedupeWindowMs: this.deps.dedupeWindowMs,
            queuedForReplay: syncState?.status === "running",
          });
        } else {
          const record = await this.deps.refreshEntry(task.formId, task.entryId);
          const result = await this.deps.upsertEntrySnapshot(task.formId, record, snapshotAt);
          await this.deps.touchSyncStateSnapshot(
            task.formId,
            snapshotAt,
            `ragic-callback:${task.eventType}:${task.entryId}`
          );
          workReportDebugLog("callback", "refresh-succeeded", {
            taskId,
            formId: task.formId,
            entryId: task.entryId,
            eventType: task.eventType,
            rowCount: result.rowCount,
            snapshotAt,
            queuedForReplay: syncState?.status === "running",
          });
        }
      }

      if (notifyClients) {
        this.deps.publishWorkReportUpdated(task.formId, task.entryId);
        this.deps.publishWorkReportFormUpdated(task.formId);
      }

      const finishedAt = new Date().toISOString();
      this.tasks.set(taskId, {
        ...this.tasks.get(taskId)!,
        status: "success",
        updatedAt: finishedAt,
        finishedAt,
      });
      this.syncTaskToRegistry(this.tasks.get(taskId)!, task);
      this.schedulePersist();
    } catch (error) {
      const finishedAt = new Date().toISOString();
      if (error instanceof HttpError && error.code === "REPORT_NOT_FOUND") {
        const isDeleteLike =
          task.eventType === "entry-deleted" || task.eventType === "row-deleted";
        if (isDeleteLike && this.deps.shouldUseSqliteReadForForm(task.formId)) {
          await this.deps.deleteEntrySnapshot(task.formId, task.entryId);
          await this.deps.touchSyncStateSnapshot(
            task.formId,
            finishedAt,
            `ragic-callback:${task.eventType}:${task.entryId}:deleted`
          );
          this.deps.publishWorkReportUpdated(task.formId, task.entryId);
          this.deps.publishWorkReportFormUpdated(task.formId);
          workReportDebugLog(
            "callback",
            "refresh-report-not-found",
            {
            taskId,
            formId: task.formId,
            entryId: task.entryId,
            eventType: task.eventType,
            handledAsDelete: true,
            },
            "warn"
          );
          this.tasks.set(taskId, {
            ...this.tasks.get(taskId)!,
            status: "success",
            updatedAt: finishedAt,
            finishedAt,
          });
          this.syncTaskToRegistry(this.tasks.get(taskId)!, task);
          this.schedulePersist();
          return;
        }
      }

      const message = error instanceof Error ? error.message : String(error);
      const code =
        typeof (error as { code?: unknown })?.code === "string"
          ? String((error as { code?: unknown }).code)
          : undefined;
      workReportDebugLog(
        "callback",
        "refresh-failed",
        {
        taskId,
        formId: task.formId,
        entryId: task.entryId,
        eventType: task.eventType,
        rowId: task.rowId ?? null,
        error: message,
        code: code ?? null,
        },
        "warn"
      );
      this.tasks.set(taskId, {
        ...this.tasks.get(taskId)!,
        status: "failed",
        updatedAt: finishedAt,
        finishedAt,
        error: {
          ...(code ? { code } : {}),
          message,
        },
      });
      this.syncTaskToRegistry(this.tasks.get(taskId)!, task);
      this.schedulePersist();
    }
  }

  private async loadFromDisk(): Promise<void> {
    if (!env.RAGIC_CALLBACK_TASK_PERSIST_ENABLED) {
      return;
    }

    const filePath = this.resolveStoreFilePath();
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as CallbackTaskSnapshotPayload;
      if (!this.isValidSnapshotPayload(parsed)) {
        workReportDebugLog("callback-persist", "snapshot-invalid", { filePath }, "warn");
        return;
      }

      for (const task of parsed.tasks) {
        this.tasks.set(task.taskId, task);
      }

      const recoveredCount = this.recoverInterruptedTasks();
      this.syncAllTasksToRegistry();
      this.pruneHistory();
      this.schedulePersist();
      workReportDebugLog("callback-persist", "snapshot-loaded", {
        filePath,
        count: parsed.tasks.length,
        recoveredCount,
      });
    } catch (error) {
      const errnoError = error as NodeJS.ErrnoException;
      if (errnoError.code === "ENOENT") {
        return;
      }
      workReportDebugLog(
        "callback-persist",
        "snapshot-load-failed",
        {
          filePath,
          error: error instanceof Error ? error.message : String(error),
        },
        "warn"
      );
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
          code: "CALLBACK_TASK_RECOVERED_AFTER_RESTART",
          message: "服務重啟，原 callback 任務已標記為失敗",
        },
      });
    }

    if (recoveredCount > 0) {
      workReportDebugLog("callback-persist", "recovered-interrupted", { recoveredCount }, "warn");
    }

    return recoveredCount;
  }

  private pruneHistory(): void {
    const maxTasks = Math.max(100, env.CREATE_TASK_HISTORY_LIMIT);
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
    }
  }

  private schedulePersist(): void {
    if (!env.RAGIC_CALLBACK_TASK_PERSIST_ENABLED) {
      return;
    }

    this.persistChain = this.persistChain
      .catch(() => {
        // keep chain alive
      })
      .then(async () => {
        await this.persistToDisk();
      })
      .catch((error) => {
        workReportDebugLog(
          "callback-persist",
          "snapshot-save-failed",
          {
            filePath: this.resolveStoreFilePath(),
            error: error instanceof Error ? error.message : String(error),
          },
          "warn"
        );
      });
  }

  private async persistToDisk(): Promise<void> {
    const filePath = this.resolveStoreFilePath();
    const dirPath = path.dirname(filePath);
    await fs.mkdir(dirPath, { recursive: true });

    const snapshot: CallbackTaskSnapshotPayload = {
      version: CALLBACK_TASK_SNAPSHOT_VERSION,
      savedAt: new Date().toISOString(),
      tasks: Array.from(this.tasks.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    };

    const tempFilePath = `${filePath}.tmp`;
    await fs.writeFile(tempFilePath, JSON.stringify(snapshot), "utf-8");
    await fs.rename(tempFilePath, filePath);
  }

  private resolveStoreFilePath(): string {
    return path.resolve(env.RAGIC_CALLBACK_TASK_STORE_FILE);
  }

  private syncTaskToRegistry(
    task: CallbackTask,
    input?: Pick<EnqueueRagicCallbackInput, "actorIp" | "actorLabel" | "source">
  ): void {
    const eventLabel = input?.source ?? task.source ?? "ragic-callback";
    const message =
      task.status === "pending"
        ? `Callback 任務排隊中（${task.eventType}）`
        : task.status === "running"
          ? `Callback 任務處理中（${task.eventType}）`
          : task.status === "success"
            ? `Callback 任務完成（${task.eventType}）`
            : task.error?.message ?? `Callback 任務失敗（${task.eventType}）`;

    workReportTaskRegistryService.upsertTask({
      taskId: task.taskId,
      taskType: "callback-refresh",
      status: task.status,
      formId: task.formId,
      entryId: task.entryId,
      rowId: task.rowId ?? null,
      queueKey: `${task.formId}:${task.entryId}`,
      createdAt: task.createdAt,
      startedAt: null,
      finishedAt: task.finishedAt ?? null,
      updatedAt: task.updatedAt,
      message,
      errorCode: task.error?.code ?? null,
      errorMessage: task.error?.message ?? null,
      actorClientId: null,
      actorTabId: null,
      actorIp: input?.actorIp ?? null,
      actorLabel: input?.actorLabel ?? eventLabel,
    });
  }

  private syncAllTasksToRegistry(): void {
    for (const task of this.tasks.values()) {
      this.syncTaskToRegistry(task);
    }
  }

  private isValidSnapshotPayload(payload: unknown): payload is CallbackTaskSnapshotPayload {
    if (!payload || typeof payload !== "object") {
      return false;
    }

    const maybeSnapshot = payload as Partial<CallbackTaskSnapshotPayload>;
    return (
      maybeSnapshot.version === CALLBACK_TASK_SNAPSHOT_VERSION &&
      Array.isArray(maybeSnapshot.tasks) &&
      maybeSnapshot.tasks.every((task) => this.isValidTask(task))
    );
  }

  private isValidTask(task: unknown): task is CallbackTask {
    if (!task || typeof task !== "object") {
      return false;
    }

    const t = task as Partial<CallbackTask>;
    return (
      typeof t.taskId === "string" &&
      typeof t.formId === "string" &&
      typeof t.entryId === "string" &&
      typeof t.eventType === "string" &&
      typeof t.status === "string" &&
      typeof t.createdAt === "string" &&
      typeof t.updatedAt === "string"
    );
  }
}

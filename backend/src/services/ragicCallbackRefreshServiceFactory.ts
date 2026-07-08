import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import { env } from "../config/env";
import { workReportDebugLog } from "../observability/workReportDebugLog";
import type { WorkReportRecord } from "../types/workReport";
import { HttpError } from "../utils/httpError";
import { createKeyedSerialQueue } from "../utils/keyedSerialQueue";
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
  latestCallbackAt?: string;
  latestCallbackSeq?: number;
  coalescedCount?: number;
  finishedAt?: string;
  error?: {
    code?: string;
    message: string;
  };
}

export interface RagicCallbackRefreshStats {
  total: number;
  pending: number;
  running: number;
  success: number;
  failed: number;
  activeCoalescingKeys: number;
  coalescedCallbacks: number;
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
  getEntrySnapshot?(formId: string, entryId: string): Promise<WorkReportRecord | null>;
  getRecentMutationProjection(
    formId: string,
    entryId: string,
    windowMs: number
  ): { projectedAt: string; reason: CallbackProjectionReason } | null;
  taskPersistEnabled?: boolean;
  taskStoreFile?: string;
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

function areWorkReportRecordsEquivalent(left: WorkReportRecord, right: WorkReportRecord): boolean {
  return stableStringify(left) === stableStringify(right);
}

function stableStringify(value: unknown): string {
  if (value === undefined) {
    return "null";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(",")}}`;
}

export class RagicCallbackRefreshService {
  private readonly tasks = new Map<string, CallbackTask>();
  private readonly activeTaskIdByCoalesceKey = new Map<string, string>();
  private readonly queueChainByEntryKey = createKeyedSerialQueue();
  private callbackSeq = 0;
  private persistChain: Promise<void> = Promise.resolve();
  private initializedPromise: Promise<void> | null = null;

  constructor(private readonly deps: RagicCallbackRefreshServiceDeps) {}

  async initialize(): Promise<void> {
    if (!this.isTaskPersistEnabled()) {
      return;
    }
    if (this.initializedPromise) {
      await this.initializedPromise;
      return;
    }
    this.initializedPromise = this.loadFromDisk();
    await this.initializedPromise;
  }

  async flush(): Promise<void> {
    await this.initialize();
    await this.persistChain.catch(() => undefined);
  }

  enqueue(input: EnqueueRagicCallbackInput): CallbackTask {
    const createdAt = new Date().toISOString();
    const callbackSeq = ++this.callbackSeq;
    const coalesceKey = this.buildCoalesceKey(input.formId, input.entryId, input.eventType);
    const activeTask = this.getActiveCoalescedTask(coalesceKey);
    if (activeTask) {
      const nextTask: CallbackTask = {
        ...activeTask,
        ...(input.rowId ? { rowId: input.rowId } : {}),
        ...(input.source ? { source: input.source } : {}),
        updatedAt: createdAt,
        latestCallbackAt: createdAt,
        latestCallbackSeq: callbackSeq,
        coalescedCount: (activeTask.coalescedCount ?? 0) + 1,
      };
      this.tasks.set(nextTask.taskId, nextTask);
      this.syncTaskToRegistry(nextTask, input);
      this.schedulePersist();
      workReportDebugLog("callback", "coalesced", {
        taskId: nextTask.taskId,
        formId: input.formId,
        entryId: input.entryId,
        eventType: input.eventType,
        coalescedCount: nextTask.coalescedCount ?? 0,
        source: input.source ?? "ragic",
      });
      return { ...nextTask };
    }

    const taskId = randomUUID();
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
      latestCallbackAt: createdAt,
      latestCallbackSeq: callbackSeq,
      coalescedCount: 0,
    };
    this.tasks.set(taskId, task);
    this.activeTaskIdByCoalesceKey.set(coalesceKey, taskId);
    this.syncTaskToRegistry(task, input);
    this.pruneHistory();
    this.schedulePersist();

    const queueKey = `${input.formId}:${input.entryId}`;
    void this.queueChainByEntryKey.enqueue(queueKey, () => this.runTask(taskId));

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

  getStats(): RagicCallbackRefreshStats {
    const stats: RagicCallbackRefreshStats = {
      total: this.tasks.size,
      pending: 0,
      running: 0,
      success: 0,
      failed: 0,
      activeCoalescingKeys: this.activeTaskIdByCoalesceKey.size,
      coalescedCallbacks: 0,
    };

    for (const task of this.tasks.values()) {
      stats[task.status] += 1;
      stats.coalescedCallbacks += task.coalescedCount ?? 0;
    }

    return stats;
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

      let notifyClients = false;
      while (true) {
        const currentTask = this.tasks.get(taskId);
        if (!currentTask) {
          return;
        }
        const coveredCallbackSeq = currentTask.latestCallbackSeq ?? 0;
        notifyClients = (await this.runRefreshPass(currentTask)) || notifyClients;
        const latestTask = this.tasks.get(taskId);
        if (!latestTask || (latestTask.latestCallbackSeq ?? 0) <= coveredCallbackSeq) {
          break;
        }
        workReportDebugLog("callback", "refresh-rerun-requested", {
          taskId,
          formId: latestTask.formId,
          entryId: latestTask.entryId,
          eventType: latestTask.eventType,
          latestCallbackAt: latestTask.latestCallbackAt ?? null,
          latestCallbackSeq: latestTask.latestCallbackSeq ?? null,
          coveredCallbackSeq,
        });
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
      this.clearActiveCoalescingKey(task);
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
          this.clearActiveCoalescingKey(task);
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
      const failedTask: CallbackTask = {
        ...this.tasks.get(taskId)!,
        status: "failed",
        updatedAt: finishedAt,
        finishedAt,
        error: {
          ...(code ? { code } : {}),
          message,
        },
      };
      this.tasks.set(taskId, failedTask);
      this.syncTaskToRegistry(failedTask, task);
      this.clearActiveCoalescingKey(failedTask);
      this.schedulePersist();
      this.enqueueFollowUpAfterCoalescedFailure(failedTask);
    }
  }

  private async runRefreshPass(task: CallbackTask): Promise<boolean> {
    const projectionReason = mapEventTypeToProjectionReason(task.eventType);
    const sqliteEnabled = this.deps.shouldUseSqliteReadForForm(task.formId);

    // 預設要通知 client；若近期 projection 已覆蓋同一筆 internal mutation，仍要讀 Ragic
    // 以免外部 Ragic callback 被整筆吞掉，但內容相同時可抑制 SSE 避免前端連閃。
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
      const dedupeProjection =
        recentProjection && recentProjection.reason === projectionReason ? recentProjection : null;

      const beforeSnapshot = dedupeProjection
        ? (await this.deps.getEntrySnapshot?.(task.formId, task.entryId)) ?? null
        : null;
      const record = await this.deps.refreshEntry(task.formId, task.entryId);
      const result = await this.deps.upsertEntrySnapshot(task.formId, record, snapshotAt);
      await this.deps.touchSyncStateSnapshot(
        task.formId,
        snapshotAt,
        dedupeProjection
          ? `ragic-callback:${task.eventType}:${task.entryId}:deduped`
          : `ragic-callback:${task.eventType}:${task.entryId}`
      );

      if (dedupeProjection) {
        notifyClients =
          beforeSnapshot === null || !areWorkReportRecordsEquivalent(beforeSnapshot, record);
        workReportDebugLog("callback", "refresh-succeeded-recent-projection", {
          taskId: task.taskId,
          formId: task.formId,
          entryId: task.entryId,
          eventType: task.eventType,
          projectionReason: dedupeProjection.reason,
          projectedAt: dedupeProjection.projectedAt,
          dedupeWindowMs: this.deps.dedupeWindowMs,
          rowCount: result.rowCount,
          snapshotAt,
          notifyClients,
          queuedForReplay: syncState?.status === "running",
        });
      } else {
        workReportDebugLog("callback", "refresh-succeeded", {
          taskId: task.taskId,
          formId: task.formId,
          entryId: task.entryId,
          eventType: task.eventType,
          rowCount: result.rowCount,
          snapshotAt,
          queuedForReplay: syncState?.status === "running",
        });
      }
    }

    return notifyClients;
  }

  private async loadFromDisk(): Promise<void> {
    if (!this.isTaskPersistEnabled()) {
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

      const recoveredTasks = this.recoverInterruptedTasks();
      this.syncAllTasksToRegistry();
      this.pruneHistory();
      this.schedulePersist();
      this.enqueueRecoveredTasks(recoveredTasks);
      workReportDebugLog("callback-persist", "snapshot-loaded", {
        filePath,
        count: parsed.tasks.length,
        recoveredCount: recoveredTasks.length,
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

  private recoverInterruptedTasks(): CallbackTask[] {
    const recoveredAt = new Date().toISOString();
    const recoveredTasks: CallbackTask[] = [];

    for (const [taskId, task] of this.tasks.entries()) {
      if (task.status !== "pending" && task.status !== "running") {
        continue;
      }

      const recoveredTask: CallbackTask = {
        ...task,
        status: "pending",
        updatedAt: recoveredAt,
      };
      delete recoveredTask.finishedAt;
      delete recoveredTask.error;
      this.tasks.set(taskId, recoveredTask);
      recoveredTasks.push(recoveredTask);
    }

    if (recoveredTasks.length > 0) {
      workReportDebugLog(
        "callback-persist",
        "recovered-interrupted",
        { recoveredCount: recoveredTasks.length },
        "warn"
      );
    }

    return recoveredTasks;
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
    if (!this.isTaskPersistEnabled()) {
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
    return path.resolve(this.deps.taskStoreFile ?? env.RAGIC_CALLBACK_TASK_STORE_FILE);
  }

  private syncTaskToRegistry(
    task: CallbackTask,
    input?: Pick<EnqueueRagicCallbackInput, "actorIp" | "actorLabel" | "source">
  ): void {
    const eventLabel = input?.source ?? task.source ?? "ragic-callback";
    const coalescedSuffix =
      task.coalescedCount && task.coalescedCount > 0
        ? `，已合併 ${task.coalescedCount} 筆`
        : "";
    const message =
      task.status === "pending"
        ? `Callback 任務排隊中（${task.eventType}${coalescedSuffix}）`
        : task.status === "running"
          ? `Callback 任務處理中（${task.eventType}${coalescedSuffix}）`
          : task.status === "success"
            ? `Callback 任務完成（${task.eventType}${coalescedSuffix}）`
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
      actorLabel: input?.actorLabel ?? null,
      source: eventLabel,
    });
  }

  private syncAllTasksToRegistry(): void {
    for (const task of this.tasks.values()) {
      this.syncTaskToRegistry(task);
    }
  }

  private enqueueFollowUpAfterCoalescedFailure(task: CallbackTask): void {
    if ((task.coalescedCount ?? 0) <= 0) {
      return;
    }

    const followUpTask = this.enqueue({
      formId: task.formId,
      entryId: task.entryId,
      eventType: task.eventType,
      ...(task.rowId ? { rowId: task.rowId } : {}),
      ...(task.source ? { source: task.source } : {}),
    });
    workReportDebugLog("callback", "follow-up-enqueued-after-coalesced-failure", {
      failedTaskId: task.taskId,
      followUpTaskId: followUpTask.taskId,
      formId: task.formId,
      entryId: task.entryId,
      eventType: task.eventType,
      coalescedCount: task.coalescedCount ?? 0,
    });
  }

  private enqueueRecoveredTasks(tasks: CallbackTask[]): void {
    for (const task of tasks) {
      const coalesceKey = this.buildCoalesceKey(task.formId, task.entryId, task.eventType);
      if (!this.activeTaskIdByCoalesceKey.has(coalesceKey)) {
        this.activeTaskIdByCoalesceKey.set(coalesceKey, task.taskId);
      }
      const queueKey = `${task.formId}:${task.entryId}`;
      void this.queueChainByEntryKey.enqueue(queueKey, () => this.runTask(task.taskId));
    }
  }

  private isTaskPersistEnabled(): boolean {
    return this.deps.taskPersistEnabled ?? env.RAGIC_CALLBACK_TASK_PERSIST_ENABLED;
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

  private getActiveCoalescedTask(coalesceKey: string): CallbackTask | null {
    const taskId = this.activeTaskIdByCoalesceKey.get(coalesceKey);
    if (!taskId) {
      return null;
    }
    const task = this.tasks.get(taskId);
    if (!task || (task.status !== "pending" && task.status !== "running")) {
      this.activeTaskIdByCoalesceKey.delete(coalesceKey);
      return null;
    }
    return task;
  }

  private clearActiveCoalescingKey(task: CallbackTask): void {
    const coalesceKey = this.buildCoalesceKey(task.formId, task.entryId, task.eventType);
    if (this.activeTaskIdByCoalesceKey.get(coalesceKey) === task.taskId) {
      this.activeTaskIdByCoalesceKey.delete(coalesceKey);
    }
  }

  private buildCoalesceKey(
    formId: string,
    entryId: string,
    eventType: RagicCallbackEventType
  ): string {
    return `${formId}:${entryId}:${eventType}`;
  }
}

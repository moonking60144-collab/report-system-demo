import { READ_MODEL_SCHEMA_VERSION } from "../../storage/sqlite/readModelSchema";
import { workReportDebugLog } from "../../observability/workReportDebugLog";
import type { WorkReportRecord } from "../../types/workReport";
import { HttpError } from "../../utils/httpError";
import { workReportTaskRegistryService } from "../work-report/workReportTaskRegistryService";
import {
  createWorkReportMutationSyncCoordinator,
  WorkReportAutoSyncYieldRequestedError,
  type WorkReportMutationSyncCoordinator,
} from "./workReportMutationSyncCoordinator";

type WorkReportSyncTaskStatus = "pending" | "running" | "success" | "failed";
const REALTIME_ENTRY_UPDATE_BATCH_SIZE = 200;

interface SyncCompletionNotification {
  formId: string;
  entryIds: string[];
}

type SyncExecutionResult =
  | { status: "yielded" }
  | { status: "finished"; notification?: SyncCompletionNotification };

export interface WorkReportSyncTask {
  taskId: string;
  formId: string;
  status: WorkReportSyncTaskStatus;
  accepted: boolean;
  triggeredBy: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  scannedEntries: number;
  syncedEntries: number;
  syncedRows: number;
  snapshotAt?: string;
  message?: string;
  error?: {
    code?: string;
    message: string;
  };
}

interface RequestSyncOptions {
  triggeredBy: string;
  waitForCompletion: boolean;
  actorClientId?: string;
  actorTabId?: string;
  actorIp?: string;
  actorLabel?: string;
}

export interface StoredSyncStateLike {
  formId: string;
  status: string;
  taskId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  snapshotAt: string | null;
  readModelVersion: number | null;
  totalEntries: number;
  totalRows: number;
  message: string | null;
  updatedAt: string;
}

interface WorkReportSyncServiceDeps {
  coordinator?: WorkReportMutationSyncCoordinator;
  scanFormRecords(
    formId: string,
    onProgress: (count: number) => void,
    options?: { shouldYieldToMutation?: () => boolean }
  ): Promise<WorkReportRecord[]>;
  refreshEntry(formId: string, entryId: string): Promise<WorkReportRecord>;
  replaceFormSnapshot(
    formId: string,
    records: WorkReportRecord[],
    syncedAt: string
  ): Promise<{ entryCount: number; rowCount: number }>;
  upsertEntrySnapshot(
    formId: string,
    record: WorkReportRecord,
    syncedAt: string,
    options?: { generationId?: string | null }
  ): Promise<{ rowCount: number }>;
  deleteEntrySnapshot(
    formId: string,
    entryId: string,
    options?: { generationId?: string | null }
  ): Promise<void>;
  getSyncState(formId: string): Promise<StoredSyncStateLike | null>;
  upsertSyncState(patch: {
    formId: string;
    status: "idle" | "running" | "success" | "failed";
    taskId?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
    snapshotAt?: string | null;
    activeGenerationId?: string | null;
    readModelVersion?: number | null;
    totalEntries?: number;
    totalRows?: number;
    message?: string | null;
  }): Promise<void>;
  getLatestProjectionSeq(formId: string): Promise<number>;
  getOldestPendingProjectionSeq(formId: string): Promise<number | null>;
  listPendingProjectionEntries(
    formId: string,
    afterSeq: number,
    upToSeq: number
  ): Promise<Array<{ entryId: string; latestSeq: number }>>;
  markProjectionRangeProcessed(
    formId: string,
    upToSeq: number,
    processedAt: string
  ): Promise<void>;
  cleanupProcessedProjectionEvents(formId: string, upToSeq: number): Promise<void>;
  getFormSnapshotCounts(
    formId: string,
    options?: { generationId?: string | null }
  ): Promise<{ entryCount: number; rowCount: number }>;
  cleanupOldFormGenerations?(formId: string, keepGenerationId: string): Promise<number>;
  publishWorkReportEntriesUpdated(formId: string, entryIds: string[]): void;
  publishWorkReportFormUpdated(formId: string): void;
  generateTaskId(): string;
}

export class WorkReportSyncService {
  private readonly tasksById = new Map<string, WorkReportSyncTask>();
  private readonly latestTaskIdByForm = new Map<string, string>();
  private readonly runningTaskIdByForm = new Map<string, string>();
  private readonly taskRunPromises = new Map<string, Promise<void>>();
  private readonly coordinator: WorkReportMutationSyncCoordinator;

  constructor(private readonly deps: WorkReportSyncServiceDeps) {
    this.coordinator = deps.coordinator ?? createWorkReportMutationSyncCoordinator();
  }

  async requestSync(
    formId: string,
    options: RequestSyncOptions
  ): Promise<WorkReportSyncTask> {
    const runningTask = this.getRunningTask(formId);
    if (runningTask) {
      return this.copyTask({
        ...runningTask,
        accepted: false,
      });
    }

    const taskId = this.deps.generateTaskId();
    const createdAt = new Date().toISOString();
    const task: WorkReportSyncTask = {
      taskId,
      formId,
      status: "pending",
      accepted: true,
      triggeredBy: options.triggeredBy,
      createdAt,
      updatedAt: createdAt,
      scannedEntries: 0,
      syncedEntries: 0,
      syncedRows: 0,
      message: "等待同步排程啟動",
    };

    this.tasksById.set(taskId, task);
    this.syncTaskToRegistry(task, options);
    workReportDebugLog("sync", "started", {
      taskId,
      formId,
      triggeredBy: options.triggeredBy,
      waitForCompletion: options.waitForCompletion,
    });
    this.latestTaskIdByForm.set(formId, taskId);
    this.runningTaskIdByForm.set(formId, taskId);

    const runPromise = this.runSyncTask(taskId).finally(() => {
      if (this.runningTaskIdByForm.get(formId) === taskId) {
        this.runningTaskIdByForm.delete(formId);
      }
      if (this.taskRunPromises.get(taskId) === runPromise) {
        this.taskRunPromises.delete(taskId);
      }
    });
    this.taskRunPromises.set(taskId, runPromise);

    if (options.waitForCompletion) {
      await runPromise;
    }

    return this.copyTask(this.tasksById.get(taskId) ?? task);
  }

  shouldDeferAutoSyncForMutation(): boolean {
    return this.coordinator.shouldDeferAutoSyncForMutation();
  }

  async getStatus(formId: string): Promise<WorkReportSyncTask | StoredSyncStateLike | null> {
    const runningTask = this.getRunningTask(formId);
    if (runningTask) {
      return this.copyTask(runningTask);
    }

    const latestTask = this.getLatestTask(formId);
    if (latestTask) {
      return this.copyTask(latestTask);
    }

    return this.deps.getSyncState(formId);
  }

  private getRunningTask(formId: string): WorkReportSyncTask | null {
    const taskId = this.runningTaskIdByForm.get(formId);
    if (!taskId) {
      return null;
    }
    return this.tasksById.get(taskId) ?? null;
  }

  private getLatestTask(formId: string): WorkReportSyncTask | null {
    const taskId = this.latestTaskIdByForm.get(formId);
    if (!taskId) {
      return null;
    }
    return this.tasksById.get(taskId) ?? null;
  }

  private copyTask(task: WorkReportSyncTask): WorkReportSyncTask {
    return {
      ...task,
      error: task.error ? { ...task.error } : undefined,
    };
  }

  private async runSyncTask(taskId: string): Promise<void> {
    const waitingTask = this.tasksById.get(taskId);
    if (!waitingTask) {
      return;
    }

    while (true) {
      let releaseSyncSlot: (() => void) | null = null;
      let executionResult: SyncExecutionResult = { status: "finished" };
      try {
        releaseSyncSlot = await this.coordinator.acquireSyncSlot({
          onWaiting: () => {
            const waitingAt = new Date().toISOString();
            const currentTask = this.tasksById.get(taskId);
            this.patchTask(taskId, {
              status: "running",
              startedAt: currentTask?.startedAt ?? waitingAt,
              updatedAt: waitingAt,
              message: "正在等待報工寫入完成",
            });
          },
        });
        executionResult = await this.executeSyncTask(taskId);
      } finally {
        releaseSyncSlot?.();
      }

      if (executionResult.status !== "yielded") {
        if (executionResult.notification) {
          try {
            this.publishSyncCompletion(executionResult.notification);
          } catch (error) {
            workReportDebugLog(
              "sync",
              "completion-notification-failed",
              {
                formId: executionResult.notification.formId,
                entryCount: executionResult.notification.entryIds.length,
                error: error instanceof Error ? error.message : String(error),
              },
              "warn"
            );
          }
        }
        return;
      }
    }
  }

  private async executeSyncTask(taskId: string): Promise<SyncExecutionResult> {
    const task = this.tasksById.get(taskId);
    if (!task) {
      return { status: "finished" };
    }

    const startedAt = task.startedAt ?? new Date().toISOString();
    this.patchTask(taskId, {
      status: "running",
      startedAt,
      updatedAt: startedAt,
      message: "正在從 Ragic 擷取資料",
    });

    try {
      await this.deps.upsertSyncState({
        formId: task.formId,
        status: "running",
        taskId,
        startedAt,
        finishedAt: null,
        message: "正在從 Ragic 擷取資料",
      });
      const startSeq = await this.deps.getLatestProjectionSeq(task.formId);
      const oldestPendingSeq = await this.deps.getOldestPendingProjectionSeq(task.formId);
      const replayedEntryIds = new Set<string>();
      let processedSeq =
        oldestPendingSeq !== null ? Math.max(0, oldestPendingSeq - 1) : startSeq;
      const replayStartedAfterSeq = processedSeq;

      const shouldYieldToMutation =
        task.triggeredBy === "auto-schedule"
          ? () => this.coordinator.shouldDeferAutoSyncForMutation()
          : undefined;
      const records = await this.deps.scanFormRecords(
        task.formId,
        (count) => {
          this.patchTask(taskId, {
            scannedEntries: count,
            updatedAt: new Date().toISOString(),
            message: `已擷取 ${count} 筆工令`,
          });
        },
        { shouldYieldToMutation }
      );

      if (shouldYieldToMutation?.()) {
        throw new WorkReportAutoSyncYieldRequestedError();
      }

      this.patchTask(taskId, {
        message: "正在寫入 SQLite",
        updatedAt: new Date().toISOString(),
      });

      const snapshotAt = new Date().toISOString();
      await this.deps.replaceFormSnapshot(task.formId, records, snapshotAt);

      this.patchTask(taskId, {
        message: "正在回補同步期間變更",
        updatedAt: new Date().toISOString(),
      });
      workReportDebugLog("sync", "replay-started", {
        taskId,
        formId: task.formId,
        generationId: snapshotAt,
        processedSeq,
      });
      const replayUpperSeq = await this.deps.getLatestProjectionSeq(task.formId);
      processedSeq = await this.replayPendingProjectionEntries(
        task.formId,
        processedSeq,
        snapshotAt,
        replayUpperSeq,
        replayedEntryIds
      );
      workReportDebugLog("sync", "replay-completed", {
        taskId,
        formId: task.formId,
        generationId: snapshotAt,
        processedSeq,
      });

      let finalSnapshotAt = new Date().toISOString();
      let counts = await this.deps.getFormSnapshotCounts(task.formId, {
        generationId: snapshotAt,
      });
      const finishedAt = new Date().toISOString();

      await this.deps.upsertSyncState({
        formId: task.formId,
        status: "success",
        taskId,
        startedAt,
        finishedAt,
        snapshotAt: finalSnapshotAt,
        activeGenerationId: snapshotAt,
        readModelVersion: READ_MODEL_SCHEMA_VERSION,
        totalEntries: counts.entryCount,
        totalRows: counts.rowCount,
        message: "同步完成",
      });
      if (processedSeq > replayStartedAfterSeq) {
        await this.deps.markProjectionRangeProcessed(task.formId, processedSeq, finishedAt);
        await this.deps.cleanupProcessedProjectionEvents(task.formId, processedSeq);
      }

      try {
        const postPromoteProcessedSeq = await this.replayPendingProjectionEntriesOnce(
          task.formId,
          processedSeq,
          snapshotAt,
          replayedEntryIds
        );
        if (postPromoteProcessedSeq > processedSeq) {
          const postPromoteProcessedAt = new Date().toISOString();
          await this.deps.markProjectionRangeProcessed(
            task.formId,
            postPromoteProcessedSeq,
            postPromoteProcessedAt
          );
          await this.deps.cleanupProcessedProjectionEvents(task.formId, postPromoteProcessedSeq);
          processedSeq = postPromoteProcessedSeq;
          finalSnapshotAt = postPromoteProcessedAt;
          counts = await this.deps.getFormSnapshotCounts(task.formId, {
            generationId: snapshotAt,
          });
          await this.deps.upsertSyncState({
            formId: task.formId,
            status: "success",
            taskId,
            startedAt,
            finishedAt,
            snapshotAt: finalSnapshotAt,
            activeGenerationId: snapshotAt,
            readModelVersion: READ_MODEL_SCHEMA_VERSION,
            totalEntries: counts.entryCount,
            totalRows: counts.rowCount,
            message: "同步完成",
          });
          workReportDebugLog("sync", "post-promote-replay-completed", {
            taskId,
            formId: task.formId,
            generationId: snapshotAt,
            processedSeq,
          });
        }
      } catch (postPromoteError) {
        workReportDebugLog(
          "sync",
          "post-promote-replay-failed",
          {
            taskId,
            formId: task.formId,
            generationId: snapshotAt,
            processedSeq,
            error:
              postPromoteError instanceof Error
                ? postPromoteError.message
                : String(postPromoteError),
          },
          "warn"
        );
      }

      this.patchTask(taskId, {
        status: "success",
        syncedEntries: counts.entryCount,
        syncedRows: counts.rowCount,
        snapshotAt: finalSnapshotAt,
        finishedAt,
        updatedAt: finishedAt,
        message: "同步完成",
      });

      workReportDebugLog("sync", "succeeded", {
        taskId,
        formId: task.formId,
        startedAt,
        finishedAt,
        snapshotAt: finalSnapshotAt,
        activeGenerationId: snapshotAt,
        syncedEntries: counts.entryCount,
        syncedRows: counts.rowCount,
      });

      void this.deps.cleanupOldFormGenerations?.(task.formId, snapshotAt).then(
        (deletedEntries) => {
          if (deletedEntries > 0) {
            workReportDebugLog("sync", "old-generations-cleaned", {
              taskId,
              formId: task.formId,
              keepGenerationId: snapshotAt,
              deletedEntries,
            });
          }
        },
        (cleanupError) => {
          workReportDebugLog(
            "sync",
            "old-generations-cleanup-failed",
            {
              taskId,
              formId: task.formId,
              keepGenerationId: snapshotAt,
              error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            },
            "warn"
          );
        }
      );
      return {
        status: "finished",
        notification: {
          formId: task.formId,
          entryIds: Array.from(replayedEntryIds),
        },
      };
    } catch (error) {
      if (
        task.triggeredBy === "auto-schedule" &&
        error instanceof WorkReportAutoSyncYieldRequestedError
      ) {
        const yieldedAt = new Date().toISOString();
        this.patchTask(taskId, {
          status: "running",
          updatedAt: yieldedAt,
          message: "已讓位給報工寫入，等待重新同步",
        });
        workReportDebugLog("sync", "yielded-to-mutation", {
          taskId,
          formId: task.formId,
          yieldedAt,
        });
        try {
          await this.deps.upsertSyncState({
            formId: task.formId,
            status: "idle",
            taskId,
            startedAt,
            finishedAt: null,
            message: "已讓位給報工寫入，等待重新同步",
          });
        } catch (stateError) {
          workReportDebugLog(
            "sync",
            "yielded-state-persist-failed",
            {
              taskId,
              formId: task.formId,
              error: stateError instanceof Error ? stateError.message : String(stateError),
            },
            "warn"
          );
        }
        return { status: "yielded" };
      }

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

      this.patchTask(taskId, {
        status: "failed",
        finishedAt,
        updatedAt: finishedAt,
        message: "同步失敗",
        error: normalizedError,
      });
      try {
        await this.deps.upsertSyncState({
          formId: task.formId,
          status: "failed",
          taskId,
          startedAt,
          finishedAt,
          message: normalizedError.message,
        });
      } catch (stateError) {
        workReportDebugLog(
          "sync",
          "failed-state-persist-failed",
          {
            taskId,
            formId: task.formId,
            error: stateError instanceof Error ? stateError.message : String(stateError),
          },
          "warn"
        );
      }
      workReportDebugLog(
        "sync",
        "failed",
        {
          taskId,
          formId: task.formId,
          startedAt,
          finishedAt,
          code: normalizedError.code ?? null,
          error: normalizedError.message,
        },
        "warn"
      );
    }

    return { status: "finished" };
  }

  private publishSyncCompletion(notification: SyncCompletionNotification): void {
    for (
      let offset = 0;
      offset < notification.entryIds.length;
      offset += REALTIME_ENTRY_UPDATE_BATCH_SIZE
    ) {
      this.deps.publishWorkReportEntriesUpdated(
        notification.formId,
        notification.entryIds.slice(offset, offset + REALTIME_ENTRY_UPDATE_BATCH_SIZE)
      );
    }
    this.deps.publishWorkReportFormUpdated(notification.formId);
  }

  private async replayPendingProjectionEntries(
    formId: string,
    initialProcessedSeq: number,
    generationId: string,
    upperSeq: number,
    replayedEntryIds: Set<string>
  ): Promise<number> {
    if (upperSeq <= initialProcessedSeq) {
      return initialProcessedSeq;
    }

    const pendingEntries = await this.deps.listPendingProjectionEntries(
      formId,
      initialProcessedSeq,
      upperSeq
    );

    for (const pendingEntry of pendingEntries) {
      await this.refreshEntrySnapshot(formId, pendingEntry.entryId, generationId);
      replayedEntryIds.add(pendingEntry.entryId);
    }

    return upperSeq;
  }

  private async replayPendingProjectionEntriesOnce(
    formId: string,
    initialProcessedSeq: number,
    generationId: string,
    replayedEntryIds: Set<string>
  ): Promise<number> {
    const upperSeq = await this.deps.getLatestProjectionSeq(formId);
    if (upperSeq <= initialProcessedSeq) {
      return initialProcessedSeq;
    }

    const pendingEntries = await this.deps.listPendingProjectionEntries(
      formId,
      initialProcessedSeq,
      upperSeq
    );
    for (const pendingEntry of pendingEntries) {
      await this.refreshEntrySnapshot(formId, pendingEntry.entryId, generationId);
      replayedEntryIds.add(pendingEntry.entryId);
    }
    return upperSeq;
  }

  private async refreshEntrySnapshot(
    formId: string,
    entryId: string,
    generationId: string
  ): Promise<void> {
    try {
      const record = await this.deps.refreshEntry(formId, entryId);
      await this.deps.upsertEntrySnapshot(formId, record, new Date().toISOString(), {
        generationId,
      });
    } catch (error) {
      if (error instanceof HttpError && error.code === "REPORT_NOT_FOUND") {
        await this.deps.deleteEntrySnapshot(formId, entryId, { generationId });
        return;
      }
      throw error;
    }
  }

  private patchTask(taskId: string, patch: Partial<WorkReportSyncTask>): void {
    const current = this.tasksById.get(taskId);
    if (!current) {
      return;
    }
    this.tasksById.set(taskId, {
      ...current,
      ...patch,
    });
    this.syncTaskToRegistry(this.tasksById.get(taskId)!);
  }

  private syncTaskToRegistry(
    task: WorkReportSyncTask,
    options?: Pick<RequestSyncOptions, "actorClientId" | "actorTabId" | "actorIp" | "actorLabel">
  ): void {
    workReportTaskRegistryService.upsertTask({
      taskId: task.taskId,
      taskType: "sync",
      status: task.status,
      formId: task.formId,
      entryId: null,
      rowId: null,
      queueKey: `sync:${task.formId}`,
      createdAt: task.createdAt,
      startedAt: task.startedAt ?? null,
      finishedAt: task.finishedAt ?? null,
      updatedAt: task.updatedAt,
      message: task.message ?? null,
      errorCode: task.error?.code ?? null,
      errorMessage: task.error?.message ?? null,
      actorClientId: options?.actorClientId ?? null,
      actorTabId: options?.actorTabId ?? null,
      actorIp: options?.actorIp ?? null,
      actorLabel: options?.actorLabel ?? task.triggeredBy ?? null,
    });
  }
}

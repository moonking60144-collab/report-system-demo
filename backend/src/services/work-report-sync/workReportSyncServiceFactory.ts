import { READ_MODEL_SCHEMA_VERSION } from "../../storage/sqlite/readModelSchema";
import { workReportDebugLog } from "../../observability/workReportDebugLog";
import type { WorkReportRecord } from "../../types/workReport";
import { HttpError } from "../../utils/httpError";
import { workReportTaskRegistryService } from "../work-report/workReportTaskRegistryService";
import {
  createWorkReportMutationSyncCoordinator,
  type WorkReportMutationSyncCoordinator,
  type WorkReportAutoSyncScanLease,
} from "./workReportMutationSyncCoordinator";

type WorkReportSyncTaskStatus = "pending" | "running" | "success" | "failed";
const REALTIME_ENTRY_UPDATE_BATCH_SIZE = 200;

interface SyncCompletionNotification {
  formId: string;
  entryIds: string[];
}

type SyncExecutionResult = { status: "finished"; notification?: SyncCompletionNotification };

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
  scanMs?: number;
  snapshotWriteMs?: number;
  promotionWaitMs?: number;
  finalReplayMs?: number;
  promotionSlotHeldMs?: number;
  message?: string;
  error?: {
    code?: string;
    message: string;
  };
}

interface RequestSyncOptions {
  triggeredBy: string;
  waitForCompletion: boolean;
  queueIfRunning?: boolean;
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
    options?: { waitForMutationIdle?: () => Promise<void> }
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
  private readonly queuedRequestByForm = new Map<string, RequestSyncOptions>();
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
      if (options.queueIfRunning) {
        this.queuedRequestByForm.set(formId, {
          ...options,
          waitForCompletion: false,
        });
      }
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
      const queuedRequest = this.queuedRequestByForm.get(formId);
      if (queuedRequest) {
        this.queuedRequestByForm.delete(formId);
        void this.requestSync(formId, queuedRequest).catch((error) => {
          workReportDebugLog(
            "sync",
            "queued-request-failed",
            {
              formId,
              triggeredBy: queuedRequest.triggeredBy,
              error: error instanceof Error ? error.message : String(error),
            },
            "error"
          );
        });
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

    const autoSync = waitingTask.triggeredBy === "auto-schedule";
    let releaseSyncSlot: (() => void) | null = null;
    let executionResult: SyncExecutionResult = { status: "finished" };
    try {
      if (!autoSync) {
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
      }
      executionResult = await this.executeSyncTask(taskId, { autoSync });
    } finally {
      releaseSyncSlot?.();
    }
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
  }

  private async executeSyncTask(
    taskId: string,
    options: { autoSync: boolean } = { autoSync: false }
  ): Promise<SyncExecutionResult> {
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

    let autoSyncScanLease: WorkReportAutoSyncScanLease | null = null;
    try {
      if (options.autoSync && this.coordinator.acquireAutoSyncScanSlot) {
        autoSyncScanLease = await this.coordinator.acquireAutoSyncScanSlot({
          onWaiting: () => {
            this.patchTask(taskId, {
              status: "running",
              updatedAt: new Date().toISOString(),
              message: "正在等待其他全量同步完成",
            });
          },
        });
      }
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

      const records = await this.measureTaskPhase(taskId, "scanMs", () =>
        this.deps.scanFormRecords(
          task.formId,
          (count) => {
            this.patchTask(taskId, {
              scannedEntries: count,
              updatedAt: new Date().toISOString(),
              message: `已擷取 ${count} 筆工令`,
            });
          },
          options.autoSync && this.coordinator.waitForMutationIdle
            ? {
                waitForMutationIdle: () =>
                  this.coordinator.waitForMutationIdle?.() ?? Promise.resolve(),
              }
            : undefined
        )
      );

      this.patchTask(taskId, {
        message: "正在寫入 SQLite",
        updatedAt: new Date().toISOString(),
      });

      const snapshotAt = new Date().toISOString();
      await this.measureTaskPhase(taskId, "snapshotWriteMs", () =>
        this.deps.replaceFormSnapshot(task.formId, records, snapshotAt)
      );

      let releasePromotionSlot: (() => void) | null = null;
      let promotionSlotStartedAt: number | null = null;
      try {
        if (options.autoSync) {
          // 先把大部分同步期間的 mutation 重播到 inactive generation；這段不阻塞使用者寫入。
          const preReplayUpperSeq = await this.deps.getLatestProjectionSeq(task.formId);
          workReportDebugLog("sync", "pre-promote-replay-started", {
            taskId,
            formId: task.formId,
            generationId: snapshotAt,
            processedSeq,
            upperSeq: preReplayUpperSeq,
          });
          processedSeq = await this.replayPendingProjectionEntries(
            task.formId,
            processedSeq,
            snapshotAt,
            preReplayUpperSeq,
            replayedEntryIds
          );
          workReportDebugLog("sync", "pre-promote-replay-completed", {
            taskId,
            formId: task.formId,
            generationId: snapshotAt,
            processedSeq,
          });
        } else {
          // 手動同步仍持有完整 sync slot，先補回同步開始前已有的 queue window。
          const initialReplayUpperSeq = await this.deps.getLatestProjectionSeq(task.formId);
          processedSeq = await this.replayPendingProjectionEntries(
            task.formId,
            processedSeq,
            snapshotAt,
            initialReplayUpperSeq,
            replayedEntryIds
          );
        }

        this.patchTask(taskId, {
          message: options.autoSync
            ? "正在短暫鎖定並套用同步尾差"
            : "正在回補同步期間變更",
          updatedAt: new Date().toISOString(),
        });
        if (options.autoSync) {
          releasePromotionSlot = await this.measureTaskPhase(taskId, "promotionWaitMs", () =>
            autoSyncScanLease
              ? autoSyncScanLease.promote()
              : this.coordinator.acquireSyncSlot()
          );
          promotionSlotStartedAt = Date.now();
        }

        // 取得 slot 後不會再有新的 mutation 開始，這裡只 replay pre-replay 之後的 tail。
        const finalReplayUpperSeq = await this.deps.getLatestProjectionSeq(task.formId);
        workReportDebugLog("sync", "final-tail-replay-started", {
          taskId,
          formId: task.formId,
          generationId: snapshotAt,
          processedSeq,
          upperSeq: finalReplayUpperSeq,
          promotionSlot: options.autoSync,
        });
        processedSeq = await this.measureTaskPhase(taskId, "finalReplayMs", () =>
          this.replayPendingProjectionEntries(
            task.formId,
            processedSeq,
            snapshotAt,
            finalReplayUpperSeq,
            replayedEntryIds
          )
        );
        workReportDebugLog("sync", "final-tail-replay-completed", {
          taskId,
          formId: task.formId,
          generationId: snapshotAt,
          processedSeq,
        });

        const finalSnapshotAt = new Date().toISOString();
        const counts = await this.deps.getFormSnapshotCounts(task.formId, {
          generationId: snapshotAt,
        });
        const finishedAt = new Date().toISOString();

        // 先 promote 再 mark queue：若 promote 後 process crash，pending event 仍可被下一輪補 replay。
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
          promotionSlotHeld: options.autoSync,
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
      } finally {
        if (promotionSlotStartedAt !== null) {
          const promotionSlotHeldMs = Math.max(0, Date.now() - promotionSlotStartedAt);
          releasePromotionSlot?.();
          autoSyncScanLease?.release();
          this.patchTask(taskId, { promotionSlotHeldMs });
          workReportDebugLog("sync", "promotion-slot-released", {
            taskId,
            formId: task.formId,
            generationId: snapshotAt,
            promotionSlotHeldMs,
            promotionWaitMs: this.tasksById.get(taskId)?.promotionWaitMs,
          });
          releasePromotionSlot = null;
          autoSyncScanLease = null;
        }
        releasePromotionSlot?.();
        autoSyncScanLease?.release();
      }
    } catch (error) {
      autoSyncScanLease?.release();
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

  private async measureTaskPhase<T>(
    taskId: string,
    phase: "scanMs" | "snapshotWriteMs" | "promotionWaitMs" | "finalReplayMs",
    worker: () => Promise<T>
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      return await worker();
    } finally {
      const durationMs = Math.max(0, Date.now() - startedAt);
      this.patchTask(taskId, { [phase]: durationMs });
      workReportDebugLog("sync", "phase-finished", { taskId, phase, durationMs });
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
      scanMs: task.scanMs ?? null,
      snapshotWriteMs: task.snapshotWriteMs ?? null,
      promotionWaitMs: task.promotionWaitMs ?? null,
      finalReplayMs: task.finalReplayMs ?? null,
      promotionSlotHeldMs: task.promotionSlotHeldMs ?? null,
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

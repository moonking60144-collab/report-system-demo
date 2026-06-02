import { READ_MODEL_SCHEMA_VERSION } from "../../storage/sqlite/readModelSchema";
import { workReportDebugLog } from "../../observability/workReportDebugLog";
import type { WorkReportRecord } from "../../types/workReport";
import { HttpError } from "../../utils/httpError";
import { workReportTaskRegistryService } from "../work-report/workReportTaskRegistryService";

type WorkReportSyncTaskStatus = "pending" | "running" | "success" | "failed";

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
  scanFormRecords(formId: string, onProgress: (count: number) => void): Promise<WorkReportRecord[]>;
  refreshEntry(formId: string, entryId: string): Promise<WorkReportRecord>;
  replaceFormSnapshot(
    formId: string,
    records: WorkReportRecord[],
    syncedAt: string
  ): Promise<{ entryCount: number; rowCount: number }>;
  upsertEntrySnapshot(
    formId: string,
    record: WorkReportRecord,
    syncedAt: string
  ): Promise<{ rowCount: number }>;
  deleteEntrySnapshot(formId: string, entryId: string): Promise<void>;
  getSyncState(formId: string): Promise<StoredSyncStateLike | null>;
  upsertSyncState(patch: {
    formId: string;
    status: "running" | "success" | "failed";
    taskId?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
    snapshotAt?: string | null;
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
  getFormSnapshotCounts(formId: string): Promise<{ entryCount: number; rowCount: number }>;
  publishWorkReportFormUpdated(formId: string): void;
  generateTaskId(): string;
}

export class WorkReportSyncService {
  private readonly tasksById = new Map<string, WorkReportSyncTask>();
  private readonly latestTaskIdByForm = new Map<string, string>();
  private readonly runningTaskIdByForm = new Map<string, string>();
  private readonly taskRunPromises = new Map<string, Promise<void>>();

  constructor(private readonly deps: WorkReportSyncServiceDeps) {}

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
    await this.deps.upsertSyncState({
      formId,
      status: "running",
      taskId,
      startedAt: createdAt,
      finishedAt: null,
      message: "等待同步排程啟動",
    });

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
    const task = this.tasksById.get(taskId);
    if (!task) {
      return;
    }

    const startedAt = new Date().toISOString();
    this.patchTask(taskId, {
      status: "running",
      startedAt,
      updatedAt: startedAt,
      message: "正在從 Ragic 擷取資料",
    });

    try {
      const startSeq = await this.deps.getLatestProjectionSeq(task.formId);
      const oldestPendingSeq = await this.deps.getOldestPendingProjectionSeq(task.formId);
      let processedSeq =
        oldestPendingSeq !== null ? Math.max(0, oldestPendingSeq - 1) : startSeq;

      const records = await this.deps.scanFormRecords(task.formId, (count) => {
        this.patchTask(taskId, {
          scannedEntries: count,
          updatedAt: new Date().toISOString(),
          message: `已擷取 ${count} 筆工令`,
        });
      });

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
        processedSeq,
      });
      processedSeq = await this.replayPendingProjectionEntries(task.formId, processedSeq);
      workReportDebugLog("sync", "replay-completed", {
        taskId,
        formId: task.formId,
        processedSeq,
      });

      const finalSnapshotAt = new Date().toISOString();
      const counts = await this.deps.getFormSnapshotCounts(task.formId);
      const finishedAt = new Date().toISOString();

      this.patchTask(taskId, {
        status: "success",
        syncedEntries: counts.entryCount,
        syncedRows: counts.rowCount,
        snapshotAt: finalSnapshotAt,
        finishedAt,
        updatedAt: finishedAt,
        message: "同步完成",
      });
      await this.deps.upsertSyncState({
        formId: task.formId,
        status: "success",
        taskId,
        startedAt,
        finishedAt,
        snapshotAt: finalSnapshotAt,
        readModelVersion: READ_MODEL_SCHEMA_VERSION,
        totalEntries: counts.entryCount,
        totalRows: counts.rowCount,
        message: "同步完成",
      });

      workReportDebugLog("sync", "succeeded", {
        taskId,
        formId: task.formId,
        startedAt,
        finishedAt,
        snapshotAt: finalSnapshotAt,
        syncedEntries: counts.entryCount,
        syncedRows: counts.rowCount,
      });

      this.deps.publishWorkReportFormUpdated(task.formId);
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

      this.patchTask(taskId, {
        status: "failed",
        finishedAt,
        updatedAt: finishedAt,
        message: "同步失敗",
        error: normalizedError,
      });
      await this.deps.upsertSyncState({
        formId: task.formId,
        status: "failed",
        taskId,
        startedAt,
        finishedAt,
        message: normalizedError.message,
      });
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
  }

  private async replayPendingProjectionEntries(
    formId: string,
    initialProcessedSeq: number
  ): Promise<number> {
    let processedSeq = initialProcessedSeq;

    while (true) {
      const upperSeq = await this.deps.getLatestProjectionSeq(formId);
      if (upperSeq <= processedSeq) {
        return processedSeq;
      }

      const pendingEntries = await this.deps.listPendingProjectionEntries(
        formId,
        processedSeq,
        upperSeq
      );

      for (const pendingEntry of pendingEntries) {
        await this.refreshEntrySnapshot(formId, pendingEntry.entryId);
      }

      const processedAt = new Date().toISOString();
      await this.deps.markProjectionRangeProcessed(formId, upperSeq, processedAt);
      await this.deps.cleanupProcessedProjectionEvents(formId, upperSeq);
      processedSeq = upperSeq;
    }
  }

  private async refreshEntrySnapshot(formId: string, entryId: string): Promise<void> {
    try {
      const record = await this.deps.refreshEntry(formId, entryId);
      await this.deps.upsertEntrySnapshot(formId, record, new Date().toISOString());
    } catch (error) {
      if (error instanceof HttpError && error.code === "REPORT_NOT_FOUND") {
        await this.deps.deleteEntrySnapshot(formId, entryId);
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

import { randomUUID } from "crypto";
import { env } from "../../config/env";
import { createLogger } from "../../observability/logger";
import { HttpError } from "../../utils/httpError";
import { pruneTerminalTaskHistory } from "./localTaskHistory";
import { workReportEntryMutationQueue } from "./workReportEntryMutationQueue";
import {
  workReportTaskRegistryService,
  type WorkReportQueueTaskStatus,
  type WorkReportQueueTaskType,
} from "./workReportTaskRegistryService";

const log = createLogger("work-report-batch-delete");

interface BatchDeleteFailedItem {
  rowId: string;
  errorCode?: string;
  errorMessage: string;
}

interface WorkReportBatchDeleteTask {
  taskId: string;
  taskType: Extract<WorkReportQueueTaskType, "delete-report" | "delete-report-batch">;
  formId: string;
  entryId: string;
  workOrderNo?: string;
  queueKey: string;
  rowIds: string[];
  requestedCount: number;
  deletedCount: number;
  failedCount: number;
  failedItems: BatchDeleteFailedItem[];
  status: WorkReportQueueTaskStatus;
  phase: "deleting" | "finalizing";
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  actorClientId?: string;
  actorTabId?: string;
  actorIp?: string;
  actorLabel?: string;
  runningMessage?: string;
}

interface RequestBatchDeleteInput {
  taskType?: Extract<WorkReportQueueTaskType, "delete-report" | "delete-report-batch">;
  formId: string;
  entryId: string;
  workOrderNo?: string;
  rowIds: string[];
  actorClientId?: string;
  actorTabId?: string;
  actorIp?: string;
  actorLabel?: string;
  concurrency?: number;
  beforeRun?: () => Promise<void>;
  beforeDeleteRow?: (rowId: string) => Promise<unknown | null>;
  deleteRow: (rowId: string) => Promise<{ rowId: string }>;
  onRowDeleted?: (
    rowId: string,
    taskId: string,
    beforeSnapshot: unknown | null
  ) => void | Promise<void>;
  finalizeAfterDelete?: (summary: {
    formId: string;
    entryId: string;
    requestedCount: number;
    deletedCount: number;
    deletedRowIds: string[];
    failedCount: number;
  }) => Promise<void>;
}

function normalizeRowIds(rowIds: string[]): string[] {
  return Array.from(
    new Set(
      rowIds
        .map((rowId) => String(rowId ?? "").trim())
        .filter((rowId) => /^\d+$/.test(rowId))
    )
  );
}

function resolveDeleteError(error: unknown): {
  code?: string;
  message: string;
} {
  if (error instanceof HttpError) {
    return {
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof Error) {
    const maybeCode =
      typeof (error as { code?: unknown }).code === "string"
        ? String((error as { code?: unknown }).code)
        : undefined;
    return {
      code: maybeCode,
      message: error.message,
    };
  }
  return {
    message: String(error),
  };
}

function isDeleteWriteIndeterminate(item: BatchDeleteFailedItem): boolean {
  return (
    item.rowId !== "*precondition*" &&
    item.rowId !== "*finalize*" &&
    String(item.errorCode ?? "").trim().toUpperCase().endsWith("_INDETERMINATE")
  );
}

class WorkReportBatchDeleteTaskService {
  private readonly tasks = new Map<string, WorkReportBatchDeleteTask>();
  private readonly queueChainByKey = workReportEntryMutationQueue;

  requestBatchDelete(input: RequestBatchDeleteInput): Pick<
    WorkReportBatchDeleteTask,
    "taskId" | "status" | "createdAt" | "requestedCount"
  > {
    const rowIds = normalizeRowIds(input.rowIds);
    if (rowIds.length === 0) {
      throw new HttpError(400, "至少要選擇一筆可刪除的明細", "BATCH_DELETE_EMPTY");
    }

    this.queueChainByKey.assertAccepting(`${input.formId}:${input.entryId}`);

    const taskId = randomUUID();
    const createdAt = new Date().toISOString();
    const taskType = input.taskType ?? "delete-report-batch";
    const task: WorkReportBatchDeleteTask = {
      taskId,
      taskType,
      formId: input.formId,
      entryId: input.entryId,
      ...(input.workOrderNo ? { workOrderNo: input.workOrderNo } : {}),
      queueKey: `${input.formId}:${input.entryId}`,
      rowIds,
      requestedCount: rowIds.length,
      deletedCount: 0,
      failedCount: 0,
      failedItems: [],
      status: "pending",
      phase: "deleting",
      createdAt,
      updatedAt: createdAt,
      ...(input.actorClientId ? { actorClientId: input.actorClientId } : {}),
      ...(input.actorTabId ? { actorTabId: input.actorTabId } : {}),
      ...(input.actorIp ? { actorIp: input.actorIp } : {}),
      ...(input.actorLabel ? { actorLabel: input.actorLabel } : {}),
    };

    this.tasks.set(taskId, task);
    this.syncTaskToRegistry(task);

    void this.queueChainByKey.enqueue(
      task.queueKey,
      () => this.runTask(taskId, input),
      {
        onWaitingForSync: () => {
          this.markWaitingForSync(taskId);
        },
      }
    );

    return {
      taskId,
      status: task.status,
      createdAt: task.createdAt,
      requestedCount: task.requestedCount,
    };
  }

  private async runTask(taskId: string, input: RequestBatchDeleteInput): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }

    const startedAt = task.startedAt ?? new Date().toISOString();
    const taskStartedAtMs = Date.parse(startedAt);
    this.patchTask(taskId, {
      status: "running",
      phase: "deleting",
      startedAt,
      updatedAt: startedAt,
      runningMessage: undefined,
    });

    const deletedRowIds: string[] = [];
    const failedItems: BatchDeleteFailedItem[] = [];
    const rowIds = [...task.rowIds];
    const concurrency = Math.max(
      1,
      Math.min(
        8,
        Math.trunc(
          input.concurrency ?? env.WORK_REPORT_BATCH_DELETE_CONCURRENCY
        )
      )
    );
    log.info({
      event: "batch-delete.started",
      taskId,
      formId: task.formId,
      entryId: task.entryId,
      requestedCount: task.requestedCount,
      concurrency,
    });

    try {
      await input.beforeRun?.();
    } catch (error) {
      const normalizedError = resolveDeleteError(error);
      failedItems.push({
        rowId: "*precondition*",
        errorCode: normalizedError.code,
        errorMessage: normalizedError.message,
      });
      const finishedAt = new Date().toISOString();
      log.warn({
        event: "batch-delete.precondition-failed",
        taskId,
        formId: task.formId,
        entryId: task.entryId,
        errorCode: normalizedError.code,
        error: normalizedError.message,
        elapsedMs: Date.now() - taskStartedAtMs,
      });
      this.patchTask(taskId, {
        status: "failed",
        finishedAt,
        updatedAt: finishedAt,
        deletedCount: 0,
        failedCount: failedItems.length,
        failedItems,
      });
      return;
    }

    let cursor = 0;
    const runWorker = async (): Promise<void> => {
      while (cursor < rowIds.length) {
        const currentIndex = cursor;
        cursor += 1;
        const rowId = rowIds[currentIndex];
        const rowStartedAtMs = Date.now();
        try {
          let beforeSnapshot: unknown | null = null;
          if (input.beforeDeleteRow) {
            try {
              beforeSnapshot = await input.beforeDeleteRow(rowId);
            } catch (error) {
              log.warn({
                event: "batch-delete.snapshot-read-failed",
                taskId,
                formId: task.formId,
                entryId: task.entryId,
                rowId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          await input.deleteRow(rowId);
          deletedRowIds.push(rowId);
          if (input.onRowDeleted) {
            try {
              await input.onRowDeleted(rowId, taskId, beforeSnapshot);
            } catch (error) {
              log.warn({
                event: "batch-delete.on-row-deleted-failed",
                taskId,
                formId: task.formId,
                entryId: task.entryId,
                rowId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          log.info({
            event: "batch-delete.row-deleted",
            taskId,
            formId: task.formId,
            entryId: task.entryId,
            rowId,
            rowIndex: currentIndex + 1,
            requestedCount: task.requestedCount,
            elapsedMs: Date.now() - rowStartedAtMs,
          });
        } catch (error) {
          const normalizedError = resolveDeleteError(error);
          failedItems.push({
            rowId,
            errorCode: normalizedError.code,
            errorMessage: normalizedError.message,
          });
          log.warn({
            event: "batch-delete.row-failed",
            taskId,
            formId: task.formId,
            entryId: task.entryId,
            rowId,
            rowIndex: currentIndex + 1,
            requestedCount: task.requestedCount,
            errorCode: normalizedError.code,
            error: normalizedError.message,
            elapsedMs: Date.now() - rowStartedAtMs,
          });
        } finally {
          this.patchTask(taskId, {
            deletedCount: deletedRowIds.length,
            failedCount: failedItems.length,
            failedItems: [...failedItems],
            updatedAt: new Date().toISOString(),
          });
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, rowIds.length) }, () =>
        runWorker()
      )
    );

    if (deletedRowIds.length > 0) {
      const finalizeStartedAtMs = Date.now();
      this.patchTask(taskId, {
        phase: "finalizing",
        updatedAt: new Date().toISOString(),
      });
      log.info({
        event: "batch-delete.finalize.started",
        taskId,
        formId: task.formId,
        entryId: task.entryId,
        requestedCount: task.requestedCount,
        deletedCount: deletedRowIds.length,
        failedCount: failedItems.length,
      });
      try {
        await input.finalizeAfterDelete?.({
          formId: task.formId,
          entryId: task.entryId,
          requestedCount: task.requestedCount,
          deletedCount: deletedRowIds.length,
          deletedRowIds: [...deletedRowIds],
          failedCount: failedItems.length,
        });
        log.info({
          event: "batch-delete.finalize.done",
          taskId,
          formId: task.formId,
          entryId: task.entryId,
          deletedCount: deletedRowIds.length,
          elapsedMs: Date.now() - finalizeStartedAtMs,
        });
      } catch (error) {
        const normalizedError = resolveDeleteError(error);
        failedItems.push({
          rowId: "*finalize*",
          errorCode: normalizedError.code,
          errorMessage: normalizedError.message,
        });
        log.warn({
          event: "batch-delete.finalize.failed",
          taskId,
          formId: task.formId,
          entryId: task.entryId,
          errorCode: normalizedError.code,
          error: normalizedError.message,
          elapsedMs: Date.now() - finalizeStartedAtMs,
        });
      }
    }

    const finishedAt = new Date().toISOString();
    const failedCount = failedItems.length;
    const deletedCount = deletedRowIds.length;
    const requestedCount = task.requestedCount;
    this.patchTask(taskId, {
      status: failedCount === 0 ? "success" : "failed",
      finishedAt,
      updatedAt: finishedAt,
      deletedCount,
      failedCount,
      failedItems,
    });
    log[failedCount === 0 ? "info" : "warn"]({
      event: "batch-delete.done",
      taskId,
      formId: task.formId,
      entryId: task.entryId,
      requestedCount,
      deletedCount,
      failedCount,
      elapsedMs: Date.now() - taskStartedAtMs,
    });
  }

  private patchTask(
    taskId: string,
    patch: Partial<WorkReportBatchDeleteTask>
  ): void {
    const existing = this.tasks.get(taskId);
    if (!existing) {
      return;
    }
    const nextTask = {
      ...existing,
      ...patch,
    };
    this.tasks.set(taskId, nextTask);
    this.syncTaskToRegistry(nextTask);
    pruneTerminalTaskHistory(this.tasks);
  }

  private markWaitingForSync(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }
    const waitingAt = new Date().toISOString();
    this.patchTask(taskId, {
      status: "running",
      startedAt: task.startedAt ?? waitingAt,
      updatedAt: waitingAt,
      runningMessage: "正在等待資料重新整理完成",
    });
  }

  private syncTaskToRegistry(task: WorkReportBatchDeleteTask): void {
    const isSingleDelete = task.taskType === "delete-report";
    const writeIndeterminate = task.failedItems.some(isDeleteWriteIndeterminate);
    const preconditionFailedItem = task.failedItems.find(
      (item) => item.rowId === "*precondition*"
    );
    const finalizeFailedItem = task.failedItems.find(
      (item) => item.rowId === "*finalize*"
    );
    const deleteFinalizeFailed = Boolean(finalizeFailedItem);
    const progressLabel = `${task.deletedCount + task.failedCount}/${task.requestedCount}`;
    const successLabel = `${task.deletedCount}/${task.requestedCount}`;
    const finalizingProgressLabel =
      task.failedCount === 0
        ? `已刪除 ${task.deletedCount}/${task.requestedCount}`
        : `已處理 ${progressLabel}`;
    const failedSummary =
      preconditionFailedItem
        ? ""
        : task.failedItems.length > 0
        ? `｜失敗 rowId: ${task.failedItems
            .slice(0, 5)
            .map((item) => item.rowId)
            .join(", ")}`
        : "";

    const message = isSingleDelete
      ? task.status === "pending"
        ? "刪除報工排隊中"
        : task.status === "running"
          ? task.runningMessage ?? (task.phase === "finalizing"
            ? "刪除報工收尾中（正在回算工令）"
            : "刪除報工進行中")
          : preconditionFailedItem
            ? "刪除報工前置檢查失敗"
          : task.status === "success"
            ? "刪除報工完成"
            : deleteFinalizeFailed && task.deletedCount > 0
              ? "報工已刪除，但工令回算或資料同步收尾失敗"
            : "刪除報工失敗"
      : task.status === "pending"
        ? `批次刪除排隊中（0/${task.requestedCount}）`
        : task.status === "running"
          ? task.runningMessage ?? (task.phase === "finalizing"
            ? `批次刪除收尾中（${finalizingProgressLabel}，正在回算工令）`
            : `批次刪除進行中（${progressLabel}）`)
          : preconditionFailedItem
            ? "批次刪除前置檢查失敗"
          : task.status === "success"
            ? `批次刪除完成（${successLabel}）`
            : deleteFinalizeFailed && task.deletedCount > 0
              ? `批次刪除已完成 ${task.deletedCount}/${task.requestedCount} 筆實體刪除，但工令回算或資料同步收尾失敗`
            : `批次刪除部分失敗（成功 ${task.deletedCount} / ${task.requestedCount}，失敗 ${task.failedCount}）${failedSummary}`;

    const errorMessage =
      preconditionFailedItem
        ? `${isSingleDelete ? "刪除報工" : "批次刪除"}尚未開始，前置檢查失敗：${preconditionFailedItem.errorMessage}`
        : task.status === "failed"
        ? task.failedItems
            .slice(0, 5)
            .map((item) => `${item.rowId}: ${item.errorMessage}`)
            .join(" | ")
        : null;

    workReportTaskRegistryService.upsertTask({
      taskId: task.taskId,
      taskType: task.taskType,
      status: task.status,
      formId: task.formId,
      workOrderNo: task.workOrderNo ?? null,
      entryId: task.entryId,
      rowId: isSingleDelete ? task.rowIds[0] ?? null : null,
      queueKey: task.queueKey,
      createdAt: task.createdAt,
      startedAt: task.startedAt ?? null,
      finishedAt: task.finishedAt ?? null,
      updatedAt: task.updatedAt,
      message,
      errorCode:
        preconditionFailedItem?.errorCode ??
        (task.status === "failed"
          ? deleteFinalizeFailed
            ? isSingleDelete
              ? "DELETE_REPORT_FINALIZE_FAILED"
              : "BATCH_DELETE_FINALIZE_FAILED"
            : isSingleDelete
              ? task.failedItems[0]?.errorCode ?? "DELETE_REPORT_FAILED"
              : "BATCH_DELETE_PARTIAL_FAILURE"
          : null),
      errorMessage,
      actorClientId: task.actorClientId ?? null,
      actorTabId: task.actorTabId ?? null,
      actorIp: task.actorIp ?? null,
      actorLabel: task.actorLabel ?? null,
      writeIndeterminate: isSingleDelete ? writeIndeterminate : null,
      batchWriteIndeterminate: isSingleDelete ? null : writeIndeterminate,
      deletedCount: task.deletedCount,
      deleteFinalizeFailed,
    });
  }
}

export const workReportBatchDeleteTaskService =
  new WorkReportBatchDeleteTaskService();

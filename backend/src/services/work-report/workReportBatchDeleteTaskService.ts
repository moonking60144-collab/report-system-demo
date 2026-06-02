import { randomUUID } from "crypto";
import { env } from "../../config/env";
import { HttpError } from "../../utils/httpError";
import {
  workReportTaskRegistryService,
  type WorkReportQueueTaskStatus,
} from "./workReportTaskRegistryService";

interface BatchDeleteFailedItem {
  rowId: string;
  errorCode?: string;
  errorMessage: string;
}

interface WorkReportBatchDeleteTask {
  taskId: string;
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
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  actorClientId?: string;
  actorTabId?: string;
  actorIp?: string;
  actorLabel?: string;
}

interface RequestBatchDeleteInput {
  formId: string;
  entryId: string;
  workOrderNo?: string;
  rowIds: string[];
  actorClientId?: string;
  actorTabId?: string;
  actorIp?: string;
  actorLabel?: string;
  concurrency?: number;
  deleteRow: (rowId: string) => Promise<{ rowId: string }>;
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

class WorkReportBatchDeleteTaskService {
  private readonly tasks = new Map<string, WorkReportBatchDeleteTask>();
  private readonly queueChainByKey = new Map<string, Promise<void>>();

  requestBatchDelete(input: RequestBatchDeleteInput): Pick<
    WorkReportBatchDeleteTask,
    "taskId" | "status" | "createdAt" | "requestedCount"
  > {
    const rowIds = normalizeRowIds(input.rowIds);
    if (rowIds.length === 0) {
      throw new HttpError(400, "至少要選擇一筆可刪除的明細", "BATCH_DELETE_EMPTY");
    }

    const taskId = randomUUID();
    const createdAt = new Date().toISOString();
    const task: WorkReportBatchDeleteTask = {
      taskId,
      formId: input.formId,
      entryId: input.entryId,
      ...(input.workOrderNo ? { workOrderNo: input.workOrderNo } : {}),
      queueKey: `delete-batch:${input.formId}:${input.entryId}`,
      rowIds,
      requestedCount: rowIds.length,
      deletedCount: 0,
      failedCount: 0,
      failedItems: [],
      status: "pending",
      createdAt,
      updatedAt: createdAt,
      ...(input.actorClientId ? { actorClientId: input.actorClientId } : {}),
      ...(input.actorTabId ? { actorTabId: input.actorTabId } : {}),
      ...(input.actorIp ? { actorIp: input.actorIp } : {}),
      ...(input.actorLabel ? { actorLabel: input.actorLabel } : {}),
    };

    this.tasks.set(taskId, task);
    this.syncTaskToRegistry(task);

    const currentChain = this.queueChainByKey.get(task.queueKey) ?? Promise.resolve();
    const nextChain = currentChain
      .catch(() => {
        // NOTE: 保持 queue 可持續接受後續批次刪除。
      })
      .then(async () => {
        await this.runTask(taskId, input);
      });
    this.queueChainByKey.set(task.queueKey, nextChain);
    void nextChain.finally(() => {
      if (this.queueChainByKey.get(task.queueKey) === nextChain) {
        this.queueChainByKey.delete(task.queueKey);
      }
    });

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

    const startedAt = new Date().toISOString();
    this.patchTask(taskId, {
      status: "running",
      startedAt,
      updatedAt: startedAt,
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

    let cursor = 0;
    const runWorker = async (): Promise<void> => {
      while (cursor < rowIds.length) {
        const currentIndex = cursor;
        cursor += 1;
        const rowId = rowIds[currentIndex];
        try {
          await input.deleteRow(rowId);
          deletedRowIds.push(rowId);
        } catch (error) {
          const normalizedError = resolveDeleteError(error);
          failedItems.push({
            rowId,
            errorCode: normalizedError.code,
            errorMessage: normalizedError.message,
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
      try {
        await input.finalizeAfterDelete?.({
          formId: task.formId,
          entryId: task.entryId,
          requestedCount: task.requestedCount,
          deletedCount: deletedRowIds.length,
          deletedRowIds: [...deletedRowIds],
          failedCount: failedItems.length,
        });
      } catch (error) {
        const normalizedError = resolveDeleteError(error);
        failedItems.push({
          rowId: "*finalize*",
          errorCode: normalizedError.code,
          errorMessage: normalizedError.message,
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
  }

  private syncTaskToRegistry(task: WorkReportBatchDeleteTask): void {
    const progressLabel = `${task.deletedCount + task.failedCount}/${task.requestedCount}`;
    const successLabel = `${task.deletedCount}/${task.requestedCount}`;
    const failedSummary =
      task.failedItems.length > 0
        ? `｜失敗 rowId: ${task.failedItems
            .slice(0, 5)
            .map((item) => item.rowId)
            .join(", ")}`
        : "";

    const message =
      task.status === "pending"
        ? `批次刪除排隊中（0/${task.requestedCount}）`
        : task.status === "running"
          ? `批次刪除進行中（${progressLabel}）`
          : task.status === "success"
            ? `批次刪除完成（${successLabel}）`
            : `批次刪除部分失敗（成功 ${task.deletedCount} / ${task.requestedCount}，失敗 ${task.failedCount}）${failedSummary}`;

    const errorMessage =
      task.status === "failed"
        ? task.failedItems
            .slice(0, 5)
            .map((item) => `${item.rowId}: ${item.errorMessage}`)
            .join(" | ")
        : null;

    workReportTaskRegistryService.upsertTask({
      taskId: task.taskId,
      taskType: "delete-report-batch",
      status: task.status,
      formId: task.formId,
      workOrderNo: task.workOrderNo ?? null,
      entryId: task.entryId,
      rowId: null,
      queueKey: task.queueKey,
      createdAt: task.createdAt,
      startedAt: task.startedAt ?? null,
      finishedAt: task.finishedAt ?? null,
      updatedAt: task.updatedAt,
      message,
      errorCode: task.status === "failed" ? "BATCH_DELETE_PARTIAL_FAILURE" : null,
      errorMessage,
      actorClientId: task.actorClientId ?? null,
      actorTabId: task.actorTabId ?? null,
      actorIp: task.actorIp ?? null,
      actorLabel: task.actorLabel ?? null,
    });
  }
}

export const workReportBatchDeleteTaskService =
  new WorkReportBatchDeleteTaskService();

import { randomUUID } from "crypto";
import { env } from "../../config/env";
import {
  batchCreateRowKeyRepository as defaultBatchCreateRowKeyRepository,
  type BatchCreateRowKeyRepository,
} from "../../storage/sqlite/batchCreateRowKeyRepository";
import { HttpError } from "../../utils/httpError";
import {
  workReportTaskRegistryService,
  type WorkReportQueueTaskStatus,
} from "./workReportTaskRegistryService";

interface BatchCreateFailedItem {
  stage: "row-create" | "finalize";
  rowIndex?: number;
  errorCode?: string;
  errorMessage: string;
}

interface WorkReportBatchCreateTask {
  taskId: string;
  formId: string;
  entryId: string;
  workOrderNo?: string;
  queueKey: string;
  requestedCount: number;
  createdCount: number;
  failedCount: number;
  createdRowIds: string[];
  failedItems: BatchCreateFailedItem[];
  status: WorkReportQueueTaskStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  actorClientId?: string;
  actorTabId?: string;
  actorIp?: string;
  actorLabel?: string;
  retryMode?: "finalize-only";
  retriedFromTaskId?: string;
}

export interface BatchCreateRowInput {
  payload: Record<string, unknown>;
  /** 前端產生的 UUID；同一 key 重送時會命中 SQLite 對應的 ragicRowId，不再重複建立 */
  clientRowKey?: string;
}

interface RequestBatchCreateInput {
  formId: string;
  entryId: string;
  workOrderNo?: string;
  rows: BatchCreateRowInput[];
  actorClientId?: string;
  actorTabId?: string;
  actorIp?: string;
  actorLabel?: string;
  createRow: (payload: Record<string, unknown>) => Promise<{ rowId: string }>;
  finalizeAfterCreate?: (summary: {
    formId: string;
    entryId: string;
    requestedCount: number;
    createdCount: number;
    failedCount: number;
    createdRowIds: string[];
  }) => Promise<void>;
  /** 可注入測試用 repository；正式環境預設走 SQLite singleton */
  rowKeyRepository?: BatchCreateRowKeyRepository;
}

interface RequestBatchCreateFinalizeRetryInput {
  taskId: string;
  actorClientId?: string;
  actorTabId?: string;
  actorIp?: string;
  actorLabel?: string;
  finalizeAfterCreate?: (summary: {
    formId: string;
    entryId: string;
    requestedCount: number;
    createdCount: number;
    failedCount: number;
    createdRowIds: string[];
  }) => Promise<void>;
}

function normalizeCreateRows(rows: BatchCreateRowInput[]): BatchCreateRowInput[] {
  return rows
    .filter(
      (row): row is BatchCreateRowInput =>
        Boolean(row) && typeof row === "object" && !Array.isArray(row) && Boolean(row.payload)
    )
    .map((row) => ({
      payload: { ...row.payload },
      clientRowKey:
        typeof row.clientRowKey === "string" && row.clientRowKey.trim().length > 0
          ? row.clientRowKey.trim()
          : undefined,
    }));
}

function resolveCreateError(error: unknown): {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 包上 idempotency 的 row 建立：
 * - 若 row 無 clientRowKey → 直接建立（保留舊行為）
 * - 若 SQLite 已有相同 key+formId+entryId → 不建立，回傳既有 ragicRowId
 * - 若 key 跨 entry 複用（理論上 UUID 不該發生）→ 當新 row 建立，不覆蓋舊映射
 * - 建立成功後 record 映射；record 失敗只 log，不回滾
 */
export async function createRowWithIdempotency(input: {
  row: BatchCreateRowInput;
  formId: string;
  entryId: string;
  createRow: (payload: Record<string, unknown>) => Promise<{ rowId: string }>;
  rowKeyRepo: BatchCreateRowKeyRepository;
}): Promise<string> {
  const { row, formId, entryId, createRow, rowKeyRepo } = input;
  const clientRowKey = row.clientRowKey;

  if (!clientRowKey) {
    const result = await createRow(row.payload);
    return result.rowId;
  }

  const existing = await rowKeyRepo.lookup(clientRowKey).catch((error) => {
    console.warn("[batch-create][row-key-lookup-failed]", {
      key: clientRowKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });

  if (existing) {
    if (existing.formId === formId && existing.entryId === entryId) {
      console.info("[batch-create][idempotent-hit]", {
        key: clientRowKey,
        formId,
        entryId,
        rowId: existing.ragicRowId,
      });
      return existing.ragicRowId;
    }
    console.warn("[batch-create][row-key-cross-entry]", {
      key: clientRowKey,
      existing,
      requested: { formId, entryId },
    });
    const result = await createRow(row.payload);
    return result.rowId;
  }

  const result = await createRow(row.payload);
  await rowKeyRepo
    .record({
      clientRowKey,
      formId,
      entryId,
      ragicRowId: result.rowId,
    })
    .catch((error) => {
      console.warn("[batch-create][row-key-record-failed]", {
        key: clientRowKey,
        rowId: result.rowId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  return result.rowId;
}

class WorkReportBatchCreateTaskService {
  private readonly tasks = new Map<string, WorkReportBatchCreateTask>();
  private readonly queueChainByKey = new Map<string, Promise<void>>();

  requestBatchCreate(input: RequestBatchCreateInput): Pick<
    WorkReportBatchCreateTask,
    "taskId" | "status" | "createdAt" | "requestedCount"
  > {
    const rows = normalizeCreateRows(input.rows);
    if (rows.length === 0) {
      throw new HttpError(400, "至少要送出一筆可建立的明細", "BATCH_CREATE_EMPTY");
    }

    const taskId = randomUUID();
    const createdAt = new Date().toISOString();
    const task: WorkReportBatchCreateTask = {
      taskId,
      formId: input.formId,
      entryId: input.entryId,
      ...(input.workOrderNo ? { workOrderNo: input.workOrderNo } : {}),
      queueKey: `create-batch:${input.formId}:${input.entryId}`,
      requestedCount: rows.length,
      createdCount: 0,
      failedCount: 0,
      createdRowIds: [],
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
        // NOTE: 保持 queue 可持續接受後續任務。
      })
      .then(async () => {
        await this.runTask(taskId, rows, input);
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

  requestBatchCreateFinalizeRetry(
    input: RequestBatchCreateFinalizeRetryInput
  ): Pick<WorkReportBatchCreateTask, "taskId" | "status" | "createdAt" | "requestedCount"> {
    const sourceTask = this.tasks.get(input.taskId);
    if (!sourceTask) {
      throw new HttpError(404, `找不到批次新增任務：${input.taskId}`, "TASK_NOT_FOUND");
    }

    const createdRowIds = Array.from(
      new Set(
        sourceTask.createdRowIds
          .map((rowId) => String(rowId ?? "").trim())
          .filter((rowId) => /^\d+$/.test(rowId))
      )
    );
    const hasFinalizeFailure = sourceTask.failedItems.some((item) => item.stage === "finalize");
    if (!hasFinalizeFailure || createdRowIds.length === 0) {
      throw new HttpError(
        409,
        "這筆批次新增不是可重試的收尾失敗任務。",
        "BATCH_CREATE_FINALIZE_RETRY_UNAVAILABLE"
      );
    }

    const taskId = randomUUID();
    const createdAt = new Date().toISOString();
    const retryTask: WorkReportBatchCreateTask = {
      taskId,
      formId: sourceTask.formId,
      entryId: sourceTask.entryId,
      ...(sourceTask.workOrderNo ? { workOrderNo: sourceTask.workOrderNo } : {}),
      queueKey: sourceTask.queueKey,
      requestedCount: sourceTask.requestedCount,
      createdCount: createdRowIds.length,
      failedCount: 0,
      createdRowIds: [...createdRowIds],
      failedItems: [],
      status: "pending",
      createdAt,
      updatedAt: createdAt,
      ...(input.actorClientId ? { actorClientId: input.actorClientId } : {}),
      ...(input.actorTabId ? { actorTabId: input.actorTabId } : {}),
      ...(input.actorIp ? { actorIp: input.actorIp } : {}),
      ...(input.actorLabel ? { actorLabel: input.actorLabel } : {}),
      retryMode: "finalize-only",
      retriedFromTaskId: sourceTask.taskId,
    };

    this.tasks.set(taskId, retryTask);
    this.syncTaskToRegistry(retryTask);

    const currentChain = this.queueChainByKey.get(retryTask.queueKey) ?? Promise.resolve();
    const nextChain = currentChain
      .catch(() => {
        // keep queue alive
      })
      .then(async () => {
        await this.runFinalizeRetryTask(taskId, input.finalizeAfterCreate);
      });
    this.queueChainByKey.set(retryTask.queueKey, nextChain);
    void nextChain.finally(() => {
      if (this.queueChainByKey.get(retryTask.queueKey) === nextChain) {
        this.queueChainByKey.delete(retryTask.queueKey);
      }
    });

    return {
      taskId,
      status: retryTask.status,
      createdAt: retryTask.createdAt,
      requestedCount: retryTask.requestedCount,
    };
  }

  private async runTask(
    taskId: string,
    rows: BatchCreateRowInput[],
    input: RequestBatchCreateInput
  ): Promise<void> {
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

    const createdRowIds: string[] = [];
    const failedItems: BatchCreateFailedItem[] = [];
    const rowKeyRepo = input.rowKeyRepository ?? defaultBatchCreateRowKeyRepository;

    for (const [index, row] of rows.entries()) {
      try {
        const rowId = await createRowWithIdempotency({
          row,
          formId: task.formId,
          entryId: task.entryId,
          createRow: input.createRow,
          rowKeyRepo,
        });
        createdRowIds.push(rowId);
      } catch (error) {
        const normalizedError = resolveCreateError(error);
        failedItems.push({
          stage: "row-create",
          rowIndex: index + 1,
          errorCode: normalizedError.code,
          errorMessage: normalizedError.message,
        });
      } finally {
        this.patchTask(taskId, {
          createdCount: createdRowIds.length,
          failedCount: failedItems.length,
          createdRowIds: [...createdRowIds],
          failedItems: [...failedItems],
          updatedAt: new Date().toISOString(),
        });
      }
    }

    if (createdRowIds.length > 0) {
      let finalizeSucceeded = false;
      for (
        let attempt = 1;
        attempt <= env.WORK_REPORT_BATCH_CREATE_FINALIZE_RETRY;
        attempt += 1
      ) {
        try {
          await input.finalizeAfterCreate?.({
            formId: task.formId,
            entryId: task.entryId,
            requestedCount: task.requestedCount,
            createdCount: createdRowIds.length,
            failedCount: failedItems.length,
            createdRowIds: [...createdRowIds],
          });
          finalizeSucceeded = true;
          break;
        } catch (error) {
          const normalizedError = resolveCreateError(error);
          if (attempt < env.WORK_REPORT_BATCH_CREATE_FINALIZE_RETRY) {
            await sleep(env.WORK_REPORT_BATCH_CREATE_FINALIZE_RETRY_DELAY_MS);
            continue;
          }
          failedItems.push({
            stage: "finalize",
            errorCode: normalizedError.code,
            errorMessage: normalizedError.message,
          });
        }
      }

      if (!finalizeSucceeded) {
        this.patchTask(taskId, {
          failedCount: failedItems.length,
          failedItems: [...failedItems],
          updatedAt: new Date().toISOString(),
        });
      }
    }

    const finishedAt = new Date().toISOString();
    this.patchTask(taskId, {
      status: failedItems.length === 0 ? "success" : "failed",
      finishedAt,
      updatedAt: finishedAt,
      createdCount: createdRowIds.length,
      failedCount: failedItems.length,
      createdRowIds,
      failedItems,
    });
  }

  private async runFinalizeRetryTask(
    taskId: string,
    finalizeAfterCreate?: RequestBatchCreateFinalizeRetryInput["finalizeAfterCreate"]
  ): Promise<void> {
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

    const failedItems: BatchCreateFailedItem[] = [];

    try {
      await finalizeAfterCreate?.({
        formId: task.formId,
        entryId: task.entryId,
        requestedCount: task.requestedCount,
        createdCount: task.createdCount,
        failedCount: 0,
        createdRowIds: [...task.createdRowIds],
      });
    } catch (error) {
      const normalizedError = resolveCreateError(error);
      failedItems.push({
        stage: "finalize",
        errorCode: normalizedError.code,
        errorMessage: normalizedError.message,
      });
    }

    const finishedAt = new Date().toISOString();
    this.patchTask(taskId, {
      status: failedItems.length === 0 ? "success" : "failed",
      finishedAt,
      updatedAt: finishedAt,
      failedCount: failedItems.length,
      failedItems,
    });
  }

  private patchTask(taskId: string, patch: Partial<WorkReportBatchCreateTask>): void {
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

  private syncTaskToRegistry(task: WorkReportBatchCreateTask): void {
    const finalizeFailedItem = task.failedItems.find((item) => item.stage === "finalize");
    const rowCreateFailedItems = task.failedItems.filter(
      (item) => item.stage === "row-create"
    );
    const message =
      task.retryMode === "finalize-only"
        ? task.status === "pending"
          ? `批次新增收尾重試排隊中（已建立 ${task.createdCount}/${task.requestedCount}）`
          : task.status === "running"
            ? `批次新增收尾重試中（已建立 ${task.createdCount}/${task.requestedCount}）`
            : finalizeFailedItem
              ? `批次新增收尾重試失敗（已建立 ${task.createdCount}/${task.requestedCount}）`
              : `批次新增收尾重試完成（已建立 ${task.createdCount}/${task.requestedCount}）`
        : task.status === "pending"
          ? `批次新增排隊中（0/${task.requestedCount}）`
          : task.status === "running"
            ? `批次新增進行中（${task.createdCount + task.failedCount}/${task.requestedCount}）`
            : finalizeFailedItem
              ? `批次新增收尾失敗（已建立 ${task.createdCount}/${task.requestedCount}）`
              : task.status === "success"
                ? `批次新增完成（${task.createdCount}/${task.requestedCount}）`
                : `批次新增部分失敗（成功 ${task.createdCount}/${task.requestedCount}，失敗 ${task.failedCount}）`;

    workReportTaskRegistryService.upsertTask({
      taskId: task.taskId,
      taskType: "create-report-batch",
      status: task.status,
      formId: task.formId,
      workOrderNo: task.workOrderNo ?? null,
      entryId: task.entryId,
      rowId: task.createdRowIds.at(-1) ?? null,
      queueKey: task.queueKey,
      createdAt: task.createdAt,
      startedAt: task.startedAt ?? null,
      finishedAt: task.finishedAt ?? null,
      updatedAt: task.updatedAt,
      message: finalizeFailedItem
        ? `${message}｜前面列可能已建立成功，請重試收尾`
        : task.status === "failed" && rowCreateFailedItems.length > 0
          ? `${message}｜失敗列：${rowCreateFailedItems
              .slice(0, 5)
              .map((item) => `第${item.rowIndex}列`)
              .join("、")}`
          : message,
      errorCode:
        finalizeFailedItem?.errorCode ??
        (task.status === "failed" ? "BATCH_CREATE_PARTIAL_FAILURE" : null),
      errorMessage:
        finalizeFailedItem
          ? `批次新增已建立 ${task.createdCount}/${task.requestedCount} 列，但最後主表收尾失敗：${finalizeFailedItem.errorMessage}`
          : task.status === "failed" && rowCreateFailedItems.length > 0
            ? rowCreateFailedItems
                .slice(0, 3)
                .map((item) => `第${item.rowIndex}列：${item.errorMessage}`)
                .join("；")
          : null,
      actorClientId: task.actorClientId ?? null,
      actorTabId: task.actorTabId ?? null,
      actorIp: task.actorIp ?? null,
      actorLabel: task.actorLabel ?? null,
      batchCreatedRowIds: task.createdRowIds,
      batchFinalizeFailed: Boolean(finalizeFailedItem),
      retriedFromTaskId: task.retriedFromTaskId ?? null,
    });
  }
}

export const workReportBatchCreateTaskService =
  new WorkReportBatchCreateTaskService();

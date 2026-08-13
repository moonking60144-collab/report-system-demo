import { randomUUID } from "crypto";
import { env } from "../../config/env";
import {
  batchCreateRowKeyRepository as defaultBatchCreateRowKeyRepository,
  type BatchCreateRowKeyRecord,
  type BatchCreateRowKeyRepository,
} from "../../storage/sqlite/batchCreateRowKeyRepository";
import { HttpError } from "../../utils/httpError";
import { workReportEntryMutationQueue } from "./workReportEntryMutationQueue";
import { pruneTerminalTaskHistory } from "./localTaskHistory";
import {
  workReportTaskRegistryService,
  type WorkReportQueueTaskRecord,
  type WorkReportQueueTaskStatus,
} from "./workReportTaskRegistryService";

interface BatchCreateFailedItem {
  stage: "precondition" | "row-create" | "finalize";
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
  runningMessage?: string;
}

interface BatchCreateBeforeRunContext {
  setStatusMessage(message: string): void;
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
  beforeRun?: (context: BatchCreateBeforeRunContext) => Promise<void>;
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
  formId: string;
  entryId: string;
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

const INDETERMINATE_WRITE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNABORTED",
  "EPIPE",
]);
const INDETERMINATE_RAGIC_WRITE_RESULT_CODES = new Set([
  "RAGIC_WRITE_GONE",
  "RAGIC_WRITE_ROLLBACK_DELETED",
  "RAGIC_WRITE_ROLLBACK_UNCONFIRMED",
]);

function readUnknownRecord(input: unknown): Record<string, unknown> | null {
  return Boolean(input) && typeof input === "object" ? (input as Record<string, unknown>) : null;
}

function getNestedRecord(input: Record<string, unknown>, key: string): Record<string, unknown> | null {
  return readUnknownRecord(input[key]);
}

function getHttpErrorUpstreamStatus(error: HttpError): number | undefined {
  const record = readUnknownRecord(error);
  const upstreamDetail = record ? getNestedRecord(record, "upstreamDetail") : null;
  const status = upstreamDetail?.status;
  return typeof status === "number" ? status : undefined;
}

function getErrorHttpStatus(error: unknown): number | undefined {
  if (error instanceof HttpError) {
    return getHttpErrorUpstreamStatus(error) ?? error.statusCode;
  }
  const record = readUnknownRecord(error);
  const response = record ? getNestedRecord(record, "response") : null;
  const status = response?.status;
  return typeof status === "number" ? status : undefined;
}

function getErrorCode(error: unknown): string | undefined {
  const record = readUnknownRecord(error);
  const code = record?.code;
  return typeof code === "string" ? code : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shouldMarkCreateResultIndeterminate(error: unknown): boolean {
  const code = getErrorCode(error);
  const message = getErrorMessage(error);

  if (error instanceof HttpError) {
    if (code && INDETERMINATE_RAGIC_WRITE_RESULT_CODES.has(code)) {
      return true;
    }
    if (code !== "RAGIC_WRITE_FAILED") {
      return false;
    }
    if (message.includes("新增成功但讀不到新明細列")) {
      return true;
    }
    const httpStatus = getErrorHttpStatus(error);
    if (typeof httpStatus === "number") {
      return httpStatus >= 500;
    }
    return Array.from(INDETERMINATE_WRITE_ERROR_CODES).some((knownCode) =>
      message.includes(knownCode)
    );
  }

  const status = getErrorHttpStatus(error);
  if (typeof status === "number" && status >= 500) {
    return true;
  }
  if (code && INDETERMINATE_WRITE_ERROR_CODES.has(code)) {
    return true;
  }
  return Array.from(INDETERMINATE_WRITE_ERROR_CODES).some((knownCode) =>
    message.includes(knownCode)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isSameBatchCreateTarget(
  record: BatchCreateRowKeyRecord,
  formId: string,
  entryId: string
): boolean {
  return record.formId === formId && record.entryId === entryId;
}

function throwIndeterminateBatchCreateRow(record: BatchCreateRowKeyRecord): never {
  const message =
    record.status === "pending"
      ? "批次新增列的 Ragic 寫入結果尚未確認，請稍後再重試或聯絡管理員確認。"
      : "批次新增列的 Ragic 寫入結果尚未確認，已暫停同 clientRowKey 重送，請先確認是否已建立。";
  throw new HttpError(
    409,
    message,
    "BATCH_CREATE_ROW_INDETERMINATE"
  );
}

function normalizeRegistryBatchCreatedRowIds(record: WorkReportQueueTaskRecord): string[] {
  return Array.from(
    new Set(
      (record.batchCreatedRowIds ?? [])
        .map((rowId) => String(rowId ?? "").trim())
        .filter((rowId) => /^\d+$/.test(rowId))
    )
  );
}

function isIndeterminateBatchCreateRowFailure(item: BatchCreateFailedItem): boolean {
  return (
    item.stage === "row-create" &&
    (item.errorCode === "BATCH_CREATE_ROW_INDETERMINATE" ||
      item.errorCode === "BATCH_CREATE_ROW_KEY_RECORD_FAILED")
  );
}

/**
 * 每列批次新增的 idempotency 保護：
 * - 若 row 無 clientRowKey → 拒絕建立，避免背景 retry 無 durable key
 * - 若 key 已映射到同一 form/entry → 回舊 rowId，不再打 Ragic
 * - 若 key 已映射到不同 form/entry → 拒絕重用，避免同 key 跨工單產生裸寫入
 * - 若 key 尚未映射 → 先 reserve pending；寫入結果未知時轉 indeterminate，避免重送造成重複新增
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
    throw new HttpError(
      400,
      "批次新增每列都必須提供 clientRowKey，才能安全處理重試與服務重啟。",
      "BATCH_CREATE_ROW_KEY_REQUIRED"
    );
  }

  const existing = await rowKeyRepo.lookup(clientRowKey).catch((error) => {
    console.warn("[batch-create][row-key-lookup-failed]", {
      key: clientRowKey,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new HttpError(
      503,
      "批次新增 idempotency store 暫時不可用，已停止寫入以避免重複新增。",
      "BATCH_CREATE_ROW_KEY_STORE_UNAVAILABLE"
    );
  });
  if (existing) {
    if (isSameBatchCreateTarget(existing, formId, entryId)) {
      if (existing.status !== "confirmed" || !existing.ragicRowId) {
        throwIndeterminateBatchCreateRow(existing);
      }
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
    throw new HttpError(
      409,
      "clientRowKey 已用於其他工令，請重新產生批次新增 key 後再送出。",
      "BATCH_CREATE_ROW_KEY_CONFLICT"
    );
  }

  const reserveResult = await rowKeyRepo
    .reservePending({
      clientRowKey,
      formId,
      entryId,
    })
    .catch((error) => {
      console.warn("[batch-create][row-key-reserve-failed]", {
        key: clientRowKey,
        formId,
        entryId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new HttpError(
        503,
        "批次新增 idempotency store 暫時不可用，已停止寫入以避免重複新增。",
        "BATCH_CREATE_ROW_KEY_STORE_UNAVAILABLE"
      );
    });

  const reserved = reserveResult.record;
  if (!reserved) {
    throw new HttpError(
      503,
      "批次新增 idempotency reservation 無法確認 owner，已停止寫入。",
      "BATCH_CREATE_ROW_KEY_STORE_UNAVAILABLE"
    );
  }
  if (!reserveResult.reserved) {
    if (isSameBatchCreateTarget(reserved, formId, entryId)) {
      if (reserved.status !== "confirmed" || !reserved.ragicRowId) {
        throwIndeterminateBatchCreateRow(reserved);
      }
      return reserved.ragicRowId;
    }
    console.warn("[batch-create][row-key-reserve-conflict]", {
      key: clientRowKey,
      existing: reserved,
      requested: { formId, entryId },
    });
    throw new HttpError(
      409,
      "clientRowKey 已被其他工令先取得 reservation，請重新產生 key 後再送出。",
      "BATCH_CREATE_ROW_KEY_CONFLICT"
    );
  }

  let result: { rowId: string };
  try {
    result = await createRow(row.payload);
  } catch (error) {
    if (shouldMarkCreateResultIndeterminate(error)) {
      const errorMessage = getErrorMessage(error);
      await rowKeyRepo
        .markIndeterminate({
          clientRowKey,
          formId,
          entryId,
          errorMessage,
        })
        .catch((markError) => {
          console.warn("[batch-create][row-key-mark-indeterminate-failed]", {
            key: clientRowKey,
            formId,
            entryId,
            error: markError instanceof Error ? markError.message : String(markError),
          });
        });
      throw new HttpError(
        409,
        `批次新增列的 Ragic 寫入結果尚未確認，已暫停同 clientRowKey 重送：${errorMessage}`,
        "BATCH_CREATE_ROW_INDETERMINATE"
      );
    } else {
      await rowKeyRepo.releasePending({ clientRowKey, formId, entryId }).catch((releaseError) => {
        console.warn("[batch-create][row-key-release-pending-failed]", {
          key: clientRowKey,
          formId,
          entryId,
          error: releaseError instanceof Error ? releaseError.message : String(releaseError),
        });
      });
    }
    throw error;
  }

  const persistedCount = await rowKeyRepo.confirm({
    clientRowKey,
    formId,
    entryId,
    ragicRowId: result.rowId,
  }).catch((error) => {
    console.warn("[batch-create][row-key-record-failed]", {
      key: clientRowKey,
      formId,
      entryId,
      rowId: result.rowId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new HttpError(
      503,
      `批次新增列已寫入 Ragic（rowId: ${result.rowId}），但 idempotency mapping 保存失敗，已暫停自動重試。`,
      "BATCH_CREATE_ROW_KEY_RECORD_FAILED"
    );
  });
  if (persistedCount !== 1) {
    throw new HttpError(
      503,
      `批次新增列已寫入 Ragic（rowId: ${result.rowId}），但 idempotency reservation 已變更，需人工確認後再重送。`,
      "BATCH_CREATE_ROW_KEY_RECORD_FAILED"
    );
  }
  return result.rowId;
}

class WorkReportBatchCreateTaskService {
  private readonly tasks = new Map<string, WorkReportBatchCreateTask>();
  private readonly queueChainByKey = workReportEntryMutationQueue;

  requestBatchCreate(input: RequestBatchCreateInput): Pick<
    WorkReportBatchCreateTask,
    "taskId" | "status" | "createdAt" | "requestedCount"
  > {
    const rows = normalizeCreateRows(input.rows);
    if (rows.length === 0) {
      throw new HttpError(400, "至少要送出一筆可建立的明細", "BATCH_CREATE_EMPTY");
    }

    this.queueChainByKey.assertAccepting(`${input.formId}:${input.entryId}`);

    const taskId = randomUUID();
    const createdAt = new Date().toISOString();
    const task: WorkReportBatchCreateTask = {
      taskId,
      formId: input.formId,
      entryId: input.entryId,
      ...(input.workOrderNo ? { workOrderNo: input.workOrderNo } : {}),
      queueKey: `${input.formId}:${input.entryId}`,
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

    void this.queueChainByKey.enqueue(
      task.queueKey,
      () => this.runTask(taskId, rows, input),
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

  requestBatchCreateFinalizeRetry(
    input: RequestBatchCreateFinalizeRetryInput
  ): Pick<WorkReportBatchCreateTask, "taskId" | "status" | "createdAt" | "requestedCount"> {
    const sourceTask = this.tasks.get(input.taskId) ?? this.hydrateFinalizeRetrySource(input);
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

    this.queueChainByKey.assertAccepting(sourceTask.queueKey);

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

    void this.queueChainByKey.enqueue(
      retryTask.queueKey,
      () => this.runFinalizeRetryTask(taskId, input.finalizeAfterCreate),
      {
        onWaitingForSync: () => {
          this.markWaitingForSync(taskId);
        },
      }
    );

    return {
      taskId,
      status: retryTask.status,
      createdAt: retryTask.createdAt,
      requestedCount: retryTask.requestedCount,
    };
  }

  private hydrateFinalizeRetrySource(
    input: RequestBatchCreateFinalizeRetryInput
  ): WorkReportBatchCreateTask | null {
    const record = workReportTaskRegistryService.getTask(input.taskId);
    if (!record || record.taskType !== "create-report-batch") {
      return null;
    }
    if (record.formId !== input.formId || record.entryId !== input.entryId) {
      return null;
    }
    const createdRowIds = normalizeRegistryBatchCreatedRowIds(record);
    if (record.status !== "failed" || !record.batchFinalizeFailed || createdRowIds.length === 0) {
      return null;
    }
    return {
      taskId: record.taskId,
      formId: record.formId,
      entryId: record.entryId,
      ...(record.workOrderNo ? { workOrderNo: record.workOrderNo } : {}),
      queueKey: record.queueKey ?? `${record.formId}:${record.entryId}`,
      requestedCount: createdRowIds.length,
      createdCount: createdRowIds.length,
      failedCount: 1,
      createdRowIds,
      failedItems: [
        {
          stage: "finalize",
          errorCode: record.errorCode ?? undefined,
          errorMessage: record.errorMessage ?? "批次新增收尾失敗",
        },
      ],
      status: "failed",
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.startedAt ? { startedAt: record.startedAt } : {}),
      ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
      ...(record.actorClientId ? { actorClientId: record.actorClientId } : {}),
      ...(record.actorTabId ? { actorTabId: record.actorTabId } : {}),
      ...(record.actorIp ? { actorIp: record.actorIp } : {}),
      ...(record.actorLabel ? { actorLabel: record.actorLabel } : {}),
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

    const startedAt = task.startedAt ?? new Date().toISOString();
    this.patchTask(taskId, {
      status: "running",
      startedAt,
      updatedAt: startedAt,
      runningMessage: undefined,
    });

    const createdRowIds: string[] = [];
    const failedItems: BatchCreateFailedItem[] = [];
    const rowKeyRepo = input.rowKeyRepository ?? defaultBatchCreateRowKeyRepository;
    const timings = {
      beforeRunMs: 0,
      rowsMs: 0,
      finalizeMs: 0,
    };

    try {
      const beforeRunStartedAt = Date.now();
      await input.beforeRun?.({
        setStatusMessage: (message) => {
          this.patchTask(taskId, {
            runningMessage: message,
            updatedAt: new Date().toISOString(),
          });
        },
      });
      this.patchTask(taskId, {
        runningMessage: undefined,
        updatedAt: new Date().toISOString(),
      });
      timings.beforeRunMs = Date.now() - beforeRunStartedAt;
    } catch (error) {
      timings.beforeRunMs = Math.max(0, Date.now() - Date.parse(startedAt));
      const normalizedError = resolveCreateError(error);
      failedItems.push({
        stage: "precondition",
        errorCode: normalizedError.code,
        errorMessage: normalizedError.message,
      });
      const finishedAt = new Date().toISOString();
      this.patchTask(taskId, {
        status: "failed",
        finishedAt,
        updatedAt: finishedAt,
        createdCount: 0,
        failedCount: failedItems.length,
        createdRowIds,
        failedItems,
      });
      console.info("[batch-create][timing]", {
        taskId,
        formId: task.formId,
        entryId: task.entryId,
        requestedCount: task.requestedCount,
        createdCount: 0,
        failedCount: failedItems.length,
        beforeRunMs: timings.beforeRunMs,
        rowsMs: timings.rowsMs,
        finalizeMs: timings.finalizeMs,
        totalMs: Date.now() - Date.parse(startedAt),
        status: "failed",
        failureStage: "precondition",
      });
      return;
    }

    const rowsStartedAt = Date.now();
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
    timings.rowsMs = Date.now() - rowsStartedAt;

    if (createdRowIds.length > 0) {
      const finalizeStartedAt = Date.now();
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
      timings.finalizeMs = Date.now() - finalizeStartedAt;

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
    console.info("[batch-create][timing]", {
      taskId,
      formId: task.formId,
      entryId: task.entryId,
      requestedCount: task.requestedCount,
      createdCount: createdRowIds.length,
      failedCount: failedItems.length,
      beforeRunMs: timings.beforeRunMs,
      rowsMs: timings.rowsMs,
      finalizeMs: timings.finalizeMs,
      totalMs: Date.now() - Date.parse(startedAt),
      status: failedItems.length === 0 ? "success" : "failed",
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

    const startedAt = task.startedAt ?? new Date().toISOString();
    this.patchTask(taskId, {
      status: "running",
      startedAt,
      updatedAt: startedAt,
      runningMessage: undefined,
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

  private syncTaskToRegistry(task: WorkReportBatchCreateTask): void {
    const preconditionFailedItem = task.failedItems.find(
      (item) => item.stage === "precondition"
    );
    const finalizeFailedItem = task.failedItems.find((item) => item.stage === "finalize");
    const hasIndeterminateRowFailure = task.failedItems.some(
      isIndeterminateBatchCreateRowFailure
    );
    const rowCreateFailedItems = task.failedItems.filter(
      (item) => item.stage === "row-create"
    );
    const message =
      task.retryMode === "finalize-only"
        ? task.status === "pending"
          ? `批次新增收尾重試排隊中（已建立 ${task.createdCount}/${task.requestedCount}）`
          : task.status === "running"
            ? task.runningMessage ??
              `批次新增收尾重試中（已建立 ${task.createdCount}/${task.requestedCount}）`
            : finalizeFailedItem
              ? `批次新增收尾重試失敗（已建立 ${task.createdCount}/${task.requestedCount}）`
              : `批次新增收尾重試完成（已建立 ${task.createdCount}/${task.requestedCount}）`
        : task.status === "pending"
          ? `批次新增排隊中（0/${task.requestedCount}）`
          : task.status === "running"
            ? task.runningMessage ??
              `批次新增進行中（${task.createdCount + task.failedCount}/${task.requestedCount}）`
            : preconditionFailedItem
              ? "批次新增前置檢查失敗"
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
        : preconditionFailedItem
          ? `${message}｜${preconditionFailedItem.errorMessage}`
        : task.status === "failed" && rowCreateFailedItems.length > 0
          ? `${message}｜失敗列：${rowCreateFailedItems
              .slice(0, 5)
              .map((item) => `第${item.rowIndex}列`)
              .join("、")}`
          : message,
      errorCode:
        preconditionFailedItem?.errorCode ??
        finalizeFailedItem?.errorCode ??
        (task.status === "failed" ? "BATCH_CREATE_PARTIAL_FAILURE" : null),
      errorMessage:
        preconditionFailedItem
          ? `批次新增尚未開始，前置檢查失敗：${preconditionFailedItem.errorMessage}`
          : finalizeFailedItem
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
      batchWriteIndeterminate: hasIndeterminateRowFailure,
      retriedFromTaskId: task.retriedFromTaskId ?? null,
    });
  }
}

export const workReportBatchCreateTaskService =
  new WorkReportBatchCreateTaskService();

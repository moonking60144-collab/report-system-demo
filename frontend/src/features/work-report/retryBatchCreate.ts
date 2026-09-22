import {
  createReportsBatchAccepted,
  fetchWorkReportQueueTask,
  retryBatchCreateFinalizeAccepted,
  type BatchCreateTaskAcceptedResult,
} from "../../api/workReport";
import { enqueueRetryPoll } from "./batchRetryPollManager";
import {
  deleteRetryableBatchCreateRecordChain,
  replaceRetryableBatchCreateRecord,
  type RetryableBatchCreateRecord,
} from "./taskBatchRetryStore";
import type { WorkReportQueueTask } from "../../api/workReport";

export type BatchCreateRetryBlockReason = "indeterminate" | "precondition" | "statusUnknown";

function readTaskFailureText(task: WorkReportQueueTask): string {
  return `${task.errorCode ?? ""} ${task.errorMessage ?? ""} ${task.message ?? ""}`;
}

export function getBatchCreateRetryBlockReason(
  task: WorkReportQueueTask
): BatchCreateRetryBlockReason | null {
  if (task.taskType !== "create-report-batch" || task.status !== "failed") {
    return null;
  }
  if (task.batchWriteIndeterminate === true) {
    return "indeterminate";
  }
  const text = readTaskFailureText(task);
  if (text.includes("寫入結果尚未確認") || text.includes("clientRowKey")) {
    return "indeterminate";
  }
  if (
    text.includes("ENTRY_STATUS_UNKNOWN") ||
    text.includes("無法確認工令狀態") ||
    text.includes("work order status could not be confirmed")
  ) {
    return "statusUnknown";
  }
  if (
    text.includes("ENTRY_CONFLICT") ||
    text.includes("ENTRY_EDIT_LOCKED") ||
    text.includes("批次新增尚未開始，前置檢查失敗") ||
    text.includes("批次新增前置檢查失敗")
  ) {
    return "precondition";
  }
  return null;
}

function getBatchCreateRetryBlockedMessage(reason: BatchCreateRetryBlockReason): string {
  if (reason === "indeterminate") {
    return "這筆舊批次新增任務已被標記為寫入結果不明，不能重送；請確認是否已建立，並重新新增一筆。";
  }
  if (reason === "statusUnknown") {
    return "這筆批次新增在開始前因無法確認工令狀態而中止，不能沿用舊資料重送；請稍後刷新工令後重新新增。";
  }
  return "這筆批次新增在開始前就因工令狀態已變更而失敗，不能沿用舊資料重送；請刷新工令後重新新增。";
}

/**
 * 共用 batch-create retry 流程：drawer / badge 都能呼叫
 * - 先抓 task 狀態判斷走 finalize-retry 或 full-retry
 * - full-retry 帶 clientRowKey，後端用 batch_create_row_keys 做 idempotent
 * - 寫回新 taskId 到 retry chain 並啟動背景 poll，成功時會自動把整條 chain 清掉
 */
export async function retryBatchCreateFromRecord(
  record: RetryableBatchCreateRecord
): Promise<BatchCreateTaskAcceptedResult> {
  const task = await fetchWorkReportQueueTask(record.formId, record.taskId);

  const retryBlockReason = getBatchCreateRetryBlockReason(task);
  if (retryBlockReason) {
    deleteRetryableBatchCreateRecordChain(record.taskId);
    throw new Error(getBatchCreateRetryBlockedMessage(retryBlockReason));
  }

  const useFinalizeRetry =
    task.batchFinalizeFailed === true &&
    Array.isArray(task.batchCreatedRowIds) &&
    task.batchCreatedRowIds.length > 0;

  const retryRows = record.rows.filter(
    (row): row is typeof row & { clientRowKey: string } =>
      typeof row.clientRowKey === "string" && row.clientRowKey.trim().length > 0
  );
  if (!useFinalizeRetry && retryRows.length !== record.rows.length) {
    deleteRetryableBatchCreateRecordChain(record.taskId);
    throw new Error(
      "這筆舊批次新增缺少逐列防重識別碼，不能安全重送；請重新建立批次。"
    );
  }

  const accepted = useFinalizeRetry
    ? await retryBatchCreateFinalizeAccepted(
        record.formId,
        record.entryId,
        record.taskId,
        { workOrderNo: record.workOrderNo ?? null }
      )
    : await createReportsBatchAccepted(
        record.formId,
        record.entryId,
        retryRows,
        {
          expectedEntryLastUpdatedAt: record.expectedEntryLastUpdatedAt,
          editSessionId: record.editSessionId,
          workOrderNo: record.workOrderNo ?? null,
        }
      );

  replaceRetryableBatchCreateRecord(record.taskId, {
    ...record,
    taskId: accepted.taskId,
    retryRootTaskId: record.retryRootTaskId,
    retriedFromTaskId: record.taskId,
    createdAt: new Date().toISOString(),
  });

  enqueueRetryPoll(record.formId, accepted.taskId);
  return accepted;
}

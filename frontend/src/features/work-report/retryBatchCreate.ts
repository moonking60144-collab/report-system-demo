import {
  createReportsBatchAccepted,
  fetchWorkReportQueueTask,
  retryBatchCreateFinalizeAccepted,
  type BatchCreateTaskAcceptedResult,
} from "../../api/workReport";
import { enqueueRetryPoll } from "./batchRetryPollManager";
import {
  replaceRetryableBatchCreateRecord,
  type RetryableBatchCreateRecord,
} from "./taskBatchRetryStore";

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

  const useFinalizeRetry =
    task.batchFinalizeFailed === true &&
    Array.isArray(task.batchCreatedRowIds) &&
    task.batchCreatedRowIds.length > 0;

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
        record.rows,
        {
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

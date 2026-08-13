import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReportsBatchAccepted,
  fetchWorkReportQueueTask,
  retryBatchCreateFinalizeAccepted,
  type WorkReportQueueTask,
} from "../../api/workReport";
import { enqueueRetryPoll } from "./batchRetryPollManager";
import {
  deleteRetryableBatchCreateRecordChain,
  replaceRetryableBatchCreateRecord,
  type RetryableBatchCreateRecord,
} from "./taskBatchRetryStore";
import {
  getBatchCreateRetryBlockReason,
  retryBatchCreateFromRecord,
} from "./retryBatchCreate";

vi.mock("../../api/workReport", () => ({
  createReportsBatchAccepted: vi.fn(),
  fetchWorkReportQueueTask: vi.fn(),
  retryBatchCreateFinalizeAccepted: vi.fn(),
}));

vi.mock("./batchRetryPollManager", () => ({
  enqueueRetryPoll: vi.fn(),
}));

vi.mock("./taskBatchRetryStore", () => ({
  deleteRetryableBatchCreateRecordChain: vi.fn(),
  replaceRetryableBatchCreateRecord: vi.fn(),
}));

function createFailedBatchTask(
  patch: Partial<WorkReportQueueTask> = {}
): WorkReportQueueTask {
  return {
    taskId: "batch-task-1",
    taskType: "create-report-batch",
    status: "failed",
    formId: "105",
    workOrderNo: "WO-25040537",
    entryId: "entry-1",
    rowId: null,
    queueKey: "105:entry-1",
    createdAt: "2026-07-02T00:00:00.000Z",
    startedAt: "2026-07-02T00:00:01.000Z",
    finishedAt: "2026-07-02T00:00:02.000Z",
    updatedAt: "2026-07-02T00:00:02.000Z",
    message: null,
    errorCode: null,
    errorMessage: null,
    actorClientId: "client-1",
    actorTabId: "tab-1",
    actorIp: "::1",
    actorLabel: null,
    source: null,
    ...patch,
  };
}

function createRetryRecord(
  patch: Partial<RetryableBatchCreateRecord> = {}
): RetryableBatchCreateRecord {
  return {
    taskId: "batch-task-1",
    retryRootTaskId: "batch-task-1",
    formId: "105",
    entryId: "entry-1",
    workOrderNo: "WO-25040537",
    rows: [
      {
        clientRowKey: "row-key-1",
        payload: {
          date: "2026/07/02",
          machineId: "P10",
          operatorId: "RA004",
          startTime: "08:00",
          endTime: "17:00",
        },
      },
    ],
    expectedEntryLastUpdatedAt: "2026-07-02T00:00:00.000Z",
    editSessionId: "edit-session-1",
    actorClientId: "client-1",
    createdAt: "2026-07-02T00:00:00.000Z",
    ...patch,
  };
}

describe("retryBatchCreateFromRecord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("blocks ENTRY_CONFLICT retries because the stored timestamp is stale", async () => {
    vi.mocked(fetchWorkReportQueueTask).mockResolvedValueOnce(
      createFailedBatchTask({
        errorCode: "ENTRY_CONFLICT",
        errorMessage: "批次新增尚未開始，前置檢查失敗：這筆工令在你編輯期間已被其他人更新，請先刷新後再重新送出。",
      })
    );

    await expect(retryBatchCreateFromRecord(createRetryRecord()))
      .rejects.toThrow("請刷新工令後重新新增");

    expect(deleteRetryableBatchCreateRecordChain).toHaveBeenCalledWith("batch-task-1");
    expect(createReportsBatchAccepted).not.toHaveBeenCalled();
    expect(retryBatchCreateFinalizeAccepted).not.toHaveBeenCalled();
    expect(replaceRetryableBatchCreateRecord).not.toHaveBeenCalled();
    expect(enqueueRetryPoll).not.toHaveBeenCalled();
  });

  it("classifies precondition and indeterminate failures separately", () => {
    expect(getBatchCreateRetryBlockReason(
      createFailedBatchTask({
        errorCode: "ENTRY_EDIT_LOCKED",
        errorMessage: "批次新增尚未開始，前置檢查失敗：這筆工令目前由其他人編輯中，請稍後再試。",
      })
    )).toBe("precondition");

    expect(getBatchCreateRetryBlockReason(
      createFailedBatchTask({
        batchWriteIndeterminate: true,
        errorMessage: "第1列：timeout of 15000ms exceeded",
      })
    )).toBe("indeterminate");

    expect(getBatchCreateRetryBlockReason(
      createFailedBatchTask({
        errorMessage: "第1列：批次新增列的 Ragic 寫入結果尚未確認，已暫停同 clientRowKey 重送。",
      })
    )).toBe("indeterminate");
  });

  it("blocks full retry when row key mapping failed after Ragic create", async () => {
    vi.mocked(fetchWorkReportQueueTask).mockResolvedValueOnce(
      createFailedBatchTask({
        batchWriteIndeterminate: true,
        errorCode: "BATCH_CREATE_PARTIAL_FAILURE",
        errorMessage: "第1列：批次新增列已寫入 Ragic（rowId: 1001），但 idempotency reservation 已變更，需人工確認後再重送。",
      })
    );

    await expect(retryBatchCreateFromRecord(createRetryRecord()))
      .rejects.toThrow("不能重送");

    expect(deleteRetryableBatchCreateRecordChain).toHaveBeenCalledWith("batch-task-1");
    expect(createReportsBatchAccepted).not.toHaveBeenCalled();
    expect(retryBatchCreateFinalizeAccepted).not.toHaveBeenCalled();
    expect(replaceRetryableBatchCreateRecord).not.toHaveBeenCalled();
    expect(enqueueRetryPoll).not.toHaveBeenCalled();
  });

  it("classifies status-unknown failures separately from changed work orders", async () => {
    const task = createFailedBatchTask({
      errorCode: "ENTRY_STATUS_UNKNOWN",
      errorMessage: "批次新增尚未開始，前置檢查失敗：目前無法確認工令狀態，為避免已結案工令被新增報工，請稍後重試。",
    });

    expect(getBatchCreateRetryBlockReason(task)).toBe("statusUnknown");
    vi.mocked(fetchWorkReportQueueTask).mockResolvedValueOnce(task);

    await expect(retryBatchCreateFromRecord(createRetryRecord()))
      .rejects.toThrow("無法確認工令狀態");

    expect(deleteRetryableBatchCreateRecordChain).toHaveBeenCalledWith("batch-task-1");
    expect(createReportsBatchAccepted).not.toHaveBeenCalled();
    expect(retryBatchCreateFinalizeAccepted).not.toHaveBeenCalled();
    expect(replaceRetryableBatchCreateRecord).not.toHaveBeenCalled();
    expect(enqueueRetryPoll).not.toHaveBeenCalled();
  });

  it("blocks legacy full retry records that have no durable row key", async () => {
    vi.mocked(fetchWorkReportQueueTask).mockResolvedValueOnce(createFailedBatchTask());

    await expect(
      retryBatchCreateFromRecord(
        createRetryRecord({
          rows: [
            {
              payload: {
                date: "2026/07/02",
                machineId: "P10",
                operatorId: "RA004",
                startTime: "08:00",
                endTime: "17:00",
              },
            },
          ],
        })
      )
    ).rejects.toThrow("缺少逐列防重識別碼");

    expect(deleteRetryableBatchCreateRecordChain).toHaveBeenCalledWith("batch-task-1");
    expect(createReportsBatchAccepted).not.toHaveBeenCalled();
    expect(retryBatchCreateFinalizeAccepted).not.toHaveBeenCalled();
    expect(replaceRetryableBatchCreateRecord).not.toHaveBeenCalled();
    expect(enqueueRetryPoll).not.toHaveBeenCalled();
  });
});

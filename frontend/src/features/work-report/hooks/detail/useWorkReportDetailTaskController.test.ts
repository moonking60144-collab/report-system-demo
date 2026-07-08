import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchCreateReportTask,
  fetchWorkReportQueueTask,
  type CreateReportTaskResult,
  type WorkReportQueueTask,
} from "../../../../api/workReport";
import { fetchAcceptedMutationTaskResult } from "./useWorkReportDetailTaskController";

vi.mock("../../../../api/workReport", () => ({
  fetchCreateReportTask: vi.fn(),
  fetchWorkReportQueueTask: vi.fn(),
}));

describe("fetchAcceptedMutationTaskResult", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the queue task endpoint for delete accepted tasks", async () => {
    const queueTask: WorkReportQueueTask = {
      taskId: "task-delete-1",
      taskType: "delete-report",
      status: "success",
      formId: "16",
      workOrderNo: "WO-260701",
      entryId: "123",
      rowId: "789",
      queueKey: "16:123",
      createdAt: "2026-07-01T00:00:00.000Z",
      startedAt: "2026-07-01T00:00:01.000Z",
      finishedAt: "2026-07-01T00:00:02.000Z",
      updatedAt: "2026-07-01T00:00:02.000Z",
      message: "刪除報工完成",
      errorCode: null,
      errorMessage: null,
      actorClientId: null,
      actorTabId: null,
      actorIp: null,
      actorLabel: null,
      source: null,
    };
    vi.mocked(fetchWorkReportQueueTask).mockResolvedValueOnce(queueTask);

    await expect(fetchAcceptedMutationTaskResult("delete", "16", "task-delete-1"))
      .resolves.toBe(queueTask);

    expect(fetchWorkReportQueueTask).toHaveBeenCalledWith("16", "task-delete-1");
    expect(fetchCreateReportTask).not.toHaveBeenCalled();
  });

  it("uses the queue task endpoint for delete-batch accepted tasks", async () => {
    const queueTask: WorkReportQueueTask = {
      taskId: "task-delete-batch-1",
      taskType: "delete-report-batch",
      status: "success",
      formId: "16",
      workOrderNo: "WO-260701",
      entryId: "123",
      rowId: null,
      queueKey: "16:123",
      createdAt: "2026-07-01T00:00:00.000Z",
      startedAt: "2026-07-01T00:00:01.000Z",
      finishedAt: "2026-07-01T00:00:02.000Z",
      updatedAt: "2026-07-01T00:00:02.000Z",
      message: "批次刪除完成（2/2）",
      errorCode: null,
      errorMessage: null,
      actorClientId: null,
      actorTabId: null,
      actorIp: null,
      actorLabel: null,
      source: null,
    };
    vi.mocked(fetchWorkReportQueueTask).mockResolvedValueOnce(queueTask);

    await expect(fetchAcceptedMutationTaskResult("delete-batch", "16", "task-delete-batch-1"))
      .resolves.toBe(queueTask);

    expect(fetchWorkReportQueueTask).toHaveBeenCalledWith("16", "task-delete-batch-1");
    expect(fetchCreateReportTask).not.toHaveBeenCalled();
  });

  it("keeps create and update accepted tasks on the create-task endpoint", async () => {
    const createTask: CreateReportTaskResult = {
      taskId: "task-create-1",
      taskType: "create-report",
      formId: "16",
      entryId: "123",
      queueKey: "16:123",
      status: "success",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:02.000Z",
      result: {
        rowId: "789",
      },
    };
    vi.mocked(fetchCreateReportTask).mockResolvedValueOnce(createTask);

    await expect(fetchAcceptedMutationTaskResult("create", "16", "task-create-1"))
      .resolves.toBe(createTask);

    expect(fetchCreateReportTask).toHaveBeenCalledWith("16", "task-create-1");
    expect(fetchWorkReportQueueTask).not.toHaveBeenCalled();
  });
});

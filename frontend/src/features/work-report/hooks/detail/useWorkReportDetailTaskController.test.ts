import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchCreateReportTask,
  fetchWorkReportQueueTask,
  type CreateReportTaskResult,
  type WorkReportQueueTask,
} from "../../../../api/workReport";
import {
  fetchAcceptedMutationTaskResult,
  hasPendingEntryFieldSettlement,
  isMutationTaskVerificationPending,
} from "./useWorkReportDetailTaskController";
import type { RetryableEntryFieldMutation } from "../../entryFieldTaskRetryStore";

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
      formId: "903",
      workOrderNo: "WO-DEMO-0002",
      entryId: "123",
      rowId: "789",
      queueKey: "903:123",
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

    await expect(fetchAcceptedMutationTaskResult("delete", "903", "task-delete-1"))
      .resolves.toBe(queueTask);

    expect(fetchWorkReportQueueTask).toHaveBeenCalledWith("903", "task-delete-1");
    expect(fetchCreateReportTask).not.toHaveBeenCalled();
  });

  it("uses the queue task endpoint for delete-batch accepted tasks", async () => {
    const queueTask: WorkReportQueueTask = {
      taskId: "task-delete-batch-1",
      taskType: "delete-report-batch",
      status: "success",
      formId: "903",
      workOrderNo: "WO-DEMO-0002",
      entryId: "123",
      rowId: null,
      queueKey: "903:123",
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

    await expect(fetchAcceptedMutationTaskResult("delete-batch", "903", "task-delete-batch-1"))
      .resolves.toBe(queueTask);

    expect(fetchWorkReportQueueTask).toHaveBeenCalledWith("903", "task-delete-batch-1");
    expect(fetchCreateReportTask).not.toHaveBeenCalled();
  });

  it("uses the queue task endpoint for create-batch accepted tasks", async () => {
    const queueTask: WorkReportQueueTask = {
      taskId: "task-create-batch-1",
      taskType: "create-report-batch",
      status: "success",
      formId: "901",
      workOrderNo: "WO-DEMO-0002",
      entryId: "123",
      rowId: null,
      queueKey: "901:123",
      createdAt: "2026-07-01T00:00:00.000Z",
      startedAt: "2026-07-01T00:00:01.000Z",
      finishedAt: "2026-07-01T00:00:02.000Z",
      updatedAt: "2026-07-01T00:00:02.000Z",
      message: "批次新增完成（2/2）",
      errorCode: null,
      errorMessage: null,
      actorClientId: null,
      actorTabId: null,
      actorIp: null,
      actorLabel: null,
      source: null,
      batchCreatedRowIds: ["201", "202"],
    };
    vi.mocked(fetchWorkReportQueueTask).mockResolvedValueOnce(queueTask);

    await expect(
      fetchAcceptedMutationTaskResult("create-batch", "901", queueTask.taskId)
    ).resolves.toBe(queueTask);

    expect(fetchWorkReportQueueTask).toHaveBeenCalledWith("901", queueTask.taskId);
    expect(fetchCreateReportTask).not.toHaveBeenCalled();
  });

  it("keeps create and update accepted tasks on the create-task endpoint", async () => {
    const createTask: CreateReportTaskResult = {
      taskId: "task-create-1",
      taskType: "create-report",
      formId: "903",
      entryId: "123",
      queueKey: "903:123",
      status: "success",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:02.000Z",
      result: {
        rowId: "789",
      },
    };
    vi.mocked(fetchCreateReportTask).mockResolvedValueOnce(createTask);

    await expect(fetchAcceptedMutationTaskResult("create", "903", "task-create-1"))
      .resolves.toBe(createTask);

    expect(fetchCreateReportTask).toHaveBeenCalledWith("903", "task-create-1");
    expect(fetchWorkReportQueueTask).not.toHaveBeenCalled();
  });
});

describe("isMutationTaskVerificationPending", () => {
  it("會阻擋 indeterminate 與 task-not-found unknown 的後續寫入", () => {
    expect(
      isMutationTaskVerificationPending({
        lifecycleState: "indeterminate",
      })
    ).toBe(true);
    expect(
      isMutationTaskVerificationPending({
        lifecycleState: "unknown",
        stale: true,
      })
    ).toBe(true);
    expect(
      isMutationTaskVerificationPending({
        lifecycleState: "failed",
      })
    ).toBe(false);
  });

  it("entry-field 已完成 authoritative settlement 後不再被舊 unknown/frozen history 阻擋", () => {
    expect(
      isMutationTaskVerificationPending({
        lifecycleState: "unknown",
        stale: true,
        entryFieldSettlementOutcome: "settled",
        optimisticMutation: {
          lifecycle: {
            version: 1,
            mutationId: "mutation-settled",
            taskId: "task-settled",
            operation: "work-report-main-machine",
            target: {
              domain: "work-report",
              formId: "901",
              entryId: "E-901",
            },
            lifecycleState: "unknown",
            optimisticState: "frozen",
            acceptedAt: "2026-09-02T03:00:00.000Z",
            confirmedAt: null,
            reconcilePolicy: "replace-target",
            failurePolicy: "rollback",
          },
          patch: { kind: "update-entry", patch: { machineCode: "MB50" } },
        },
      })
    ).toBe(false);
  });
});

describe("hasPendingEntryFieldSettlement", () => {
  it("terminal task 在確認前仍阻擋同工令編輯，即使 durable intent 缺失", () => {
    expect(
      hasPendingEntryFieldSettlement(
        {
          taskId: "task-main-machine",
          entryFieldOperation: "work-report-main-machine",
        },
        () => ({ taskId: "task-main-machine" }) as RetryableEntryFieldMutation
      )
    ).toBe(true);
    expect(
      hasPendingEntryFieldSettlement(
        {
          taskId: "task-main-machine",
          entryFieldOperation: "work-report-main-machine",
        },
        () => null
      )
    ).toBe(true);
  });

  it("superseded terminal retry 只保留 history，不阻擋同工令新編輯", () => {
    expect(
      hasPendingEntryFieldSettlement(
        {
          taskId: "task-main-machine",
          entryFieldOperation: "work-report-main-machine",
          entryFieldSettlementOutcome: "superseded",
        },
        () => ({ taskId: "task-main-machine" }) as RetryableEntryFieldMutation
      )
    ).toBe(false);
    expect(
      hasPendingEntryFieldSettlement(
        {
          taskId: "task-main-machine",
          entryFieldOperation: "work-report-main-machine",
        },
        () =>
          ({
            taskId: "task-main-machine",
            settlementOutcome: "superseded",
          }) as RetryableEntryFieldMutation
      )
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import type { CreateTaskMonitor } from "../../types";
import { resolveTerminalMutationTask } from "./useWorkReportDetailStatusController";

const t = (key: string, options?: Record<string, unknown>): string => {
  if (key === "workReport:messages.detailCreatedWithRow") {
    return `created ${String(options?.rowId ?? "")}`;
  }
  if (key === "workReport:messages.detailUpdatedWithRow") {
    return `updated ${String(options?.rowId ?? "")}`;
  }
  if (key === "workReport:messages.batchDeleteCompleted") {
    return "batch delete completed";
  }
  if (key === "workReport:messages.detailDeletedQueuedCompleted") {
    return "delete completed";
  }
  return key;
};

function createTaskMonitor(overrides: Partial<CreateTaskMonitor>): CreateTaskMonitor {
  return {
    taskId: "task-1",
    kind: "create",
    formId: "104",
    entryId: "17382",
    workOrderNo: "WO-25040537",
    status: "success",
    message: "done",
    updatedAt: "2026-07-07T00:00:00.000Z",
    ...overrides,
  };
}

describe("resolveTerminalMutationTask", () => {
  it("treats delete success as a force refresh, not a row update", () => {
    const result = resolveTerminalMutationTask(
      createTaskMonitor({
        kind: "delete",
        rowId: "122298",
        message: "刪除報工完成",
      }),
      t
    );

    expect(result.notice).toEqual({
      type: "success",
      message: "刪除報工完成",
    });
    expect(result.highlightRowId).toBeUndefined();
    expect(result.releaseRowId).toBeUndefined();
    expect(result.loadEntryOptions).toEqual({
      mode: "refreshing",
      forceRefresh: true,
    });
  });

  it("treats delete-batch success as a batch delete refresh, not a row update", () => {
    const result = resolveTerminalMutationTask(
      createTaskMonitor({
        kind: "delete-batch",
        rowId: undefined,
        message: "批次刪除完成（5/5）",
      }),
      t
    );

    expect(result.notice).toEqual({
      type: "success",
      message: "批次刪除完成（5/5）",
    });
    expect(result.highlightRowId).toBeUndefined();
    expect(result.releaseRowId).toBeUndefined();
    expect(result.loadEntryOptions).toEqual({
      mode: "refreshing",
      forceRefresh: true,
    });
  });

  it("keeps update success on row highlight and background refresh", () => {
    const result = resolveTerminalMutationTask(
      createTaskMonitor({
        kind: "update",
        rowId: "122298",
        message: "updated",
      }),
      t
    );

    expect(result.notice).toEqual({
      type: "success",
      message: "updated 122298",
    });
    expect(result.highlightRowId).toBe("122298");
    expect(result.releaseRowId).toBe("122298");
    expect(result.loadEntryOptions).toEqual({
      mode: "background",
      forceRefresh: false,
    });
  });
});

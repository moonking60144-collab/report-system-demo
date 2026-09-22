import { describe, expect, it } from "vitest";
import type { CreateTaskMonitor } from "../../types";
import {
  isDetailTerminalTaskReady,
  resolveDetailTerminalTaskConsumption,
  resolveTerminalMutationTask,
} from "./useWorkReportDetailStatusController";

const t = (key: string, options?: Record<string, unknown>): string => {
  if (key === "workReport:messages.detailCreatedWithRow") {
    return `created ${String(options?.rowId ?? "")}`;
  }
  if (key === "workReport:messages.detailUpdatedWithRow") {
    return `updated ${String(options?.rowId ?? "")}`;
  }
  if (key === "workReport:messages.taskBackgroundUpdateCompleted") {
    return "entry updated";
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
    formId: "901",
    entryId: "90002",
    workOrderNo: "DEMO-040537",
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

  it("force refreshes a failed single delete when the row was already deleted", () => {
    const result = resolveTerminalMutationTask(
      createTaskMonitor({
        kind: "delete",
        status: "failed",
        rowId: "122298",
        deletedCount: 1,
        deleteFinalizeFailed: true,
        message: "報工已刪除，但工令回算或資料同步收尾失敗",
      }),
      t
    );

    expect(result.notice).toEqual({
      type: "error",
      message: "報工已刪除，但工令回算或資料同步收尾失敗",
    });
    expect(result.loadEntryOptions).toEqual({
      mode: "refreshing",
      forceRefresh: true,
    });
  });

  it("force refreshes a partially completed batch delete", () => {
    const result = resolveTerminalMutationTask(
      createTaskMonitor({
        kind: "delete-batch",
        status: "failed",
        deletedCount: 2,
        message: "批次刪除部分失敗（成功 2 / 3，失敗 1）",
      }),
      t
    );

    expect(result.notice).toEqual({
      type: "error",
      message: "批次刪除部分失敗（成功 2 / 3，失敗 1）",
    });
    expect(result.loadEntryOptions).toEqual({
      mode: "refreshing",
      forceRefresh: true,
    });
  });

  it("background refreshes a failed delete after optimistic rollback", () => {
    const result = resolveTerminalMutationTask(
      createTaskMonitor({
        kind: "delete",
        status: "failed",
        deletedCount: 0,
        message: "刪除報工失敗",
      }),
      t
    );

    expect(result.notice).toEqual({
      type: "error",
      message: "刪除報工失敗",
    });
    expect(result.loadEntryOptions).toEqual({
      mode: "background",
      forceRefresh: true,
    });
  });

  it("task-not-found 的非終態 monitor 也要求權威 refresh", () => {
    const result = resolveTerminalMutationTask(
      createTaskMonitor({
        status: "running",
        lifecycleState: "unknown",
        stale: true,
        message: "任務狀態待查證",
      }),
      t
    );

    expect(result.notice).toEqual({
      type: "error",
      message: "任務狀態待查證",
    });
    expect(result.loadEntryOptions).toEqual({
      mode: "background",
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

  it("treats an update without rowId as an entry-level refresh", () => {
    const result = resolveTerminalMutationTask(
      createTaskMonitor({
        kind: "update",
        rowId: undefined,
        message: "",
      }),
      t
    );

    expect(result.notice).toEqual({
      type: "success",
      message: "entry updated",
    });
    expect(result.highlightRowId).toBeUndefined();
    expect(result.releaseRowId).toBeUndefined();
    expect(result.loadEntryOptions).toEqual({
      mode: "background",
      forceRefresh: false,
    });
  });

  it("entry-field authority 已被較新資料取代時顯示 conflict 而非成功", () => {
    const result = resolveTerminalMutationTask(
      createTaskMonitor({
        kind: "update",
        rowId: undefined,
        status: "failed",
        lifecycleState: "conflict",
        entryFieldSettlementOutcome: "superseded",
        message: "更新已被較新資料取代，已顯示目前權威值。",
      }),
      t
    );

    expect(result.notice).toEqual({
      type: "error",
      message: "更新已被較新資料取代，已顯示目前權威值。",
    });
    expect(result.loadEntryOptions).toEqual({
      mode: "background",
      forceRefresh: true,
    });
  });
});

describe("Detail entry-field terminal consumption", () => {
  const authoritativeRecord = {
    id: "90002",
    workOrderNo: "DEMO-040537",
    status: "未結案",
    customerPartNo: null,
    erpPartNo: null,
    machineCode: "MB50",
    reportsLoaded: true,
  };

  it("舊的 summary settlement 不得阻止明細重新載入", () => {
    const task = createTaskMonitor({ kind: "update", entryFieldOperation: "work-report-sort-order",
      entryFieldSettlementOutcome: "settled",
      entryFieldSettlementRecord: { ...authoritativeRecord, reports: [], reportsLoaded: false },
    });
    const resolution = resolveDetailTerminalTaskConsumption(task, t);
    expect(resolution.authoritativeRecord).toBeUndefined();
    expect(resolution.loadEntryOptions?.forceRefresh).toBe(true);
  });

  it("settlement record 即使保留 retry history 仍要進入同一個 terminal transition", () => {
    const task = createTaskMonitor({
      kind: "update",
      entryFieldSettlementOutcome: "superseded",
      entryFieldSettlementRecord: authoritativeRecord,
      status: "failed",
      lifecycleState: "conflict",
      message: "更新已被較新資料取代，已顯示目前權威值。",
    });

    expect(isDetailTerminalTaskReady(task)).toBe(true);
    expect(resolveDetailTerminalTaskConsumption(task, t)).toEqual({
      authoritativeRecord,
      notice: {
        type: "error",
        message: "更新已被較新資料取代，已顯示目前權威值。",
      },
      highlightRowId: undefined,
      releaseRowId: undefined,
      loadEntryOptions: undefined,
    });
  });

  it("尚未 settlement 且 retry 仍存在的 terminal task 交由 provider，不提前處理", () => {
    expect(
      isDetailTerminalTaskReady(
        createTaskMonitor({ kind: "update", entryFieldOperation: "work-report-main-machine" })
      )
    ).toBe(false);
  });

  it("bind-loss terminal 即使 taskId 查不到 retry，也要等 provider settlement", () => {
    expect(
      isDetailTerminalTaskReady(
        createTaskMonitor({
          kind: "update",
          entryFieldOperation: "work-report-sort-order",
          entryFieldClientMutationId: "mutation-bind-loss",
        })
      )
    ).toBe(false);
  });

  it("reload 後 settlement record 被移除時，settled marker 仍可完成 Detail transition", () => {
    expect(
      isDetailTerminalTaskReady(
        createTaskMonitor({
          kind: "update",
          entryFieldOperation: "work-report-sort-order",
          entryFieldSettlementOutcome: "superseded",
          entryFieldSettlementRecord: undefined,
        })
      )
    ).toBe(true);
  });
});

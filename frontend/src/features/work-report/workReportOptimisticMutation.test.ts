import { describe, expect, it } from "vitest";
import type { ReportMutationPayload, WorkReportRecord } from "../../api/workReport";
import {
  applyWorkReportOptimisticMutations,
  createWorkReportOptimisticMutation,
  isStoredWorkReportOptimisticMutation,
  reconcileWorkReportOptimisticMutation,
} from "./workReportOptimisticMutation";

const basePayload: ReportMutationPayload = {
  date: "2026/08/12",
  processCode: "P1",
  machineId: "W23",
  operatorId: "A001",
  startTime: "08:00",
  endTime: "09:00",
  productionQty: 100,
};

function createRecord(): WorkReportRecord {
  return {
    id: "entry-1",
    workOrderNo: "WO-1",
    customerPartNo: "PART-1",
    erpPartNo: "ERP-1",
    status: "未結案",
    machineCode: "W22",
    reportsLoaded: true,
    reports: [
      {
        rowId: "row-1",
        date: "2026/08/11",
        plannedIdle: null,
        processCode: "OLD",
        processCodeDisplay: "OLD",
        machineId: "W22",
        machineIdDisplay: "W22",
        operatorId: "A000",
        operatorIdDisplay: "A000",
        operatorName: null,
        inputOptions: null,
        shiftType: null,
        startTime: "07:00",
        endTime: "08:00",
        breakTime: null,
        totalWorkTime: 1,
        productionQty: 10,
      },
    ],
  };
}

function createMutation(input: {
  operation: "work-report-create" | "work-report-update" | "work-report-delete" | "work-report-main-machine";
  patch: Parameters<typeof createWorkReportOptimisticMutation>[0]["patch"];
  previousSnapshot: unknown;
}) {
  return createWorkReportOptimisticMutation({
    taskId: `task-${input.operation}`,
    mutationId: `mutation-${input.operation}`,
    operation: input.operation,
    target: {
      domain: "work-report",
      formId: "104",
      entryId: "entry-1",
    },
    acceptedAt: "2026-08-12T07:00:00.000Z",
    reconcilePolicy: "refresh-entry",
    failurePolicy: "rollback",
    previousSnapshot: input.previousSnapshot,
    patch: input.patch,
  });
}

describe("workReportOptimisticMutation", () => {
  it("新增 accepted 時顯示 temporary row，success 後改用真正 rowId 且不重複", () => {
    const mutation = createMutation({
      operation: "work-report-create",
      previousSnapshot: null,
      patch: {
        kind: "create-rows",
        rows: [{ clientRowKey: "client-row-1", payload: basePayload }],
      },
    });
    const accepted = applyWorkReportOptimisticMutations(createRecord(), [
      { taskId: mutation.lifecycle.taskId, optimisticMutation: mutation },
    ]);
    expect(accepted?.reports?.map((row) => row.rowId)).toEqual([
      "row-1",
      "__optimistic__:client-row-1",
    ]);

    const confirmed = reconcileWorkReportOptimisticMutation(mutation, {
      lifecycleState: "success",
      confirmedAt: "2026-08-12T07:00:02.000Z",
    });
    const authoritative = createRecord();
    authoritative.reports?.push({
      ...(accepted?.reports?.[1] ?? authoritative.reports![0]),
      rowId: "row-2",
    });
    const reconciled = applyWorkReportOptimisticMutations(authoritative, [
      {
        taskId: confirmed.lifecycle.taskId,
        lifecycleState: "success",
        rowId: "row-2",
        optimisticMutation: confirmed,
      },
    ]);
    expect(reconciled?.reports?.map((row) => row.rowId)).toEqual(["row-1", "row-2"]);
  });

  it("更新 accepted 立即 patch，確定失敗後 rollback 到 authoritative row", () => {
    const mutation = createMutation({
      operation: "work-report-update",
      previousSnapshot: createRecord().reports?.[0],
      patch: { kind: "update-row", rowId: "row-1", payload: basePayload },
    });
    const accepted = applyWorkReportOptimisticMutations(createRecord(), [
      { taskId: mutation.lifecycle.taskId, optimisticMutation: mutation },
    ]);
    expect(accepted?.reports?.[0].machineId).toBe("W23");

    const rolledBack = reconcileWorkReportOptimisticMutation(mutation, {
      lifecycleState: "conflict",
    });
    const failed = applyWorkReportOptimisticMutations(createRecord(), [
      { taskId: rolledBack.lifecycle.taskId, optimisticMutation: rolledBack },
    ]);
    expect(failed?.reports?.[0].machineId).toBe("W22");
  });

  it("刪除 indeterminate 會 freeze optimistic remove，確定失敗才恢復", () => {
    const mutation = createMutation({
      operation: "work-report-delete",
      previousSnapshot: createRecord().reports,
      patch: { kind: "delete-rows", rowIds: ["row-1"] },
    });
    const frozen = reconcileWorkReportOptimisticMutation(mutation, {
      lifecycleState: "indeterminate",
    });
    expect(
      applyWorkReportOptimisticMutations(createRecord(), [
        { taskId: frozen.lifecycle.taskId, optimisticMutation: frozen },
      ])?.reports
    ).toEqual([]);

    const rolledBack = reconcileWorkReportOptimisticMutation(mutation, {
      lifecycleState: "failed",
    });
    expect(
      applyWorkReportOptimisticMutations(createRecord(), [
        { taskId: rolledBack.lifecycle.taskId, optimisticMutation: rolledBack },
      ])?.reports?.[0].rowId
    ).toBe("row-1");
  });

  it("主表 patch 與 detail row patch 使用同一 task observation 套用", () => {
    const mutation = createMutation({
      operation: "work-report-main-machine",
      previousSnapshot: { machineCode: "W22" },
      patch: { kind: "update-entry", patch: { machineCode: "W23" } },
    });
    expect(
      applyWorkReportOptimisticMutations(createRecord(), [
        { taskId: mutation.lifecycle.taskId, optimisticMutation: mutation },
      ])?.machineCode
    ).toBe("W23");
  });

  it("localStorage 的 row collection 格式錯誤時回傳 false 而不丟例外", () => {
    const lifecycle = createMutation({
      operation: "work-report-delete",
      patch: { kind: "delete-rows", rowIds: ["row-1"] },
      previousSnapshot: null,
    }).lifecycle;

    expect(
      isStoredWorkReportOptimisticMutation({
        lifecycle,
        patch: { kind: "delete-rows", rowIds: null },
      })
    ).toBe(false);
    expect(
      isStoredWorkReportOptimisticMutation({
        lifecycle,
        patch: { kind: "create-rows", rows: {} },
      })
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import type { WorkReportRecord } from "../../../../api/workReport";
import {
  buildEntryFieldMutationBlockedEntryIds,
  buildEntryFieldMutationSyncingEntryIdsByOperation,
  findEntryFieldMutationAuthoritativeRecord,
  selectEntryFieldMutationAuthoritativeRecords,
  shouldDisplayEntryFieldOptimisticState,
  shouldDisplayStoredEntryFieldPendingPatch,
} from "./useWorkReportListMutationTaskController";
import {
  authoritativeEntryFieldMutationMatches,
  previousEntryFieldMutationMatches,
  type RetryableEntryFieldMutation,
} from "../../entryFieldTaskRetryStore";
import { shouldReplayEntryFieldMutationPatch } from "../../entryFieldMutationSettlement";

describe("shouldDisplayEntryFieldOptimisticState", () => {
  it("accepted／confirmed 可顯示 optimistic patch，frozen 不覆蓋 authoritative record", () => {
    expect(shouldDisplayEntryFieldOptimisticState(undefined)).toBe(true);
    expect(shouldDisplayEntryFieldOptimisticState("applied")).toBe(true);
    expect(shouldDisplayEntryFieldOptimisticState("confirmed")).toBe(true);
    expect(shouldDisplayEntryFieldOptimisticState("frozen")).toBe(false);
    expect(shouldDisplayEntryFieldOptimisticState("rolled-back")).toBe(false);
  });

  it("task monitor 的 frozen 狀態優先於 retry store 內仍為 applied 的舊 lifecycle", () => {
    expect(shouldDisplayStoredEntryFieldPendingPatch("frozen", "applied")).toBe(false);
    expect(shouldDisplayStoredEntryFieldPendingPatch(undefined, "applied")).toBe(true);
  });
});

describe("buildEntryFieldMutationSyncingEntryIdsByOperation", () => {
  it("urgent pending 只標示急件欄，terminal 刪除後下一個 revision 立即清除", () => {
    const retryMutation = {
      operation: "work-report-urgent",
      formId: "901",
      entryId: "E-URGENT",
      taskId: "task-urgent",
    } as RetryableEntryFieldMutation;

    const pending = buildEntryFieldMutationSyncingEntryIdsByOperation({
      currentFormId: "901",
      localSyncingEntryKeysByOperation: new Map(),
      retryMutations: [retryMutation],
    });

    expect(pending.get("work-report-urgent")?.has("E-URGENT")).toBe(true);
    expect(pending.get("work-report-main-machine")?.has("E-URGENT") ?? false).toBe(false);
    expect(pending.get("work-report-sort-order")?.has("E-URGENT") ?? false).toBe(false);
    expect(pending.get("work-report-planned-end-date")?.has("E-URGENT") ?? false).toBe(false);
    expect(pending.get("work-report-start-schedule")?.has("E-URGENT") ?? false).toBe(false);
    expect(buildEntryFieldMutationBlockedEntryIds(pending).has("E-URGENT")).toBe(true);

    const settled = buildEntryFieldMutationSyncingEntryIdsByOperation({
      currentFormId: "901",
      localSyncingEntryKeysByOperation: new Map(),
      retryMutations: [retryMutation],
      taskMonitors: [
        {
          taskId: "task-urgent",
          formId: "901",
          entryId: "E-URGENT",
          entryFieldOperation: "work-report-urgent",
          entryFieldSettlementOutcome: "superseded",
        },
      ],
    });
    expect(settled.get("work-report-urgent")?.has("E-URGENT") ?? false).toBe(false);
    expect(buildEntryFieldMutationBlockedEntryIds(settled).has("E-URGENT")).toBe(false);

    const restoredSettled = buildEntryFieldMutationSyncingEntryIdsByOperation({
      currentFormId: "901",
      localSyncingEntryKeysByOperation: new Map(),
      retryMutations: [{ ...retryMutation, settlementOutcome: "superseded" }],
    });
    expect(restoredSettled.get("work-report-urgent")?.has("E-URGENT") ?? false).toBe(false);
    expect(buildEntryFieldMutationBlockedEntryIds(restoredSettled).has("E-URGENT")).toBe(false);
  });

  it("retry bind 遺失時仍以 unsettled task monitor 鎖定正確 operation", () => {
    const syncing = buildEntryFieldMutationSyncingEntryIdsByOperation({
      currentFormId: "901",
      localSyncingEntryKeysByOperation: new Map(),
      retryMutations: [],
      taskMonitors: [
        {
          taskId: "task-without-bound-retry",
          formId: "901",
          entryId: "E-901",
          entryFieldOperation: "work-report-sort-order",
        },
      ],
    });

    expect(syncing.get("work-report-sort-order")?.has("E-901")).toBe(true);
    expect(syncing.get("work-report-urgent")?.has("E-901") ?? false).toBe(false);
    expect(buildEntryFieldMutationBlockedEntryIds(syncing).has("E-901")).toBe(true);
  });
});

describe("findEntryFieldMutationAuthoritativeRecord", () => {
  it("full hydration authority 已是第三值時不得被 preview pending patch 改寫", () => {
    const mutation = {
      operation: "work-report-sort-order",
      formId: "901",
      entryId: "E-901",
      value: 11,
      previousValue: 9,
      hasPreviousValue: true,
      expectedEntryLastUpdatedAt: "2026/09/01 05:15:37",
    } as RetryableEntryFieldMutation;
    const previewRecord = {
      id: "E-901",
      workOrderNo: "WO-901",
      status: "未結案",
      customerPartNo: null,
      erpPartNo: null,
      sortOrder: 11,
      lastUpdatedAt: mutation.expectedEntryLastUpdatedAt,
    } satisfies WorkReportRecord;
    const fullRecord = {
      ...previewRecord,
      sortOrder: 12,
    };
    const authority = findEntryFieldMutationAuthoritativeRecord(
      "E-901",
      [fullRecord],
      [previewRecord]
    );

    expect(authority).toBe(fullRecord);
    expect(
      shouldReplayEntryFieldMutationPatch(
        mutation.expectedEntryLastUpdatedAt,
        mutation,
        authority,
        {
          status: "pending",
          lifecycleState: "accepted",
        }
      )
    ).toBe(false);
  });

  it("新 full hydration 尚未完成時使用 preview，不使用前一輪 allRecords", () => {
    const previewRecord = {
      id: "E-901",
      workOrderNo: "WO-901",
      status: "未結案",
      customerPartNo: null,
      erpPartNo: null,
      sortOrder: 12,
    } satisfies WorkReportRecord;
    const staleFullRecord = {
      ...previewRecord,
      sortOrder: 9,
    };

    expect(
      selectEntryFieldMutationAuthoritativeRecords({
        previewRecords: [previewRecord],
        allRecords: [staleFullRecord],
        hasHydratedAllRecords: false,
      })
    ).toEqual([previewRecord]);
    expect(
      selectEntryFieldMutationAuthoritativeRecords({
        previewRecords: [previewRecord],
        allRecords: [staleFullRecord],
        hasHydratedAllRecords: true,
      })
    ).toEqual([staleFullRecord]);
  });
});

describe("authoritativeEntryFieldMutationMatches", () => {
  it("依各欄位 canonical 值判定 strict refresh 是否已觀察到 mutation", () => {
    const record = {
      id: "E-901",
      workOrderNo: "WO-901",
      status: "未結案",
      customerPartNo: null,
      erpPartNo: null,
      sortOrder: "11",
      plannedEndDate: "2026/09/05",
      startSchedule: "Yes",
      urgent: "",
      machineCode: "MA51",
      filterMachineCode: "W3",
    } as WorkReportRecord;

    expect(
      authoritativeEntryFieldMutationMatches(
        record,
        {
          operation: "work-report-sort-order",
          value: 11,
        } as RetryableEntryFieldMutation
      )
    ).toBe(true);
    expect(
      authoritativeEntryFieldMutationMatches(
        record,
        {
          operation: "work-report-start-schedule",
          value: true,
          formId: "901",
        } as RetryableEntryFieldMutation
      )
    ).toBe(true);
    expect(
      authoritativeEntryFieldMutationMatches(
        record,
        {
          operation: "work-report-urgent",
          value: false,
          formId: "901",
        } as RetryableEntryFieldMutation
      )
    ).toBe(true);
    expect(
      authoritativeEntryFieldMutationMatches(
        record,
        {
          operation: "work-report-main-machine",
          value: "MA51",
          formId: "901",
        } as RetryableEntryFieldMutation
      )
    ).toBe(true);
    expect(
      authoritativeEntryFieldMutationMatches(
        record,
        {
          operation: "work-report-main-machine",
          value: "W3",
          formId: "902",
        } as RetryableEntryFieldMutation
      )
    ).toBe(true);
    expect(
      authoritativeEntryFieldMutationMatches(
        record,
        {
          operation: "work-report-planned-end-date",
          value: "2026-09-05",
        } as RetryableEntryFieldMutation
      )
    ).toBe(true);
    expect(
      authoritativeEntryFieldMutationMatches(
        record,
        {
          operation: "work-report-sort-order",
          value: 99,
        } as RetryableEntryFieldMutation
      )
    ).toBe(false);
    expect(
      previousEntryFieldMutationMatches(
        { ...record, sortOrder: null },
        {
          operation: "work-report-sort-order",
          value: 11,
          previousValue: null,
          hasPreviousValue: true,
        } as RetryableEntryFieldMutation
      )
    ).toBe(true);
    expect(
      previousEntryFieldMutationMatches(
        { ...record, urgent: "No" },
        {
          operation: "work-report-urgent",
          value: true,
          previousValue: false,
          hasPreviousValue: true,
          formId: "901",
        } as RetryableEntryFieldMutation
      )
    ).toBe(true);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { WorkReportRecord } from "../../api/workReport";
import type { RetryableEntryFieldMutation } from "./entryFieldTaskRetryStore";
import {
  entryFieldConfirmationMessage,
  isEntryFieldConfirmationPending,
  isEntryFieldMutationConfirmationReusable,
  orderEntryFieldSettlementTasksForConsumption,
  settleEntryFieldMutationWithAuthority,
  shouldReplayEntryFieldOptimisticTask,
  shouldReplayEntryFieldMutationPatch,
  shouldSettleEntryFieldMutationTask,
} from "./entryFieldMutationSettlement";
import type { CreateTaskMonitor } from "./types";
import { WorkReportEntrySettlementRevisionBarrier } from "./entrySettlementRevisionBarrier";
import { resolveDetailTerminalTaskConsumption } from "./hooks/detail/useWorkReportDetailStatusController";
import { normalizeRecord } from "./utils/recordUtils";

function createMonitor(overrides: Partial<CreateTaskMonitor> = {}): CreateTaskMonitor {
  return {
    taskId: "task-sort-1",
    kind: "update",
    formId: "901",
    entryId: "E-901",
    workOrderNo: "WO-901",
    status: "success",
    lifecycleState: "success",
    entryFieldOperation: "work-report-sort-order",
    message: "done",
    updatedAt: "2026-08-31T00:00:01.000Z",
    optimisticMutation: {
      lifecycle: {
        version: 1,
        mutationId: "mutation-sort-1",
        taskId: "task-sort-1",
        operation: "work-report-sort-order",
        target: { domain: "work-report", formId: "901", entryId: "E-901" },
        lifecycleState: "success",
        optimisticState: "confirmed",
        acceptedAt: "2026-08-31T00:00:00.000Z",
        confirmedAt: "2026-08-31T00:00:01.000Z",
        reconcilePolicy: "replace-target",
        failurePolicy: "rollback",
        previousSnapshot: { sortOrder: 9 },
      },
      patch: { kind: "update-entry", patch: { sortOrder: 11 } },
    },
    ...overrides,
  };
}

const retryMutation = {
  operation: "work-report-sort-order",
  formId: "901",
  entryId: "E-901",
  value: 11,
} as RetryableEntryFieldMutation;

describe("settleEntryFieldMutationWithAuthority", () => {
  it("列表排序成功後進明細，revision barrier 仍保留實際報工列", async () => {
    const summary = { id: "E-901", workOrderNo: "WO-901", status: "未結案",
      customerPartNo: null, erpPartNo: null, sortOrder: 9, reports: [], reportsLoaded: false,
      lastUpdatedAt: "2026-09-01T00:59:58.000Z" } satisfies WorkReportRecord;
    const full = { ...summary, sortOrder: 11, reportsLoaded: true,
      lastUpdatedAt: "2026-09-01T00:59:59.000Z",
      reports: [{ rowId: "R-1", productionQty: 20 }] as WorkReportRecord["reports"] };
    const monitor = createMonitor({ confirmedEntry: {
      entryId: summary.id, operation: "work-report-sort-order", patch: { sortOrder: 11 },
      observedAt: "2026-09-01T01:00:00.000Z", entryLastUpdatedAt: full.lastUpdatedAt,
    } });
    const settlement = await settleEntryFieldMutationWithAuthority({ monitor, retryMutation,
      currentRecord: summary, fetchEntry: vi.fn().mockResolvedValue(full),
      successMessage: "ok", supersededMessage: "conflict" });
    const barrier = new WorkReportEntrySettlementRevisionBarrier<WorkReportRecord>();
    const revision = barrier.captureRevision();
    const resolution = resolveDetailTerminalTaskConsumption({ ...settlement.monitor,
      entryFieldSettlementOutcome: "settled", entryFieldSettlementRecord: settlement.authoritativeRecord }, key => key);
    barrier.record("901", normalizeRecord(resolution.authoritativeRecord!, true));
    const displayed = barrier.mergeRecord("901", revision, full);
    expect(displayed.reports).toEqual(full.reports);
    expect(displayed.reportsLoaded).toBe(true);
  });
  it("完整且同版本的 matching record 可重用，不再 strict fetch", async () => {
    const currentRecord = {
      id: "E-901",
      workOrderNo: "WO-901",
      status: "未結案",
      customerPartNo: null,
      erpPartNo: null,
      sortOrder: 11,
      reportsLoaded: true,
      lastUpdatedAt: "2026-09-01T00:59:59.000Z",
      reports: [{ rowId: "R-1", date: null, plannedIdle: null, processCode: null, processCodeDisplay: null, machineId: null, machineIdDisplay: null, operatorId: null, operatorIdDisplay: null, operatorName: null, inputOptions: null, shiftType: null, startTime: null, endTime: null, breakTime: null, totalWorkTime: null, productionQty: null }],
    } satisfies WorkReportRecord;
    const fetchEntry = vi.fn();
    const monitor = createMonitor({
      confirmedEntry: {
        entryId: "E-901",
        operation: "work-report-sort-order",
        observedAt: "2026-09-01T01:00:00.000Z",
        entryLastUpdatedAt: "2026-09-01T00:59:59.000Z",
        patch: { sortOrder: 11 },
      },
    });

    const settlement = await settleEntryFieldMutationWithAuthority({
      monitor,
      retryMutation,
      currentRecord,
      fetchEntry,
      successMessage: "排序碼已更新。",
      supersededMessage: "更新已被較新資料取代。",
    });

    expect(fetchEntry).not.toHaveBeenCalled();
    expect(settlement.authoritativeRecord).toMatchObject({
      id: "E-901",
      workOrderNo: "WO-901",
      sortOrder: 11,
      lastUpdatedAt: "2026-09-01T00:59:59.000Z",
    });
    expect(settlement.authoritativeRecord.reports).toBe(currentRecord.reports);
    expect(settlement.monitor).toMatchObject({
      authoritativeRefreshMs: 0,
      updatedAt: "2026-09-01T01:00:00.000Z",
    });
  });

  it.each([false, true])("不以單欄位確認將舊 record 升級成完整 authority（reportsLoaded=%s）", async (reportsLoaded) => {
    const currentRecord = {
      id: "E-901", workOrderNo: "WO-901", status: "未結案",
      customerPartNo: null, erpPartNo: null, sortOrder: 9, urgent: "No",
      reports: [], reportsLoaded, lastUpdatedAt: "2026-09-01T00:59:58.000Z",
    } satisfies WorkReportRecord;
    const fullRecord = { ...currentRecord, sortOrder: 11, urgent: "Yes", reportsLoaded: true,
      lastUpdatedAt: "2026-09-01T00:59:59.000Z" };
    const fetchEntry = vi.fn().mockResolvedValue(fullRecord);
    const settlement = await settleEntryFieldMutationWithAuthority({
      monitor: createMonitor({ confirmedEntry: {
        entryId: "E-901", operation: "work-report-sort-order",
        observedAt: "2026-09-01T01:00:00.000Z",
        entryLastUpdatedAt: fullRecord.lastUpdatedAt, patch: { sortOrder: 11 },
      } }), retryMutation, currentRecord, fetchEntry,
      successMessage: "ok", supersededMessage: "conflict",
    });
    expect(fetchEntry).toHaveBeenCalledWith("901", "E-901", true, { strictRefresh: true });
    expect(settlement.authoritativeRecord).toEqual(fullRecord);
    expect(settlement.authoritativeRecord.urgent).toBe("Yes");
  });

  it("observation identity 或 value 不匹配時保留 strict fetch fallback", async () => {
    const authoritativeRecord = {
      id: "E-901",
      workOrderNo: "WO-901",
      status: "未結案",
      customerPartNo: null,
      erpPartNo: null,
      sortOrder: 11,
    } satisfies WorkReportRecord;
    const fetchEntry = vi.fn().mockResolvedValue(authoritativeRecord);

    await settleEntryFieldMutationWithAuthority({
      monitor: createMonitor({
        confirmedEntry: {
          entryId: "E-other",
          operation: "work-report-sort-order",
          observedAt: "2026-09-01T01:00:00.000Z",
          patch: { sortOrder: 11 },
        },
      }),
      retryMutation,
      currentRecord: { ...authoritativeRecord, sortOrder: 9 },
      fetchEntry,
      successMessage: "排序碼已更新。",
      supersededMessage: "更新已被較新資料取代。",
    });

    expect(fetchEntry).toHaveBeenCalledWith("901", "E-901", true, {
      strictRefresh: true,
    });
  });

  it("task success 後 strict authority 是第三值時標記 conflict", async () => {
    const authoritativeRecord = {
      id: "E-901",
      workOrderNo: "WO-901",
      status: "未結案",
      customerPartNo: null,
      erpPartNo: null,
      sortOrder: 12,
    } satisfies WorkReportRecord;
    const fetchEntry = vi.fn().mockResolvedValue(authoritativeRecord);
    const times = [1_000, 1_125];

    const settlement = await settleEntryFieldMutationWithAuthority({
      monitor: createMonitor(),
      retryMutation,
      fetchEntry,
      successMessage: "排序碼已更新。",
      supersededMessage: "更新已被較新資料取代。",
      nowIso: () => "2026-08-31T00:00:02.000Z",
      nowMs: () => times.shift() ?? 1_125,
    });

    expect(settlement.authoritativeRecord.sortOrder).toBe(12);
    expect(settlement.shouldDeleteRetryMutation).toBe(false);
    expect(settlement.monitor).toMatchObject({
      status: "failed",
      lifecycleState: "conflict",
      entryFieldSettlementOutcome: "superseded",
      optimisticMutation: {
        lifecycle: {
          lifecycleState: "conflict",
          optimisticState: "rolled-back",
        },
      },
      authoritativeRefreshMs: 125,
      message: "更新已被較新資料取代。",
    });
  });

  it("failed／unknown task 觀察到 intended value 時收斂成 success", async () => {
    const fetchEntry = vi.fn().mockResolvedValue({
      id: "E-901",
      workOrderNo: "WO-901",
      status: "未結案",
      customerPartNo: null,
      erpPartNo: null,
      sortOrder: 11,
    } satisfies WorkReportRecord);

    const settlement = await settleEntryFieldMutationWithAuthority({
      monitor: createMonitor({
        status: "failed",
        lifecycleState: "indeterminate",
        confirmedAt: null,
        message: "背景處理失敗：資料衝突",
      }),
      retryMutation,
      fetchEntry,
      successMessage: "排序碼已更新。",
      supersededMessage: "更新已被較新資料取代。",
      nowIso: () => "2026-08-31T00:00:02.000Z",
    });

    expect(settlement.monitor).toMatchObject({
      status: "success",
      lifecycleState: "success",
      confirmedAt: "2026-08-31T00:00:02.000Z",
      optimisticMutation: {
        lifecycle: {
          lifecycleState: "success",
          optimisticState: "confirmed",
        },
      },
      message: "排序碼已更新。",
    });
  });

  it("較舊的 task observation 不得覆蓋較新的 authoritative record", async () => {
    const currentRecord = {
      id: "E-901",
      workOrderNo: "WO-901",
      status: "未結案",
      customerPartNo: null,
      erpPartNo: null,
      urgent: "Yes",
      lastUpdatedAt: "2026/09/01 06:25:15",
    } satisfies WorkReportRecord;
    const authoritativeRecord = { ...currentRecord };
    const fetchEntry = vi.fn().mockResolvedValue(authoritativeRecord);
    const urgentMutation = {
      operation: "work-report-urgent",
      formId: "901",
      entryId: "E-901",
      value: false,
    } as RetryableEntryFieldMutation;

    const settlement = await settleEntryFieldMutationWithAuthority({
      monitor: createMonitor({
        entryFieldOperation: "work-report-urgent",
        confirmedEntry: {
          entryId: "E-901",
          operation: "work-report-urgent",
          observedAt: "2026-09-01T05:15:39.205Z",
          entryLastUpdatedAt: "2026/09/01 05:15:37",
          patch: { urgent: "No" },
        },
      }),
      retryMutation: urgentMutation,
      currentRecord,
      fetchEntry,
      successMessage: "急件狀態已更新。",
      supersededMessage: "更新已被較新資料取代，已顯示目前權威值。",
    });

    expect(fetchEntry).toHaveBeenCalledWith("901", "E-901", true, {
      strictRefresh: true,
    });
    expect(settlement.authoritativeRecord).toEqual({ ...authoritativeRecord, reports: [], reportsLoaded: true });
    expect(settlement.authoritativeRecord.urgent).toBe("Yes");
  });

  it("同秒 task observation 與 current 第三值衝突時必須 strict refresh", async () => {
    const currentRecord = {
      id: "E-901",
      workOrderNo: "WO-901",
      status: "未結案",
      customerPartNo: null,
      erpPartNo: null,
      urgent: "Yes",
      lastUpdatedAt: "2026/09/01 05:15:37",
    } satisfies WorkReportRecord;
    const fetchEntry = vi.fn().mockResolvedValue(currentRecord);
    const urgentMutation = {
      operation: "work-report-urgent",
      formId: "901",
      entryId: "E-901",
      value: false,
    } as RetryableEntryFieldMutation;

    const settlement = await settleEntryFieldMutationWithAuthority({
      monitor: createMonitor({
        entryFieldOperation: "work-report-urgent",
        confirmedEntry: {
          entryId: "E-901",
          operation: "work-report-urgent",
          observedAt: "2026-09-01T05:15:39.205Z",
          entryLastUpdatedAt: currentRecord.lastUpdatedAt,
          patch: { urgent: "No" },
        },
      }),
      retryMutation: urgentMutation,
      currentRecord,
      fetchEntry,
      successMessage: "急件狀態已更新。",
      supersededMessage: "更新已被較新資料取代，已顯示目前權威值。",
    });

    expect(fetchEntry).toHaveBeenCalledWith("901", "E-901", true, {
      strictRefresh: true,
    });
    expect(settlement.authoritativeRecord.urgent).toBe("Yes");
    expect(settlement.shouldDeleteRetryMutation).toBe(false);
    expect(settlement.monitor).toMatchObject({
      status: "failed",
      lifecycleState: "conflict",
      message: "更新已被較新資料取代，已顯示目前權威值。",
    });
  });
});

describe("isEntryFieldMutationConfirmationReusable", () => {
  it("只有 confirmation 版本不早於 current record 時才能重用 optimistic patch", () => {
    const currentRecord = {
      id: "E-901",
      workOrderNo: "WO-901",
      status: "未結案",
      customerPartNo: null,
      erpPartNo: null,
      lastUpdatedAt: "2026/09/01 06:25:15",
    } satisfies WorkReportRecord;
    const confirmedEntry = {
      entryId: "E-901",
      operation: "work-report-urgent" as const,
      observedAt: "2026-09-01T05:15:39.205Z",
      entryLastUpdatedAt: "2026/09/01 05:15:37",
      patch: { urgent: "No" },
    };

    expect(
      isEntryFieldMutationConfirmationReusable(
        confirmedEntry,
        currentRecord,
        { ...retryMutation, operation: "work-report-urgent", value: false }
      )
    ).toBe(false);
    expect(
      isEntryFieldMutationConfirmationReusable(
        { ...confirmedEntry, entryLastUpdatedAt: currentRecord.lastUpdatedAt },
        currentRecord,
        { ...retryMutation, operation: "work-report-urgent", value: false }
      )
    ).toBe(true);
    expect(
      isEntryFieldMutationConfirmationReusable(
        { ...confirmedEntry, entryLastUpdatedAt: currentRecord.lastUpdatedAt },
        { ...currentRecord, urgent: "Yes" },
        { ...retryMutation, operation: "work-report-urgent", value: false }
      )
    ).toBe(false);
    expect(
      isEntryFieldMutationConfirmationReusable(
        { ...confirmedEntry, entryLastUpdatedAt: undefined },
        currentRecord,
        { ...retryMutation, operation: "work-report-urgent", value: false }
      )
    ).toBe(false);
  });

  it("durable pending patch 與 current 同 token 但是第三值時不得重播", () => {
    const mutation = {
      operation: "work-report-urgent",
      formId: "901",
      entryId: "E-901",
      value: false,
    } as RetryableEntryFieldMutation;
    const currentRecord = {
      id: "E-901",
      workOrderNo: "WO-901",
      status: "未結案",
      customerPartNo: null,
      erpPartNo: null,
      urgent: "Yes",
      lastUpdatedAt: "2026/09/01 05:15:37",
    } satisfies WorkReportRecord;

    expect(
      shouldReplayEntryFieldMutationPatch(
        currentRecord.lastUpdatedAt,
        mutation,
        currentRecord
      )
    ).toBe(false);
    expect(
      shouldReplayEntryFieldMutationPatch(
        currentRecord.lastUpdatedAt,
        mutation,
        { ...currentRecord, urgent: "No" }
      )
    ).toBe(true);
  });

  it("pending task reload 看到 previous value 時保留 provisional patch", () => {
    const mutation = {
      operation: "work-report-urgent",
      formId: "901",
      entryId: "E-901",
      value: true,
      previousValue: false,
      hasPreviousValue: true,
      expectedEntryLastUpdatedAt: "2026/09/01 05:15:37",
      lifecycle: {
        version: 1,
        mutationId: "mutation-urgent-1",
        taskId: "task-urgent-1",
        operation: "work-report-urgent",
        target: { domain: "work-report", formId: "901", entryId: "E-901" },
        lifecycleState: "accepted",
        optimisticState: "applied",
        acceptedAt: "2026-09-01T05:15:38.000Z",
        confirmedAt: null,
        reconcilePolicy: "replace-target",
        failurePolicy: "rollback",
        previousSnapshot: { urgent: "No" },
      },
    } as RetryableEntryFieldMutation;
    const currentRecord = {
      id: "E-901",
      workOrderNo: "WO-901",
      status: "未結案",
      customerPartNo: null,
      erpPartNo: null,
      urgent: "No",
      lastUpdatedAt: mutation.expectedEntryLastUpdatedAt,
    } satisfies WorkReportRecord;

    expect(
      shouldReplayEntryFieldMutationPatch(
        mutation.expectedEntryLastUpdatedAt,
        mutation,
        currentRecord,
        createMonitor({
          taskId: "task-urgent-1",
          status: "pending",
          lifecycleState: "accepted",
          entryFieldOperation: "work-report-urgent",
        })
      )
    ).toBe(true);
  });

  it("token 缺失或不可解析且 current 是第三值時 fail closed", () => {
    const mutation = {
      operation: "work-report-sort-order",
      formId: "901",
      entryId: "E-901",
      value: 11,
      previousValue: 9,
      hasPreviousValue: true,
    } as RetryableEntryFieldMutation;
    const currentRecord = {
      id: "E-901",
      workOrderNo: "WO-901",
      status: "未結案",
      customerPartNo: null,
      erpPartNo: null,
      sortOrder: 12,
      lastUpdatedAt: null,
    } satisfies WorkReportRecord;

    expect(
      shouldReplayEntryFieldMutationPatch(undefined, mutation, currentRecord)
    ).toBe(false);
    expect(
      shouldReplayEntryFieldMutationPatch("not-a-date", mutation, {
        ...currentRecord,
        lastUpdatedAt: "also-not-a-date",
      })
    ).toBe(false);
  });
});

describe("shouldReplayEntryFieldOptimisticTask", () => {
  it("Detail terminal overlay 必須用 raw authority 判斷，不得用 derived intended view", () => {
    const mutation = {
      operation: "work-report-urgent",
      formId: "901",
      entryId: "E-901",
      value: false,
      previousValue: true,
      hasPreviousValue: true,
    } as RetryableEntryFieldMutation;
    const monitor = createMonitor({
      entryFieldOperation: "work-report-urgent",
      confirmedEntry: {
        entryId: "E-901",
        operation: "work-report-urgent",
        observedAt: "2026-09-01T05:15:39.205Z",
        entryLastUpdatedAt: "2026/09/01 05:15:37",
        patch: { urgent: "No" },
      },
    });
    const rawAuthority = {
      id: "E-901",
      workOrderNo: "WO-901",
      status: "未結案",
      customerPartNo: null,
      erpPartNo: null,
      urgent: "Yes",
      lastUpdatedAt: "2026/09/01 05:15:37",
    } satisfies WorkReportRecord;

    expect(
      shouldReplayEntryFieldOptimisticTask(
        monitor,
        rawAuthority,
        () => mutation
      )
    ).toBe(false);
    expect(
      shouldReplayEntryFieldOptimisticTask(
        monitor,
        { ...rawAuthority, urgent: "No" },
        () => null
      )
    ).toBe(false);
    expect(
      shouldReplayEntryFieldOptimisticTask(
        monitor,
        { ...rawAuthority, urgent: "No" },
        () => mutation
      )
    ).toBe(true);
  });
});

describe("shouldSettleEntryFieldMutationTask", () => {
  it("找不到工令時保留待確認，但不自動重讀；手動恢復後才可確認", () => {
    const paused = createMonitor({ entryFieldSettlementErrorCode: "REPORT_NOT_FOUND" });
    expect(isEntryFieldConfirmationPending(paused)).toBe(true);
    expect(shouldSettleEntryFieldMutationTask(paused)).toBe(false);
    expect(shouldSettleEntryFieldMutationTask({ ...paused, entryFieldSettlementErrorCode: undefined })).toBe(true);
  });

  it("待確認保留失敗原因，未知結果不呈現為任務未成功", () => {
    const translate = (key: string) => key;
    const failed = createMonitor({ status: "failed", lifecycleState: "failed", message: "original conflict reason" });
    expect(entryFieldConfirmationMessage(failed, translate)).toContain("original conflict reason");
    expect(entryFieldConfirmationMessage(failed, translate)).toContain("entryFieldFailureConfirmationPending");
    const unknown = createMonitor({ status: "running", lifecycleState: "unknown", stale: true, message: "task registry missing" });
    expect(entryFieldConfirmationMessage(unknown, translate)).toContain("task registry missing");
    expect(entryFieldConfirmationMessage(unknown, translate)).toContain("entryFieldUnknownConfirmationPending");
    expect(entryFieldConfirmationMessage(unknown, translate)).not.toContain("entryFieldFailureConfirmationPending");
  });

  it("只有 terminal 或不可再 poll 的 stale task 會進低頻 authoritative settlement", () => {
    expect(shouldSettleEntryFieldMutationTask(createMonitor())).toBe(true);
    expect(
      shouldSettleEntryFieldMutationTask(
        createMonitor({ status: "running", stale: true, retryableStale: false })
      )
    ).toBe(true);
    expect(
      shouldSettleEntryFieldMutationTask(
        createMonitor({ status: "running", stale: true, retryableStale: true })
      )
    ).toBe(false);
    expect(
      shouldSettleEntryFieldMutationTask(
        createMonitor({
          status: "failed",
          lifecycleState: "conflict",
          entryFieldSettlementOutcome: "superseded",
        })
      )
    ).toBe(false);
    expect(
      shouldSettleEntryFieldMutationTask(
        createMonitor({ entryFieldSettlementOutcome: "settled" })
      )
    ).toBe(false);
  });
});

describe("orderEntryFieldSettlementTasksForConsumption", () => {
  it("同一 entry remount 時由舊到新套用 settlement，最後保留最新 authority", () => {
    const older = createMonitor({
      taskId: "task-older",
      acceptedAt: "2026-09-02T01:00:00.000Z",
      confirmedAt: "2026-09-02T01:00:01.000Z",
      updatedAt: "2026-09-02T01:00:01.000Z",
      entryFieldSettlementRecord: {
        id: "E-901",
        workOrderNo: "WO-901",
        status: "未結案",
        customerPartNo: null,
        erpPartNo: null,
        sortOrder: 10,
        lastUpdatedAt: "2026/09/02 09:00:01",
      },
    });
    const newer = createMonitor({
      taskId: "task-newer",
      acceptedAt: "2026-09-02T01:00:02.000Z",
      confirmedAt: "2026-09-02T01:00:03.000Z",
      updatedAt: "2026-09-02T01:00:03.000Z",
      entryFieldSettlementRecord: {
        id: "E-901",
        workOrderNo: "WO-901",
        status: "未結案",
        customerPartNo: null,
        erpPartNo: null,
        sortOrder: 11,
        lastUpdatedAt: "2026/09/02 09:00:03",
      },
    });

    const finalRecord = orderEntryFieldSettlementTasksForConsumption([
      newer,
      older,
    ]).reduce<WorkReportRecord | null>(
      (current, task) => task.entryFieldSettlementRecord ?? current,
      null
    );

    expect(finalRecord?.sortOrder).toBe(11);
  });
});

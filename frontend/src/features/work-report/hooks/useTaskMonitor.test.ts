import { AxiosError } from "axios";
import { describe, expect, it, vi } from "vitest";
import type {
  CreateReportTaskResult,
  WorkReportQueueTask,
  WorkReportRecord,
} from "../../../api/workReport";
import { CREATE_TASK_AUTO_CLEAR_MS, CREATE_TASK_STALE_AUTO_CLEAR_MS } from "../constants";
import type { CreateTaskMonitor } from "../types";
import {
  clearFinishedTaskMonitorsAndEvidence,
  hasAutoClearableTaskMonitors,
  hasTerminalTaskMonitors,
  isTaskMonitorClearable,
  limitTaskMonitorHistory,
  mergeRetryableEntryFieldTaskMonitors,
  pollCreateTaskMonitor,
  persistTaskMonitorEntryFieldLifecycle,
  persistTaskMonitorEntryFieldLifecycles,
  pruneExpiredTaskMonitors,
  resolveTaskMonitorEntryFieldOperation,
  resolveTaskMonitorResult,
  settleTerminalEntryFieldTask,
} from "./useTaskMonitor";
import { createWorkReportOptimisticMutation } from "../workReportOptimisticMutation";
import type { RetryableEntryFieldMutation } from "../entryFieldTaskRetryStore";
import { shouldSettleEntryFieldMutationTask } from "../entryFieldMutationSettlement";
import { createEntryFieldSettlementReader } from "../entryFieldSettlementRetry";
import { resolveDetailTerminalTaskConsumption } from "./detail/useWorkReportDetailStatusController";

function createMonitor(
  overrides: Partial<CreateTaskMonitor> & Pick<CreateTaskMonitor, "taskId" | "status" | "updatedAt">
): CreateTaskMonitor {
  return {
    taskId: overrides.taskId,
    formId: overrides.formId ?? "901",
    entryId: overrides.entryId ?? "90002",
    workOrderNo: overrides.workOrderNo ?? "DEMO-040537",
    status: overrides.status,
    message: overrides.message ?? "task message",
    updatedAt: overrides.updatedAt,
    kind: overrides.kind ?? "create",
    rowId: overrides.rowId,
    stale: overrides.stale,
    retryableStale: overrides.retryableStale,
    entryFieldOperation: overrides.entryFieldOperation,
    lifecycleState: overrides.lifecycleState,
    acceptedAt: overrides.acceptedAt,
    confirmedAt: overrides.confirmedAt,
    confirmedEntry: overrides.confirmedEntry,
    batchCreatedRowIds: overrides.batchCreatedRowIds,
    optimisticMutation: overrides.optimisticMutation,
    entryFieldClientMutationId: overrides.entryFieldClientMutationId,
    entryFieldSettlementOutcome: overrides.entryFieldSettlementOutcome,
    entryFieldSettlementRecord: overrides.entryFieldSettlementRecord,
  };
}

function createTaskResult(
  patch: Partial<CreateReportTaskResult> = {}
): CreateReportTaskResult {
  return {
    taskId: "task-1",
    taskType: "create-report",
    formId: "901",
    entryId: "90002",
    queueKey: "901:90002",
    status: "running",
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:01.000Z",
    ...patch,
  };
}

function createTaskNotFoundError(): AxiosError {
  return new AxiosError(
    "task not found",
    undefined,
    undefined,
    undefined,
    {
      data: { error: { code: "TASK_NOT_FOUND", message: "找不到任務" } },
      status: 404,
      statusText: "Not Found",
      headers: {},
      config: {} as never,
    }
  );
}

function createSortRetryMutation(
  patch: Partial<RetryableEntryFieldMutation> = {}
): RetryableEntryFieldMutation {
  return {
    operation: "work-report-sort-order",
    clientMutationId: "mutation-sort-1",
    taskId: "task-sort-1",
    formId: "901",
    entryId: "E-901",
    value: 11,
    previousValue: 9,
    hasPreviousValue: true,
    workOrderNo: "WO-901",
    actorClientId: "client-1",
    createdAt: "2026-08-31T00:00:00.000Z",
    pendingPatch: { sortOrder: 11 },
    successPatch: { sortOrder: 11 },
    rollbackPatch: { sortOrder: 9 },
    ...patch,
  };
}

describe("shared authority response", () => {
  it("legacy superseded evidence restores as terminal conflict even without a lifecycle", () => {
    const restored = mergeRetryableEntryFieldTaskMonitors([], [createSortRetryMutation({ settlementOutcome: "superseded" })], key => key);
    expect(restored[0]).toMatchObject({ status: "failed", lifecycleState: "conflict", entryFieldSettlementOutcome: "superseded" });
    expect(shouldSettleEntryFieldMutationTask(restored[0])).toBe(false);
    expect(isTaskMonitorClearable(restored[0])).toBe(true);
  });

  it("history cap never drops running, paused or unresolved tasks at restore and merge", () => {
    const pending = Array.from({ length: 50 }, (_, i) => createMonitor({
      taskId: `pending-${i}`, status: "success", kind: "update", entryFieldOperation: "work-report-sort-order",
      updatedAt: "2026-09-17T00:00:00Z",
    }));
    pending.push({ ...pending[0], taskId: "paused", entryFieldSettlementErrorCode: "REPORT_NOT_FOUND" });
    pending.push(createMonitor({ taskId: "running", status: "running", updatedAt: "2026-09-17T00:00:00Z" }));
    const history = Array.from({ length: 20 }, (_, i) => createMonitor({
      taskId: `history-${i}`, status: "success", updatedAt: "2026-09-17T00:00:00Z",
    }));
    expect(limitTaskMonitorHistory([...history, ...pending]), "UNRESOLVED_TASKS_SURVIVE_HISTORY_CAP").toEqual(pending);
    expect(mergeRetryableEntryFieldTaskMonitors([...history, ...pending], [], key => key)).toEqual(pending);
    expect(limitTaskMonitorHistory(history), "TERMINAL_HISTORY_REMAINS_BOUNDED").toHaveLength(12);
  });

  it("same work order shares one read while each field retains its own settlement result", async () => {
    const sort = createSortRetryMutation();
    const urgent = createSortRetryMutation({
      taskId: "task-urgent", operation: "work-report-urgent", clientMutationId: "mutation-urgent",
      value: true, previousValue: false, pendingPatch: { urgent: "是" },
      successPatch: { urgent: "是" }, rollbackPatch: { urgent: "否" },
    });
    const fetchEntry = vi.fn().mockResolvedValue({ id: "E-901", workOrderNo: "WO-901", sortOrder: 11, urgent: "否", reports: [] });
    const read = createEntryFieldSettlementReader(fetchEntry);
    const deleteRetry = vi.fn();
    const markSuperseded = vi.fn();
    const results = await Promise.all([sort, urgent].map(mutation => settleTerminalEntryFieldTask({
      monitor: createMonitor({
        taskId: mutation.taskId!, kind: "update", entryId: mutation.entryId, status: "success",
        updatedAt: "2026-09-17T00:00:00Z", entryFieldOperation: mutation.operation,
      }),
      fetchEntry: read, getRetryMutation: () => mutation,
      upsertMonitor: monitor => {
        if (monitor.entryFieldSettlementOutcome === "superseded") {
          expect(markSuperseded, "SUPERSEDED_EVIDENCE_PRECEDES_HISTORY_PUBLICATION").toHaveBeenCalledWith(urgent.operation, urgent.clientMutationId, undefined);
        }
      },
      markRetryMutationSupersededByClientMutationId: markSuperseded,
      deleteRetryMutation: deleteRetry, successMessage: "confirmed", supersededMessage: "superseded",
    })));
    expect(fetchEntry, "ONE_RESPONSE_FOR_SAME_PASS_FIELDS").toHaveBeenCalledTimes(1);
    expect(results.map(result => result?.monitor.entryFieldSettlementOutcome), "SHARED_RESPONSE_MUST_NOT_SHARE_MUTATION_OUTCOME")
      .toEqual(["settled", "superseded"]);
    expect(deleteRetry).toHaveBeenCalledOnce();
    expect(deleteRetry).toHaveBeenCalledWith(sort.taskId);
  });
});

describe("pruneExpiredTaskMonitors", () => {
  it("沒有 task 被清掉時回傳原本陣列 reference", () => {
    const now = Date.parse("2026-07-07T00:00:05.000Z");
    const monitors = [
      createMonitor({
        taskId: "running-task",
        status: "running",
        updatedAt: "invalid-date",
      }),
      createMonitor({
        taskId: "fresh-success",
        status: "success",
        updatedAt: new Date(now - CREATE_TASK_AUTO_CLEAR_MS + 1).toISOString(),
      }),
    ];

    expect(pruneExpiredTaskMonitors(monitors, now)).toBe(monitors);
  });

  it("會移除過期或時間格式無效的 terminal task", () => {
    const now = Date.parse("2026-07-07T00:00:05.000Z");
    const monitors = [
      createMonitor({
        taskId: "running-task",
        status: "running",
        updatedAt: "invalid-date",
      }),
      createMonitor({
        taskId: "expired-success",
        status: "success",
        updatedAt: new Date(now - CREATE_TASK_AUTO_CLEAR_MS).toISOString(),
      }),
      createMonitor({
        taskId: "invalid-failed",
        status: "failed",
        updatedAt: "invalid-date",
      }),
    ];

    const next = pruneExpiredTaskMonitors(monitors, now);

    expect(next).not.toBe(monitors);
    expect(next.map((item) => item.taskId)).toEqual(["running-task"]);
  });

  it("會用較長 TTL 移除 stale 的非終態 task", () => {
    const now = Date.parse("2026-07-07T00:01:00.000Z");
    const monitors = [
      createMonitor({
        taskId: "fresh-stale-running",
        status: "running",
        stale: true,
        updatedAt: new Date(now - CREATE_TASK_STALE_AUTO_CLEAR_MS + 1).toISOString(),
      }),
      createMonitor({
        taskId: "expired-stale-running",
        status: "running",
        stale: true,
        updatedAt: new Date(now - CREATE_TASK_STALE_AUTO_CLEAR_MS).toISOString(),
      }),
    ];

    const next = pruneExpiredTaskMonitors(monitors, now);

    expect(next).not.toBe(monitors);
    expect(next.map((item) => item.taskId)).toEqual(["fresh-stale-running"]);
  });

  it("indeterminate 終態會用待查證 TTL，不會在一般完成 TTL 後過早清除", () => {
    const now = Date.parse("2026-07-07T00:01:00.000Z");
    const monitors = [
      createMonitor({
        taskId: "fresh-indeterminate",
        status: "failed",
        lifecycleState: "indeterminate",
        updatedAt: new Date(now - CREATE_TASK_AUTO_CLEAR_MS).toISOString(),
      }),
      createMonitor({
        taskId: "expired-indeterminate",
        status: "failed",
        lifecycleState: "indeterminate",
        updatedAt: new Date(now - CREATE_TASK_STALE_AUTO_CLEAR_MS).toISOString(),
      }),
    ];

    expect(pruneExpiredTaskMonitors(monitors, now).map((item) => item.taskId)).toEqual([
      "fresh-indeterminate",
    ]);
  });
});

describe("hasTerminalTaskMonitors", () => {
  it("終態 task 尚未過期時仍會維持 auto-clear 心跳資格", () => {
    const now = Date.parse("2026-07-07T00:00:05.000Z");
    const monitors = [
      createMonitor({
        taskId: "fresh-success",
        status: "success",
        updatedAt: new Date(now - CREATE_TASK_AUTO_CLEAR_MS + 1).toISOString(),
      }),
    ];

    expect(pruneExpiredTaskMonitors(monitors, now)).toBe(monitors);
    expect(hasTerminalTaskMonitors(monitors)).toBe(true);
    expect(hasAutoClearableTaskMonitors(monitors)).toBe(true);
  });

  it("只有 pending/running 時不需要 auto-clear 心跳", () => {
    const monitors = [
      createMonitor({
        taskId: "pending-task",
        status: "pending",
        updatedAt: "invalid-date",
      }),
      createMonitor({
        taskId: "running-task",
        status: "running",
        updatedAt: "invalid-date",
      }),
    ];

    expect(hasTerminalTaskMonitors(monitors)).toBe(false);
    expect(hasAutoClearableTaskMonitors(monitors)).toBe(false);
  });

  it("stale 的 pending/running 也需要 auto-clear 心跳", () => {
    const monitors = [
      createMonitor({
        taskId: "stale-running-task",
        status: "running",
        stale: true,
        updatedAt: "2026-07-07T00:00:00.000Z",
      }),
    ];

    expect(hasTerminalTaskMonitors(monitors)).toBe(false);
    expect(hasAutoClearableTaskMonitors(monitors)).toBe(true);
  });
});

describe("isTaskMonitorClearable", () => {
  it("confirmed terminal 可清除，unknown／indeterminate 仍由 convergence owner 保留", () => {
    expect(
      isTaskMonitorClearable(
        createMonitor({
          taskId: "success-task",
          status: "success",
          lifecycleState: "success",
          updatedAt: "2026-08-31T00:00:00.000Z",
        })
      )
    ).toBe(true);
    expect(
      isTaskMonitorClearable(
        createMonitor({
          taskId: "unknown-task",
          status: "running",
          lifecycleState: "unknown",
          stale: true,
          retryableStale: true,
          updatedAt: "2026-08-31T00:00:00.000Z",
        })
      )
    ).toBe(false);
    expect(
      isTaskMonitorClearable(
        createMonitor({
          taskId: "indeterminate-task",
          status: "failed",
          lifecycleState: "indeterminate",
          updatedAt: "2026-08-31T00:00:00.000Z",
        })
      )
    ).toBe(false);
    expect(
      isTaskMonitorClearable(
        createMonitor({
          taskId: "superseded-task",
          status: "failed",
          lifecycleState: "conflict",
          entryFieldSettlementOutcome: "superseded",
          updatedAt: "2026-08-31T00:00:00.000Z",
        }),
        () => createSortRetryMutation({ taskId: "superseded-task" })
      )
    ).toBe(true);
  });

  it("entry-field settled marker 會終止舊 unknown/frozen history 的 blocking 與七天 retention", () => {
    const optimisticMutation = createWorkReportOptimisticMutation({
      taskId: "settled-unknown-task",
      mutationId: "settled-unknown-mutation",
      operation: "work-report-sort-order",
      target: {
        domain: "work-report",
        formId: "901",
        entryId: "E-901",
      },
      acceptedAt: "2026-09-02T03:00:00.000Z",
      reconcilePolicy: "replace-target",
      failurePolicy: "rollback",
      previousSnapshot: { sortOrder: 9 },
      patch: { kind: "update-entry", patch: { sortOrder: 11 } },
    });
    optimisticMutation.lifecycle = {
      ...optimisticMutation.lifecycle,
      lifecycleState: "unknown",
      optimisticState: "frozen",
    };
    const updatedAt = "2026-09-02T03:01:00.000Z";
    const monitor = createMonitor({
      taskId: "settled-unknown-task",
      kind: "update",
      status: "running",
      lifecycleState: "unknown",
      stale: true,
      retryableStale: false,
      entryFieldOperation: "work-report-sort-order",
      entryFieldSettlementOutcome: "settled",
      optimisticMutation,
      updatedAt,
    });

    expect(isTaskMonitorClearable(monitor, () => null)).toBe(true);
    expect(
      pruneExpiredTaskMonitors(
        [monitor],
        Date.parse(updatedAt) + CREATE_TASK_AUTO_CLEAR_MS + 1
      )
    ).toEqual([]);
  });
});

describe("clearFinishedTaskMonitorsAndEvidence", () => {
  it("清除 superseded history 時同步刪除 retry evidence", () => {
    const superseded = createMonitor({
      taskId: "superseded-task",
      status: "failed",
      lifecycleState: "conflict",
      entryFieldSettlementOutcome: "superseded",
      updatedAt: "2026-08-31T00:00:00.000Z",
    });
    const unknown = createMonitor({
      taskId: "unknown-task",
      status: "failed",
      lifecycleState: "unknown",
      updatedAt: "2026-08-31T00:00:00.000Z",
    });
    const deleteRetryMutation = vi.fn();

    const remaining = clearFinishedTaskMonitorsAndEvidence(
      [superseded, unknown],
      (taskId) =>
        taskId === "superseded-task"
          ? createSortRetryMutation({ taskId })
          : null,
      deleteRetryMutation
    );

    expect(remaining).toEqual([unknown]);
    expect(deleteRetryMutation).toHaveBeenCalledWith("superseded-task");
  });

  it("清除 bind-loss superseded history 時以 client mutation identity 刪除 evidence", () => {
    const deleteRetryMutation = vi.fn();
    const deleteRetryMutationByClientMutationId = vi.fn();
    const monitor = createMonitor({
      taskId: "bind-loss-task",
      status: "failed",
      lifecycleState: "conflict",
      entryFieldOperation: "work-report-sort-order",
      entryFieldClientMutationId: "bind-loss-mutation",
      entryFieldSettlementOutcome: "superseded",
      updatedAt: "2026-09-02T01:00:00.000Z",
    });

    expect(
      clearFinishedTaskMonitorsAndEvidence(
        [monitor],
        () => null,
        deleteRetryMutation,
        deleteRetryMutationByClientMutationId
      )
    ).toEqual([]);
    expect(deleteRetryMutation).not.toHaveBeenCalled();
    expect(deleteRetryMutationByClientMutationId).toHaveBeenCalledWith(
      "work-report-sort-order",
      "bind-loss-mutation"
    );
  });
});

describe("persistTaskMonitorEntryFieldLifecycle", () => {
  it("由全域 task monitor 持久化 entry-field terminal lifecycle", () => {
    const optimisticMutation = createWorkReportOptimisticMutation({
      taskId: "sort-task-global-owner",
      mutationId: "sort-mutation-global-owner",
      operation: "work-report-sort-order",
      target: {
        domain: "work-report",
        formId: "901",
        entryId: "E-901",
      },
      acceptedAt: "2026-08-31T00:00:00.000Z",
      reconcilePolicy: "replace-target",
      failurePolicy: "rollback",
      previousSnapshot: { sortOrder: 9 },
      patch: {
        kind: "update-entry",
        patch: { sortOrder: 11 },
      },
    });
    const persistLifecycle = vi.fn();

    persistTaskMonitorEntryFieldLifecycle(
      createMonitor({
        taskId: "sort-task-global-owner",
        status: "failed",
        updatedAt: "2026-08-31T00:00:01.000Z",
        optimisticMutation,
      }),
      persistLifecycle
    );

    expect(persistLifecycle).toHaveBeenCalledWith(
      "sort-task-global-owner",
      optimisticMutation.lifecycle
    );
  });

  it("非 optimistic task 不寫入 entry-field retry store", () => {
    const persistLifecycle = vi.fn();

    persistTaskMonitorEntryFieldLifecycle(
      createMonitor({
        taskId: "plain-task",
        status: "success",
        updatedAt: "2026-08-31T00:00:01.000Z",
      }),
      persistLifecycle
    );

    expect(persistLifecycle).not.toHaveBeenCalled();
  });

  it("非 entry-field optimistic task 不掃描 entry-field retry store", () => {
    const optimisticMutation = createWorkReportOptimisticMutation({
      taskId: "row-update-task",
      mutationId: "row-update-mutation",
      operation: "work-report-update",
      target: {
        domain: "work-report",
        formId: "901",
        entryId: "E-901",
        rowId: "R-1",
      },
      acceptedAt: "2026-08-31T00:00:00.000Z",
      reconcilePolicy: "replace-target",
      failurePolicy: "rollback",
      previousSnapshot: { productionQty: 10 },
      patch: {
        kind: "update-row",
        rowId: "R-1",
        payload: {
          date: "2026/08/31",
          machineId: "MA51",
          operatorId: "A001",
          startTime: "08:00",
          endTime: "09:00",
          productionQty: 12,
        },
      },
    });
    const persistLifecycle = vi.fn();

    persistTaskMonitorEntryFieldLifecycle(
      createMonitor({
        taskId: "row-update-task",
        status: "running",
        updatedAt: "2026-08-31T00:00:01.000Z",
        optimisticMutation,
      }),
      persistLifecycle
    );

    expect(persistLifecycle).not.toHaveBeenCalled();
  });

  it("啟動時還原的 terminal monitors 也會在 TTL 清理前持久化", () => {
    const optimisticMutation = createWorkReportOptimisticMutation({
      taskId: "restored-frozen-task",
      mutationId: "restored-frozen-mutation",
      operation: "work-report-sort-order",
      target: {
        domain: "work-report",
        formId: "901",
        entryId: "E-RESTORED",
      },
      acceptedAt: "2026-08-31T00:00:00.000Z",
      reconcilePolicy: "replace-target",
      failurePolicy: "rollback",
      previousSnapshot: { sortOrder: 9 },
      patch: {
        kind: "update-entry",
        patch: { sortOrder: 11 },
      },
    });
    const persistLifecycle = vi.fn();

    persistTaskMonitorEntryFieldLifecycles(
      [
        createMonitor({
          taskId: "restored-frozen-task",
          status: "failed",
          updatedAt: "2026-08-31T00:00:01.000Z",
          optimisticMutation,
        }),
      ],
      persistLifecycle
    );

    expect(persistLifecycle).toHaveBeenCalledWith(
      "restored-frozen-task",
      optimisticMutation.lifecycle
    );
  });
});

describe("resolveTaskMonitorResult", () => {
  it("success create-task result 會把 confirmed entry observation 帶進 monitor", () => {
    const confirmedEntry = {
      entryId: "90002",
      operation: "work-report-urgent" as const,
      observedAt: "2026-09-01T01:00:00.000Z",
      patch: { urgent: "Yes" },
    };
    const monitor = resolveTaskMonitorResult(
      createMonitor({
        taskId: "urgent-task",
        kind: "update",
        status: "running",
        updatedAt: "2026-09-01T00:59:00.000Z",
      }),
      createTaskResult({
        taskId: "urgent-task",
        taskType: "update-report",
        status: "success",
        result: { confirmedEntry },
      }),
      (key) => key
    );

    expect(monitor.confirmedEntry).toEqual(confirmedEntry);
  });

  it("task terminal 會把 optimistic lifecycle 收斂成 confirmed、rolled-back 或 frozen", () => {
    const optimisticMutation = createWorkReportOptimisticMutation({
      taskId: "task-optimistic",
      mutationId: "mutation-optimistic",
      operation: "work-report-update",
      target: {
        domain: "work-report",
        formId: "901",
        entryId: "90002",
        rowId: "row-1",
      },
      acceptedAt: "2026-08-12T00:00:00.000Z",
      reconcilePolicy: "replace-target",
      failurePolicy: "rollback",
      previousSnapshot: { rowId: "row-1", productionQty: 10 },
      patch: {
        kind: "update-row",
        rowId: "row-1",
        payload: {
          date: "2026/08/12",
          machineId: "MA23",
          operatorId: "A001",
          startTime: "08:00",
          endTime: "09:00",
          productionQty: 20,
        },
      },
    });
    const base = createMonitor({
      taskId: "task-optimistic",
      kind: "update",
      status: "running",
      updatedAt: "2026-08-12T00:00:01.000Z",
      optimisticMutation,
    });

    const success = resolveTaskMonitorResult(
      base,
      createTaskResult({
        taskId: "task-optimistic",
        status: "success",
        confirmedAt: "2026-08-12T00:00:02.000Z",
      }),
      (key) => key
    );
    expect(success.optimisticMutation?.lifecycle.optimisticState).toBe("confirmed");

    const failed = resolveTaskMonitorResult(
      base,
      createTaskResult({
        taskId: "task-optimistic",
        status: "failed",
        error: { code: "ENTRY_CONFLICT", message: "conflict" },
      }),
      (key) => key
    );
    expect(failed.optimisticMutation?.lifecycle.optimisticState).toBe("rolled-back");

    const indeterminate = resolveTaskMonitorResult(
      base,
      createTaskResult({
        taskId: "task-optimistic",
        status: "failed",
        writeIndeterminate: true,
        error: { code: "RAGIC_WRITE_VERIFY_FAILED", message: "unknown" },
      }),
      (key) => key
    );
    expect(indeterminate.optimisticMutation?.lifecycle.optimisticState).toBe("frozen");
  });

  it("entry-level update 完成時不會製造假的 rowId", () => {
    const monitor = resolveTaskMonitorResult(
      createMonitor({
        taskId: "sort-order-task",
        kind: "update",
        status: "running",
        updatedAt: "2026-08-04T00:00:01.000Z",
      }),
      createTaskResult({
        taskId: "sort-order-task",
        taskType: "update-report",
        status: "success",
        updatedAt: "2026-08-04T00:00:02.000Z",
        result: {},
      }),
      (key) => key
    );

    expect(monitor.status).toBe("success");
    expect(monitor.rowId).toBeUndefined();
    expect(monitor.message).toBe(
      "workReport:messages.taskBackgroundUpdateCompleted"
    );
  });

  it("create task 含 taskType 時仍從 nested result 取得 rowId", () => {
    const monitor = resolveTaskMonitorResult(
      createMonitor({
        taskId: "create-task-1",
        status: "running",
        updatedAt: "2026-07-07T00:00:01.000Z",
      }),
      createTaskResult({
        status: "success",
        updatedAt: "2026-07-07T00:00:02.000Z",
        result: { rowId: "2001" },
      }),
      (key) => key
    );

    expect(monitor).toMatchObject({
      status: "success",
      rowId: "2001",
    });
  });

  it("queue task 維持從 flat rowId 取得結果", () => {
    const task: WorkReportQueueTask = {
      taskId: "delete-task-flat-row",
      taskType: "delete-report",
      status: "success",
      formId: "902",
      workOrderNo: "DEMO-040537",
      entryId: "90002",
      rowId: "3001",
      queueKey: "902:90002",
      createdAt: "2026-07-07T00:00:00.000Z",
      startedAt: "2026-07-07T00:00:01.000Z",
      finishedAt: "2026-07-07T00:00:02.000Z",
      updatedAt: "2026-07-07T00:00:02.000Z",
      message: "刪除報工完成",
      errorCode: null,
      errorMessage: null,
      actorClientId: null,
      actorTabId: null,
      actorIp: null,
      actorLabel: null,
      source: null,
    };

    const monitor = resolveTaskMonitorResult(
      createMonitor({
        taskId: task.taskId,
        kind: "delete",
        status: "running",
        updatedAt: "2026-07-07T00:00:01.000Z",
      }),
      task,
      (key) => key
    );

    expect(monitor).toMatchObject({
      status: "success",
      rowId: "3001",
    });
  });

  it("保留已完成刪除的 registry metadata 與收尾失敗訊息", () => {
    const task: WorkReportQueueTask = {
      taskId: "delete-task-1",
      taskType: "delete-report",
      status: "failed",
      formId: "902",
      workOrderNo: "DEMO-040537",
      entryId: "90002",
      rowId: "1001",
      queueKey: "902:90002",
      createdAt: "2026-07-07T00:00:00.000Z",
      startedAt: "2026-07-07T00:00:01.000Z",
      finishedAt: "2026-07-07T00:00:02.000Z",
      updatedAt: "2026-07-07T00:00:02.000Z",
      message: "報工已刪除，但工令回算或資料同步收尾失敗",
      errorCode: "DELETE_REPORT_FINALIZE_FAILED",
      errorMessage: "*finalize*: Ragic formula recalculation failed",
      actorClientId: null,
      actorTabId: null,
      actorIp: null,
      actorLabel: null,
      source: null,
      deletedCount: 1,
      deleteFinalizeFailed: true,
    };

    const monitor = resolveTaskMonitorResult(
      createMonitor({
        taskId: task.taskId,
        kind: "delete",
        status: "running",
        updatedAt: "2026-07-07T00:00:01.000Z",
      }),
      task,
      (key) => key
    );

    expect(monitor).toMatchObject({
      status: "failed",
      message: "報工已刪除，但工令回算或資料同步收尾失敗",
      deletedCount: 1,
      deleteFinalizeFailed: true,
    });
  });
});

describe("schedule mutation global reconciliation", () => {
  it("List/Detail 未掛載時 provider 仍會 strict settle terminal task 並清除 retry", async () => {
    const retryMutation = createSortRetryMutation();
    const authoritativeRecord = {
      id: "E-901",
      workOrderNo: "WO-901",
      status: "未結案",
      customerPartNo: null,
      erpPartNo: null,
      sortOrder: 11,
      lastUpdatedAt: "2026/09/02 09:30:00",
    } satisfies WorkReportRecord;
    const fetchEntry = vi.fn().mockResolvedValue(authoritativeRecord);
    const upsertMonitor = vi.fn();
    const deleteRetryMutation = vi.fn();

    const settlement = await settleTerminalEntryFieldTask({
      monitor: createMonitor({
        taskId: "task-sort-1",
        kind: "update",
        entryId: "E-901",
        workOrderNo: "WO-901",
        status: "success",
        lifecycleState: "success",
        entryFieldOperation: "work-report-sort-order",
        updatedAt: "2026-09-02T01:30:00.000Z",
      }),
      getRetryMutation: () => retryMutation,
      fetchEntry,
      upsertMonitor,
      deleteRetryMutation,
      successMessage: "entry updated",
      supersededMessage: "entry superseded",
    });

    expect(fetchEntry).toHaveBeenCalledWith("901", "E-901", true, {
      strictRefresh: true,
    });
    expect(settlement?.monitor).toMatchObject({
      status: "success",
      message: "entry updated",
      entryFieldSettlementRecord: authoritativeRecord,
    });
    expect(upsertMonitor).toHaveBeenCalledWith(
      expect.objectContaining({
        entryFieldSettlementRecord: expect.objectContaining(authoritativeRecord),
      })
    );
    expect(deleteRetryMutation).toHaveBeenCalledWith("task-sort-1");
  });

  it("mounted list 先套用 authoritative settlement，再發布 terminal monitor", async () => {
    const retryMutation = createSortRetryMutation();
    const authoritativeRecord = {
      id: "E-901",
      workOrderNo: "WO-901",
      status: "未結案",
      customerPartNo: null,
      erpPartNo: null,
      sortOrder: 11,
      lastUpdatedAt: "2026/09/02 09:30:00",
    } satisfies WorkReportRecord;
    const calls: string[] = [];

    await settleTerminalEntryFieldTask({
      monitor: createMonitor({
        taskId: "task-sort-direct-settlement",
        kind: "update",
        entryId: "E-901",
        workOrderNo: "WO-901",
        status: "success",
        lifecycleState: "success",
        entryFieldOperation: "work-report-sort-order",
        confirmedEntry: {
          entryId: "E-901",
          operation: "work-report-sort-order",
          observedAt: "2026-09-02T01:30:00.000Z",
          entryLastUpdatedAt: "2026/09/02 09:30:00",
          patch: { sortOrder: 11 },
        },
        updatedAt: "2026-09-02T01:30:00.000Z",
      }),
      consumer: {
        getCurrentRecord: () => null,
        applySettlement: ({ taskId, authoritativeRecord: incoming, expectedPatch }) => {
          expect(taskId).toBe("task-sort-direct-settlement");
          expect(incoming).toMatchObject(authoritativeRecord);
          expect(expectedPatch).toEqual({ sortOrder: 11 });
          calls.push("list");
        },
      },
      getRetryMutation: () => retryMutation,
      fetchEntry: vi.fn().mockResolvedValue(authoritativeRecord),
      upsertMonitor: () => calls.push("monitor"),
      deleteRetryMutation: vi.fn(),
      successMessage: "entry updated",
      supersededMessage: "entry superseded",
    });

    expect(calls).toEqual(["list", "monitor"]);
  });

  it("strict authority read 失敗時不提交 settlement，也不刪除 retry", async () => {
    const retryMutation = createSortRetryMutation();
    const fetchEntry = vi.fn().mockRejectedValue(new Error("Ragic timeout"));
    const upsertMonitor = vi.fn();
    const deleteRetryMutation = vi.fn();

    await expect(
      settleTerminalEntryFieldTask({
        monitor: createMonitor({
          taskId: "task-sort-1",
          kind: "update",
          entryId: "E-901",
          workOrderNo: "WO-901",
          status: "success",
          lifecycleState: "success",
          entryFieldOperation: "work-report-sort-order",
          updatedAt: "2026-09-02T01:30:00.000Z",
        }),
        getRetryMutation: () => retryMutation,
        fetchEntry,
        upsertMonitor,
        deleteRetryMutation,
        successMessage: "entry updated",
        supersededMessage: "entry superseded",
      })
    ).rejects.toThrow("Ragic timeout");

    expect(upsertMonitor).not.toHaveBeenCalled();
    expect(deleteRetryMutation).not.toHaveBeenCalled();
  });

  it("retry evidence 遺失時 provider 仍會 strict refresh 並留下 settled marker", async () => {
    const authoritativeRecord = {
      id: "E-901",
      workOrderNo: "WO-901",
      status: "未結案",
      customerPartNo: null,
      erpPartNo: null,
      sortOrder: 11,
      lastUpdatedAt: "2026/09/02 10:10:00",
    } satisfies WorkReportRecord;
    const fetchEntry = vi.fn().mockResolvedValue(authoritativeRecord);
    const upsertMonitor = vi.fn();
    const deleteRetryMutation = vi.fn();
    const deleteRetryMutationByClientMutationId = vi.fn();

    const settlement = await settleTerminalEntryFieldTask({
      monitor: createMonitor({
        taskId: "task-missing-retry",
        kind: "update",
        entryId: "E-901",
        workOrderNo: "WO-901",
        status: "success",
        lifecycleState: "success",
        entryFieldOperation: "work-report-sort-order",
        entryFieldClientMutationId: "mutation-missing-retry",
        updatedAt: "2026-09-02T02:10:00.000Z",
      }),
      getRetryMutation: () => null,
      fetchEntry,
      upsertMonitor,
      deleteRetryMutation,
      deleteRetryMutationByClientMutationId,
      successMessage: "entry updated",
      supersededMessage: "entry superseded",
    });

    expect(fetchEntry).toHaveBeenCalledWith("901", "E-901", true, {
      strictRefresh: true,
    });
    expect(settlement?.monitor).toMatchObject({
      status: "success",
      entryFieldSettlementOutcome: "settled",
      entryFieldSettlementRecord: { ...authoritativeRecord, reportsLoaded: true },
    });
    expect(upsertMonitor).toHaveBeenCalledWith(
      expect.objectContaining({
        entryFieldSettlementOutcome: "settled",
        entryFieldSettlementRecord: { ...authoritativeRecord, reports: [], reportsLoaded: true },
      })
    );
    const detail = resolveDetailTerminalTaskConsumption(settlement!.monitor, key => key);
    expect(detail.authoritativeRecord?.reportsLoaded).toBe(true);
    expect(detail.loadEntryOptions).toBeUndefined();
    expect(deleteRetryMutation).not.toHaveBeenCalled();
    expect(deleteRetryMutationByClientMutationId).toHaveBeenCalledWith(
      "work-report-sort-order",
      "mutation-missing-retry"
    );
  });

  it("retry evidence 遺失且 strict refresh 失敗時不留下 settled marker", async () => {
    const upsertMonitor = vi.fn();
    const deleteRetryMutation = vi.fn();
    const monitor = createMonitor({
      taskId: "task-missing-retry-failed-read",
      kind: "update",
      entryId: "E-901",
      workOrderNo: "WO-901",
      status: "success",
      lifecycleState: "success",
      entryFieldOperation: "work-report-sort-order",
      updatedAt: "2026-09-02T02:11:00.000Z",
    });

    await expect(
      settleTerminalEntryFieldTask({
        monitor,
        getRetryMutation: () => null,
        fetchEntry: vi.fn().mockRejectedValue(new Error("strict read failed")),
        upsertMonitor,
        deleteRetryMutation,
        successMessage: "entry updated",
        supersededMessage: "entry superseded",
      })
    ).rejects.toThrow("strict read failed");

    expect(upsertMonitor).not.toHaveBeenCalled();
    expect(deleteRetryMutation).not.toHaveBeenCalled();
    expect(shouldSettleEntryFieldMutationTask(monitor)).toBe(true);
  });

  it("mounted authority consumer 提供 raw current，provider 發布 strict third value 並保留 evidence", async () => {
    const retryMutation = createSortRetryMutation({
      lifecycle: createWorkReportOptimisticMutation({
        taskId: "task-sort-1",
        mutationId: "mutation-sort-1",
        operation: "work-report-sort-order",
        target: {
          domain: "work-report",
          formId: "901",
          entryId: "E-901",
        },
        acceptedAt: "2026-08-31T00:00:00.000Z",
        reconcilePolicy: "replace-target",
        failurePolicy: "rollback",
        previousSnapshot: { sortOrder: 9 },
        patch: {
          kind: "update-entry",
          patch: { sortOrder: 11 },
        },
      }).lifecycle,
    });
    const authoritativeRecord = {
      id: "E-901",
      workOrderNo: "WO-901",
      status: "未結案",
      customerPartNo: null,
      erpPartNo: null,
      sortOrder: 12,
      lastUpdatedAt: "2026/09/02 09:30:00",
    } satisfies WorkReportRecord;
    const fetchEntry = vi.fn().mockResolvedValue(authoritativeRecord);
    const upsertMonitor = vi.fn();
    const deleteRetryMutation = vi.fn();

    const settlement = await settleTerminalEntryFieldTask({
      monitor: createMonitor({
        taskId: "task-sort-1",
        kind: "update",
        entryId: "E-901",
        workOrderNo: "WO-901",
        status: "success",
        lifecycleState: "success",
        entryFieldOperation: "work-report-sort-order",
        updatedAt: "2026-09-02T01:30:00.000Z",
      }),
      consumer: {
        getCurrentRecord: () => ({
          ...authoritativeRecord,
          sortOrder: 9,
          lastUpdatedAt: "2026/09/02 09:29:59",
        }),
      },
      getRetryMutation: () => retryMutation,
      fetchEntry,
      upsertMonitor,
      deleteRetryMutation,
      successMessage: "entry updated",
      supersededMessage: "entry superseded",
    });

    expect(settlement?.monitor).toMatchObject({
      status: "failed",
      lifecycleState: "conflict",
      entryFieldSettlementOutcome: "superseded",
      entryFieldSettlementRecord: authoritativeRecord,
      optimisticMutation: {
        lifecycle: {
          lifecycleState: "conflict",
          optimisticState: "rolled-back",
        },
      },
      message: "entry superseded",
    });
    expect(deleteRetryMutation).not.toHaveBeenCalled();
  });

  it("直接重載 detail 時會由 provider 從 durable retry intent 重建 monitor", () => {
    const mutation = createSortRetryMutation({
      lifecycle: {
        version: 1,
        mutationId: "mutation-sort-1",
        taskId: "task-sort-1",
        operation: "work-report-sort-order",
        target: {
          domain: "work-report",
          formId: "901",
          entryId: "E-901",
        },
        lifecycleState: "indeterminate",
        optimisticState: "frozen",
        acceptedAt: "2026-08-31T00:00:00.000Z",
        confirmedAt: null,
        reconcilePolicy: "replace-target",
        failurePolicy: "rollback",
        previousSnapshot: { sortOrder: 9 },
      },
    });

    expect(
      mergeRetryableEntryFieldTaskMonitors([], [mutation], (key) => key)
    ).toMatchObject([
      {
        taskId: "task-sort-1",
        status: "failed",
        lifecycleState: "indeterminate",
        entryFieldOperation: "work-report-sort-order",
        optimisticMutation: {
          lifecycle: { optimisticState: "frozen" },
        },
      },
    ]);
  });

  it("monitor owner 已掛載後仍會合併其他分頁新增的已綁定 retry task", () => {
    const existingMonitor = createMonitor({
      taskId: "existing-task",
      status: "success",
      updatedAt: "2026-09-02T01:00:00.000Z",
    });
    const crossTabMutation = createSortRetryMutation({
      clientMutationId: "cross-tab-mutation",
      taskId: "cross-tab-task",
      entryId: "E-cross-tab",
      lifecycle: {
        version: 1,
        mutationId: "cross-tab-mutation",
        taskId: "cross-tab-task",
        operation: "work-report-sort-order",
        target: {
          domain: "work-report",
          formId: "901",
          entryId: "E-cross-tab",
        },
        lifecycleState: "accepted",
        optimisticState: "applied",
        acceptedAt: "2026-09-02T01:00:01.000Z",
        confirmedAt: null,
        reconcilePolicy: "replace-target",
        failurePolicy: "rollback",
        previousSnapshot: { sortOrder: 9 },
      },
    });

    expect(
      mergeRetryableEntryFieldTaskMonitors(
        [existingMonitor],
        [crossTabMutation],
        (key) => key
      )
    ).toMatchObject([
      {
        taskId: "cross-tab-task",
        status: "pending",
        entryFieldClientMutationId: "cross-tab-mutation",
      },
      { taskId: "existing-task" },
    ]);
  });

  it("durable schedule intents 不會被 12 筆 UI history cap 截斷", () => {
    const mutations = Array.from({ length: 13 }, (_, index) =>
      createSortRetryMutation({
        clientMutationId: `mutation-${index}`,
        taskId: `task-${index}`,
        entryId: `E-${index}`,
      })
    );

    const monitors = mergeRetryableEntryFieldTaskMonitors(
      [],
      mutations,
      (key) => key
    );

    expect(monitors).toHaveLength(13);
    expect(new Set(monitors.map((monitor) => monitor.taskId)).size).toBe(13);
  });

  it("main-machine monitor 與列表欄位共用 entry-field convergence", () => {
    const optimisticMutation = createWorkReportOptimisticMutation({
      taskId: "main-machine-task",
      mutationId: "main-machine-mutation",
      operation: "work-report-main-machine",
      target: {
        domain: "work-report",
        formId: "901",
        entryId: "E-901",
      },
      acceptedAt: "2026-08-31T00:00:00.000Z",
      reconcilePolicy: "replace-target",
      failurePolicy: "rollback",
      previousSnapshot: { machineCode: "MB50" },
      patch: { kind: "update-entry", patch: { machineCode: "MA51" } },
    });

    expect(
      resolveTaskMonitorEntryFieldOperation(
        createMonitor({
          taskId: "main-machine-task",
          status: "failed",
          updatedAt: "2026-08-31T00:00:01.000Z",
          optimisticMutation,
        })
      )
    ).toBe("work-report-main-machine");
  });

});

describe("pollCreateTaskMonitor", () => {
  it.each(["success", "failed"] as const)("%s settlement 暫時失敗時保留處理中，重試成功才發布 terminal", async (status) => {
    const updates: CreateTaskMonitor[] = [];
    const fetchEntry = vi.fn()
      .mockRejectedValueOnce(new Error("LIVE timeout"))
      .mockResolvedValue({ id: "entry-1", reports: [] });
    const settle = async (monitor: CreateTaskMonitor) => {
      try {
        await settleTerminalEntryFieldTask({
          monitor,
          fetchEntry,
          getRetryMutation: () => null,
          upsertMonitor: (next) => updates.push(next),
          successMessage: "settled",
          supersededMessage: "superseded",
        });
        return true;
      } catch {
        return "retry" as const;
      }
    };
    const sleepMs = vi.fn(async () => {
      expect(updates).toEqual([]);
    });
    await pollCreateTaskMonitor({
      seedMonitor: createMonitor({
        taskId: "task-retry-settlement",
        entryId: "entry-1",
        status: "running",
        updatedAt: "2026-09-11T00:00:00.000Z",
        entryFieldOperation: "work-report-sort-order",
      }),
      fetchTask: vi.fn().mockResolvedValue(createTaskResult({ status })),
      buildMonitorFromTaskResult: (base, task) => ({ ...base, status: task.status }),
      upsertTaskMonitorState: (monitor) => updates.push(monitor),
      onSuccess: settle,
      onFailed: settle,
      buildPollingRetryMessage: () => "retry",
      buildPollingUnavailableMessage: () => "unavailable",
      buildTaskNotFoundMessage: () => "unknown",
      buildTimedOutMessage: () => "timeout",
      sleepMs,
    });
    expect(fetchEntry).toHaveBeenCalledTimes(2);
    expect(sleepMs).toHaveBeenCalledOnce();
    expect(updates).toEqual([
      expect.objectContaining({ status, entryFieldSettlementOutcome: "settled" }),
    ]);
  });

  it("terminal callback 已完成 settlement 時不先發布未收斂的 success monitor", async () => {
    const updates: CreateTaskMonitor[] = [];
    const onSuccess = vi.fn(async (monitor: CreateTaskMonitor) => {
      updates.push({
        ...monitor,
        entryFieldSettlementOutcome: "settled",
        message: "settled",
      });
      return true;
    });

    await pollCreateTaskMonitor({
      seedMonitor: createMonitor({
        taskId: "task-direct-settlement",
        status: "running",
        entryFieldOperation: "work-report-sort-order",
        updatedAt: "2026-07-07T00:00:00.000Z",
      }),
      fetchTask: vi.fn().mockResolvedValue(
        createTaskResult({
          taskId: "task-direct-settlement",
          status: "success",
          updatedAt: "2026-07-07T00:00:03.000Z",
        })
      ),
      buildMonitorFromTaskResult: (base, task) => ({
        ...base,
        status: task.status,
        updatedAt: task.updatedAt,
      }),
      upsertTaskMonitorState: (monitor) => updates.push(monitor),
      onSuccess,
      onFailed: vi.fn(),
      buildPollingRetryMessage: () => "retry",
      buildPollingUnavailableMessage: () => "unavailable",
      buildTaskNotFoundMessage: () => "unknown",
      buildTimedOutMessage: () => "timeout",
      sleepMs: async () => {},
    });

    expect(onSuccess).toHaveBeenCalledOnce();
    expect(updates).toEqual([
      expect.objectContaining({
        status: "success",
        entryFieldSettlementOutcome: "settled",
        message: "settled",
      }),
    ]);
  });

  it("單次 status fetch 失敗不會把 task 標 failed，下一輪成功會繼續完成", async () => {
    let now = 0;
    const updates: CreateTaskMonitor[] = [];
    const fetchTask = vi
      .fn<(monitor: CreateTaskMonitor) => Promise<CreateReportTaskResult>>()
      .mockRejectedValueOnce(new Error("Network Error"))
      .mockResolvedValueOnce(
        createTaskResult({
          status: "success",
          updatedAt: "2026-07-07T00:00:03.000Z",
          result: {
            rowId: "row-1",
          },
        })
      );
    const onSuccess = vi.fn();
    const onFailed = vi.fn();

    await pollCreateTaskMonitor({
      seedMonitor: createMonitor({
        taskId: "task-1",
        status: "running",
        updatedAt: "2026-07-07T00:00:00.000Z",
      }),
      fetchTask,
      buildMonitorFromTaskResult: (base, task) => ({
        ...base,
        status: task.status,
        stale: undefined,
        rowId: "result" in task ? task.result?.rowId : "rowId" in task ? task.rowId ?? undefined : undefined,
        message: task.status,
        updatedAt: task.updatedAt,
      }),
      upsertTaskMonitorState: (monitor) => updates.push(monitor),
      onSuccess,
      onFailed,
      buildPollingRetryMessage: (error) => `retry:${error instanceof Error ? error.message : String(error)}`,
      buildPollingUnavailableMessage: (error) =>
        `unavailable:${error instanceof Error ? error.message : String(error)}`,
      buildTaskNotFoundMessage: () => "unknown",
      buildTimedOutMessage: () => "timeout",
      nowMs: () => now,
      nowIso: () => "2026-07-07T00:00:02.000Z",
      sleepMs: async (ms) => {
        now += ms;
      },
      timeoutMs: 10,
      intervalMs: 1,
    });

    expect(fetchTask).toHaveBeenCalledTimes(2);
    expect(updates.map((item) => item.status)).toEqual(["running", "success"]);
    expect(updates[0]).toMatchObject({
      status: "running",
      stale: undefined,
      message: "retry:Network Error",
    });
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("TASK_NOT_FOUND 會轉成 stale 非終態，不標 failed", async () => {
    const updates: CreateTaskMonitor[] = [];

    await pollCreateTaskMonitor({
      seedMonitor: createMonitor({
        taskId: "missing-task",
        status: "running",
        updatedAt: "2026-07-07T00:00:00.000Z",
        confirmedAt: "2026-07-07T00:00:01.000Z",
      }),
      fetchTask: vi.fn().mockRejectedValueOnce(createTaskNotFoundError()),
      buildMonitorFromTaskResult: (base) => base,
      upsertTaskMonitorState: (monitor) => updates.push(monitor),
      onSuccess: vi.fn(),
      onFailed: vi.fn(),
      buildPollingRetryMessage: () => "retry",
      buildPollingUnavailableMessage: () => "unavailable",
      buildTaskNotFoundMessage: () => "unknown",
      buildTimedOutMessage: () => "timeout",
      nowMs: () => 0,
      nowIso: () => "2026-07-07T00:00:02.000Z",
      sleepMs: async () => {},
      timeoutMs: 10,
      intervalMs: 1,
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      status: "running",
      lifecycleState: "unknown",
      confirmedAt: null,
      stale: true,
      retryableStale: false,
      message: "unknown",
    });
  });

  it("polling 到 deadline 後降頻持續追蹤，延遲 success 不需 reload 即可收斂", async () => {
    let now = 0;
    const updates: CreateTaskMonitor[] = [];
    let fetchCount = 0;

    await pollCreateTaskMonitor({
      seedMonitor: createMonitor({
        taskId: "slow-task",
        status: "running",
        entryFieldOperation: "work-report-sort-order",
        updatedAt: "2026-07-07T00:00:00.000Z",
        confirmedAt: "2026-07-07T00:00:01.000Z",
      }),
      fetchTask: vi.fn().mockImplementation(async () => {
        fetchCount += 1;
        return createTaskResult({
          status: fetchCount >= 5 ? "success" : "running",
          updatedAt: `2026-07-07T00:00:0${fetchCount}.000Z`,
        });
      }),
      buildMonitorFromTaskResult: (base, task) => ({
        ...base,
        status: task.status,
        stale: undefined,
        retryableStale: undefined,
        message: task.status,
        updatedAt: task.updatedAt,
      }),
      upsertTaskMonitorState: (monitor) => updates.push(monitor),
      onSuccess: vi.fn(),
      onFailed: vi.fn(),
      buildPollingRetryMessage: () => "retry",
      buildPollingUnavailableMessage: () => "unavailable",
      buildTaskNotFoundMessage: () => "unknown",
      buildTimedOutMessage: () => "timeout",
      nowMs: () => now,
      nowIso: () => "2026-07-07T00:00:30.000Z",
      sleepMs: async (ms) => {
        now += ms;
      },
      timeoutMs: 2,
      intervalMs: 1,
      staleIntervalMs: 10,
    });

    expect(updates).toContainEqual(
      expect.objectContaining({
        status: "running",
        lifecycleState: "unknown",
        confirmedAt: null,
        stale: true,
        retryableStale: true,
        message: "timeout",
      })
    );
    expect(updates.at(-1)).toMatchObject({
      status: "success",
      stale: undefined,
      retryableStale: undefined,
    });
    expect(fetchCount).toBe(5);
  });

  it("retryable stale running monitor 不會被 30 秒 TTL 清除", () => {
    const monitor = createMonitor({
      taskId: "slow-task-retained",
      status: "running",
      lifecycleState: "unknown",
      confirmedAt: null,
      stale: true,
      retryableStale: true,
      updatedAt: "2026-07-07T00:00:30.000Z",
      message: "timeout",
    });
    expect(
      pruneExpiredTaskMonitors(
        [monitor],
        Date.parse("2026-07-07T00:00:30.000Z") + CREATE_TASK_STALE_AUTO_CLEAR_MS
      )
    ).toEqual([monitor]);
  });

  it("非 schedule task 維持原本 timeout 後停止 polling 的契約", async () => {
    let now = 0;
    const updates: CreateTaskMonitor[] = [];

    await pollCreateTaskMonitor({
      seedMonitor: createMonitor({
        taskId: "slow-generic-task",
        status: "running",
        updatedAt: "2026-07-07T00:00:00.000Z",
      }),
      fetchTask: vi.fn().mockResolvedValue(createTaskResult({ status: "running" })),
      buildMonitorFromTaskResult: (base, task) => ({
        ...base,
        status: task.status,
        stale: undefined,
        retryableStale: undefined,
        message: task.status,
        updatedAt: task.updatedAt,
      }),
      upsertTaskMonitorState: (monitor) => updates.push(monitor),
      onSuccess: vi.fn(),
      onFailed: vi.fn(),
      buildPollingRetryMessage: () => "retry",
      buildPollingUnavailableMessage: () => "unavailable",
      buildTaskNotFoundMessage: () => "unknown",
      buildTimedOutMessage: () => "timeout",
      nowMs: () => now,
      nowIso: () => "2026-07-07T00:00:30.000Z",
      sleepMs: async (ms) => {
        now += ms;
      },
      timeoutMs: 2,
      intervalMs: 1,
    });

    expect(updates.at(-1)).toMatchObject({
      status: "running",
      stale: true,
      retryableStale: false,
      message: "timeout",
    });
  });

  it("write indeterminate 維持 failed wire status，但 lifecycle 不會偽造成 confirmed failed", () => {
    const monitor = resolveTaskMonitorResult(
      createMonitor({
        taskId: "indeterminate-task",
        status: "running",
        updatedAt: "2026-08-12T06:00:01.000Z",
      }),
      createTaskResult({
        taskId: "indeterminate-task",
        status: "failed",
        updatedAt: "2026-08-12T06:00:05.000Z",
        finishedAt: "2026-08-12T06:00:05.000Z",
        confirmedAt: "2026-08-12T06:00:05.000Z",
        writeIndeterminate: true,
        error: { code: "RAGIC_WRITE_FAILED", message: "write result unknown" },
      }),
      (key) => key
    );

    expect(monitor).toMatchObject({
      status: "failed",
      lifecycleState: "indeterminate",
      confirmedAt: null,
    });
  });
});

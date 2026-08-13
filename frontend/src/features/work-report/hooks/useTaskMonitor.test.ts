import { AxiosError } from "axios";
import { describe, expect, it, vi } from "vitest";
import type { CreateReportTaskResult, WorkReportQueueTask } from "../../../api/workReport";
import { CREATE_TASK_AUTO_CLEAR_MS, CREATE_TASK_STALE_AUTO_CLEAR_MS } from "../constants";
import type { CreateTaskMonitor } from "../types";
import {
  hasAutoClearableTaskMonitors,
  hasTerminalTaskMonitors,
  pollCreateTaskMonitor,
  pruneExpiredTaskMonitors,
  resolveTaskMonitorResult,
} from "./useTaskMonitor";
import { createWorkReportOptimisticMutation } from "../workReportOptimisticMutation";

function createMonitor(
  overrides: Partial<CreateTaskMonitor> & Pick<CreateTaskMonitor, "taskId" | "status" | "updatedAt">
): CreateTaskMonitor {
  return {
    taskId: overrides.taskId,
    formId: overrides.formId ?? "104",
    entryId: overrides.entryId ?? "17382",
    workOrderNo: overrides.workOrderNo ?? "WO-25040537",
    status: overrides.status,
    message: overrides.message ?? "task message",
    updatedAt: overrides.updatedAt,
    kind: overrides.kind ?? "create",
    rowId: overrides.rowId,
    stale: overrides.stale,
    lifecycleState: overrides.lifecycleState,
    acceptedAt: overrides.acceptedAt,
    confirmedAt: overrides.confirmedAt,
    batchCreatedRowIds: overrides.batchCreatedRowIds,
    optimisticMutation: overrides.optimisticMutation,
  };
}

function createTaskResult(
  patch: Partial<CreateReportTaskResult> = {}
): CreateReportTaskResult {
  return {
    taskId: "task-1",
    taskType: "create-report",
    formId: "104",
    entryId: "17382",
    queueKey: "104:17382",
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

describe("resolveTaskMonitorResult", () => {
  it("task terminal 會把 optimistic lifecycle 收斂成 confirmed、rolled-back 或 frozen", () => {
    const optimisticMutation = createWorkReportOptimisticMutation({
      taskId: "task-optimistic",
      mutationId: "mutation-optimistic",
      operation: "work-report-update",
      target: {
        domain: "work-report",
        formId: "104",
        entryId: "17382",
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
          machineId: "W23",
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
      formId: "105",
      workOrderNo: "WO-25040537",
      entryId: "17382",
      rowId: "3001",
      queueKey: "105:17382",
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
      formId: "105",
      workOrderNo: "WO-25040537",
      entryId: "17382",
      rowId: "1001",
      queueKey: "105:17382",
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

describe("pollCreateTaskMonitor", () => {
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
      message: "unknown",
    });
  });

  it("polling 到 deadline 後會轉成 stale 非終態，交給 stale TTL 清除", async () => {
    let now = 0;
    const updates: CreateTaskMonitor[] = [];

    await pollCreateTaskMonitor({
      seedMonitor: createMonitor({
        taskId: "slow-task",
        status: "running",
        updatedAt: "2026-07-07T00:00:00.000Z",
        confirmedAt: "2026-07-07T00:00:01.000Z",
      }),
      fetchTask: vi.fn().mockResolvedValue(createTaskResult({ status: "running" })),
      buildMonitorFromTaskResult: (base, task) => ({
        ...base,
        status: task.status,
        stale: undefined,
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

    const finalUpdate = updates.at(-1);
    expect(finalUpdate).toMatchObject({
      status: "running",
      lifecycleState: "unknown",
      confirmedAt: null,
      stale: true,
      message: "timeout",
    });
    expect(
      pruneExpiredTaskMonitors(
        [finalUpdate!],
        Date.parse("2026-07-07T00:00:30.000Z") + CREATE_TASK_STALE_AUTO_CLEAR_MS
      )
    ).toEqual([]);
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

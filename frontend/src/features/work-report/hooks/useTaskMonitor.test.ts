import { AxiosError } from "axios";
import { describe, expect, it, vi } from "vitest";
import type { CreateReportTaskResult } from "../../../api/workReport";
import { CREATE_TASK_AUTO_CLEAR_MS, CREATE_TASK_STALE_AUTO_CLEAR_MS } from "../constants";
import type { CreateTaskMonitor } from "../types";
import {
  hasAutoClearableTaskMonitors,
  hasTerminalTaskMonitors,
  pollCreateTaskMonitor,
  pruneExpiredTaskMonitors,
} from "./useTaskMonitor";

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
});

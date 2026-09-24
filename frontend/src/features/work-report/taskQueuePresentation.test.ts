import { describe, expect, it } from "vitest";
import type { WorkReportQueueTask } from "../../api/workReport";
import {
  getBatchTaskProgress,
  getTaskQueuePollIntervalMs,
  isObservedTaskFailure,
  summarizeTaskQueue,
} from "./taskQueuePresentation";

function buildTask(overrides: Partial<WorkReportQueueTask> = {}): WorkReportQueueTask {
  return {
    taskId: "task-1",
    taskType: "create-report-batch",
    status: "running",
    formId: "901",
    workOrderNo: "WO-1",
    entryId: "entry-1",
    rowId: null,
    queueKey: "901:entry-1",
    createdAt: "2026-09-11T00:00:00.000Z",
    startedAt: "2026-09-11T00:00:00.000Z",
    finishedAt: null,
    updatedAt: "2026-09-11T00:00:01.000Z",
    message: null,
    errorCode: null,
    errorMessage: null,
    actorClientId: null,
    actorTabId: null,
    actorIp: null,
    actorLabel: null,
    source: null,
    ...overrides,
  };
}

describe("taskQueuePresentation", () => {
  it("does not show row progress for finalize-only tasks without a row workload", () => {
    expect(getBatchTaskProgress(buildTask({
      status: "success",
      batchRequestedCount: null,
      batchCreatedCount: 3,
      batchFailedCount: 0,
    }))).toBeNull();
  });

  it("uses structured batch counts for progress", () => {
    expect(
      getBatchTaskProgress(
        buildTask({
          batchRequestedCount: 6,
          batchCreatedCount: 3,
          batchFailedCount: 1,
          batchCreatedRowIds: ["1", "2", "3"],
        })
      )
    ).toEqual({
      processedCount: 4,
      requestedCount: 6,
      createdCount: 3,
      failedCount: 1,
      percent: 67,
    });
  });

  it("falls back to created row ids for older partial task data", () => {
    expect(
      getBatchTaskProgress(
        buildTask({
          batchRequestedCount: 4,
          batchCreatedRowIds: ["1", "2"],
        })
      )
    ).toMatchObject({
      processedCount: 2,
      createdCount: 2,
      requestedCount: 4,
    });
  });

  it("uses low-frequency fallback when SSE is connected", () => {
    expect(getTaskQueuePollIntervalMs(false)).toBe(5_000);
    expect(getTaskQueuePollIntervalMs(true)).toBe(30_000);
  });

  it("summarizes visible task states", () => {
    expect(
      summarizeTaskQueue([
        buildTask({ taskId: "pending", status: "pending" }),
        buildTask({ taskId: "running", status: "running" }),
        buildTask({ taskId: "success", status: "success" }),
        buildTask({ taskId: "failed", status: "failed" }),
      ])
    ).toEqual({ activeCount: 2, successCount: 1, failedCount: 1, observedCount: 0 });
  });

  it("keeps observed failures separate from successful writes and unresolved failures", () => {
    const observed = buildTask({ status: "failed", scheduleMutationObservedAt: "2026-09-24T01:00:00Z", writeIndeterminate: false });
    expect(isObservedTaskFailure(observed)).toBe(true);
    const unresolved = [
      buildTask({ status: "failed" }),
      { ...observed, writeIndeterminate: true },
      { ...observed, lifecycleState: "indeterminate" as const },
      { ...observed, lifecycleState: "unknown" as const },
    ];
    for (const task of unresolved) expect(isObservedTaskFailure(task)).toBe(false);
    expect(summarizeTaskQueue([observed, ...unresolved])).toEqual({
      activeCount: 0, successCount: 0, failedCount: 4, observedCount: 1,
    });
  });
});

import type { WorkReportQueueTask } from "../../api/workReport";

export interface BatchTaskProgress {
  processedCount: number;
  requestedCount: number;
  createdCount: number;
  failedCount: number;
  percent: number;
}

export function isTaskActive(task: Pick<WorkReportQueueTask, "status">): boolean {
  return task.status === "pending" || task.status === "running";
}

export function isMutationQueueTask(
  task: Pick<WorkReportQueueTask, "taskType">
): boolean {
  return (
    task.taskType === "create-report" ||
    task.taskType === "update-report" ||
    task.taskType === "create-report-batch" ||
    task.taskType === "delete-report" ||
    task.taskType === "delete-report-batch"
  );
}

export function getBatchTaskProgress(
  task: Pick<
    WorkReportQueueTask,
    | "taskType"
    | "batchRequestedCount"
    | "batchCreatedCount"
    | "batchFailedCount"
    | "batchCreatedRowIds"
  >
): BatchTaskProgress | null {
  if (
    task.taskType !== "create-report-batch" ||
    typeof task.batchRequestedCount !== "number" ||
    task.batchRequestedCount <= 0
  ) {
    return null;
  }

  const requestedCount = Math.max(1, Math.trunc(task.batchRequestedCount));
  const createdCount = Math.min(
    requestedCount,
    Math.max(
      0,
      Math.trunc(
        typeof task.batchCreatedCount === "number"
          ? task.batchCreatedCount
          : task.batchCreatedRowIds?.length ?? 0
      )
    )
  );
  const failedCount = Math.min(
    requestedCount - createdCount,
    Math.max(0, Math.trunc(task.batchFailedCount ?? 0))
  );
  const processedCount = Math.min(requestedCount, createdCount + failedCount);

  return {
    processedCount,
    requestedCount,
    createdCount,
    failedCount,
    percent: Math.round((processedCount / requestedCount) * 100),
  };
}

export function summarizeTaskQueue(tasks: WorkReportQueueTask[]): {
  activeCount: number;
  successCount: number;
  failedCount: number;
} {
  return tasks.reduce(
    (summary, task) => {
      if (isTaskActive(task)) {
        summary.activeCount += 1;
      } else if (task.status === "success") {
        summary.successCount += 1;
      } else if (task.status === "failed") {
        summary.failedCount += 1;
      }
      return summary;
    },
    { activeCount: 0, successCount: 0, failedCount: 0 }
  );
}

export function getTaskQueuePollIntervalMs(
  connected = false,
): number {
  return connected ? 30_000 : 5_000;
}

import type { DowntimeQueueTask, DowntimeTaskStatus } from "../../api/downtime";

export function isDowntimeTaskRunning(status: DowntimeTaskStatus): boolean {
  return status === "pending" || status === "running";
}

export function isDowntimeCreateQueueTask(
  task: Pick<DowntimeQueueTask, "taskType">
): boolean {
  return task.taskType === "create-downtime";
}

export function isDowntimeSynchronousMutationRecord(
  task: Pick<DowntimeQueueTask, "taskType">
): boolean {
  return task.taskType === "update-downtime" || task.taskType === "delete-downtime";
}

export function isRetryableDowntimeCreateTask(
  task: Pick<DowntimeQueueTask, "taskType" | "status">
): boolean {
  return isDowntimeCreateQueueTask(task) && task.status === "failed";
}

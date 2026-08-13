import type { DowntimeQueueTask, DowntimeTaskStatus } from "../../api/downtime";

const INDETERMINATE_DOWNTIME_CREATE_ERROR_CODES = new Set([
  "FORM16_WRITE_INDETERMINATE",
  "RAGIC_ACTION_BUTTON_INDETERMINATE",
  "RAGIC_WRITE_FAILED",
  "RAGIC_WRITE_GONE",
  "RAGIC_WRITE_ROLLBACK_DELETED",
  "RAGIC_WRITE_ROLLBACK_UNCONFIRMED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNABORTED",
  "EPIPE",
]);

type DowntimeCreateRetryCandidate = Pick<
  DowntimeQueueTask,
  "taskType" | "status"
> & {
  errorCode?: string | null;
  writeIndeterminate?: boolean | null;
};

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
  task: DowntimeCreateRetryCandidate
): boolean {
  return (
    isDowntimeCreateQueueTask(task) &&
    task.status === "failed" &&
    !isIndeterminateDowntimeCreateTask(task)
  );
}

export function isIndeterminateDowntimeCreateTask(
  task: DowntimeCreateRetryCandidate
): boolean {
  if (!isDowntimeCreateQueueTask(task) || task.status !== "failed") {
    return false;
  }
  if (task.writeIndeterminate === true) {
    return true;
  }
  if (task.writeIndeterminate === false) {
    return false;
  }
  return INDETERMINATE_DOWNTIME_CREATE_ERROR_CODES.has(
    String(task.errorCode ?? "").trim()
  );
}

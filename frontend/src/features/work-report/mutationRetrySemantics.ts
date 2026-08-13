import type { WorkReportQueueTask } from "../../api/workReport";

const LEGACY_INDETERMINATE_CREATE_ERROR_CODES = new Set([
  "FORM16_WRITE_INDETERMINATE",
  "RAGIC_ACTION_BUTTON_INDETERMINATE",
  "RAGIC_WRITE_FAILED",
]);

export function isCreateMutationWriteIndeterminate(
  task: Pick<WorkReportQueueTask, "taskType" | "writeIndeterminate" | "errorCode">
): boolean {
  if (task.taskType !== "create-report") {
    return false;
  }
  if (task.writeIndeterminate === true) {
    return true;
  }
  if (task.writeIndeterminate === false) {
    return false;
  }
  return LEGACY_INDETERMINATE_CREATE_ERROR_CODES.has(
    String(task.errorCode ?? "").trim()
  );
}

export function isEntryLevelUpdateWithoutRetryPayload(
  task: Pick<WorkReportQueueTask, "taskType" | "rowId">,
  retryRowId?: string
): boolean {
  return (
    task.taskType === "update-report" &&
    !String(task.rowId ?? "").trim() &&
    !String(retryRowId ?? "").trim()
  );
}

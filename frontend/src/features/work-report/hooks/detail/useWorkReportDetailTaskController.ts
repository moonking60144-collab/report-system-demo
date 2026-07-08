import { useCallback, useMemo } from "react";
import {
  fetchCreateReportTask,
  fetchWorkReportQueueTask,
  type CreateReportTaskResult,
  type CreateReportTaskStatus,
  type WorkReportQueueTask,
} from "../../../../api/workReport";
import type { WorkReportFrontendEventAction } from "../../debug/workReportDeveloperContract";
import type { CreateTaskMonitor, WorkReportFormId, WorkReportMutationTaskKind } from "../../types";
import { deleteRetryableMutationRecord } from "../../taskRetryStore";
import { getWorkReportTaskErrorMessage } from "../../utils";

interface AcceptedMutationTask {
  taskId: string;
  status: CreateReportTaskStatus;
  createdAt: string;
  rowId?: string;
}

type AcceptedMutationTaskResult = CreateReportTaskResult | WorkReportQueueTask;

interface UseWorkReportDetailTaskControllerArgs {
  formId: WorkReportFormId | null;
  safeEntryId: string | null;
  workOrderNo?: unknown;
  createTaskMonitors: CreateTaskMonitor[];
  upsertCreateTaskMonitor: (task: CreateTaskMonitor) => void;
  logDetailEvent: (
    category: "task",
    action: WorkReportFrontendEventAction,
    summary: string,
    options?: {
      level?: "info" | "warn" | "error";
      rowId?: string;
      taskId?: string;
      meta?: Record<string, string | number | boolean | null | undefined | string[]>;
    }
  ) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

function isMutationTaskActive(task: Pick<CreateTaskMonitor, "status" | "stale">): boolean {
  return task.stale !== true && (task.status === "pending" || task.status === "running");
}

function isQueueTask(kind: WorkReportMutationTaskKind): boolean {
  return kind === "delete" || kind === "delete-batch";
}

function isWorkReportQueueTaskResult(task: AcceptedMutationTaskResult): task is WorkReportQueueTask {
  return "errorMessage" in task;
}

export async function fetchAcceptedMutationTaskResult(
  kind: WorkReportMutationTaskKind,
  formId: string,
  taskId: string
): Promise<AcceptedMutationTaskResult> {
  if (isQueueTask(kind)) {
    return fetchWorkReportQueueTask(formId, taskId);
  }
  return fetchCreateReportTask(formId, taskId);
}

function getTerminalTaskRowId(
  task: AcceptedMutationTaskResult,
  accepted: AcceptedMutationTask,
  rowId?: string
): string | undefined {
  if (isWorkReportQueueTaskResult(task)) {
    return task.rowId ?? accepted.rowId ?? rowId;
  }
  return task.result?.rowId ?? accepted.rowId ?? rowId;
}

function getTerminalTaskErrorMessage(task: AcceptedMutationTaskResult): string {
  return getWorkReportTaskErrorMessage(task);
}

function getTerminalTaskSuccessMessage(
  kind: WorkReportMutationTaskKind,
  task: AcceptedMutationTaskResult,
  rowId: string | undefined,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  if ((kind === "delete" || kind === "delete-batch") && isWorkReportQueueTaskResult(task) && task.message) {
    return task.message;
  }
  if (kind === "update") {
    return t("workReport:messages.taskBackgroundUpdatedWithRow", {
      rowId: rowId ?? "-",
    });
  }
  return t("workReport:messages.taskBackgroundCompletedWithRow", {
    rowId: rowId ?? "-",
  });
}

function compareMonitorUpdatedAtDesc(left: CreateTaskMonitor, right: CreateTaskMonitor): number {
  const leftTime = Date.parse(left.updatedAt);
  const rightTime = Date.parse(right.updatedAt);
  if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) {
    return 0;
  }
  if (Number.isNaN(leftTime)) {
    return 1;
  }
  if (Number.isNaN(rightTime)) {
    return -1;
  }
  return rightTime - leftTime;
}

export function useWorkReportDetailTaskController({
  formId,
  safeEntryId,
  workOrderNo,
  createTaskMonitors,
  upsertCreateTaskMonitor,
  logDetailEvent,
  t,
}: UseWorkReportDetailTaskControllerArgs) {
  const currentEntryTaskMonitors = useMemo(
    () =>
      createTaskMonitors
        .filter((item) => item.formId === (formId ?? "") && item.entryId === safeEntryId)
        .sort(compareMonitorUpdatedAtDesc),
    [createTaskMonitors, formId, safeEntryId]
  );
  const activeMutationTasks = useMemo(
    () => currentEntryTaskMonitors.filter((item) => isMutationTaskActive(item)),
    [currentEntryTaskMonitors]
  );
  const activeMutationTask = activeMutationTasks[0] ?? null;
  const activeMutationTaskCount = activeMutationTasks.length;
  const hasActiveMutationTask = activeMutationTaskCount > 0;
  const hasBlockingMutationTask = activeMutationTasks.some((task) => task.kind !== "create");

  const buildTaskMonitor = useCallback(
    (
      kind: WorkReportMutationTaskKind,
      taskId: string,
      status: CreateReportTaskStatus,
      message: string,
      rowId?: string
    ): CreateTaskMonitor => ({
      taskId,
      kind,
      formId: formId ?? "",
      entryId: safeEntryId ?? "",
      workOrderNo: String(workOrderNo ?? safeEntryId ?? ""),
      status,
      message,
      updatedAt: new Date().toISOString(),
      rowId,
    }),
    [formId, safeEntryId, workOrderNo]
  );

  const registerAcceptedMutationTask = useCallback(
    async (
      kind: WorkReportMutationTaskKind,
      accepted: AcceptedMutationTask,
      rowId?: string
    ): Promise<void> => {
      if (!formId) {
        return;
      }

      if (accepted.status === "success" || accepted.status === "failed") {
        const task = await fetchAcceptedMutationTaskResult(kind, formId, accepted.taskId);
        const terminalRowId = getTerminalTaskRowId(task, accepted, rowId);
        logDetailEvent(
          "task",
          "accepted-mutation-task-registered",
          task.status === "failed" ? "背景任務已完成，但結果失敗" : "背景任務已完成並回寫列結果",
          {
            level: task.status === "failed" ? "error" : "info",
            rowId: terminalRowId,
            taskId: task.taskId,
            meta: {
              kind,
              result: task.status,
            },
          }
        );
        upsertCreateTaskMonitor(
          buildTaskMonitor(
            kind,
            task.taskId,
            task.status,
            task.status === "success"
              ? getTerminalTaskSuccessMessage(kind, task, terminalRowId, t)
              : t("workReport:messages.backgroundProcessingFailedWithError", {
                  error:
                    getTerminalTaskErrorMessage(task) ||
                    t("workReport:messages.backgroundProcessingFailedDefault"),
                }),
            terminalRowId
          )
        );
        if (task.status === "success") {
          deleteRetryableMutationRecord(task.taskId);
        }
        return;
      }

      logDetailEvent("task", "accepted-mutation-task-registered", "背景任務已受理", {
        rowId,
        taskId: accepted.taskId,
        meta: {
          kind,
          result: accepted.status,
        },
      });
      upsertCreateTaskMonitor(
        buildTaskMonitor(
          kind,
          accepted.taskId,
          accepted.status,
          kind === "create"
            ? accepted.status === "pending"
              ? t("workReport:messages.createTaskQueuedContinue")
              : t("workReport:messages.createTaskBackgroundRunning")
            : kind === "delete" || kind === "delete-batch"
              ? accepted.status === "pending"
                ? t("workReport:messages.taskQueuedWaitingPrevious")
                : t("workReport:messages.deleteTaskBackgroundRunning")
            : accepted.status === "pending"
              ? t("workReport:messages.taskQueuedWaitingPrevious")
              : t("workReport:messages.taskBackgroundRecalcRunning"),
          rowId
        )
      );
    },
    [buildTaskMonitor, formId, logDetailEvent, t, upsertCreateTaskMonitor]
  );

  return {
    currentEntryTaskMonitors,
    activeMutationTask,
    activeMutationTaskCount,
    hasActiveMutationTask,
    hasBlockingMutationTask,
    registerAcceptedMutationTask,
  };
}

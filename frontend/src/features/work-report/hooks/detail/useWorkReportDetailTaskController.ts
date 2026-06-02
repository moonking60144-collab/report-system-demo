import { useCallback, useMemo } from "react";
import { fetchCreateReportTask, type CreateReportTaskAcceptedResult, type CreateReportTaskStatus } from "../../../../api/workReport";
import type { WorkReportFrontendEventAction } from "../../debug/workReportDeveloperContract";
import type { CreateTaskMonitor, WorkReportFormId, WorkReportMutationTaskKind } from "../../types";
import { deleteRetryableMutationRecord } from "../../taskRetryStore";

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

function isMutationTaskActive(status: CreateReportTaskStatus): boolean {
  return status === "pending" || status === "running";
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
    () => currentEntryTaskMonitors.filter((item) => isMutationTaskActive(item.status)),
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
      accepted: CreateReportTaskAcceptedResult,
      rowId?: string
    ): Promise<void> => {
      if (!formId) {
        return;
      }

      if (accepted.status === "success" || accepted.status === "failed") {
        const task = await fetchCreateReportTask(formId, accepted.taskId);
        const terminalRowId = task.result?.rowId ?? accepted.rowId ?? rowId;
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
              ? kind === "update"
                ? t("workReport:messages.taskBackgroundUpdatedWithRow", {
                    rowId: terminalRowId ?? "-",
                  })
                : t("workReport:messages.taskBackgroundCompletedWithRow", {
                    rowId: terminalRowId ?? "-",
                  })
              : t("workReport:messages.backgroundProcessingFailedWithError", {
                  error:
                    String(task.error?.message ?? "").trim() ||
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { message } from "antd";
import { useTranslation } from "react-i18next";
import { fetchCreateReportTask, type CreateReportTaskResult } from "../../../api/workReport";
import {
  CREATE_TASK_AUTO_CLEAR_MS,
  CREATE_TASK_POLL_INTERVAL_MS,
  CREATE_TASK_POLL_TIMEOUT_MS,
  MAX_CREATE_TASK_MONITORS,
  WORK_REPORT_TASK_MONITOR_STORAGE_KEY,
} from "../constants";
import type { CreateTaskMonitor } from "../types";
import { getErrorMessage } from "../utils";
import type { WorkReportMutationTaskKind } from "../types";
import { deleteRetryableMutationRecord } from "../taskRetryStore";

function isTaskRunning(status: CreateTaskMonitor["status"]): boolean {
  return status === "pending" || status === "running";
}

function readStoredTaskMonitors(): CreateTaskMonitor[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(WORK_REPORT_TASK_MONITOR_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    const now = Date.now();
    return parsed
      .filter((item): item is CreateTaskMonitor => {
        if (!item || typeof item !== "object") {
          return false;
        }
        const candidate = item as Partial<CreateTaskMonitor>;
        return (
          typeof candidate.taskId === "string" &&
          typeof candidate.formId === "string" &&
          typeof candidate.entryId === "string" &&
          typeof candidate.workOrderNo === "string" &&
          typeof candidate.status === "string" &&
          typeof candidate.message === "string" &&
          typeof candidate.updatedAt === "string"
        );
      })
      .filter((item) => {
        if (isTaskRunning(item.status)) {
          return true;
        }
        const updatedAt = Date.parse(item.updatedAt);
        return !Number.isNaN(updatedAt) && now - updatedAt < CREATE_TASK_AUTO_CLEAR_MS;
      })
      .map((item) => ({
        ...item,
        kind: item.kind ?? "create",
      }))
      .slice(0, MAX_CREATE_TASK_MONITORS);
  } catch {
    return [];
  }
}

function writeStoredTaskMonitors(monitors: CreateTaskMonitor[]): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (monitors.length === 0) {
      window.localStorage.removeItem(WORK_REPORT_TASK_MONITOR_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(
      WORK_REPORT_TASK_MONITOR_STORAGE_KEY,
      JSON.stringify(monitors)
    );
  } catch {
    // NOTE: localStorage 寫入失敗不阻塞主流程
  }
}

export function useTaskMonitor() {
  const { t } = useTranslation(["workReport", "common"]);
  const [createTaskMonitors, setCreateTaskMonitors] = useState<CreateTaskMonitor[]>(() =>
    readStoredTaskMonitors()
  );
  const [taskMonitorExpanded, setTaskMonitorExpanded] = useState(false);
  const trackingTaskIdsRef = useRef(new Set<string>());

  const upsertTaskMonitorState = useCallback((nextMonitor: CreateTaskMonitor): void => {
    setCreateTaskMonitors((prev) => {
      const index = prev.findIndex((item) => item.taskId === nextMonitor.taskId);
      if (index === -1) {
        return [nextMonitor, ...prev].slice(0, MAX_CREATE_TASK_MONITORS);
      }
      const next = [...prev];
      next[index] = {
        ...next[index],
        ...nextMonitor,
      };
      return next;
    });
  }, []);

  const buildMonitorFromTaskResult = useCallback(
    (baseMonitor: CreateTaskMonitor, task: CreateReportTaskResult): CreateTaskMonitor => {
      const kind: WorkReportMutationTaskKind = baseMonitor.kind ?? "create";
      if (task.status === "pending" || task.status === "running") {
        return {
          ...baseMonitor,
          kind,
          status: task.status,
          message:
            kind === "create"
              ? task.status === "pending"
                ? t("workReport:messages.createTaskQueuedContinue")
                : t("workReport:messages.createTaskBackgroundRunning")
              : task.status === "pending"
                ? t("workReport:messages.taskQueuedWaitingPrevious")
                : t("workReport:messages.taskBackgroundRecalcRunning"),
          updatedAt: task.updatedAt ?? new Date().toISOString(),
        };
      }

      if (task.status === "success") {
        const rowId = task.result?.rowId ?? baseMonitor.rowId ?? "-";
        return {
          ...baseMonitor,
          kind,
          status: "success",
          rowId,
          message:
            kind === "update"
              ? t("workReport:messages.taskBackgroundUpdatedWithRow", { rowId })
              : t("workReport:messages.taskBackgroundCompletedWithRow", { rowId }),
          updatedAt: task.updatedAt ?? new Date().toISOString(),
        };
      }

      const detail =
        String(task.error?.message ?? "").trim() ||
        t("workReport:messages.backgroundProcessingFailedDefault");
      return {
        ...baseMonitor,
        kind,
        status: "failed",
        message: t("workReport:messages.backgroundProcessingFailedWithError", { error: detail }),
        updatedAt: task.updatedAt ?? new Date().toISOString(),
      };
    },
    [t]
  );

  const trackCreateTask = useCallback(
    (seedMonitor: CreateTaskMonitor): void => {
      if (!isTaskRunning(seedMonitor.status)) {
        return;
      }
      if (trackingTaskIdsRef.current.has(seedMonitor.taskId)) {
        return;
      }

      trackingTaskIdsRef.current.add(seedMonitor.taskId);

      const run = async () => {
        const startedAt = Date.now();
        let currentMonitor = seedMonitor;

        try {
          while (Date.now() - startedAt <= CREATE_TASK_POLL_TIMEOUT_MS) {
            const task = await fetchCreateReportTask(currentMonitor.formId, currentMonitor.taskId);
            const nextMonitor = buildMonitorFromTaskResult(currentMonitor, task);
            upsertTaskMonitorState(nextMonitor);
            currentMonitor = nextMonitor;

            if (!isTaskRunning(nextMonitor.status)) {
              if (nextMonitor.status === "success") {
                deleteRetryableMutationRecord(nextMonitor.taskId);
                void message.success(
                  nextMonitor.kind === "update"
                    ? t("workReport:messages.toastUpdateSuccess", {
                        rowId: nextMonitor.rowId ?? "-",
                      })
                    : t("workReport:messages.toastCreateSuccess", {
                        rowId: nextMonitor.rowId ?? "-",
                      })
                );
              } else if (nextMonitor.status === "failed") {
                void message.error(nextMonitor.message);
              }
              return;
            }

            await new Promise<void>((resolve) => {
              window.setTimeout(resolve, CREATE_TASK_POLL_INTERVAL_MS);
            });
          }

          upsertTaskMonitorState({
            ...currentMonitor,
            kind: currentMonitor.kind ?? "create",
            status: "failed",
            message: t("workReport:messages.backgroundProcessingTimedOut"),
            updatedAt: new Date().toISOString(),
          });
        } catch (error) {
          upsertTaskMonitorState({
            ...currentMonitor,
            kind: currentMonitor.kind ?? "create",
            status: "failed",
            message: t("workReport:messages.backgroundPollingFailed", {
              error: getErrorMessage(error),
            }),
            updatedAt: new Date().toISOString(),
          });
        } finally {
          trackingTaskIdsRef.current.delete(seedMonitor.taskId);
        }
      };

      void run();
    },
    [buildMonitorFromTaskResult, t, upsertTaskMonitorState]
  );

  const upsertCreateTaskMonitor = useCallback(
    (nextMonitor: CreateTaskMonitor): void => {
      upsertTaskMonitorState(nextMonitor);
      trackCreateTask(nextMonitor);
    },
    [trackCreateTask, upsertTaskMonitorState]
  );

  const clearFinishedTaskMonitors = useCallback((): void => {
    setCreateTaskMonitors((prev) =>
      prev.filter((item) => item.status === "pending" || item.status === "running")
    );
  }, []);

  useEffect(() => {
    if (createTaskMonitors.length === 0) {
      return;
    }

    const timer = window.setTimeout(() => {
      const now = Date.now();
      setCreateTaskMonitors((prev) =>
        prev.filter((item) => {
          if (item.status === "pending" || item.status === "running") {
            return true;
          }
          const updatedAt = Date.parse(item.updatedAt);
          if (Number.isNaN(updatedAt)) {
            return false;
          }
          return now - updatedAt < CREATE_TASK_AUTO_CLEAR_MS;
        })
      );
    }, 1000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [createTaskMonitors]);

  useEffect(() => {
    writeStoredTaskMonitors(createTaskMonitors);
  }, [createTaskMonitors]);

  useEffect(() => {
    for (const monitor of createTaskMonitors) {
      if (isTaskRunning(monitor.status)) {
        trackCreateTask(monitor);
      }
    }
  }, [createTaskMonitors, trackCreateTask]);

  const hasFinishedTaskMonitors = useMemo(
    () => createTaskMonitors.some((item) => item.status === "success" || item.status === "failed"),
    [createTaskMonitors]
  );
  const taskRunningCount = useMemo(
    () => createTaskMonitors.filter((item) => item.status === "pending" || item.status === "running").length,
    [createTaskMonitors]
  );
  const taskFailedCount = useMemo(
    () => createTaskMonitors.filter((item) => item.status === "failed").length,
    [createTaskMonitors]
  );
  const latestTaskMonitor = useMemo(
    () =>
      createTaskMonitors.reduce<CreateTaskMonitor | null>((latest, current) => {
        if (!latest) {
          return current;
        }
        const latestTime = Date.parse(latest.updatedAt);
        const currentTime = Date.parse(current.updatedAt);
        if (Number.isNaN(latestTime) || Number.isNaN(currentTime)) {
          return latest;
        }
        return currentTime > latestTime ? current : latest;
      }, null),
    [createTaskMonitors]
  );

  const toggleTaskMonitorExpanded = useCallback(() => {
    setTaskMonitorExpanded((prev) => !prev);
  }, []);

  const collapseTaskMonitor = useCallback(() => {
    setTaskMonitorExpanded(false);
  }, []);

  return {
    createTaskMonitors,
    taskMonitorExpanded: createTaskMonitors.length > 0 && taskMonitorExpanded,
    setTaskMonitorExpanded,
    toggleTaskMonitorExpanded,
    collapseTaskMonitor,
    upsertCreateTaskMonitor,
    clearFinishedTaskMonitors,
    hasFinishedTaskMonitors,
    taskRunningCount,
    taskFailedCount,
    latestTaskMonitor,
  };
}

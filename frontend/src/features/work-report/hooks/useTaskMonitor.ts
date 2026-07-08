import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { message } from "antd";
import { AxiosError } from "axios";
import { useTranslation } from "react-i18next";
import {
  fetchCreateReportTask,
  fetchWorkReportQueueTask,
  type CreateReportTaskResult,
  type WorkReportQueueTask,
} from "../../../api/workReport";
import {
  CREATE_TASK_AUTO_CLEAR_MS,
  CREATE_TASK_POLL_INTERVAL_MS,
  CREATE_TASK_POLL_TIMEOUT_MS,
  CREATE_TASK_STALE_AUTO_CLEAR_MS,
  MAX_CREATE_TASK_MONITORS,
  WORK_REPORT_TASK_MONITOR_STORAGE_KEY,
} from "../constants";
import type { CreateTaskMonitor } from "../types";
import { getErrorMessage, getWorkReportTaskErrorMessage } from "../utils";
import type { WorkReportMutationTaskKind } from "../types";
import { deleteRetryableMutationRecord } from "../taskRetryStore";

function isTaskRunning(status: CreateTaskMonitor["status"]): boolean {
  return status === "pending" || status === "running";
}

function isMonitorRunning(monitor: CreateTaskMonitor): boolean {
  return isTaskRunning(monitor.status) && monitor.stale !== true;
}

function isQueueTask(kind: WorkReportMutationTaskKind): boolean {
  return kind === "delete" || kind === "delete-batch";
}

function getApiErrorCode(error: unknown): string | null {
  if (!(error instanceof AxiosError)) {
    return null;
  }
  const code = error.response?.data?.error?.code;
  return typeof code === "string" ? code : null;
}

function isTaskNotFoundError(error: unknown): boolean {
  return getApiErrorCode(error) === "TASK_NOT_FOUND";
}

function isWorkReportQueueTask(task: CreateReportTaskResult | WorkReportQueueTask): task is WorkReportQueueTask {
  return "taskType" in task;
}

function getTaskRowId(task: CreateReportTaskResult | WorkReportQueueTask): string | undefined {
  return isWorkReportQueueTask(task) ? task.rowId ?? undefined : task.result?.rowId;
}

function getTaskErrorMessage(task: CreateReportTaskResult | WorkReportQueueTask): string {
  if (isWorkReportQueueTask(task)) {
    return getWorkReportTaskErrorMessage(task);
  }
  return getWorkReportTaskErrorMessage(task);
}

function getRunningTaskMessage(
  kind: WorkReportMutationTaskKind,
  status: CreateTaskMonitor["status"],
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  if (kind === "create") {
    return status === "pending"
      ? t("workReport:messages.createTaskQueuedContinue")
      : t("workReport:messages.createTaskBackgroundRunning");
  }
  if (kind === "delete" || kind === "delete-batch") {
    return status === "pending"
      ? t("workReport:messages.taskQueuedWaitingPrevious")
      : t("workReport:messages.deleteTaskBackgroundRunning");
  }
  return status === "pending"
    ? t("workReport:messages.taskQueuedWaitingPrevious")
    : t("workReport:messages.taskBackgroundRecalcRunning");
}

function getSuccessTaskMessage(
  kind: WorkReportMutationTaskKind,
  task: CreateReportTaskResult | WorkReportQueueTask,
  rowId: string,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  if ((kind === "delete" || kind === "delete-batch") && "message" in task && task.message) {
    return task.message;
  }
  if (kind === "update") {
    return t("workReport:messages.taskBackgroundUpdatedWithRow", { rowId });
  }
  return t("workReport:messages.taskBackgroundCompletedWithRow", { rowId });
}

function getSuccessToastMessage(
  monitor: CreateTaskMonitor,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  if (monitor.kind === "delete" || monitor.kind === "delete-batch") {
    return monitor.message;
  }
  if (monitor.kind === "update") {
    return t("workReport:messages.toastUpdateSuccess", {
      rowId: monitor.rowId ?? "-",
    });
  }
  return t("workReport:messages.toastCreateSuccess", {
    rowId: monitor.rowId ?? "-",
  });
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
      .map((item) => ({
        ...item,
        kind: item.kind ?? "create",
      }))
      .filter((item) => shouldKeepTaskMonitor(item, now))
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

function shouldKeepTaskMonitor(item: CreateTaskMonitor, now: number): boolean {
  if (item.stale === true) {
    const updatedAt = Date.parse(item.updatedAt);
    return !Number.isNaN(updatedAt) && now - updatedAt < CREATE_TASK_STALE_AUTO_CLEAR_MS;
  }
  if (isTaskRunning(item.status)) {
    return true;
  }
  const updatedAt = Date.parse(item.updatedAt);
  return !Number.isNaN(updatedAt) && now - updatedAt < CREATE_TASK_AUTO_CLEAR_MS;
}

export function pruneExpiredTaskMonitors(
  monitors: CreateTaskMonitor[],
  now = Date.now()
): CreateTaskMonitor[] {
  const next = monitors.filter((item) => shouldKeepTaskMonitor(item, now));
  return next.length === monitors.length ? monitors : next;
}

export function hasTerminalTaskMonitors(monitors: CreateTaskMonitor[]): boolean {
  return monitors.some((item) => !isTaskRunning(item.status));
}

export function hasAutoClearableTaskMonitors(monitors: CreateTaskMonitor[]): boolean {
  return monitors.some((item) => item.stale === true || !isTaskRunning(item.status));
}

export async function pollCreateTaskMonitor(options: {
  seedMonitor: CreateTaskMonitor;
  fetchTask: (monitor: CreateTaskMonitor) => Promise<CreateReportTaskResult | WorkReportQueueTask>;
  buildMonitorFromTaskResult: (
    baseMonitor: CreateTaskMonitor,
    task: CreateReportTaskResult | WorkReportQueueTask
  ) => CreateTaskMonitor;
  upsertTaskMonitorState: (monitor: CreateTaskMonitor) => void;
  onSuccess: (monitor: CreateTaskMonitor) => void;
  onFailed: (monitor: CreateTaskMonitor) => void;
  buildPollingRetryMessage: (error: unknown) => string;
  buildPollingUnavailableMessage: (error: unknown) => string;
  buildTaskNotFoundMessage: () => string;
  buildTimedOutMessage: () => string;
  nowMs?: () => number;
  nowIso?: () => string;
  sleepMs?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<void> {
  const nowMs = options.nowMs ?? Date.now;
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const sleepMs =
    options.sleepMs ??
    ((ms) =>
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, ms);
      }));
  const timeoutMs = options.timeoutMs ?? CREATE_TASK_POLL_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? CREATE_TASK_POLL_INTERVAL_MS;
  const startedAt = nowMs();
  let currentMonitor = options.seedMonitor;
  let lastPollingError: unknown = null;

  while (nowMs() - startedAt <= timeoutMs) {
    try {
      const task = await options.fetchTask(currentMonitor);
      lastPollingError = null;
      const nextMonitor = options.buildMonitorFromTaskResult(currentMonitor, task);
      options.upsertTaskMonitorState(nextMonitor);
      currentMonitor = nextMonitor;

      if (!isMonitorRunning(nextMonitor)) {
        if (nextMonitor.status === "success") {
          options.onSuccess(nextMonitor);
        } else if (nextMonitor.status === "failed") {
          options.onFailed(nextMonitor);
        }
        return;
      }
    } catch (error) {
      const nextMonitor: CreateTaskMonitor = {
        ...currentMonitor,
        kind: currentMonitor.kind ?? "create",
        status: currentMonitor.status,
        stale: isTaskNotFoundError(error) ? true : undefined,
        message: isTaskNotFoundError(error)
          ? options.buildTaskNotFoundMessage()
          : options.buildPollingRetryMessage(error),
        updatedAt: nowIso(),
      };
      options.upsertTaskMonitorState(nextMonitor);
      currentMonitor = nextMonitor;
      if (nextMonitor.stale === true) {
        return;
      }
      lastPollingError = error;
    }

    await sleepMs(intervalMs);
  }

  options.upsertTaskMonitorState({
    ...currentMonitor,
    kind: currentMonitor.kind ?? "create",
    status: currentMonitor.status,
    stale: true,
    message: lastPollingError
      ? options.buildPollingUnavailableMessage(lastPollingError)
      : options.buildTimedOutMessage(),
    updatedAt: nowIso(),
  });
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
    (
      baseMonitor: CreateTaskMonitor,
      task: CreateReportTaskResult | WorkReportQueueTask
    ): CreateTaskMonitor => {
      const kind: WorkReportMutationTaskKind = baseMonitor.kind ?? "create";
      if (task.status === "pending" || task.status === "running") {
        return {
          ...baseMonitor,
          kind,
          status: task.status,
          stale: undefined,
          message: getRunningTaskMessage(kind, task.status, t),
          updatedAt: task.updatedAt ?? new Date().toISOString(),
        };
      }

      if (task.status === "success") {
        const rowId = getTaskRowId(task) ?? baseMonitor.rowId ?? "-";
        return {
          ...baseMonitor,
          kind,
          status: "success",
          stale: undefined,
          rowId,
          message: getSuccessTaskMessage(kind, task, rowId, t),
          updatedAt: task.updatedAt ?? new Date().toISOString(),
        };
      }

      const detail =
        getTaskErrorMessage(task) ||
        t("workReport:messages.backgroundProcessingFailedDefault");
      return {
        ...baseMonitor,
        kind,
        status: "failed",
        stale: undefined,
        message: t("workReport:messages.backgroundProcessingFailedWithError", { error: detail }),
        updatedAt: task.updatedAt ?? new Date().toISOString(),
      };
    },
    [t]
  );

  const trackCreateTask = useCallback(
    (seedMonitor: CreateTaskMonitor): void => {
      if (!isMonitorRunning(seedMonitor)) {
        return;
      }
      if (trackingTaskIdsRef.current.has(seedMonitor.taskId)) {
        return;
      }

      trackingTaskIdsRef.current.add(seedMonitor.taskId);

      const run = async () => {
        try {
          await pollCreateTaskMonitor({
            seedMonitor,
            fetchTask: (monitor) =>
              isQueueTask(monitor.kind)
                ? fetchWorkReportQueueTask(monitor.formId, monitor.taskId)
                : fetchCreateReportTask(monitor.formId, monitor.taskId),
            buildMonitorFromTaskResult,
            upsertTaskMonitorState,
            onSuccess: (nextMonitor) => {
              deleteRetryableMutationRecord(nextMonitor.taskId);
              void message.success(getSuccessToastMessage(nextMonitor, t));
            },
            onFailed: (nextMonitor) => {
              void message.error(nextMonitor.message);
            },
            buildPollingRetryMessage: (error) =>
              t("workReport:messages.backgroundPollingRetrying", {
                error: getErrorMessage(error),
              }),
            buildPollingUnavailableMessage: (error) =>
              t("workReport:messages.backgroundPollingUnavailable", {
                error: getErrorMessage(error),
              }),
            buildTaskNotFoundMessage: () => t("workReport:messages.backgroundTaskStatusUnknown"),
            buildTimedOutMessage: () => t("workReport:messages.backgroundProcessingTimedOut"),
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
    setCreateTaskMonitors((prev) => prev.filter((item) => isMonitorRunning(item)));
  }, []);

  useEffect(() => {
    if (!hasAutoClearableTaskMonitors(createTaskMonitors)) {
      return;
    }

    const timer = window.setInterval(() => {
      setCreateTaskMonitors((prev) => pruneExpiredTaskMonitors(prev));
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [createTaskMonitors]);

  useEffect(() => {
    writeStoredTaskMonitors(createTaskMonitors);
  }, [createTaskMonitors]);

  useEffect(() => {
    for (const monitor of createTaskMonitors) {
      if (isMonitorRunning(monitor)) {
        trackCreateTask(monitor);
      }
    }
  }, [createTaskMonitors, trackCreateTask]);

  const hasFinishedTaskMonitors = useMemo(
    () =>
      createTaskMonitors.some(
        (item) => item.status === "success" || item.status === "failed" || item.stale === true
      ),
    [createTaskMonitors]
  );
  const taskRunningCount = useMemo(
    () => createTaskMonitors.filter((item) => isMonitorRunning(item)).length,
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

  return useMemo(
    () => ({
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
    }),
    [
      clearFinishedTaskMonitors,
      collapseTaskMonitor,
      createTaskMonitors,
      hasFinishedTaskMonitors,
      latestTaskMonitor,
      taskFailedCount,
      taskMonitorExpanded,
      taskRunningCount,
      toggleTaskMonitorExpanded,
      upsertCreateTaskMonitor,
    ]
  );
}

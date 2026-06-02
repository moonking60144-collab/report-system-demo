import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { fetchWorkReportSyncStatus, triggerWorkReportSync, type WorkReportSyncTask } from "../../../../api/workReport";
import type {
  WorkReportFrontendEventAction,
  WorkReportFrontendEventCategory,
} from "../../debug/workReportDeveloperContract";
import { calculateDurationMs, createFrontendOperationId } from "../../logging/frontendEventLog";
import { useWorkReportRealtime } from "../useWorkReportRealtime";
import type { NoticeState, WorkReportFormId } from "../../types";

function isSyncTaskStatus(value: unknown): value is WorkReportSyncTask {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.taskId === "string" &&
    typeof candidate.formId === "string" &&
    typeof candidate.status === "string"
  );
}

interface UseWorkReportListRefreshControllerArgs {
  currentFormId: WorkReportFormId;
  shouldUseFullHydrationForList: boolean;
  isStandaloneTopView: boolean;
  loading: boolean;
  isHydratingAllRecords: boolean;
  page: number;
  setPage: Dispatch<SetStateAction<number>>;
  loadReports: (forceRefresh?: boolean, options?: { throwOnError?: boolean }) => Promise<void>;
  hydrateAllRecords: (forceRefresh?: boolean) => Promise<unknown[]>;
  setNotice: Dispatch<SetStateAction<NoticeState | null>>;
  t: (key: string, options?: Record<string, unknown>) => string;
  logListEvent: (
    category: WorkReportFrontendEventCategory,
    action: WorkReportFrontendEventAction,
    summary: string,
    options?: {
      level?: "info" | "warn" | "error";
      entryId?: string;
      rowId?: string;
      taskId?: string;
      clientMutationId?: string;
      operationId?: string;
      operationType?: string;
      phase?: string;
      durationMs?: number;
      startedAt?: string;
      endedAt?: string;
      meta?: Record<string, string | number | boolean | null | undefined | string[]>;
    } | Record<string, string | number | boolean | null | undefined | string[]>,
    level?: "info" | "warn" | "error"
  ) => void;
}

export function useWorkReportListRefreshController({
  currentFormId,
  shouldUseFullHydrationForList,
  isStandaloneTopView,
  loading,
  isHydratingAllRecords,
  page,
  setPage,
  loadReports,
  hydrateAllRecords,
  setNotice,
  t,
  logListEvent,
}: UseWorkReportListRefreshControllerArgs) {
  const [sseNoticeReloadToken, setSseNoticeReloadToken] = useState<string>("");
  const [isSyncingFromRagic, setIsSyncingFromRagic] = useState(false);
  const [refreshSyncTask, setRefreshSyncTask] = useState<WorkReportSyncTask | null>(null);
  const [refreshSyncErrorMessage, setRefreshSyncErrorMessage] = useState<string | null>(null);
  const [refreshSyncModalOpen, setRefreshSyncModalOpen] = useState(false);
  const autoRefreshTimerRef = useRef<number | null>(null);
  const autoRefreshInFlightRef = useRef(false);
  const lastHandledNoticeForceRefreshTokenRef = useRef("");
  const pendingAutoRefreshNoticeMessageRef = useRef<string | null>(null);

  const waitSyncTaskCompleted = useCallback(
    async (
      formId: string,
      taskId: string,
      onProgress?: (task: WorkReportSyncTask) => void
    ): Promise<WorkReportSyncTask | null> => {
      const maxPollCount = 120;
      const pollDelayMs = 1000;

      for (let index = 0; index < maxPollCount; index += 1) {
        const status = await fetchWorkReportSyncStatus(formId);
        if (isSyncTaskStatus(status) && status.taskId === taskId) {
          onProgress?.(status);
          if (status.status === "success" || status.status === "failed") {
            return status;
          }
        }
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, pollDelayMs);
        });
      }
      return null;
    },
    []
  );

  const handleRefresh = useCallback(async (): Promise<void> => {
    if (isSyncingFromRagic) {
      return;
    }
    const operationId = createFrontendOperationId("list-manual-refresh");
    const startedAt = new Date().toISOString();
    logListEvent("api", "manual-refresh-started", "手動刷新同步已啟動", {
      operationId,
      operationType: "list-manual-refresh",
      phase: "started",
      startedAt,
    });

    setRefreshSyncModalOpen(true);
    setRefreshSyncErrorMessage(null);
    setRefreshSyncTask(null);
    setIsSyncingFromRagic(true);
    try {
      logListEvent("api", "manual-refresh-request-started", "手動刷新 sync request 已送出", {
        operationId,
        operationType: "list-manual-refresh",
        phase: "request",
        startedAt,
      });
      const task = await triggerWorkReportSync(currentFormId, {
        async: true,
        triggeredBy: "toolbar-refresh",
      });
      setRefreshSyncTask(task);

      if (!task.accepted) {
        logListEvent(
          "task",
          "manual-refresh-accepted",
          "同步任務已存在，沿用既有背景任務",
          {
            operationId,
            operationType: "list-manual-refresh",
            phase: "accepted-existing-task",
            startedAt,
            taskId: task.taskId,
            meta: {
              result: task.status,
            },
          }
        );
        setNotice({
          type: "success",
          message: t("workReport:messages.syncAlreadyRunning", {
            formId: currentFormId,
          }),
        });
      } else {
        logListEvent(
          "task",
          "manual-refresh-accepted",
          "手動刷新同步任務已受理",
          {
            operationId,
            operationType: "list-manual-refresh",
            phase: "accepted",
            startedAt,
            taskId: task.taskId,
            meta: {
              result: task.status,
            },
          }
        );
        setNotice({
          type: "success",
          message: t("workReport:messages.syncStarted", {
            formId: currentFormId,
          }),
        });
      }

      const completedTask = await waitSyncTaskCompleted(currentFormId, task.taskId, setRefreshSyncTask);
      if (!completedTask) {
        logListEvent(
          "task",
          "manual-refresh-timeout",
          "手動刷新逾時，背景同步仍在進行中",
          {
            level: "error",
            operationId,
            operationType: "list-manual-refresh",
            phase: "timeout",
            startedAt,
          }
        );
        setRefreshSyncErrorMessage(
          t("workReport:messages.syncStillRunning", {
            formId: currentFormId,
          })
        );
        setNotice({
          type: "error",
          message: t("workReport:messages.syncStillRunning", {
            formId: currentFormId,
          }),
        });
        return;
      }

      if (completedTask.status === "failed") {
        logListEvent(
          "task",
          "manual-refresh-failed",
          completedTask.error?.message || "資料同步失敗",
          {
            level: "error",
            operationId,
            operationType: "list-manual-refresh",
            phase: "sync-failed",
            startedAt,
            taskId: completedTask.taskId,
          }
        );
        setRefreshSyncErrorMessage(completedTask.error?.message || "資料同步失敗");
        setNotice({
          type: "error",
          message: completedTask.error?.message || "資料同步失敗",
        });
        return;
      }

      const syncEndedAt = new Date().toISOString();
      logListEvent("task", "manual-refresh-sync-succeeded", "手動刷新 sync 已完成", {
        operationId,
        operationType: "list-manual-refresh",
        phase: "sync-succeeded",
        startedAt,
        endedAt: syncEndedAt,
        durationMs: calculateDurationMs(startedAt, syncEndedAt),
        taskId: completedTask.taskId,
        meta: {
          syncedEntries: completedTask.syncedEntries,
          syncedRows: completedTask.syncedRows,
        },
      });

      logListEvent("api", "manual-refresh-data-refresh-started", "開始刷新列表資料", {
        operationId,
        operationType: "list-manual-refresh",
        phase: "data-refresh",
        startedAt,
        taskId: completedTask.taskId,
      });
      if (shouldUseFullHydrationForList) {
        await hydrateAllRecords(false);
      } else {
        await loadReports(false, { throwOnError: true });
      }
      const endedAt = new Date().toISOString();
      logListEvent("api", "manual-refresh-data-refresh-completed", "列表資料刷新完成", {
        operationId,
        operationType: "list-manual-refresh",
        phase: "data-refresh-completed",
        startedAt,
        endedAt,
        durationMs: calculateDurationMs(startedAt, endedAt),
        taskId: completedTask.taskId,
      });
      logListEvent("api", "manual-refresh-completed", "手動刷新同步完成", {
        operationId,
        operationType: "list-manual-refresh",
        phase: "completed",
        startedAt,
        endedAt,
        durationMs: calculateDurationMs(startedAt, endedAt),
        taskId: completedTask.taskId,
        meta: {
          result: completedTask.status,
        },
      });
      setNotice({
        type: "success",
        message: t("workReport:messages.syncCompleted", {
          count: completedTask.syncedEntries,
        }),
      });
    } catch (error) {
      logListEvent(
        "api",
        "manual-refresh-failed",
        error instanceof Error ? error.message : t("workReport:messages.syncFailedDefault"),
        {
          level: "error",
          operationId,
          operationType: "list-manual-refresh",
          phase: "failed",
          startedAt,
          endedAt: new Date().toISOString(),
        }
      );
      setRefreshSyncErrorMessage(
        error instanceof Error ? error.message : t("workReport:messages.syncFailedDefault")
      );
      setNotice({
        type: "error",
        message: error instanceof Error ? error.message : t("workReport:messages.syncFailedDefault"),
      });
    } finally {
      setIsSyncingFromRagic(false);
    }
  }, [
    currentFormId,
    hydrateAllRecords,
    isSyncingFromRagic,
    loadReports,
    logListEvent,
    setNotice,
    shouldUseFullHydrationForList,
    t,
    waitSyncTaskCompleted,
  ]);

  const handleCloseRefreshSyncModal = useCallback(() => {
    if (refreshSyncTask && (refreshSyncTask.status === "running" || refreshSyncTask.status === "pending")) {
      return;
    }
    setRefreshSyncModalOpen(false);
    setRefreshSyncErrorMessage(null);
  }, [refreshSyncTask]);

  const triggerAutoRefresh = useCallback(
    (options: { noticeMessage?: string; maxJitterMs?: number; resetPageToFirst?: boolean } = {}): void => {
      if (autoRefreshInFlightRef.current || autoRefreshTimerRef.current !== null) {
        if (options.noticeMessage) {
          pendingAutoRefreshNoticeMessageRef.current = options.noticeMessage;
        }
        return;
      }

      const jitterMs = Math.max(0, options.maxJitterMs ?? 1200);
      autoRefreshTimerRef.current = window.setTimeout(() => {
        autoRefreshTimerRef.current = null;
        if (autoRefreshInFlightRef.current) {
          return;
        }
        autoRefreshInFlightRef.current = true;
        const operationId = createFrontendOperationId("list-auto-refresh");
        const startedAt = new Date().toISOString();
        logListEvent("realtime", "auto-refresh-started", "自動刷新已啟動", {
          operationId,
          operationType: "list-auto-refresh",
          phase: "started",
          startedAt,
          meta: {
            resetPageToFirst: options.resetPageToFirst ?? false,
            jitterMs,
          },
        });
        const run = async () => {
          try {
            if (options.resetPageToFirst && page !== 1) {
              setPage(1);
            }
            if (shouldUseFullHydrationForList) {
              await hydrateAllRecords(false);
            } else {
              await loadReports(false);
            }
            const noticeMessage = pendingAutoRefreshNoticeMessageRef.current || options.noticeMessage;
            pendingAutoRefreshNoticeMessageRef.current = null;
            if (noticeMessage) {
              setNotice({
                type: "success",
                message: noticeMessage,
                displayAsHumanStatus: true,
              });
            }
            const endedAt = new Date().toISOString();
            logListEvent("realtime", "auto-refresh-completed", "自動刷新完成", {
              operationId,
              operationType: "list-auto-refresh",
              phase: "completed",
              startedAt,
              endedAt,
              durationMs: calculateDurationMs(startedAt, endedAt),
            });
          } finally {
            autoRefreshInFlightRef.current = false;
          }
        };
        void run();
      }, Math.floor(Math.random() * (jitterMs + 1)));
    },
    [hydrateAllRecords, loadReports, logListEvent, page, setNotice, setPage, shouldUseFullHydrationForList]
  );

  const handleSystemNoticeForceRefresh = useCallback(
    (forceRefreshToken: string): void => {
      const normalizedToken = String(forceRefreshToken ?? "").trim();
      if (!normalizedToken) {
        return;
      }
      if (lastHandledNoticeForceRefreshTokenRef.current === normalizedToken) {
        return;
      }
      lastHandledNoticeForceRefreshTokenRef.current = normalizedToken;
      triggerAutoRefresh({
        noticeMessage: t("workReport:messages.systemNoticeTriggeredAutoRefresh"),
        maxJitterMs: 5000,
        resetPageToFirst: true,
      });
    },
    [t, triggerAutoRefresh]
  );

  const handleRealtimeFormUpdated = useCallback(
    (event: { formId?: string }) => {
      if (String(event.formId ?? "").trim() !== currentFormId) {
        return;
      }
      // SSE 被動觸發不回 page 1：使用者翻頁找資料時不希望被背景 refresh 拉走。
      // 其他觸發源（系統公告強刷、keyword / filter / sort 變化）仍保留 resetPageToFirst。
      triggerAutoRefresh({ maxJitterMs: 1200, resetPageToFirst: false });
    },
    [currentFormId, triggerAutoRefresh]
  );

  const handleRealtimeSystemNoticeForceRefresh = useCallback(
    (event: { forceRefreshToken?: string }) => {
      const token = String(event.forceRefreshToken ?? "").trim();
      if (!token) {
        return;
      }
      handleSystemNoticeForceRefresh(token);
      setSseNoticeReloadToken(token);
    },
    [handleSystemNoticeForceRefresh]
  );

  const { connected: realtimeConnected, disconnectedSince: realtimeDisconnectedSince } = useWorkReportRealtime({
    enabled: !isStandaloneTopView,
    onFormUpdated: handleRealtimeFormUpdated,
    onSystemNoticeForceRefresh: handleRealtimeSystemNoticeForceRefresh,
  });

  useEffect(() => {
    if (isStandaloneTopView) {
      return;
    }
    if (realtimeConnected) {
      logListEvent("realtime", "list-sse-connected", "列表 SSE 已連線", {
        level: "info",
        meta: {
          disconnectedSince: realtimeDisconnectedSince ?? null,
        },
      });
      return;
    }
    if (realtimeDisconnectedSince !== null) {
      logListEvent("realtime", "list-sse-disconnected", "列表 SSE 已斷線", {
        level: "warn",
        meta: {
          disconnectedSince: realtimeDisconnectedSince,
        },
      });
    }
  }, [isStandaloneTopView, logListEvent, realtimeConnected, realtimeDisconnectedSince]);

  useEffect(() => {
    return () => {
      if (autoRefreshTimerRef.current !== null) {
        window.clearTimeout(autoRefreshTimerRef.current);
        autoRefreshTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (isStandaloneTopView || realtimeConnected) {
      return;
    }

    const timer = window.setInterval(() => {
      if (loading || isHydratingAllRecords || autoRefreshInFlightRef.current) {
        return;
      }
      triggerAutoRefresh({ maxJitterMs: 0 });
    }, 60_000);

    return () => {
      window.clearInterval(timer);
    };
  }, [isStandaloneTopView, realtimeConnected, loading, isHydratingAllRecords, triggerAutoRefresh]);

  const tableSoftBusy = useMemo(
    () =>
      isSyncingFromRagic ||
      (loading) ||
      (shouldUseFullHydrationForList && isHydratingAllRecords),
    [isHydratingAllRecords, isSyncingFromRagic, loading, shouldUseFullHydrationForList]
  );

  const tableSoftBusyLabel = useMemo(() => {
    if (isSyncingFromRagic) {
      return t("workReport:status.tableBusy.syncing");
    }
    if (shouldUseFullHydrationForList && isHydratingAllRecords) {
      return t("workReport:status.tableBusy.hydrating");
    }
    if (loading) {
      return t("workReport:status.tableBusy.loading");
    }
    return null;
  }, [isHydratingAllRecords, isSyncingFromRagic, loading, shouldUseFullHydrationForList, t]);

  return {
    sseNoticeReloadToken,
    isSyncingFromRagic,
    refreshSyncTask,
    refreshSyncErrorMessage,
    refreshSyncModalOpen,
    realtimeConnected,
    realtimeDisconnectedSince,
    handleRefresh,
    handleCloseRefreshSyncModal,
    handleSystemNoticeForceRefresh,
    triggerAutoRefresh,
    tableSoftBusy,
    tableSoftBusyLabel,
  };
}

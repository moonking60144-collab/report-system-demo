import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { WorkReportFrontendEventAction } from "../../debug/workReportDeveloperContract";
import { useWorkReportRealtime } from "../useWorkReportRealtime";
import type { LoadEntryOptions } from "./types";

interface DetailNoticeState {
  type: "success" | "error" | "info";
  message: string;
}

interface UseWorkReportDetailRefreshControllerArgs {
  enabled: boolean;
  formId: string | null;
  safeEntryId: string | null;
  modalOpen: boolean;
  editingRowId: string | null;
  hasActiveMutationTask: boolean;
  submitting: boolean;
  loading: boolean;
  refreshing: boolean;
  loadEntry: (options?: LoadEntryOptions) => Promise<void>;
  setNotice: Dispatch<SetStateAction<DetailNoticeState | null>>;
  logDetailEvent: (
    category: "realtime",
    action: WorkReportFrontendEventAction,
    summary: string,
    options?: {
      level?: "info" | "warn" | "error";
      operationId?: string;
      operationType?: string;
      phase?: string;
      durationMs?: number;
      startedAt?: string;
      endedAt?: string;
      meta?: Record<string, string | number | boolean | null | undefined | string[]>;
    }
  ) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

export function useWorkReportDetailRefreshController({
  enabled,
  formId,
  safeEntryId,
  modalOpen,
  editingRowId,
  hasActiveMutationTask,
  submitting,
  loading,
  refreshing,
  loadEntry,
  setNotice,
  logDetailEvent,
  t,
}: UseWorkReportDetailRefreshControllerArgs) {
  const pendingRealtimeRefreshRef = useRef(false);
  const pendingFallbackRefreshRef = useRef(false);

  const runImmediateRefresh = useCallback(() => {
    if (
      modalOpen ||
      editingRowId !== null ||
      hasActiveMutationTask ||
      submitting ||
      loading ||
      refreshing ||
      !formId ||
      !safeEntryId
    ) {
      pendingRealtimeRefreshRef.current = true;
      logDetailEvent("realtime", "refresh-deferred", "即時刷新已延後，等待編輯或背景處理結束", {
        phase: "deferred",
        meta: {
          modalOpen,
          editingRowId: editingRowId ?? null,
          hasActiveMutationTask,
          submitting,
          loading,
          refreshing,
          hasRouteContext: Boolean(formId && safeEntryId),
        },
      });
      setNotice({
        type: "info",
        message: t("workReport:messages.realtimeRefreshDeferredDuringEdit"),
      });
      return;
    }

    pendingRealtimeRefreshRef.current = false;
    logDetailEvent("realtime", "refresh-immediate", "即時刷新立即套用", {
      phase: "immediate",
    });
    void loadEntry({ silent: true, forceRefresh: false });
  }, [
    editingRowId,
    formId,
    hasActiveMutationTask,
    loadEntry,
    loading,
    logDetailEvent,
    modalOpen,
    refreshing,
    safeEntryId,
    setNotice,
    submitting,
    t,
  ]);

  const handleRealtimeEntryUpdated = useCallback(
    (event: { formId?: string; entryId?: string }) => {
      if (!formId || !safeEntryId) {
        return;
      }
      if (String(event.formId ?? "").trim() !== formId) {
        return;
      }
      if (String(event.entryId ?? "").trim() !== safeEntryId) {
        return;
      }
      runImmediateRefresh();
    },
    [formId, runImmediateRefresh, safeEntryId]
  );

  const { connected: realtimeConnected, disconnectedSince: realtimeDisconnectedSince } =
    useWorkReportRealtime({
      enabled,
      onEntryUpdated: handleRealtimeEntryUpdated,
    });

  useEffect(() => {
    if (!enabled) {
      return;
    }
    if (realtimeConnected) {
      logDetailEvent("realtime", "sse-connected", "SSE 已連線", {
        level: "info",
        meta: {
          disconnectedSince: realtimeDisconnectedSince ?? null,
        },
      });
      return;
    }
    if (realtimeDisconnectedSince !== null) {
      logDetailEvent("realtime", "sse-disconnected", "SSE 已斷線", {
        level: "warn",
        meta: {
          disconnectedSince: realtimeDisconnectedSince,
        },
      });
    }
  }, [enabled, logDetailEvent, realtimeConnected, realtimeDisconnectedSince]);

  useEffect(() => {
    if (
      !pendingRealtimeRefreshRef.current ||
      modalOpen ||
      editingRowId !== null ||
      hasActiveMutationTask ||
      submitting ||
      loading ||
      refreshing
    ) {
      return;
    }

    pendingRealtimeRefreshRef.current = false;
    logDetailEvent("realtime", "refresh-applied", "延後的即時刷新已套用", {
      phase: "applied",
    });
    setNotice({
      type: "success",
      message: t("workReport:messages.realtimeRefreshApplied"),
    });
    void loadEntry({ silent: true, forceRefresh: false });
  }, [
    editingRowId,
    hasActiveMutationTask,
    loadEntry,
    loading,
    logDetailEvent,
    modalOpen,
    refreshing,
    setNotice,
    submitting,
    t,
  ]);

  useEffect(() => {
    if (!enabled || realtimeConnected) {
      return;
    }

    const timer = window.setInterval(() => {
      if (
        pendingFallbackRefreshRef.current ||
        modalOpen ||
        editingRowId !== null ||
        hasActiveMutationTask ||
        submitting ||
        loading ||
        refreshing
      ) {
        return;
      }

      pendingFallbackRefreshRef.current = true;
      logDetailEvent("realtime", "fallback-refresh-triggered", "離線 fallback refresh 已觸發", {
        phase: "fallback",
        meta: {
          realtimeConnected,
        },
      });
      const run = async () => {
        try {
          await loadEntry({ silent: true, forceRefresh: false });
        } finally {
          pendingFallbackRefreshRef.current = false;
        }
      };
      void run();
    }, 60_000);

    return () => {
      window.clearInterval(timer);
    };
  }, [
    editingRowId,
    enabled,
    hasActiveMutationTask,
    loadEntry,
    loading,
    logDetailEvent,
    modalOpen,
    realtimeConnected,
    refreshing,
    submitting,
  ]);

  return {
    realtimeConnected,
    realtimeDisconnectedSince,
    runImmediateRefresh,
  };
}

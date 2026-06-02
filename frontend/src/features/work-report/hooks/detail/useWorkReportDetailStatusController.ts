import { useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from "react";
import {
  createReportAccepted,
  updateReportAccepted,
  type ReportMutationPayload,
} from "../../../../api/workReport";
import type { CreateTaskMonitor, WorkReportFormId, WorkReportMutationTaskKind } from "../../types";
import { formatStatusDateTime, getErrorMessage } from "../../utils";
import type { LoadEntryOptions } from "./types";
import { saveRetryableMutationRecord } from "../../taskRetryStore";

interface PendingMutationReplay {
  kind: WorkReportMutationTaskKind;
  formId: WorkReportFormId;
  entryId: string;
  rowId?: string;
  payload: ReportMutationPayload;
  clientMutationId: string;
  expectedEntryLastUpdatedAt?: string;
  editSessionId?: string;
  editLockVersion?: number;
  attempts: number;
  createdAt: string;
}

interface DetailNoticeState {
  type: "success" | "error" | "info";
  message: string;
}

type SystemStatusType = "loading" | "success" | "error" | "info" | "warn";

export interface SystemStatusState {
  type: SystemStatusType;
  message: string;
  showSpinner?: boolean;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
}

function readPendingMutationReplay(storageKey: string): PendingMutationReplay | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as PendingMutationReplay;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writePendingMutationReplay(storageKey: string, pending: PendingMutationReplay): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(storageKey, JSON.stringify(pending));
}

function clearPendingMutationReplay(storageKey: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(storageKey);
}

export function useWorkReportDetailStatusController({
  formId,
  safeEntryId,
  workOrderNo,
  loading,
  refreshing,
  submitting,
  editingRowId,
  modalOpen,
  hasActiveMutationTask,
  currentEntryTaskMonitors,
  activeMutationTask,
  activeMutationTaskCount,
  registerAcceptedMutationTask,
  pendingMutationReplayStorageKey,
  setNotice,
  setHighlightedDetailRowId,
  loadEntry,
  releaseRowEditLock,
  notice,
  loadError,
  isValidRoute,
  realtimeConnected,
  realtimeDisconnectedSince,
  entryEditingSummary,
  t,
}: {
  formId: WorkReportFormId | null;
  safeEntryId: string | null;
  workOrderNo?: string | null;
  loading: boolean;
  refreshing: boolean;
  submitting: boolean;
  editingRowId: string | null;
  modalOpen: boolean;
  hasActiveMutationTask: boolean;
  currentEntryTaskMonitors: CreateTaskMonitor[];
  activeMutationTask: CreateTaskMonitor | null;
  activeMutationTaskCount: number;
  registerAcceptedMutationTask: (
    kind: WorkReportMutationTaskKind,
    accepted: Awaited<ReturnType<typeof createReportAccepted>>,
    rowId?: string
  ) => Promise<void>;
  pendingMutationReplayStorageKey: string;
  setNotice: Dispatch<SetStateAction<DetailNoticeState | null>>;
  setHighlightedDetailRowId: Dispatch<SetStateAction<string | null>>;
  loadEntry: (options?: LoadEntryOptions) => Promise<void>;
  releaseRowEditLock: (rowId?: string | null) => Promise<void>;
  notice: DetailNoticeState | null;
  loadError: string | null;
  isValidRoute: boolean;
  realtimeConnected: boolean;
  realtimeDisconnectedSince: number | null;
  entryEditingSummary: {
    hasOtherEditors: boolean;
    otherEditorCount: number;
  } | null;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const handledCreateTaskTerminalIdsRef = useRef<Set<string>>(new Set());
  const pendingMutationReplayInFlightRef = useRef(false);

  useEffect(() => {
    if (
      !formId ||
      !safeEntryId ||
      loading ||
      refreshing ||
      submitting ||
      editingRowId !== null ||
      modalOpen ||
      hasActiveMutationTask ||
      pendingMutationReplayInFlightRef.current
    ) {
      return;
    }

    const pendingReplay = readPendingMutationReplay(pendingMutationReplayStorageKey);
    if (!pendingReplay) {
      return;
    }
    if (pendingReplay.formId !== formId || pendingReplay.entryId !== safeEntryId) {
      return;
    }
    if (pendingReplay.attempts >= 1) {
      clearPendingMutationReplay(pendingMutationReplayStorageKey);
      setNotice({
        type: "error",
        message: t("workReport:messages.systemRestartReplayFailed"),
      });
      return;
    }

    pendingMutationReplayInFlightRef.current = true;
    writePendingMutationReplay(pendingMutationReplayStorageKey, {
      ...pendingReplay,
      attempts: pendingReplay.attempts + 1,
    });

    const run = async () => {
      try {
        const accepted =
          pendingReplay.kind === "update" && pendingReplay.rowId
            ? await updateReportAccepted(
                pendingReplay.formId,
                pendingReplay.entryId,
                pendingReplay.rowId,
                pendingReplay.payload,
                {
                  clientMutationId: pendingReplay.clientMutationId,
                  workOrderNo,
                  expectedEntryLastUpdatedAt: pendingReplay.expectedEntryLastUpdatedAt,
                  editSessionId: pendingReplay.editSessionId,
                  editLockVersion: pendingReplay.editLockVersion,
                }
              )
            : await createReportAccepted(
                pendingReplay.formId,
                pendingReplay.entryId,
                pendingReplay.payload,
                {
                  clientMutationId: pendingReplay.clientMutationId,
                  workOrderNo,
                  expectedEntryLastUpdatedAt: pendingReplay.expectedEntryLastUpdatedAt,
                  editSessionId: pendingReplay.editSessionId,
                  editLockVersion: pendingReplay.editLockVersion,
                }
              );
        saveRetryableMutationRecord({
          taskId: accepted.taskId,
          retryRootTaskId: accepted.taskId,
          kind: pendingReplay.kind === "update" ? "update" : "create",
          formId: pendingReplay.formId,
          entryId: pendingReplay.entryId,
          rowId: pendingReplay.rowId,
          workOrderNo,
          payload: pendingReplay.payload,
          clientMutationId: pendingReplay.clientMutationId,
          expectedEntryLastUpdatedAt: pendingReplay.expectedEntryLastUpdatedAt,
          editSessionId: pendingReplay.editSessionId,
          editLockVersion: pendingReplay.editLockVersion,
          createdAt: new Date().toISOString(),
        });
        clearPendingMutationReplay(pendingMutationReplayStorageKey);
        await registerAcceptedMutationTask(pendingReplay.kind, accepted, pendingReplay.rowId);
        setNotice({
          type: "success",
          message: t("workReport:messages.systemRestartReplaySubmitted"),
        });
      } catch (error) {
        clearPendingMutationReplay(pendingMutationReplayStorageKey);
        setNotice({
          type: "error",
          message: getErrorMessage(error),
        });
      } finally {
        pendingMutationReplayInFlightRef.current = false;
      }
    };

    void run();
  }, [
    editingRowId,
    formId,
    hasActiveMutationTask,
    loading,
    modalOpen,
    pendingMutationReplayStorageKey,
    refreshing,
    registerAcceptedMutationTask,
    safeEntryId,
    setNotice,
    submitting,
    t,
    workOrderNo,
  ]);

  const systemStatus = useMemo<SystemStatusState>(() => {
    if (activeMutationTask) {
      const statusMessage =
        activeMutationTask.kind === "create"
          ? activeMutationTask.status === "pending"
            ? t("workReport:messages.createTaskQueuedContinue")
            : t("workReport:messages.createTaskBackgroundRunning")
          : activeMutationTask.status === "pending"
            ? t("workReport:messages.taskQueuedWaitingPrevious")
            : t("workReport:messages.taskBackgroundRecalcRunning");
      const acceptedTaskMessage = t(
        activeMutationTask.kind === "create"
          ? "workReport:messages.createAcceptedTaskProcessing"
          : "workReport:messages.updateAcceptedTaskProcessing",
        {
          taskShortId: activeMutationTask.taskId.slice(0, 8),
        }
      );
      const multiTaskSuffix = activeMutationTaskCount > 1 ? ` (${activeMutationTaskCount})` : "";
      return {
        type: "info",
        message: `${acceptedTaskMessage}${multiTaskSuffix} ${statusMessage}`,
        showSpinner: true,
      };
    }

    if (!isValidRoute) {
      return {
        type: "error",
        message: t("workReport:detailPage.invalidRoute"),
      };
    }

    if (loadError) {
      return {
        type: "error",
        message: loadError,
      };
    }

    if (notice) {
      return {
        type: notice.type,
        message: notice.message,
      };
    }

    if (loading || refreshing) {
      return {
        type: "loading",
        message: t("common:states.loadingData"),
        showSpinner: true,
      };
    }

    if (!realtimeConnected && realtimeDisconnectedSince) {
      return {
        type: "info",
        message: t("workReport:status.human.realtimeDisconnectedDetail", {
          since: formatStatusDateTime(realtimeDisconnectedSince),
        }),
      };
    }

    if (entryEditingSummary?.hasOtherEditors) {
      return {
        type: "warn",
        message: t("workReport:detailPage.entryHasEditorsWarning", {
          count: entryEditingSummary.otherEditorCount,
        }),
      };
    }

    return {
      type: "info",
      message: t("workReport:detailPage.systemStatusIdle"),
    };
  }, [
    activeMutationTask,
    activeMutationTaskCount,
    entryEditingSummary?.hasOtherEditors,
    entryEditingSummary?.otherEditorCount,
    isValidRoute,
    loadError,
    loading,
    notice,
    realtimeConnected,
    realtimeDisconnectedSince,
    refreshing,
    t,
  ]);

  useEffect(() => {
    const unhandledTerminalTasks = currentEntryTaskMonitors.filter(
      (task) =>
        task.status !== "pending" &&
        task.status !== "running" &&
        !handledCreateTaskTerminalIdsRef.current.has(task.taskId)
    );

    if (unhandledTerminalTasks.length === 0) {
      return;
    }

    let shouldReloadEntry = false;
    for (const task of unhandledTerminalTasks) {
      handledCreateTaskTerminalIdsRef.current.add(task.taskId);
      const terminalRowId = task.rowId ?? null;
      if (task.kind === "update" && terminalRowId) {
        void releaseRowEditLock(terminalRowId);
      }

      if (task.status === "success") {
        const rowId = terminalRowId ?? "-";
        setHighlightedDetailRowId(rowId);
        setNotice({
          type: "success",
          message:
            task.kind === "create"
              ? t("workReport:messages.detailCreatedWithRow", { rowId })
              : t("workReport:messages.detailUpdatedWithRow", { rowId }),
        });
        shouldReloadEntry = true;
        continue;
      }

      setNotice({
        type: "error",
        message: task.message,
      });
    }

    if (shouldReloadEntry) {
      void loadEntry({ silent: true, forceRefresh: false });
    }
  }, [currentEntryTaskMonitors, loadEntry, releaseRowEditLock, setHighlightedDetailRowId, setNotice, t]);

  return {
    systemStatus,
  };
}

import {
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  createReportAccepted,
  updateReportAccepted,
  type ReportMutationPayload,
  type WorkReportRecord,
} from "../../../../api/workReport";
import type { CreateTaskMonitor, WorkReportFormId, WorkReportMutationTaskKind } from "../../types";
import { formatStatusDateTime, getErrorMessage } from "../../utils";
import type { LoadEntryOptions } from "./types";
import { saveRetryableMutationRecord } from "../../taskRetryStore";
import type { WorkReportOptimisticMutationInput } from "../../workReportOptimisticMutation";
import { isEntryFieldMutationOperation } from "../../entryFieldTaskRetryStore";
import { entryFieldConfirmationMessage, isEntryFieldConfirmationPending, orderEntryFieldSettlementTasksForConsumption } from "../../entryFieldMutationSettlement";
import type { EntryFieldSettlementConsumer } from "../useTaskMonitor";

interface PendingMutationReplay {
  kind: Extract<WorkReportMutationTaskKind, "create" | "update">;
  formId: WorkReportFormId;
  entryId: string;
  rowId?: string;
  payload: ReportMutationPayload;
  clientMutationId: string;
  createIdempotencyKey?: string;
  expectedEntryLastUpdatedAt?: string;
  editSessionId?: string;
  editLockVersion?: number;
  attempts: number;
  createdAt: string;
}

export function isDetailTerminalTaskReady(
  task: Pick<
    CreateTaskMonitor,
    | "status"
    | "stale"
    | "entryFieldOperation"
    | "entryFieldSettlementOutcome"
    | "entryFieldSettlementRecord"
    | "optimisticMutation"
  >
): boolean {
  const operation =
    task.entryFieldOperation ?? task.optimisticMutation?.lifecycle.operation;
  if (isEntryFieldMutationOperation(operation)) {
    return Boolean(
      task.entryFieldSettlementRecord || task.entryFieldSettlementOutcome
    );
  }
  return (
    task.stale === true ||
    (task.status !== "pending" && task.status !== "running")
  );
}

export function resolveDetailTerminalTaskConsumption(
  task: CreateTaskMonitor,
  t: (key: string, options?: Record<string, unknown>) => string
): ReturnType<typeof resolveTerminalMutationTask> & {
  authoritativeRecord?: WorkReportRecord;
} {
  const resolution = resolveTerminalMutationTask(task, t);
  return {
    ...resolution,
    ...(task.entryFieldSettlementRecord?.reportsLoaded === true
      ? {
          authoritativeRecord: task.entryFieldSettlementRecord,
          loadEntryOptions: undefined,
        }
      : task.entryFieldSettlementRecord
        ? { loadEntryOptions: { mode: "background" as const, forceRefresh: true } }
        : {}),
  };
}

export interface DetailNoticeState {
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

interface TerminalMutationTaskResolution {
  notice: DetailNoticeState;
  highlightRowId?: string;
  releaseRowId?: string;
  loadEntryOptions?: LoadEntryOptions;
}

export function resolveTerminalMutationTask(
  task: CreateTaskMonitor,
  t: (key: string, options?: Record<string, unknown>) => string
): TerminalMutationTaskResolution {
  if (task.status !== "success") {
    const hasCompletedDelete =
      (task.kind === "delete" || task.kind === "delete-batch") &&
      (task.deletedCount ?? 0) > 0;
    return {
      notice: {
        type: "error",
        message: task.message,
      },
      loadEntryOptions: {
        mode: hasCompletedDelete ? "refreshing" : "background",
        forceRefresh: true,
      },
    };
  }

  if (task.kind === "create-batch") {
    return {
      notice: {
        type: "success",
        message: task.message,
      },
      loadEntryOptions: {
        mode: "background",
        forceRefresh: true,
      },
    };
  }

  if (task.kind === "delete" || task.kind === "delete-batch") {
    return {
      notice: {
        type: "success",
        message:
          task.message ||
          t(
            task.kind === "delete"
              ? "workReport:messages.detailDeletedQueuedCompleted"
              : "workReport:messages.batchDeleteCompleted"
          ),
      },
      loadEntryOptions: {
        mode: "refreshing",
        forceRefresh: true,
      },
    };
  }

  if (task.kind === "update" && !task.rowId) {
    return {
      notice: {
        type: "success",
        message:
          task.message ||
          t("workReport:messages.taskBackgroundUpdateCompleted"),
      },
      loadEntryOptions: {
        mode: "background",
        forceRefresh: false,
      },
    };
  }

  const rowId = task.rowId ?? "-";
  return {
    notice: {
      type: "success",
      message:
        task.kind === "create"
          ? t("workReport:messages.detailCreatedWithRow", { rowId })
          : t("workReport:messages.detailUpdatedWithRow", { rowId }),
    },
    highlightRowId: rowId,
    releaseRowId: task.kind === "update" && task.rowId ? task.rowId : undefined,
    loadEntryOptions: {
      mode: "background",
      forceRefresh: false,
    },
  };
}

function readPendingMutationReplay(storageKey: string): PendingMutationReplay | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.sessionStorage.getItem(storageKey);
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
  window.sessionStorage.setItem(storageKey, JSON.stringify(pending));
}

function clearPendingMutationReplay(storageKey: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.sessionStorage.removeItem(storageKey);
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
  retryEntryFieldConfirmation,
  registerEntryFieldSettlementConsumer,
  activeMutationTask,
  activeMutationTaskCount,
  registerAcceptedMutationTask,
  pendingMutationReplayStorageKey,
  setNotice,
  setHighlightedDetailRowId,
  loadEntry,
  currentRecord,
  mergeAuthoritativeRecord,
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
  retryEntryFieldConfirmation?: (taskId: string) => void;
  registerEntryFieldSettlementConsumer: (
    formId: WorkReportFormId,
    consumer: EntryFieldSettlementConsumer
  ) => () => void;
  activeMutationTask: CreateTaskMonitor | null;
  activeMutationTaskCount: number;
  registerAcceptedMutationTask: (
    kind: WorkReportMutationTaskKind,
    accepted: Awaited<ReturnType<typeof createReportAccepted>>,
    rowId?: string,
    optimisticInput?: WorkReportOptimisticMutationInput
  ) => Promise<void>;
  pendingMutationReplayStorageKey: string;
  setNotice: Dispatch<SetStateAction<DetailNoticeState | null>>;
  setHighlightedDetailRowId: Dispatch<SetStateAction<string | null>>;
  loadEntry: (options?: LoadEntryOptions) => Promise<void>;
  currentRecord: WorkReportRecord | null;
  mergeAuthoritativeRecord: (record: WorkReportRecord) => void;
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
    if (!formId || !safeEntryId) {
      return;
    }
    return registerEntryFieldSettlementConsumer(formId, {
      getCurrentRecord: (entryId) =>
        entryId === safeEntryId ? currentRecord : null,
    });
  }, [
    currentRecord,
    formId,
    registerEntryFieldSettlementConsumer,
    safeEntryId,
  ]);

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
                  createIdempotencyKey:
                    pendingReplay.createIdempotencyKey ?? pendingReplay.clientMutationId,
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
          createIdempotencyKey:
            pendingReplay.kind === "create"
              ? pendingReplay.createIdempotencyKey ?? pendingReplay.clientMutationId
              : undefined,
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
        activeMutationTask.kind === "create" || activeMutationTask.kind === "create-batch"
          ? activeMutationTask.status === "pending"
            ? t("workReport:messages.createTaskQueuedContinue")
            : t("workReport:messages.createTaskBackgroundRunning")
          : activeMutationTask.kind === "delete" || activeMutationTask.kind === "delete-batch"
            ? activeMutationTask.status === "pending"
              ? t("workReport:messages.taskQueuedWaitingPrevious")
              : t("workReport:messages.deleteTaskBackgroundRunning")
          : activeMutationTask.status === "pending"
            ? t("workReport:messages.taskQueuedWaitingPrevious")
            : t("workReport:messages.taskBackgroundRecalcRunning");
      const acceptedTaskMessage = t(
        activeMutationTask.kind === "create" || activeMutationTask.kind === "create-batch"
          ? "workReport:messages.createAcceptedTaskProcessing"
          : activeMutationTask.kind === "delete" || activeMutationTask.kind === "delete-batch"
            ? "workReport:messages.deleteAcceptedTaskProcessing"
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

    const confirmationTask = currentEntryTaskMonitors.find(isEntryFieldConfirmationPending);
    if (confirmationTask) {
      const blocked = Boolean(confirmationTask.entryFieldSettlementErrorCode);
      return {
        type: blocked ? "warn" : "info",
        message: entryFieldConfirmationMessage(confirmationTask, t)!,
        showSpinner: !blocked,
        ...(blocked && retryEntryFieldConfirmation ? {
          actionLabel: t("workReport:messages.entryFieldConfirmationRetry"),
          onAction: () => retryEntryFieldConfirmation(confirmationTask.taskId),
        } : {}),
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
    currentEntryTaskMonitors,
    retryEntryFieldConfirmation,
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
    const unhandledTerminalTasks = orderEntryFieldSettlementTasksForConsumption(
      currentEntryTaskMonitors.filter(
        (task) =>
          !handledCreateTaskTerminalIdsRef.current.has(task.taskId) &&
          isDetailTerminalTaskReady(task)
      )
    );

    if (unhandledTerminalTasks.length === 0) {
      return;
    }

    let loadEntryOptions: LoadEntryOptions | null = null;
    for (const task of unhandledTerminalTasks) {
      handledCreateTaskTerminalIdsRef.current.add(task.taskId);
      const resolution = resolveDetailTerminalTaskConsumption(task, t);
      if (resolution.authoritativeRecord) {
        mergeAuthoritativeRecord(resolution.authoritativeRecord);
      }
      if (resolution.releaseRowId) {
        void releaseRowEditLock(resolution.releaseRowId);
      }
      if (resolution.highlightRowId !== undefined) {
        setHighlightedDetailRowId(resolution.highlightRowId);
      }
      if (resolution.loadEntryOptions) {
        loadEntryOptions = resolution.loadEntryOptions.forceRefresh
          ? resolution.loadEntryOptions
          : loadEntryOptions ?? resolution.loadEntryOptions;
      }
      setNotice(resolution.notice);
    }

    if (loadEntryOptions) {
      void loadEntry(loadEntryOptions);
    }
  }, [currentEntryTaskMonitors, loadEntry, mergeAuthoritativeRecord, releaseRowEditLock, setHighlightedDetailRowId, setNotice, t]);

  return {
    systemStatus,
  };
}

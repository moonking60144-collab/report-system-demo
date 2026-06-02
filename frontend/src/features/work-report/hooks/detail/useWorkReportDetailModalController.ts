import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import {
  type CreateReportTaskAcceptedResult,
  createReportAccepted,
  updateReportAccepted,
  type ReportMutationPayload,
  type WorkReportItem,
} from "../../../../api/workReport";
import type {
  WorkReportFrontendEventAction,
  WorkReportFrontendEventCategory,
} from "../../debug/workReportDeveloperContract";
import { calculateDurationMs, createFrontendOperationId } from "../../logging/frontendEventLog";
import { saveRetryableMutationRecord } from "../../taskRetryStore";
import type { WorkReportFormId } from "../../types";
import { getErrorMessage } from "../../utils";
import type { DetailModalState } from "./types";

interface DetailNoticeState {
  type: "success" | "error" | "info";
  message: string;
}

interface UseWorkReportDetailModalControllerArgs {
  formId: WorkReportFormId | null;
  safeEntryId: string | null;
  workOrderNo?: string | null;
  hasActiveMutationTask: boolean;
  hasBlockingMutationTask: boolean;
  ensureOptionsLoaded: (options?: { silent?: boolean }) => Promise<unknown>;
  acquireRowEditLock: (rowId: string) => Promise<number | null>;
  releaseRowEditLock: (rowId?: string | null) => Promise<void>;
  clearActiveRowEditLock: () => void;
  currentEditSessionId: string;
  editLockVersion: number | null;
  setSubmitting: Dispatch<SetStateAction<boolean>>;
  submitting: boolean;
  registerAcceptedMutationTask: (
    kind: "create" | "update",
    accepted: CreateReportTaskAcceptedResult,
    rowId?: string
  ) => Promise<void>;
  createClientMutationId: () => string;
  writePendingMutationReplay: (pending: {
    kind: "create" | "update";
    formId: WorkReportFormId;
    entryId: string;
    rowId?: string;
    payload: ReportMutationPayload;
    clientMutationId: string;
    attempts: number;
    createdAt: string;
    editSessionId?: string;
    editLockVersion?: number;
  }) => void;
  clearPendingMutationReplay: () => void;
  isRetryableMutationError: (error: unknown) => boolean;
  summarizeChangedPayloadFields: (payload: ReportMutationPayload) => string[];
  logDetailEvent: (
    category: WorkReportFrontendEventCategory,
    action: WorkReportFrontendEventAction,
    summary: string,
    options?: {
      level?: "info" | "warn" | "error";
      rowId?: string;
      clientMutationId?: string;
      taskId?: string;
      operationId?: string;
      operationType?: string;
      phase?: string;
      durationMs?: number;
      startedAt?: string;
      endedAt?: string;
      meta?: Record<string, string | number | boolean | null | undefined | string[]>;
    }
  ) => void;
  setNotice: Dispatch<SetStateAction<DetailNoticeState | null>>;
  t: (key: string, options?: Record<string, unknown>) => string;
}

export function useWorkReportDetailModalController({
  formId,
  safeEntryId,
  workOrderNo,
  hasActiveMutationTask,
  hasBlockingMutationTask,
  ensureOptionsLoaded,
  acquireRowEditLock,
  releaseRowEditLock,
  clearActiveRowEditLock,
  currentEditSessionId,
  editLockVersion,
  setSubmitting,
  submitting,
  registerAcceptedMutationTask,
  createClientMutationId,
  writePendingMutationReplay,
  clearPendingMutationReplay,
  isRetryableMutationError,
  summarizeChangedPayloadFields,
  logDetailEvent,
  setNotice,
  t,
}: UseWorkReportDetailModalControllerArgs) {
  const [modalState, setModalState] = useState<DetailModalState>({
    open: false,
    mode: "create",
    row: null,
  });
  const [createFormResetToken, setCreateFormResetToken] = useState(0);

  const openCreateModal = useCallback(() => {
    if (hasBlockingMutationTask) {
      return;
    }
    const run = async () => {
      await ensureOptionsLoaded();
      setModalState({ open: true, mode: "create", row: null });
    };
    void run();
  }, [ensureOptionsLoaded, hasBlockingMutationTask]);

  const openEditModal = useCallback(
    (row: WorkReportItem) => {
      const run = async () => {
        if (hasActiveMutationTask) {
          return;
        }
        await ensureOptionsLoaded();
        if ((await acquireRowEditLock(row.rowId)) === null) {
          return;
        }
        setModalState({ open: true, mode: "edit", row });
      };
      void run();
    },
    [acquireRowEditLock, ensureOptionsLoaded, hasActiveMutationTask]
  );

  const closeModal = useCallback(() => {
    if (submitting) {
      return;
    }
    if (modalState.mode === "edit" && modalState.row?.rowId) {
      void releaseRowEditLock(modalState.row.rowId);
    }
    setModalState({ open: false, mode: "create", row: null });
  }, [modalState.mode, modalState.row?.rowId, releaseRowEditLock, submitting]);

  const handleSubmit = useCallback(
    async (
      payload: ReportMutationPayload,
      options: { continueAfterSave?: boolean } = {}
    ): Promise<void> => {
      if (!formId || !safeEntryId) {
        throw new Error(t("workReport:detailPage.invalidRoute"));
      }

      setSubmitting(true);
      try {
        if (modalState.mode === "create") {
          const operationId = createFrontendOperationId("modal-create");
          const startedAt = new Date().toISOString();
          const clientMutationId = createClientMutationId();
          const changedFields = summarizeChangedPayloadFields(payload);
          logDetailEvent("api", "modal-create-started", "開始新增報工 modal", {
            clientMutationId,
            operationId,
            operationType: "modal-create",
            phase: "started",
            startedAt,
            meta: { changedFields },
          });
          logDetailEvent("api", "modal-create-request-started", "新增報工 modal request 已送出", {
            clientMutationId,
            operationId,
            operationType: "modal-create",
            phase: "request",
            startedAt,
            meta: { changedFields },
          });
          logDetailEvent("api", "modal-create-submit", "送出新增報工 modal", {
            clientMutationId,
            operationId,
            operationType: "modal-create",
            phase: "accepted-wait",
            startedAt,
            meta: {
              changedFields,
            },
          });
          writePendingMutationReplay({
            kind: "create",
            formId,
            entryId: safeEntryId,
            payload,
            clientMutationId,
            attempts: 0,
            createdAt: new Date().toISOString(),
          });
          const accepted = await createReportAccepted(formId, safeEntryId, payload, {
            clientMutationId,
            workOrderNo,
          });
          saveRetryableMutationRecord({
            taskId: accepted.taskId,
            retryRootTaskId: accepted.taskId,
            kind: "create",
            formId,
            entryId: safeEntryId,
            workOrderNo,
            payload,
            clientMutationId,
            createdAt: new Date().toISOString(),
          });
          clearPendingMutationReplay();
          await registerAcceptedMutationTask("create", accepted);
          const endedAt = new Date().toISOString();
          logDetailEvent("task", "modal-create-accepted", "新增報工 modal 已 accepted", {
            taskId: accepted.taskId,
            clientMutationId,
            operationId,
            operationType: "modal-create",
            phase: "accepted",
            startedAt,
            endedAt,
            durationMs: calculateDurationMs(startedAt, endedAt),
            meta: {
              changedFields,
              result: accepted.status,
            },
          });
          if (options.continueAfterSave) {
            setNotice({
              type: "success",
              message: t("workReport:messages.detailQueuedContinue"),
            });
            setCreateFormResetToken((prev) => prev + 1);
            setModalState({ open: true, mode: "create", row: null });
            return;
          }
          setModalState({ open: false, mode: "create", row: null });
          clearActiveRowEditLock();
          return;
        }

        if (!modalState.row?.rowId) {
          throw new Error(t("workReport:messages.missingRowIdCannotUpdate"));
        }

        const clientMutationId = createClientMutationId();
        const changedFields = summarizeChangedPayloadFields(payload);
        const operationId = createFrontendOperationId("modal-update");
        const startedAt = new Date().toISOString();
        logDetailEvent("api", "modal-update-started", "開始編輯報工 modal", {
          rowId: modalState.row.rowId,
          clientMutationId,
          operationId,
          operationType: "modal-update",
          phase: "started",
          startedAt,
          meta: { changedFields },
        });
        logDetailEvent("api", "modal-update-request-started", "編輯報工 modal request 已送出", {
          rowId: modalState.row.rowId,
          clientMutationId,
          operationId,
          operationType: "modal-update",
          phase: "request",
          startedAt,
          meta: { changedFields },
        });
        logDetailEvent("api", "modal-update-submit", "送出編輯報工 modal", {
          rowId: modalState.row.rowId,
          clientMutationId,
          operationId,
          operationType: "modal-update",
          phase: "accepted-wait",
          startedAt,
          meta: {
            changedFields,
          },
        });
        writePendingMutationReplay({
          kind: "update",
          formId,
          entryId: safeEntryId,
          rowId: modalState.row.rowId,
          payload,
          clientMutationId,
          editSessionId: currentEditSessionId,
          editLockVersion: editLockVersion ?? undefined,
          attempts: 0,
          createdAt: new Date().toISOString(),
        });
        const accepted = await updateReportAccepted(formId, safeEntryId, modalState.row.rowId, payload, {
          clientMutationId,
          workOrderNo,
          editSessionId: currentEditSessionId,
          editLockVersion: editLockVersion ?? undefined,
        });
          saveRetryableMutationRecord({
            taskId: accepted.taskId,
            retryRootTaskId: accepted.taskId,
            kind: "update",
            formId,
          entryId: safeEntryId,
          rowId: modalState.row.rowId,
          workOrderNo,
          payload,
          clientMutationId,
          editSessionId: currentEditSessionId,
          editLockVersion: editLockVersion ?? undefined,
          createdAt: new Date().toISOString(),
        });
        clearPendingMutationReplay();
        await registerAcceptedMutationTask("update", accepted, modalState.row.rowId);
        const endedAt = new Date().toISOString();
        logDetailEvent("task", "modal-update-accepted", "編輯報工 modal 已 accepted", {
          rowId: modalState.row.rowId,
          taskId: accepted.taskId,
          clientMutationId,
          operationId,
          operationType: "modal-update",
          phase: "accepted",
          startedAt,
          endedAt,
          durationMs: calculateDurationMs(startedAt, endedAt),
          meta: {
            changedFields,
            result: accepted.status,
          },
        });
        setNotice({ type: "success", message: t("workReport:messages.detailUpdateQueued") });
        setModalState({ open: false, mode: "create", row: null });
      } catch (error) {
        logDetailEvent("api", "modal-submit-failed", getErrorMessage(error), {
          level: "error",
          rowId: modalState.row?.rowId,
        });
        if (isRetryableMutationError(error)) {
          setNotice({ type: "error", message: t("workReport:messages.systemRestartReplayPending") });
          window.location.reload();
          throw new Error(t("workReport:messages.systemRestartReplayPending"));
        }
        clearPendingMutationReplay();
        if (modalState.mode === "edit" && modalState.row?.rowId) {
          void releaseRowEditLock(modalState.row.rowId);
        }
        const message = getErrorMessage(error);
        setNotice({ type: "error", message });
        throw new Error(message);
      } finally {
        setSubmitting(false);
      }
    },
    [
      clearActiveRowEditLock,
      clearPendingMutationReplay,
      createClientMutationId,
      currentEditSessionId,
      editLockVersion,
      formId,
      logDetailEvent,
      modalState.mode,
      modalState.row,
      registerAcceptedMutationTask,
      releaseRowEditLock,
      safeEntryId,
      setNotice,
      setSubmitting,
      summarizeChangedPayloadFields,
      t,
      workOrderNo,
      writePendingMutationReplay,
      isRetryableMutationError,
    ]
  );

  return {
    modalState,
    createFormResetToken,
    setModalState,
    openCreateModal,
    openEditModal,
    closeModal,
    handleSubmit,
  };
}

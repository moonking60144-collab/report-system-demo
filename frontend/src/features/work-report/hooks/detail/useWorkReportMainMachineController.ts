import { startTransition, useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { updateWorkOrderMainMachine, type WorkReportRecord } from "../../../../api/workReport";
import type {
  WorkReportFrontendEventAction,
  WorkReportFrontendEventCategory,
} from "../../debug/workReportDeveloperContract";
import { calculateDurationMs, createFrontendOperationId } from "../../logging/frontendEventLog";
import { getErrorMessage } from "../../utils";
import type { LoadEntryOptions } from "./types";

interface DetailNoticeState {
  type: "success" | "error" | "info";
  message: string;
}

interface UseWorkReportMainMachineControllerArgs {
  formId: string | null;
  safeEntryId: string | null;
  record: WorkReportRecord | null;
  editingRowId: string | null;
  hasActiveMutationTask: boolean;
  modalOpen: boolean;
  loading: boolean;
  refreshing: boolean;
  submitting: boolean;
  ensureOptionsLoaded: (options?: { silent?: boolean }) => Promise<unknown>;
  loadEntry: (options?: LoadEntryOptions) => Promise<void>;
  setNotice: Dispatch<SetStateAction<DetailNoticeState | null>>;
  logDetailEvent: (
    category: WorkReportFrontendEventCategory,
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

export function useWorkReportMainMachineController({
  formId,
  safeEntryId,
  record,
  editingRowId,
  hasActiveMutationTask,
  modalOpen,
  loading,
  refreshing,
  submitting,
  ensureOptionsLoaded,
  loadEntry,
  setNotice,
  logDetailEvent,
  t,
}: UseWorkReportMainMachineControllerArgs) {
  const [mainMachineModalOpen, setMainMachineModalOpen] = useState(false);
  const [mainMachineDraft, setMainMachineDraft] = useState("");
  const [mainMachinePickerOpen, setMainMachinePickerOpen] = useState(false);
  const [mainMachinePickerSearch, setMainMachinePickerSearch] = useState("");
  const [mainMachineSaving, setMainMachineSaving] = useState(false);
  const [mainMachineSaveProgress, setMainMachineSaveProgress] = useState(0);
  const updateMainMachinePickerSearch = useCallback((value: string) => {
    startTransition(() => {
      setMainMachinePickerSearch(value);
    });
  }, []);

  useEffect(() => {
    if (!mainMachineSaving) {
      return;
    }

    const timer = window.setInterval(() => {
      setMainMachineSaveProgress((prev) => {
        if (prev >= 95) {
          return prev;
        }
        if (prev < 30) {
          return Math.min(95, prev + 7);
        }
        if (prev < 70) {
          return Math.min(95, prev + 4);
        }
        return Math.min(95, prev + 2);
      });
    }, 220);

    return () => {
      window.clearInterval(timer);
    };
  }, [mainMachineSaving]);

  const openMainMachineModal = useCallback(() => {
    const run = async () => {
      if (
        !record ||
        editingRowId ||
        hasActiveMutationTask ||
        modalOpen ||
        loading ||
        refreshing ||
        submitting
      ) {
        return;
      }

      await ensureOptionsLoaded();
      setMainMachineDraft(String(record.machineCode ?? "").trim());
      setMainMachinePickerSearch("");
      setMainMachinePickerOpen(false);
      setMainMachineModalOpen(true);
      logDetailEvent("ui", "main-machine-dialog-opened", "開啟更改工令機台", {
        meta: {
          currentMachineCode: String(record.machineCode ?? "").trim(),
        },
      });
    };

    void run();
  }, [
    editingRowId,
    ensureOptionsLoaded,
    hasActiveMutationTask,
    loading,
    logDetailEvent,
    modalOpen,
    record,
    refreshing,
    submitting,
  ]);

  const closeMainMachineModal = useCallback(() => {
    if (mainMachineSaving) {
      return;
    }
    setMainMachineModalOpen(false);
    setMainMachinePickerOpen(false);
    setMainMachinePickerSearch("");
    setMainMachineDraft("");
    setMainMachineSaveProgress(0);
  }, [mainMachineSaving]);

  const submitMainMachineUpdate = useCallback(async () => {
    if (!formId || !safeEntryId || !record) {
      return;
    }

    const nextMachineCode = mainMachineDraft.trim();
    if (!nextMachineCode) {
      logDetailEvent(
        "api",
        "main-machine-update-validation-failed",
        "更改工令機台缺少目標機台",
        {
          level: "warn",
        }
      );
      setNotice({
        type: "error",
        message: t("workReport:reportForm.validation.requiredField", {
          field: t("workReport:contextCard.fieldLabels.machineCode"),
        }),
      });
      return;
    }

    if (nextMachineCode === String(record.machineCode ?? "").trim()) {
      setMainMachineModalOpen(false);
      setMainMachineDraft("");
      return;
    }

    setMainMachineSaving(true);
    setMainMachineSaveProgress((prev) => (prev > 0 ? prev : 8));
    const operationId = createFrontendOperationId("main-machine-update");
    const startedAt = new Date().toISOString();
    try {
      logDetailEvent("api", "main-machine-update-started", "開始更改工令機台", {
        operationId,
        operationType: "main-machine-update",
        phase: "started",
        startedAt,
        meta: {
          nextMachineCode,
        },
      });
      logDetailEvent("api", "main-machine-update-request-started", "更改工令機台 request 已送出", {
        operationId,
        operationType: "main-machine-update",
        phase: "request",
        startedAt,
        meta: {
          nextMachineCode,
        },
      });
      await updateWorkOrderMainMachine(formId, safeEntryId, nextMachineCode);
      logDetailEvent("api", "main-machine-update-succeeded", "更改工令機台成功", {
        operationId,
        operationType: "main-machine-update",
        phase: "request-succeeded",
        startedAt,
        meta: {
          nextMachineCode,
        },
      });
      setMainMachineSaveProgress(100);
      setMainMachineModalOpen(false);
      setMainMachineDraft("");
      setNotice({ type: "success", message: t("workReport:messages.mainMachineUpdated") });
      await loadEntry({ silent: true, forceRefresh: true });
      const endedAt = new Date().toISOString();
      logDetailEvent(
        "realtime",
        "main-machine-update-refresh-completed",
        "更改工令機台後已完成刷新",
        {
          operationId,
          operationType: "main-machine-update",
          phase: "refresh-completed",
          startedAt,
          endedAt,
          durationMs: calculateDurationMs(startedAt, endedAt),
          meta: {
            nextMachineCode,
          },
        }
      );
    } catch (error) {
      logDetailEvent("api", "main-machine-update-failed", getErrorMessage(error), {
        level: "error",
        operationId,
        operationType: "main-machine-update",
        phase: "failed",
        startedAt,
        endedAt: new Date().toISOString(),
        meta: {
          nextMachineCode,
        },
      });
      setNotice({ type: "error", message: getErrorMessage(error) });
    } finally {
      window.setTimeout(() => {
        setMainMachineSaveProgress(0);
      }, 180);
      setMainMachineSaving(false);
    }
  }, [
    formId,
    loadEntry,
    logDetailEvent,
    mainMachineDraft,
    record,
    safeEntryId,
    setNotice,
    t,
  ]);

  return {
    mainMachineModalOpen,
    mainMachineDraft,
    mainMachinePickerOpen,
    mainMachinePickerSearch,
    mainMachineSaving,
    mainMachineSaveProgress,
    setMainMachineDraft,
    setMainMachinePickerOpen,
    setMainMachinePickerSearch: updateMainMachinePickerSearch,
    openMainMachineModal,
    closeMainMachineModal,
    submitMainMachineUpdate,
  };
}

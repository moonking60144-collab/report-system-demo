import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type SetStateAction,
} from "react";
import { showClosedLockWarning } from "../../utils/closedLockWarning";
import {
  type CreateReportTaskAcceptedResult,
  type FormOptionItem,
  type ReportMutationPayload,
  type WorkReportItem,
  type WorkReportRecord,
  createReportAccepted,
  updateReportAccepted,
} from "../../../../api/workReport";
import {
  applyInputOptionRule,
  buildReportMutationPayload,
  inferOperatorDefaultByMachine,
  inferOperatorDefaultSelection,
  inferReportTypeFromProcessCode,
  mapToFormState,
  validate,
} from "../../../../components/report-form/formLogic";
import { INPUT_OPTION_DEFAULT_RULES, PLANNED_IDLE_YES_DEFAULT_RULE } from "../../../../components/report-form/constants";
import { writeRememberedCreateDefaults, buildInitialFormState } from "../../../../components/report-form/formMemory";
import { maskTimeInputResult } from "../../../../components/report-form/timeUtils";
import { normalizeShiftTypeValue } from "../../../../components/report-form/form-logic/inference";
import type { FormState } from "../../../../components/report-form/types";
import {
  filterActiveMachineOptionsWithCurrentValue,
  withCurrentValue,
} from "../../../../components/report-form/optionUtils";
import { INPUT_OPTION_VALUES, SHIFT_TYPE_VALUES } from "../../../../components/report-form/constants";
import { translateInputOptionValue, translateShiftTypeValue } from "../../../../i18n/valueMappers";
import type {
  WorkReportFrontendEventAction,
  WorkReportFrontendEventCategory,
} from "../../debug/workReportDeveloperContract";
import { calculateDurationMs, createFrontendOperationId } from "../../logging/frontendEventLog";
import { saveRetryableMutationRecord } from "../../taskRetryStore";
import { getErrorMessage } from "../../utils";
import type { WorkReportFormId } from "../../types";
import type { DetailTableRow, InlineEditableDetailKey, LinkedPickerFieldKey, LinkedPickerState } from "./types";

interface DetailNoticeState {
  type: "success" | "error" | "info";
  message: string;
}

interface UseWorkReportDetailInlineControllerArgs {
  formId: WorkReportFormId | null;
  safeEntryId: string | null;
  record: WorkReportRecord | null;
  workOrderNo?: string | null;
  modalOpen: boolean;
  submitting: boolean;
  currentEditSessionId: string;
  editLockVersion: number | null;
  inlineEditableColumnKeySet: Set<InlineEditableDetailKey>;
  ensureOptionsLoaded: (options?: { silent?: boolean }) => Promise<Record<string, FormOptionItem[]>>;
  formOptions: Record<string, FormOptionItem[]>;
  acquireRowEditLock: (rowId: string) => Promise<number | null>;
  releaseRowEditLock: (rowId?: string | null) => Promise<void>;
  clearActiveRowEditLock: () => void;
  setNotice: Dispatch<SetStateAction<DetailNoticeState | null>>;
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
  isCreatePlaceholderRow: (row: DetailTableRow) => boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
}

function isInlineFieldEmpty(key: InlineEditableDetailKey, state: FormState): boolean {
  const value = state[key];
  return String(value ?? "").trim() === "";
}

function isInlineElementFocusable(el: HTMLElement): boolean {
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLButtonElement
  ) {
    if (el.disabled) {
      return false;
    }
    if (
      (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
      el.readOnly
    ) {
      return false;
    }
  }
  return true;
}

function resolveInlineEditorTarget(
  target: EventTarget | null
): {
  element: HTMLElement;
  key: InlineEditableDetailKey;
} | null {
  if (!(target instanceof HTMLElement)) {
    return null;
  }
  const inlineRoot = target.closest<HTMLElement>("[data-inline-editor-key]");
  if (!inlineRoot) {
    return null;
  }
  const key = inlineRoot.getAttribute(
    "data-inline-editor-key"
  ) as InlineEditableDetailKey | null;
  if (!key) {
    return null;
  }
  return {
    element: inlineRoot,
    key,
  };
}

function shouldHandleHorizontalArrow(
  event: ReactKeyboardEvent,
  target: HTMLElement
): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return false;
  }
  if (target instanceof HTMLTextAreaElement) {
    return false;
  }
  if (target instanceof HTMLButtonElement || target instanceof HTMLSelectElement) {
    return true;
  }
  if (!(target instanceof HTMLInputElement)) {
    return false;
  }
  const inputType = String(target.type ?? "").toLowerCase();
  if (inputType === "checkbox" || inputType === "radio") {
    return true;
  }
  const rawValue = String(target.value ?? "");
  const selectionStart =
    typeof target.selectionStart === "number" ? target.selectionStart : null;
  const selectionEnd =
    typeof target.selectionEnd === "number" ? target.selectionEnd : null;
  if (selectionStart === null || selectionEnd === null) {
    return true;
  }
  if (event.key === "ArrowLeft") {
    return selectionStart === 0 && selectionEnd === 0;
  }
  if (event.key === "ArrowRight") {
    return (
      selectionStart === rawValue.length && selectionEnd === rawValue.length
    );
  }
  return false;
}

function findOptionByValue(options: FormOptionItem[], value: string): FormOptionItem | undefined {
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  return options.find((item) => item.value.trim() === normalized);
}

const INLINE_EDITABLE_DETAIL_KEYS_BY_FORM: Record<"104" | "105", readonly InlineEditableDetailKey[]> = {
  "104": [
    "date",
    "plannedIdle",
    "machineId",
    "operatorId",
    "processCode",
    "inputOptions",
    "shiftType",
    "startTime",
    "endTime",
    "breakTime",
    "productionQty",
    "remark",
    "setupAdjustType",
    "setupAdjustMinutes",
    "countSetupTimeFlag",
    "setupTimeStandardHours",
    "setupLossQtyPerPcs",
    "processLossQtyPerPcs",
    "totalContainerQty",
    "containerUnit",
    "plannedIdleMinutes",
    "unplannedIdleMinutes",
    "absentOrTrainingMinutes",
    "noMaterialMinutes",
    "waitingQcApprovalMinutes",
    "meetingMinutes",
    "cleaningMinutes",
    "rdSamplingMinutes",
    "supportOtherMachinesMinutes",
    "machineBreakdownMinutes",
    "machineAdjustmentMinutes",
    "othersMinutes",
    "waitingForDiesMinutes",
    "testingDiesMinutes",
  ],
  "105": [
    "date",
    "plannedIdle",
    "machineId",
    "operatorId",
    "processCode",
    "inputOptions",
    "shiftType",
    "startTime",
    "endTime",
    "breakTime",
    "productionQty",
    "remark",
  ],
};

export function useWorkReportDetailInlineController({
  formId,
  safeEntryId,
  record,
  workOrderNo,
  modalOpen,
  submitting,
  currentEditSessionId,
  editLockVersion,
  inlineEditableColumnKeySet,
  ensureOptionsLoaded,
  formOptions,
  acquireRowEditLock,
  releaseRowEditLock,
  clearActiveRowEditLock,
  setNotice,
  logDetailEvent,
  registerAcceptedMutationTask,
  createClientMutationId,
  writePendingMutationReplay,
  clearPendingMutationReplay,
  isRetryableMutationError,
  summarizeChangedPayloadFields,
  isCreatePlaceholderRow,
  t,
}: UseWorkReportDetailInlineControllerArgs) {
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [editingRowDraft, setEditingRowDraft] = useState<FormState | null>(null);
  const [savingRowId, setSavingRowId] = useState<string | null>(null);
  const [linkedPickerState, setLinkedPickerState] = useState<LinkedPickerState | null>(null);
  const [autoHighlightedInlineKeys, setAutoHighlightedInlineKeys] = useState<InlineEditableDetailKey[]>([]);
  const [inlineTimeWarningField, setInlineTimeWarningField] =
    useState<"startTime" | "endTime" | null>(null);
  const detailTableScrollRef = useRef<HTMLDivElement | null>(null);
  const autoHighlightTimerRef = useRef<number | null>(null);
  const inlineMachineOptions = useMemo<FormOptionItem[]>(
    () =>
      filterActiveMachineOptionsWithCurrentValue(
        formOptions.machineId,
        editingRowDraft?.machineId ?? ""
      ),
    [editingRowDraft?.machineId, formOptions.machineId]
  );
  const inlineOperatorOptions = useMemo<FormOptionItem[]>(
    () => withCurrentValue(formOptions.operatorId, editingRowDraft?.operatorId ?? ""),
    [editingRowDraft?.operatorId, formOptions.operatorId]
  );
  const inlineProcessOptions = useMemo<FormOptionItem[]>(
    () => withCurrentValue(formOptions.processCode, editingRowDraft?.processCode ?? ""),
    [editingRowDraft?.processCode, formOptions.processCode]
  );
  const inputOptionPickerOptions = useMemo(
    () =>
      INPUT_OPTION_VALUES.map((value) => {
        const display = translateInputOptionValue(value, t);
        return {
          value,
          label: display ? `${value} - ${display}` : value,
          display,
        };
      }),
    [t]
  );
  const shiftTypePickerOptions = useMemo(
    () =>
      SHIFT_TYPE_VALUES.map((value) => {
        const display = translateShiftTypeValue(value, t);
        return {
          value,
          label: display ? `${value} - ${display}` : value,
          display,
        };
      }),
    [t]
  );
  const selectedInlineMachineOption = useMemo(() => {
    const value = editingRowDraft?.machineId?.trim() ?? "";
    if (!value) {
      return null;
    }
    return findOptionByValue(inlineMachineOptions, value) ?? null;
  }, [editingRowDraft?.machineId, inlineMachineOptions]);
  const selectedInlineOperatorOption = useMemo(() => {
    const value = editingRowDraft?.operatorId?.trim() ?? "";
    if (!value) {
      return null;
    }
    return findOptionByValue(inlineOperatorOptions, value) ?? null;
  }, [editingRowDraft?.operatorId, inlineOperatorOptions]);
  const selectedInlineProcessOption = useMemo(() => {
    const value = editingRowDraft?.processCode?.trim() ?? "";
    if (!value) {
      return null;
    }
    return findOptionByValue(inlineProcessOptions, value) ?? null;
  }, [editingRowDraft?.processCode, inlineProcessOptions]);
  const selectedInlineInputOption = useMemo(() => {
    const value = editingRowDraft?.inputOptions?.trim() ?? "";
    if (!value) {
      return null;
    }
    return findOptionByValue(inputOptionPickerOptions, value) ?? null;
  }, [editingRowDraft?.inputOptions, inputOptionPickerOptions]);
  const selectedInlineShiftTypeOption = useMemo(() => {
    const value = editingRowDraft?.shiftType?.trim() ?? "";
    if (!value) {
      return null;
    }
    return findOptionByValue(shiftTypePickerOptions, value) ?? null;
  }, [editingRowDraft?.shiftType, shiftTypePickerOptions]);

  useEffect(() => {
    if (!inlineTimeWarningField) {
      return;
    }
    const timer = window.setTimeout(() => {
      setInlineTimeWarningField(null);
    }, 3000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [inlineTimeWarningField]);

  useEffect(() => {
    if (!linkedPickerState) {
      return;
    }
    if (editingRowId !== linkedPickerState.rowId) {
      setLinkedPickerState(null);
    }
  }, [editingRowId, linkedPickerState]);

  useEffect(() => {
    if (editingRowId) {
      return;
    }
    if (autoHighlightTimerRef.current !== null) {
      window.clearTimeout(autoHighlightTimerRef.current);
      autoHighlightTimerRef.current = null;
    }
    setAutoHighlightedInlineKeys([]);
  }, [editingRowId]);

  const focusInlineSaveButton = useCallback((rowId: string | null): boolean => {
    if (!rowId) {
      return false;
    }
    const saveButton = detailTableScrollRef.current?.querySelector<HTMLButtonElement>(
      `tr[data-row-id="${rowId}"] .action-cell button[data-inline-action="save"]`
    );
    if (!saveButton || saveButton.disabled) {
      return false;
    }
    saveButton.focus();
    return true;
  }, []);

  const focusBatchCreateSaveButton = useCallback((): boolean => {
    const batchSaveButton = document.querySelector<HTMLButtonElement>(
      ".detail-batch-create-save-btn:not(:disabled)"
    );
    if (!batchSaveButton) {
      return false;
    }
    batchSaveButton.focus();
    return true;
  }, []);

  const findInlineEditorElement = useCallback(
    (rowId: string | null, key: InlineEditableDetailKey): HTMLElement | null => {
      if (!rowId) {
        return null;
      }
      return (
        detailTableScrollRef.current?.querySelector<HTMLElement>(
          `tr[data-row-id="${rowId}"] [data-inline-editor-key="${key}"]`
        ) ?? null
      );
    },
    []
  );

  const getOrderedInlineKeysForRow = useCallback(
    (rowId: string | null): InlineEditableDetailKey[] => {
      const fallbackKeys = (INLINE_EDITABLE_DETAIL_KEYS_BY_FORM[formId ?? "104"] ?? []).filter((key) =>
        inlineEditableColumnKeySet.has(key)
      );
      if (!rowId) {
        return fallbackKeys;
      }

      const rowElement =
        detailTableScrollRef.current?.querySelector<HTMLElement>(`tr[data-row-id="${rowId}"]`) ?? null;
      if (!rowElement) {
        return fallbackKeys;
      }

      const domOrderedKeys: InlineEditableDetailKey[] = [];
      rowElement.querySelectorAll<HTMLElement>("[data-inline-editor-key]").forEach((element) => {
        const key = element.getAttribute("data-inline-editor-key") as InlineEditableDetailKey | null;
        if (!key || !inlineEditableColumnKeySet.has(key) || domOrderedKeys.includes(key)) {
          return;
        }
        domOrderedKeys.push(key);
      });

      return domOrderedKeys.length > 0 ? domOrderedKeys : fallbackKeys;
    },
    [formId, inlineEditableColumnKeySet]
  );

  const focusNextEmptyInlineField = useCallback(
    (
      currentKey: InlineEditableDetailKey,
      nextState: FormState,
      options: { autoOpenPicker?: boolean; focusSaveWhenDone?: boolean } = {}
    ): void => {
      const { autoOpenPicker = false, focusSaveWhenDone = false } = options;
      const orderedKeys = getOrderedInlineKeysForRow(editingRowId);
      const currentIndex = orderedKeys.indexOf(currentKey);
      if (currentIndex === -1) {
        return;
      }

      window.setTimeout(() => {
        const remainingKeys = orderedKeys.slice(currentIndex + 1);
        const focusKey = (nextKey: InlineEditableDetailKey): boolean => {
          const nextEl = findInlineEditorElement(editingRowId, nextKey);
          if (!nextEl || !isInlineElementFocusable(nextEl)) {
            return false;
          }
          nextEl.scrollIntoView({
            block: "nearest",
            inline: "center",
          });
          nextEl.focus();
          if (autoOpenPicker && nextEl instanceof HTMLButtonElement) {
            nextEl.click();
          }
          return true;
        };

        for (const nextKey of remainingKeys) {
          if (!isInlineFieldEmpty(nextKey, nextState)) {
            continue;
          }
          if (focusKey(nextKey)) {
            return;
          }
        }

        for (const nextKey of remainingKeys) {
          if (focusKey(nextKey)) {
            return;
          }
        }

        if (focusSaveWhenDone) {
          const saveFocused =
            focusInlineSaveButton(editingRowId) || focusBatchCreateSaveButton();
          if (saveFocused) {
            const saveButton =
              detailTableScrollRef.current?.querySelector<HTMLElement>(
                `tr[data-row-id="${editingRowId}"] .action-cell button[data-inline-action="save"]`
              ) ??
              document.querySelector<HTMLElement>(".detail-batch-create-save-btn");
            saveButton?.scrollIntoView({
              block: "nearest",
              inline: "center",
            });
          }
        }
      }, 0);
    },
    [
      editingRowId,
      findInlineEditorElement,
      focusBatchCreateSaveButton,
      focusInlineSaveButton,
      getOrderedInlineKeysForRow,
    ]
  );

  const focusInlineNeighborField = useCallback(
    (
      currentKey: InlineEditableDetailKey,
      direction: "previous" | "next"
    ): void => {
      const orderedKeys = getOrderedInlineKeysForRow(editingRowId);
      const currentIndex = orderedKeys.indexOf(currentKey);
      if (currentIndex === -1) {
        return;
      }
      const nextIndex =
        direction === "previous" ? currentIndex - 1 : currentIndex + 1;
      const nextKey = orderedKeys[nextIndex];
      if (!nextKey) {
        return;
      }

      window.setTimeout(() => {
        const nextEl = findInlineEditorElement(editingRowId, nextKey);
        if (!nextEl || !isInlineElementFocusable(nextEl)) {
          return;
        }
        nextEl.scrollIntoView({
          block: "nearest",
          inline: "center",
        });
        nextEl.focus();
      }, 0);
    },
    [editingRowId, findInlineEditorElement, getOrderedInlineKeysForRow]
  );

  const handleDetailTableKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (!editingRowId || !editingRowDraft) return;
      const target = event.target as HTMLElement;
      const inlineTarget = resolveInlineEditorTarget(target);
      if (!inlineTarget) {
        return;
      }
      if (event.key === "Enter") {
        if (target instanceof HTMLTextAreaElement && event.shiftKey) {
          return;
        }
        if (target instanceof HTMLButtonElement) {
          return;
        }
        if (
          !(target instanceof HTMLInputElement) &&
          !(target instanceof HTMLSelectElement) &&
          !(target instanceof HTMLTextAreaElement)
        ) {
          return;
        }
        event.preventDefault();
        focusNextEmptyInlineField(inlineTarget.key, editingRowDraft, {
          autoOpenPicker: false,
          focusSaveWhenDone: true,
        });
        return;
      }

      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        return;
      }
      if (!shouldHandleHorizontalArrow(event, target)) {
        return;
      }
      event.preventDefault();
      focusInlineNeighborField(
        inlineTarget.key,
        event.key === "ArrowLeft" ? "previous" : "next"
      );
    },
    [
      editingRowDraft,
      editingRowId,
      focusInlineNeighborField,
      focusNextEmptyInlineField,
    ]
  );

  const triggerAutoHighlight = useCallback((keys: InlineEditableDetailKey[]) => {
    const nextKeys = Array.from(new Set(keys));
    if (autoHighlightTimerRef.current !== null) {
      window.clearTimeout(autoHighlightTimerRef.current);
      autoHighlightTimerRef.current = null;
    }
    setAutoHighlightedInlineKeys(nextKeys);
    if (nextKeys.length === 0) {
      return;
    }
    autoHighlightTimerRef.current = window.setTimeout(() => {
      setAutoHighlightedInlineKeys([]);
      autoHighlightTimerRef.current = null;
    }, 1500);
  }, []);

  const startInlineRowEdit = useCallback(
    async (row: WorkReportItem) => {
      if (submitting || modalOpen) {
        return;
      }
      if (record?.status === "已結案") {
        showClosedLockWarning(t("workReport:detailPage.closedLockedMessage"));
        return;
      }
      if (editingRowId === row.rowId) {
        return;
      }
      await ensureOptionsLoaded();
      if ((await acquireRowEditLock(row.rowId)) === null) {
        return;
      }
      setEditingRowId(row.rowId);
      setEditingRowDraft(mapToFormState(row));
      logDetailEvent("ui", "inline-edit-opened", `開啟 inline 編輯：row ${row.rowId}`, {
        rowId: row.rowId,
      });
    },
    [acquireRowEditLock, editingRowId, ensureOptionsLoaded, logDetailEvent, modalOpen, record?.status, submitting, t]
  );

  const activateInlineCreateRow = useCallback(
    async (rowId: string, draftOverride?: FormState | null) => {
      if (!formId || submitting || modalOpen) {
        return;
      }
      if (record?.status === "已結案") {
        showClosedLockWarning(t("workReport:detailPage.closedLockedMessage"));
        return;
      }
      if (editingRowId === rowId && (!draftOverride || editingRowDraft)) {
        return;
      }
      const options = await ensureOptionsLoaded();
      setEditingRowId(rowId);
      setEditingRowDraft(
        draftOverride ??
          buildInitialFormState(
            formId,
            "create",
            null,
            record,
            options.machineId ?? [],
            options.operatorId ?? []
          )
      );
      logDetailEvent("ui", "inline-create-opened", `開啟 inline 新增：row ${rowId}`, {
        rowId,
      });
    },
    [
      editingRowDraft,
      editingRowId,
      ensureOptionsLoaded,
      formId,
      logDetailEvent,
      modalOpen,
      record,
      submitting,
      t,
    ]
  );
  const startInlineCreateRowEdit = activateInlineCreateRow;

  const updateEditingRowField = useCallback((field: keyof FormState, value: string) => {
    setEditingRowDraft((prev) => (prev ? { ...prev, [field]: value } : prev));
  }, []);

  const updateEditingTimeField = useCallback((field: "startTime" | "endTime", rawValue: string) => {
    const masked = maskTimeInputResult(rawValue);
    setEditingRowDraft((prev) =>
      prev
        ? {
            ...prev,
            [field]: masked.value,
          }
        : prev
    );
    if (masked.invalidAttempt) {
      setInlineTimeWarningField(field);
    }
  }, []);

  const handleInlineInputOptionsChange = useCallback(
    (value: string) => {
      if (!editingRowDraft) {
        return;
      }
      const next: FormState = {
        ...editingRowDraft,
        inputOptions: value,
      };
      const applied = applyInputOptionRule(next, INPUT_OPTION_DEFAULT_RULES[value]);
      const changedKeys = (["shiftType", "startTime", "endTime", "breakTime"] as const).filter(
        (key) => editingRowDraft[key] !== applied[key]
      );
      triggerAutoHighlight(changedKeys);
      setEditingRowDraft(applied);
      focusNextEmptyInlineField("inputOptions", applied);
    },
    [editingRowDraft, focusNextEmptyInlineField, triggerAutoHighlight]
  );

  const handleInlinePlannedIdleChange = useCallback(
    (value: string) => {
      if (!editingRowDraft) {
        return;
      }
      const next: FormState = {
        ...editingRowDraft,
        plannedIdle: value,
        productionQty: value === "Yes" ? "" : editingRowDraft.productionQty,
      };
      const applied = applyInputOptionRule(
        next,
        value === "Yes" ? PLANNED_IDLE_YES_DEFAULT_RULE : undefined
      );
      const changedKeys = ([
        "shiftType",
        "startTime",
        "endTime",
        "breakTime",
        "plannedIdleMinutes",
      ] as const).filter((key) => editingRowDraft[key] !== applied[key]);
      triggerAutoHighlight(changedKeys);
      setEditingRowDraft(applied);
      focusNextEmptyInlineField("plannedIdle", applied, { autoOpenPicker: false });
    },
    [editingRowDraft, focusNextEmptyInlineField, triggerAutoHighlight]
  );

  const handleInlineMachineChange = useCallback(
    (value: string) => {
      if (!editingRowDraft) {
        return;
      }
      const nextState: FormState = {
        ...editingRowDraft,
        machineId: value,
      };
      const machineDefaults = inferOperatorDefaultByMachine(value, inlineMachineOptions);
      const resolvedState =
        !machineDefaults.operatorId &&
        !machineDefaults.operatorName &&
        !machineDefaults.processCode &&
        !machineDefaults.reportType
          ? nextState
          : {
              ...nextState,
              operatorId:
                !editingRowDraft.operatorId.trim() && machineDefaults.operatorId
                  ? machineDefaults.operatorId
                  : nextState.operatorId,
              operatorName:
                !editingRowDraft.operatorName.trim()
                  ? machineDefaults.operatorName ?? nextState.operatorName
                  : nextState.operatorName,
              processCode:
                !editingRowDraft.processCode.trim() && machineDefaults.processCode
                  ? machineDefaults.processCode
                  : nextState.processCode,
              reportType:
                !editingRowDraft.reportType.trim() &&
                (machineDefaults.reportType || machineDefaults.processCode)
                  ? machineDefaults.reportType ??
                    inferReportTypeFromProcessCode(machineDefaults.processCode ?? "")
                  : nextState.reportType,
            };
      setEditingRowDraft(resolvedState);
      focusNextEmptyInlineField("machineId", resolvedState);
    },
    [editingRowDraft, focusNextEmptyInlineField, inlineMachineOptions]
  );

  const handleInlineOperatorChange = useCallback(
    (value: string) => {
      if (!editingRowDraft) {
        return;
      }
      const selected = findOptionByValue(inlineOperatorOptions, value);
      const defaults = inferOperatorDefaultSelection(value, record, inlineMachineOptions);
      const nextState = {
        ...editingRowDraft,
        operatorId: value,
        operatorName: selected?.display ?? editingRowDraft.operatorName,
        processCode:
          !editingRowDraft.processCode.trim() && defaults.processCode
            ? defaults.processCode
            : editingRowDraft.processCode,
        machineId:
          !editingRowDraft.machineId.trim() && defaults.machineId
            ? defaults.machineId
            : editingRowDraft.machineId,
        reportType:
          !editingRowDraft.reportType.trim() && (defaults.reportType || defaults.processCode)
            ? defaults.reportType ?? inferReportTypeFromProcessCode(defaults.processCode ?? "")
            : editingRowDraft.reportType,
      };
      setEditingRowDraft(nextState);
      focusNextEmptyInlineField("operatorId", nextState);
    },
    [
      editingRowDraft,
      focusNextEmptyInlineField,
      inlineMachineOptions,
      inlineOperatorOptions,
      record,
    ]
  );

  const handleInlineProcessChange = useCallback(
    (value: string) => {
      if (!editingRowDraft) {
        return;
      }
      const nextState = {
        ...editingRowDraft,
        processCode: value,
        reportType: editingRowDraft.reportType.trim()
          ? editingRowDraft.reportType
          : inferReportTypeFromProcessCode(value),
      };
      setEditingRowDraft(nextState);
      focusNextEmptyInlineField("processCode", nextState);
    },
    [editingRowDraft, focusNextEmptyInlineField]
  );

  const handleInlineShiftTypeChange = useCallback(
    (value: string) => {
      if (!editingRowDraft) {
        return;
      }
      const nextState = {
        ...editingRowDraft,
        shiftType: normalizeShiftTypeValue(value),
      };
      setEditingRowDraft(nextState);
      focusNextEmptyInlineField("shiftType", nextState);
    },
    [editingRowDraft, focusNextEmptyInlineField]
  );

  const applyInlineFieldValueToDraft = useCallback(
    (draft: FormState, key: InlineEditableDetailKey, rawValue: string): FormState => {
      switch (key) {
        case "inputOptions": {
          const next = {
            ...draft,
            inputOptions: rawValue,
          };
          return applyInputOptionRule(next, INPUT_OPTION_DEFAULT_RULES[rawValue]);
        }
        case "plannedIdle": {
          const next = {
            ...draft,
            plannedIdle: rawValue,
            productionQty: rawValue === "Yes" ? "" : draft.productionQty,
          };
          return applyInputOptionRule(
            next,
            rawValue === "Yes" ? PLANNED_IDLE_YES_DEFAULT_RULE : undefined
          );
        }
        case "machineId": {
          const nextState: FormState = {
            ...draft,
            machineId: rawValue,
          };
          const machineDefaults = inferOperatorDefaultByMachine(rawValue, inlineMachineOptions);
          if (
            !machineDefaults.operatorId &&
            !machineDefaults.operatorName &&
            !machineDefaults.processCode &&
            !machineDefaults.reportType
          ) {
            return nextState;
          }
          return {
            ...nextState,
            operatorId:
              !draft.operatorId.trim() && machineDefaults.operatorId
                ? machineDefaults.operatorId
                : nextState.operatorId,
            operatorName:
              !draft.operatorName.trim()
                ? machineDefaults.operatorName ?? nextState.operatorName
                : nextState.operatorName,
            processCode:
              !draft.processCode.trim() && machineDefaults.processCode
                ? machineDefaults.processCode
                : nextState.processCode,
            reportType:
              !draft.reportType.trim() &&
              (machineDefaults.reportType || machineDefaults.processCode)
                ? machineDefaults.reportType ??
                  inferReportTypeFromProcessCode(machineDefaults.processCode ?? "")
                : nextState.reportType,
          };
        }
        case "operatorId": {
          const selected = findOptionByValue(inlineOperatorOptions, rawValue);
          const defaults = inferOperatorDefaultSelection(rawValue, record, inlineMachineOptions);
          return {
            ...draft,
            operatorId: rawValue,
            operatorName: selected?.display ?? draft.operatorName,
            processCode:
              !draft.processCode.trim() && defaults.processCode
                ? defaults.processCode
                : draft.processCode,
            machineId:
              !draft.machineId.trim() && defaults.machineId
                ? defaults.machineId
                : draft.machineId,
            reportType:
              !draft.reportType.trim() && (defaults.reportType || defaults.processCode)
                ? defaults.reportType ??
                  inferReportTypeFromProcessCode(defaults.processCode ?? "")
                : draft.reportType,
          };
        }
        case "processCode":
          return {
            ...draft,
            processCode: rawValue,
            reportType: draft.reportType.trim()
              ? draft.reportType
              : inferReportTypeFromProcessCode(rawValue),
          };
        case "shiftType":
          return {
            ...draft,
            shiftType: normalizeShiftTypeValue(rawValue),
          };
        case "startTime":
        case "endTime":
          return {
            ...draft,
            [key]: maskTimeInputResult(rawValue).value,
          };
        default:
          return {
            ...draft,
            [key]: rawValue,
          };
      }
    },
    [inlineMachineOptions, inlineOperatorOptions, record]
  );

  const cancelInlineRowEdit = useCallback(() => {
    if (savingRowId) {
      return;
    }
    if (editingRowId) {
      logDetailEvent("ui", "inline-edit-cancelled", "取消 inline 編輯", {
        rowId: editingRowId,
        meta: {
          hadDraft: Boolean(editingRowDraft),
        },
      });
    }
    if (autoHighlightTimerRef.current !== null) {
      window.clearTimeout(autoHighlightTimerRef.current);
      autoHighlightTimerRef.current = null;
    }
    setAutoHighlightedInlineKeys([]);
    void releaseRowEditLock();
    setEditingRowId(null);
    setEditingRowDraft(null);
    setLinkedPickerState(null);
  }, [editingRowDraft, editingRowId, logDetailEvent, releaseRowEditLock, savingRowId]);

  const openLinkedPicker = useCallback((key: LinkedPickerFieldKey, rowId: string) => {
    setLinkedPickerState({
      key,
      rowId,
      search: "",
    });
  }, []);

  const closeLinkedPicker = useCallback(() => {
    setLinkedPickerState(null);
  }, []);

  const updateLinkedPickerSearch = useCallback((value: string) => {
    startTransition(() => {
      setLinkedPickerState((prev) => (prev ? { ...prev, search: value } : prev));
    });
  }, []);

  const handleLinkedOptionSelect = useCallback(
    (value: string) => {
      if (linkedPickerState?.key === "processCode") {
        handleInlineProcessChange(value);
      } else if (linkedPickerState?.key === "operatorId") {
        handleInlineOperatorChange(value);
      } else if (linkedPickerState?.key === "inputOptions") {
        handleInlineInputOptionsChange(value);
      } else if (linkedPickerState?.key === "shiftType") {
        handleInlineShiftTypeChange(value);
      } else {
        handleInlineMachineChange(value);
      }
      setLinkedPickerState(null);
    },
    [
      handleInlineInputOptionsChange,
      handleInlineMachineChange,
      handleInlineOperatorChange,
      handleInlineProcessChange,
      handleInlineShiftTypeChange,
      linkedPickerState?.key,
    ]
  );

  const submitCreateDraft = useCallback(
    async (rowId: string, draft: FormState) => {
      if (!formId || !safeEntryId || !rowId) {
        return;
      }
      const validationError = validate(draft, t);
      if (validationError) {
        logDetailEvent("api", "inline-save-validation-failed", validationError, {
          level: "warn",
          rowId,
          meta: { isCreate: true },
        });
        setNotice({ type: "error", message: validationError });
        throw new Error(validationError);
      }

      setSavingRowId(rowId);
      try {
        const payload = buildReportMutationPayload(draft);
        const changedFields = summarizeChangedPayloadFields(payload);
        const operationId = createFrontendOperationId("inline-create");
        const startedAt = new Date().toISOString();
        const clientMutationId = createClientMutationId();
        logDetailEvent("api", "inline-create-started", "開始 inline 新增", {
          rowId,
          clientMutationId,
          operationId,
          operationType: "inline-create",
          phase: "started",
          startedAt,
          meta: { changedFields },
        });
        logDetailEvent("api", "inline-create-request-started", "inline 新增 request 已送出", {
          rowId,
          clientMutationId,
          operationId,
          operationType: "inline-create",
          phase: "request",
          startedAt,
          meta: { changedFields },
        });
        logDetailEvent("api", "inline-create-submit", "送出 inline 新增", {
          rowId,
          clientMutationId,
          operationId,
          operationType: "inline-create",
          phase: "accepted-wait",
          startedAt,
          meta: { changedFields },
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
        writeRememberedCreateDefaults(formId, draft, safeEntryId);
        await registerAcceptedMutationTask("create", accepted);
        const endedAt = new Date().toISOString();
        logDetailEvent("task", "inline-create-accepted", "inline 新增已 accepted", {
          rowId,
          taskId: accepted.taskId,
          clientMutationId,
          operationId,
          operationType: "inline-create",
          phase: "accepted",
          startedAt,
          endedAt,
          durationMs: calculateDurationMs(startedAt, endedAt),
          meta: {
            changedFields,
            result: accepted.status,
          },
        });
        setNotice({ type: "success", message: t("workReport:messages.createAcceptedTaskProcessing") });
      } catch (error) {
        logDetailEvent("api", "inline-save-failed", getErrorMessage(error), {
          level: "error",
          rowId,
        });
        if (isRetryableMutationError(error)) {
          setNotice({ type: "error", message: t("workReport:messages.systemRestartReplayPending") });
          window.location.reload();
          return;
        }
        clearPendingMutationReplay();
        setNotice({ type: "error", message: getErrorMessage(error) });
        throw error;
      } finally {
        setSavingRowId(null);
      }
    },
    [
      clearPendingMutationReplay,
      createClientMutationId,
      formId,
      isRetryableMutationError,
      logDetailEvent,
      registerAcceptedMutationTask,
      safeEntryId,
      setNotice,
      summarizeChangedPayloadFields,
      t,
      workOrderNo,
      writePendingMutationReplay,
    ]
  );

  const saveInlineRowEdit = useCallback(
    async (row: DetailTableRow) => {
      if (!formId || !safeEntryId || !row.rowId) {
        return;
      }
      if (!editingRowDraft) {
        return;
      }
      const validationError = validate(editingRowDraft, t);
      if (validationError) {
        logDetailEvent("api", "inline-save-validation-failed", validationError, {
          level: "warn",
          rowId: row.rowId,
          meta: {
            isCreate: isCreatePlaceholderRow(row),
          },
        });
        setNotice({ type: "error", message: validationError });
        return;
      }

      setSavingRowId(row.rowId);
      try {
        const payload = buildReportMutationPayload(editingRowDraft);
        const changedFields = summarizeChangedPayloadFields(payload);
        if (isCreatePlaceholderRow(row)) {
          await submitCreateDraft(row.rowId, editingRowDraft);
        } else {
          const operationId = createFrontendOperationId("inline-update");
          const startedAt = new Date().toISOString();
          const clientMutationId = createClientMutationId();
          logDetailEvent("api", "inline-update-started", "開始 inline 更新", {
            rowId: row.rowId,
            clientMutationId,
            operationId,
            operationType: "inline-update",
            phase: "started",
            startedAt,
            meta: { changedFields },
          });
          logDetailEvent("api", "inline-update-request-started", "inline 更新 request 已送出", {
            rowId: row.rowId,
            clientMutationId,
            operationId,
            operationType: "inline-update",
            phase: "request",
            startedAt,
            meta: { changedFields },
          });
          logDetailEvent("api", "inline-update-submit", "送出 inline 更新", {
            rowId: row.rowId,
            clientMutationId,
            operationId,
            operationType: "inline-update",
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
            rowId: row.rowId,
            payload,
            clientMutationId,
            editSessionId: currentEditSessionId,
            editLockVersion: editLockVersion ?? undefined,
            attempts: 0,
            createdAt: new Date().toISOString(),
          });
          const accepted = await updateReportAccepted(formId, safeEntryId, row.rowId, payload, {
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
            rowId: row.rowId,
            workOrderNo,
            payload,
            clientMutationId,
            editSessionId: currentEditSessionId,
            editLockVersion: editLockVersion ?? undefined,
            createdAt: new Date().toISOString(),
          });
          clearPendingMutationReplay();
          await registerAcceptedMutationTask("update", accepted, row.rowId);
          const endedAt = new Date().toISOString();
          logDetailEvent("task", "inline-update-accepted", "inline 更新已 accepted", {
            rowId: row.rowId,
            taskId: accepted.taskId,
            clientMutationId,
            operationId,
            operationType: "inline-update",
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
        }
      setEditingRowId(null);
      setEditingRowDraft(null);
      if (isCreatePlaceholderRow(row)) {
        clearActiveRowEditLock();
      }
      } catch (error) {
        logDetailEvent("api", "inline-save-failed", getErrorMessage(error), {
          level: "error",
          rowId: row.rowId,
        });
        if (isRetryableMutationError(error)) {
          setNotice({ type: "error", message: t("workReport:messages.systemRestartReplayPending") });
          window.location.reload();
          return;
        }
        clearPendingMutationReplay();
        if (!isCreatePlaceholderRow(row)) {
          void releaseRowEditLock(row.rowId);
        }
        setNotice({ type: "error", message: getErrorMessage(error) });
      } finally {
        setSavingRowId(null);
      }
    },
    [
      clearActiveRowEditLock,
      clearPendingMutationReplay,
      createClientMutationId,
      currentEditSessionId,
      editingRowDraft,
      editLockVersion,
      formId,
      isCreatePlaceholderRow,
      isRetryableMutationError,
      logDetailEvent,
      registerAcceptedMutationTask,
      releaseRowEditLock,
      safeEntryId,
      setNotice,
      summarizeChangedPayloadFields,
      submitCreateDraft,
      t,
      workOrderNo,
      writePendingMutationReplay,
    ]
  );

  useEffect(() => {
    return () => {
      if (autoHighlightTimerRef.current !== null) {
        window.clearTimeout(autoHighlightTimerRef.current);
      }
    };
  }, []);

  return {
    editingRowId,
    editingRowDraft,
    savingRowId,
    linkedPickerState,
    autoHighlightedInlineKeys,
    inlineTimeWarningField,
    detailTableScrollRef,
    inlineMachineOptions,
    inlineOperatorOptions,
    inlineProcessOptions,
    inputOptionPickerOptions,
    shiftTypePickerOptions,
    selectedInlineMachineOption,
    selectedInlineOperatorOption,
    selectedInlineProcessOption,
    selectedInlineInputOption,
    selectedInlineShiftTypeOption,
    setEditingRowDraft,
    activateInlineCreateRow,
    startInlineRowEdit,
    startInlineCreateRowEdit,
    handleDetailTableKeyDown,
    updateEditingRowField,
    updateEditingTimeField,
    handleInlinePlannedIdleChange,
    cancelInlineRowEdit,
    openLinkedPicker,
    closeLinkedPicker,
    updateLinkedPickerSearch,
    handleLinkedOptionSelect,
    applyInlineFieldValueToDraft,
    submitCreateDraft,
    saveInlineRowEdit,
  };
}

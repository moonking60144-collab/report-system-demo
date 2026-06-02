import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type {
  FormOptionMap,
  ReportMutationPayload,
  WorkReportItem,
  WorkReportRecord,
} from "../../../api/workReport";
import type { WorkReportFormId } from "../../../features/work-report/types";
import {
  translateInputOptionValue,
  translateReportTypeValue,
  translateShiftTypeValue,
} from "../../../i18n/valueMappers";
import {
  CONTAINER_UNIT_VALUES,
  COUNT_SETUP_TIME_FLAG_VALUES,
  EMPTY_FORM,
  INPUT_OPTION_DEFAULT_RULES,
  INPUT_OPTION_VALUES,
  PLANNED_IDLE_YES_DEFAULT_RULE,
  REPORT_TYPE_VALUES,
  SETUP_ADJUST_TYPE_VALUES,
  SHIFT_TYPE_VALUES,
} from "../constants";
import {
  applyInputOptionRule,
  buildReportMutationPayload,
  normalizeShiftTypeValue,
  validate,
} from "../formLogic";
import { buildInitialFormState, writeRememberedCreateDefaults } from "../formMemory";
import { buildLocalizedOptions, withCurrentValue } from "../optionUtils";
import { maskTimeInputResult } from "../timeUtils";
import type { FormState } from "../types";
import type { ModalFieldKey } from "./types";

const PLANNED_IDLE_MODAL_OPTIONS = [
  { value: "No", label: "—", display: "No" },
  { value: "Yes", label: "✓", display: "Yes" },
] as const;

function normalizeDateInputValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return "";
  }

  const digitsOnly = trimmed.replace(/\D/g, "");
  if (/^\d{8}$/.test(digitsOnly)) {
    return `${digitsOnly.slice(0, 4)}-${digitsOnly.slice(4, 6)}-${digitsOnly.slice(6, 8)}`;
  }

  const normalizedSeparator = trimmed.replace(/[/.]/g, "-");
  const match = normalizedSeparator.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) {
    return trimmed;
  }

  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

interface UseReportFormModalFormControllerArgs {
  formId: WorkReportFormId;
  mode: "create" | "edit";
  initialValue?: WorkReportItem | null;
  entryContext?: WorkReportRecord | null;
  options: FormOptionMap;
  optionsLoading: boolean;
  submitting: boolean;
  onSubmit: (
    payload: ReportMutationPayload,
    options?: { continueAfterSave?: boolean }
  ) => Promise<void>;
  onDebugEvent?: (
    action:
      | "modal-submit-validation-failed"
      | "modal-submit-blocked-options-loading",
    summary: string,
    meta?: Record<string, string | number | boolean | null | undefined | string[]>
  ) => void;
  tr: (key: string, options?: Record<string, unknown>) => string;
  focusNextEmptyModalField: (
    currentKey: ModalFieldKey,
    state: FormState,
    options?: { wrap?: boolean }
  ) => boolean;
}

export function useReportFormModalFormController({
  formId,
  mode,
  initialValue,
  entryContext,
  options,
  optionsLoading,
  submitting,
  onSubmit,
  onDebugEvent,
  tr,
  focusNextEmptyModalField,
}: UseReportFormModalFormControllerArgs) {
  const initialFormState = useMemo(
    () =>
      buildInitialFormState(
        formId,
        mode,
        initialValue,
        entryContext,
        options.machineId ?? [],
        options.operatorId ?? []
      ),
    [entryContext, formId, initialValue, mode, options.machineId, options.operatorId]
  );
  const [formState, setFormState] = useState<FormState>(() => initialFormState);
  const [error, setError] = useState<string | null>(null);
  const [saveProgress, setSaveProgress] = useState(0);
  const [autofilledFieldKeys, setAutofilledFieldKeys] = useState<string[]>([]);
  const [timeInputWarningField, setTimeInputWarningField] = useState<"startTime" | "endTime" | null>(null);

  const isPlannedIdleYes = formState.plannedIdle.trim() === "Yes";
  const title = useMemo(
    () =>
      mode === "create"
        ? tr("workReport:reportForm.titles.create")
        : tr("workReport:reportForm.titles.edit"),
    [mode, tr]
  );

  useEffect(() => {
    if (!submitting) {
      return;
    }

    const timer = window.setInterval(() => {
      setSaveProgress((prev) => {
        if (prev >= 95) return prev;
        if (prev < 30) return Math.min(95, prev + 7);
        if (prev < 70) return Math.min(95, prev + 4);
        return Math.min(95, prev + 2);
      });
    }, 220);

    return () => {
      window.clearInterval(timer);
    };
  }, [submitting]);

  useEffect(() => {
    if (autofilledFieldKeys.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      setAutofilledFieldKeys([]);
    }, 700);
    return () => {
      window.clearTimeout(timer);
    };
  }, [autofilledFieldKeys]);

  useEffect(() => {
    if (!timeInputWarningField) {
      return;
    }
    const timer = window.setTimeout(() => {
      setTimeInputWarningField(null);
    }, 3000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [timeInputWarningField]);

  const localizedReportTypeBaseOptions = useMemo(
    () => buildLocalizedOptions(REPORT_TYPE_VALUES, (value) => translateReportTypeValue(value, tr)),
    [tr]
  );
  const localizedInputOptionBaseOptions = useMemo(
    () => buildLocalizedOptions(INPUT_OPTION_VALUES, (value) => translateInputOptionValue(value, tr)),
    [tr]
  );
  const localizedShiftTypeBaseOptions = useMemo(
    () => buildLocalizedOptions(SHIFT_TYPE_VALUES, (value) => translateShiftTypeValue(value, tr)),
    [tr]
  );

  const reportTypeOptions = useMemo(
    () => withCurrentValue(localizedReportTypeBaseOptions, formState.reportType),
    [localizedReportTypeBaseOptions, formState.reportType]
  );
  const inputOptions = useMemo(
    () => withCurrentValue(localizedInputOptionBaseOptions, formState.inputOptions),
    [localizedInputOptionBaseOptions, formState.inputOptions]
  );
  const shiftTypeOptions = useMemo(
    () => withCurrentValue(localizedShiftTypeBaseOptions, formState.shiftType),
    [localizedShiftTypeBaseOptions, formState.shiftType]
  );
  const setupAdjustTypeOptions = useMemo(
    () =>
      withCurrentValue(
        buildLocalizedOptions(SETUP_ADJUST_TYPE_VALUES, (value) => value),
        formState.setupAdjustType
      ),
    [formState.setupAdjustType]
  );
  const countSetupTimeFlagOptions = useMemo(
    () =>
      withCurrentValue(
        buildLocalizedOptions(COUNT_SETUP_TIME_FLAG_VALUES, (value) => (value === "v" ? "✓" : value)),
        formState.countSetupTimeFlag
      ),
    [formState.countSetupTimeFlag]
  );
  const containerUnitOptions = useMemo(
    () =>
      withCurrentValue(
        buildLocalizedOptions(CONTAINER_UNIT_VALUES, (value) => value),
        formState.containerUnit
      ),
    [formState.containerUnit]
  );

  const setMaskedTimeField = useCallback((fieldKey: "startTime" | "endTime", rawValue: string): void => {
    const masked = maskTimeInputResult(rawValue);
    setFormState((prev) => ({
      ...prev,
      [fieldKey]: masked.value,
    }));
    if (masked.invalidAttempt) {
      setTimeInputWarningField(fieldKey);
    }
  }, []);

  const handleInputOptionsChange = useCallback(
    (value: string) => {
      let nextStateSnapshot: FormState | null = null;
      setFormState((prev) => {
        const next: FormState = { ...prev, inputOptions: value };
        const rule = INPUT_OPTION_DEFAULT_RULES[value];
        const nextState = applyInputOptionRule(next, rule);
        const flashKeys: string[] = [];
        if (rule?.shiftType && nextState.shiftType !== prev.shiftType) flashKeys.push("shiftType");
        if (rule?.startTime && nextState.startTime !== prev.startTime) flashKeys.push("startTime");
        if (rule?.endTime && nextState.endTime !== prev.endTime) flashKeys.push("endTime");
        if (rule?.breakTime && nextState.breakTime !== prev.breakTime) flashKeys.push("breakTime");
        if (flashKeys.length > 0) {
          setAutofilledFieldKeys(flashKeys);
        }
        nextStateSnapshot = nextState;
        return nextState;
      });
      if (nextStateSnapshot) {
        focusNextEmptyModalField("inputOptions", nextStateSnapshot);
      }
    },
    [focusNextEmptyModalField]
  );

  const handlePlannedIdleChange = useCallback(
    (value: string) => {
      let nextStateSnapshot: FormState | null = null;
      setFormState((prev) => {
        const next: FormState = {
          ...prev,
          plannedIdle: value,
          productionQty: value === "Yes" ? "" : prev.productionQty,
        };
        const rule = value === "Yes" ? PLANNED_IDLE_YES_DEFAULT_RULE : undefined;
        const nextState = applyInputOptionRule(next, rule);
        const flashKeys: string[] = [];
        if (rule?.shiftType && nextState.shiftType !== prev.shiftType) flashKeys.push("shiftType");
        if (rule?.startTime && nextState.startTime !== prev.startTime) flashKeys.push("startTime");
        if (rule?.endTime && nextState.endTime !== prev.endTime) flashKeys.push("endTime");
        if (rule?.plannedIdleMinutes && nextState.plannedIdleMinutes !== prev.plannedIdleMinutes) {
          flashKeys.push("plannedIdleMinutes");
        }
        if (flashKeys.length > 0) {
          setAutofilledFieldKeys(flashKeys);
        }
        nextStateSnapshot = nextState;
        return nextState;
      });
      if (nextStateSnapshot) {
        focusNextEmptyModalField("plannedIdle", nextStateSnapshot);
      }
    },
    [focusNextEmptyModalField]
  );

  const handleShiftTypeChange = useCallback(
    (value: string) => {
      let nextStateSnapshot: FormState | null = null;
      setFormState((prev) => {
        const nextState = {
          ...prev,
          shiftType: normalizeShiftTypeValue(value),
        };
        nextStateSnapshot = nextState;
        return nextState;
      });
      if (nextStateSnapshot) {
        focusNextEmptyModalField("shiftType", nextStateSnapshot);
      }
    },
    [focusNextEmptyModalField]
  );

  const handleDateChange = useCallback((rawValue: string) => {
    setFormState((prev) => ({
      ...prev,
      date: normalizeDateInputValue(rawValue),
    }));
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nativeSubmitEvent = event.nativeEvent as SubmitEvent;
    const submitter = nativeSubmitEvent.submitter;
    const submitIntent =
      submitter instanceof HTMLButtonElement &&
      submitter.value === "save-and-next" &&
      mode === "create"
        ? "save-and-next"
        : "save";

    if (optionsLoading) {
      onDebugEvent?.("modal-submit-blocked-options-loading", tr("workReport:reportForm.validation.optionsStillLoading"), {
        mode,
      });
      setError(tr("workReport:reportForm.validation.optionsStillLoading"));
      return;
    }

    const validationError = validate(formState, tr);
    if (validationError) {
      onDebugEvent?.("modal-submit-validation-failed", validationError, {
        mode,
      });
      setError(validationError);
      return;
    }

    const payload = buildReportMutationPayload(formState);
    setError(null);
    setSaveProgress((prev) => (prev > 0 ? prev : 8));
    try {
      await onSubmit(payload, {
        continueAfterSave: submitIntent === "save-and-next",
      });
      if (mode === "create") {
        writeRememberedCreateDefaults(formId, formState, entryContext?.id ?? "");
      }
      setSaveProgress(100);
    } catch (submitError) {
      if (submitError instanceof Error) {
        setError(submitError.message);
      } else {
        setError(tr("workReport:reportForm.validation.saveFailedRetry"));
      }
      setSaveProgress(0);
    }
  }

  const isAutofilledField = useCallback(
    (fieldKey: string): boolean => autofilledFieldKeys.includes(fieldKey),
    [autofilledFieldKeys]
  );

  return {
    formState,
    setFormState,
    isPlannedIdleYes,
    error,
    saveProgress,
    title,
    plannedIdleOptions: [...PLANNED_IDLE_MODAL_OPTIONS],
    reportTypeOptions,
    inputOptions,
    shiftTypeOptions,
    setupAdjustTypeOptions,
    countSetupTimeFlagOptions,
    containerUnitOptions,
    timeInputWarningField,
    handleSubmit,
    setMaskedTimeField,
    handleInputOptionsChange,
    handlePlannedIdleChange,
    handleShiftTypeChange,
    handleDateChange,
    isAutofilledField,
    resetToEmptyForm: () => setFormState(EMPTY_FORM),
  };
}

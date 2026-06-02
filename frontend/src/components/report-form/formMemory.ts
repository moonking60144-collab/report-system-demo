import { EMPTY_FORM } from "./constants";
import { mapToFormState } from "./formLogic";
import type { FormState } from "./types";
import type { FormOptionItem, WorkReportItem, WorkReportRecord } from "../../api/workReport";
import {
  inferEntryMachineDefaultSelection,
  inferOperatorDefaultByMachine,
  inferOperatorDefaultSelection,
  inferReportTypeFromProcessCode,
} from "./formLogic";
import type { WorkReportFormId } from "../../features/work-report/types";

function getReportFormMemoryStorageKey(formId: WorkReportFormId, entryId: string): string {
  return `work-report:form-memory:${formId}:${entryId}:v1`;
}

type RememberedFormFields = Pick<
  FormState,
  "machineId" | "operatorId" | "processCode"
>;

function resolveOperatorDisplayName(
  operatorId: string,
  operatorOptions: FormOptionItem[] = []
): string {
  const normalizedOperatorId = String(operatorId ?? "").trim();
  if (!normalizedOperatorId) {
    return "";
  }
  const matched = operatorOptions.find(
    (option) => String(option.value ?? "").trim() === normalizedOperatorId
  );
  return String(matched?.display ?? "").trim();
}

function sanitizeRememberedFormFields(value: unknown): RememberedFormFields {
  if (!value || typeof value !== "object") {
    return {
      machineId: "",
      operatorId: "",
      processCode: "",
    };
  }

  const candidate = value as Partial<RememberedFormFields>;
  return {
    machineId: String(candidate.machineId ?? "").trim(),
    operatorId: String(candidate.operatorId ?? "").trim(),
    processCode: String(candidate.processCode ?? "").trim(),
  };
}

export function readRememberedCreateDefaults(formId: WorkReportFormId, entryId: string): RememberedFormFields {
  if (typeof window === "undefined") {
    return {
      machineId: "",
      operatorId: "",
      processCode: "",
    };
  }

  try {
    const raw = window.sessionStorage.getItem(getReportFormMemoryStorageKey(formId, entryId));
    if (!raw) {
      return {
        machineId: "",
        operatorId: "",
        processCode: "",
      };
    }
    return sanitizeRememberedFormFields(JSON.parse(raw));
  } catch {
    return {
      machineId: "",
      operatorId: "",
      processCode: "",
    };
  }
}

export function writeRememberedCreateDefaults(
  formId: WorkReportFormId,
  formState: FormState,
  entryId: string
): void {
  if (typeof window === "undefined") {
    return;
  }

  const payload: RememberedFormFields = {
    machineId: String(formState.machineId ?? "").trim(),
    operatorId: String(formState.operatorId ?? "").trim(),
    processCode: String(formState.processCode ?? "").trim(),
  };

  try {
    window.sessionStorage.setItem(
      getReportFormMemoryStorageKey(formId, entryId),
      JSON.stringify(payload)
    );
  } catch {
    // NOTE: sessionStorage 寫入失敗時不阻塞主流程
  }
}

function buildLastRecordFallback(
  reports: WorkReportItem[] | undefined
): RememberedFormFields | null {
  if (!reports?.length) {
    return null;
  }

  const sorted = [...reports].sort((a, b) => {
    const aId = Number(a.rowId) || Number.MIN_SAFE_INTEGER;
    const bId = Number(b.rowId) || Number.MIN_SAFE_INTEGER;
    return bId - aId;
  });

  const last = sorted[0];
  if (!String(last.operatorId ?? "").trim()) {
    return null;
  }

  return {
    machineId: String(last.machineId ?? "").trim(),
    operatorId: String(last.operatorId ?? "").trim(),
    processCode: String(last.processCode ?? "").trim(),
  };
}

export function buildInitialFormState(
  formId: WorkReportFormId,
  mode: "create" | "edit",
  initialValue?: WorkReportItem | null,
  entryContext?: WorkReportRecord | null,
  machineOptions: FormOptionItem[] = [],
  operatorOptions: FormOptionItem[] = []
): FormState {
  const base = mapToFormState(initialValue);
  if (mode !== "create" || initialValue) {
    return base;
  }

  const remembered = readRememberedCreateDefaults(formId, entryContext?.id ?? "");
  const entryDefaultProcessCode = String(entryContext?.defaultProcessCode ?? "").trim();
  const rememberedOrFallback =
    remembered.operatorId || remembered.machineId || remembered.processCode
      ? remembered
      : (buildLastRecordFallback(entryContext?.reports) ?? {
          machineId: "",
          operatorId: "",
          processCode: "",
        });
  const entryMachineDefaults = inferEntryMachineDefaultSelection(entryContext, machineOptions);

  if (formId === "105") {
    const operatorDefaults = rememberedOrFallback.operatorId
      ? inferOperatorDefaultSelection(rememberedOrFallback.operatorId, entryContext, machineOptions)
      : {};
    const machineDefaults = rememberedOrFallback.machineId
      ? inferOperatorDefaultByMachine(rememberedOrFallback.machineId, machineOptions)
      : {};
    const processCode =
      entryDefaultProcessCode ||
      rememberedOrFallback.processCode ||
      operatorDefaults.processCode ||
      machineDefaults.processCode ||
      entryMachineDefaults.processCode ||
      "";
    const reportType =
      inferReportTypeFromProcessCode(entryDefaultProcessCode) ||
      inferReportTypeFromProcessCode(processCode) ||
      operatorDefaults.reportType ||
      machineDefaults.reportType ||
      "";
    const resolvedOperatorId = base.operatorId || rememberedOrFallback.operatorId;
    const operatorName =
      base.operatorName ||
      resolveOperatorDisplayName(resolvedOperatorId, operatorOptions) ||
      (resolvedOperatorId &&
      resolvedOperatorId === String(machineDefaults.operatorId ?? "").trim()
        ? String(machineDefaults.operatorName ?? "").trim()
        : "");

    return {
      ...EMPTY_FORM,
      ...base,
      machineId:
        base.machineId ||
        rememberedOrFallback.machineId ||
        operatorDefaults.machineId ||
        entryMachineDefaults.machineId ||
        "",
      operatorId: resolvedOperatorId,
      operatorName,
      processCode: base.processCode || processCode,
      reportType: base.reportType || reportType,
    };
  }

  const operatorDefaults = rememberedOrFallback.operatorId
    ? inferOperatorDefaultSelection(rememberedOrFallback.operatorId, entryContext, machineOptions)
    : {};
  const machineDefaults = rememberedOrFallback.machineId
    ? inferOperatorDefaultByMachine(rememberedOrFallback.machineId, machineOptions)
    : {};
  const derivedProcessCode =
    entryDefaultProcessCode ||
    rememberedOrFallback.processCode ||
    operatorDefaults.processCode ||
    machineDefaults.processCode ||
    entryMachineDefaults.processCode ||
    "";
  const derivedReportType =
    inferReportTypeFromProcessCode(entryDefaultProcessCode) ||
    inferReportTypeFromProcessCode(derivedProcessCode) ||
    operatorDefaults.reportType ||
    machineDefaults.reportType ||
    "";
  const derivedMachineId =
    rememberedOrFallback.machineId ||
    operatorDefaults.machineId ||
    entryMachineDefaults.machineId;
  const resolvedOperatorId = base.operatorId || rememberedOrFallback.operatorId;
  const operatorName =
    base.operatorName ||
    resolveOperatorDisplayName(resolvedOperatorId, operatorOptions) ||
    (resolvedOperatorId &&
    resolvedOperatorId === String(machineDefaults.operatorId ?? "").trim()
      ? String(machineDefaults.operatorName ?? "").trim()
      : "");

  return {
    ...EMPTY_FORM,
    ...base,
    machineId: base.machineId || derivedMachineId || "",
    operatorId: resolvedOperatorId,
    operatorName,
    processCode: base.processCode || derivedProcessCode,
    reportType: base.reportType || derivedReportType,
  };
}

export function hasAdvancedFieldValues(formState: FormState): boolean {
  const advancedKeys: Array<keyof FormState> = [
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
  ];

  return advancedKeys.some((key) => String(formState[key] ?? "").trim().length > 0);
}

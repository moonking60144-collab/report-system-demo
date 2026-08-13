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

export function buildInitialFormState(
  mode: "create" | "edit",
  initialValue?: WorkReportItem | null,
  entryContext?: WorkReportRecord | null,
  machineOptions: FormOptionItem[] = []
): FormState {
  const base = mapToFormState(initialValue);
  if (mode !== "create" || initialValue) {
    return base;
  }

  const entryDefaultProcessCode = String(entryContext?.defaultProcessCode ?? "").trim();
  const entryMachineDefaults = inferEntryMachineDefaultSelection(entryContext, machineOptions);
  const derivedProcessCode =
    entryDefaultProcessCode ||
    entryMachineDefaults.processCode ||
    "";
  const derivedReportType =
    inferReportTypeFromProcessCode(entryDefaultProcessCode) ||
    inferReportTypeFromProcessCode(derivedProcessCode) ||
    entryMachineDefaults.reportType ||
    "";

  return {
    ...EMPTY_FORM,
    ...base,
    machineId: base.machineId || entryMachineDefaults.machineId || "",
    processCode: base.processCode || derivedProcessCode,
    reportType: base.reportType || derivedReportType,
  };
}

export function applyCreateDefaultsToFormState(
  formState: FormState,
  entryContext?: WorkReportRecord | null,
  machineOptions: FormOptionItem[] = [],
  operatorOptions: FormOptionItem[] = []
): FormState {
  const defaults = buildInitialFormState(
    "create",
    null,
    entryContext,
    machineOptions
  );
  const next: FormState = { ...formState };
  const entryDefaultProcessCode = String(entryContext?.defaultProcessCode ?? "").trim();
  const draftMachineId = String(next.machineId ?? "").trim();
  const machineDefaults = draftMachineId
    ? inferOperatorDefaultByMachine(draftMachineId, machineOptions)
    : {};
  const draftOperatorId = String(next.operatorId ?? "").trim();
  const operatorDefaults = draftOperatorId
    ? inferOperatorDefaultSelection(draftOperatorId, entryContext, machineOptions)
    : {};
  const resolvedMachineId =
    String(next.machineId ?? "").trim() ||
    String(defaults.machineId ?? "").trim() ||
    String(operatorDefaults.machineId ?? "").trim();
  const resolvedOperatorId =
    String(next.operatorId ?? "").trim() ||
    String(defaults.operatorId ?? "").trim();
  const resolvedProcessCode =
    String(next.processCode ?? "").trim() ||
    entryDefaultProcessCode ||
    String(machineDefaults.processCode ?? "").trim() ||
    String(operatorDefaults.processCode ?? "").trim() ||
    String(defaults.processCode ?? "").trim();
  const resolvedReportType =
    String(next.reportType ?? "").trim() ||
    inferReportTypeFromProcessCode(resolvedProcessCode) ||
    String(machineDefaults.reportType ?? "").trim() ||
    String(operatorDefaults.reportType ?? "").trim() ||
    String(defaults.reportType ?? "").trim();
  const resolvedOperatorName =
    String(next.operatorName ?? "").trim() ||
    resolveOperatorDisplayName(resolvedOperatorId, operatorOptions) ||
    String(defaults.operatorName ?? "").trim();

  return {
    ...next,
    machineId: resolvedMachineId,
    operatorId: resolvedOperatorId,
    operatorName: resolvedOperatorName,
    processCode: resolvedProcessCode,
    reportType: resolvedReportType,
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

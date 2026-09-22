import type { ReportMutationPayload } from "../../../api/workReport";
import type { FormState } from "../types";
import { normalizeShiftTypeValue } from "./inference";

function normalizeOptionalNumber(value: string): number | undefined {
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeReasonMinute(value: string): number | undefined {
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function normalizePlannedIdle(value: string): string | undefined {
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "Yes" || normalized === "No") {
    return normalized;
  }
  return undefined;
}

export function buildReportMutationPayload(formState: FormState): ReportMutationPayload {
  const plannedIdle = normalizePlannedIdle(formState.plannedIdle);
  const productionQtyValue = formState.productionQty.trim();
  return {
    date: formState.date.trim(),
    plannedIdle,
    reportType: formState.reportType.trim() || undefined,
    processCode: formState.processCode.trim() || undefined,
    inputOptions: formState.inputOptions.trim() || undefined,
    shiftType: normalizeShiftTypeValue(formState.shiftType) || undefined,
    machineId: formState.machineId.trim(),
    operatorId: formState.operatorId.trim(),
    operatorName: formState.operatorName.trim() || undefined,
    startTime: formState.startTime.trim(),
    endTime: formState.endTime.trim(),
    breakTime: formState.breakTime.trim() || undefined,
    productionQty:
      plannedIdle === "Yes" && !productionQtyValue ? undefined : Number(formState.productionQty),
    remark: formState.remark.trim() || undefined,
    setupAdjustType: formState.setupAdjustType.trim() || undefined,
    setupAdjustMinutes: normalizeOptionalNumber(formState.setupAdjustMinutes),
    countSetupTimeFlag: formState.countSetupTimeFlag.trim() || undefined,
    setupTimeStandardHours: normalizeOptionalNumber(formState.setupTimeStandardHours),
    setupLossQtyPerPcs: normalizeOptionalNumber(formState.setupLossQtyPerPcs),
    processLossQtyPerPcs: normalizeOptionalNumber(formState.processLossQtyPerPcs),
    totalContainerQty: normalizeOptionalNumber(formState.totalContainerQty),
    containerUnit: formState.containerUnit.trim() || undefined,
    plannedIdleMinutes: normalizeReasonMinute(formState.plannedIdleMinutes),
    unplannedIdleMinutes: normalizeReasonMinute(formState.unplannedIdleMinutes),
    absentOrTrainingMinutes: normalizeReasonMinute(formState.absentOrTrainingMinutes),
    noMaterialMinutes: normalizeReasonMinute(formState.noMaterialMinutes),
    waitingQcApprovalMinutes: normalizeReasonMinute(formState.waitingQcApprovalMinutes),
    meetingMinutes: normalizeReasonMinute(formState.meetingMinutes),
    cleaningMinutes: normalizeReasonMinute(formState.cleaningMinutes),
    rdSamplingMinutes: normalizeReasonMinute(formState.rdSamplingMinutes),
    supportOtherMachinesMinutes: normalizeReasonMinute(formState.supportOtherMachinesMinutes),
    machineBreakdownMinutes: normalizeReasonMinute(formState.machineBreakdownMinutes),
    machineAdjustmentMinutes: normalizeReasonMinute(formState.machineAdjustmentMinutes),
    othersMinutes: normalizeReasonMinute(formState.othersMinutes),
    waitingForDiesMinutes: normalizeReasonMinute(formState.waitingForDiesMinutes),
    testingDiesMinutes: normalizeReasonMinute(formState.testingDiesMinutes),
  };
}

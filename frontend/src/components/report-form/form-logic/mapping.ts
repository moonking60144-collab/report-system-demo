import type { WorkReportItem } from "../../../api/workReport";
import { EMPTY_FORM } from "../constants";
import type { FormState } from "../types";
import { inferReportTypeFromProcessCode, normalizeShiftTypeValue } from "./inference";
import { to24HourTime } from "../timeUtils";

function toInputDate(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  const yyyy = parsed.getFullYear();
  const mm = String(parsed.getMonth() + 1).padStart(2, "0");
  const dd = String(parsed.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function toInputTime(value: string | null | undefined): string {
  return to24HourTime(value);
}

function toInputNumberString(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return String(value).trim();
}

export function mapToFormState(item?: WorkReportItem | null): FormState {
  if (!item) {
    return EMPTY_FORM;
  }

  const processCode = item.processCode ?? "";
  const reportType =
    (typeof item.reportType === "string" ? item.reportType : "").trim() ||
    inferReportTypeFromProcessCode(processCode);

  return {
    date: toInputDate(item.date),
    plannedIdle: item.plannedIdle ? String(item.plannedIdle) : "",
    reportType,
    processCode,
    inputOptions: item.inputOptions ?? "",
    machineId: item.machineId ?? "",
    operatorId: item.operatorId ?? "",
    operatorName: item.operatorName ?? "",
    shiftType: normalizeShiftTypeValue(item.shiftType),
    startTime: toInputTime(item.startTime),
    endTime: toInputTime(item.endTime),
    breakTime: item.breakTime ? String(item.breakTime) : "",
    productionQty:
      item.productionQty === null || item.productionQty === undefined
        ? ""
        : String(item.productionQty),
    remark: item.remark ?? "",
    setupAdjustType: item.setupAdjustType ? String(item.setupAdjustType) : "",
    setupAdjustMinutes: toInputNumberString(item.setupAdjustMinutes),
    countSetupTimeFlag: item.countSetupTimeFlag ? String(item.countSetupTimeFlag) : "",
    setupTimeStandardHours: toInputNumberString(item.setupTimeStandardHours),
    setupLossQtyPerPcs: toInputNumberString(item.setupLossQtyPerPcs),
    processLossQtyPerPcs: toInputNumberString(item.processLossQtyPerPcs),
    totalContainerQty: toInputNumberString(item.totalContainerQty),
    containerUnit: item.containerUnit ? String(item.containerUnit) : "",
    plannedIdleMinutes: toInputNumberString(item.plannedIdleMinutes),
    unplannedIdleMinutes: toInputNumberString(item.unplannedIdleMinutes),
    absentOrTrainingMinutes: toInputNumberString(item.absentOrTrainingMinutes),
    noMaterialMinutes: toInputNumberString(item.noMaterialMinutes),
    waitingQcApprovalMinutes: toInputNumberString(item.waitingQcApprovalMinutes),
    meetingMinutes: toInputNumberString(item.meetingMinutes),
    cleaningMinutes: toInputNumberString(item.cleaningMinutes),
    rdSamplingMinutes: toInputNumberString(item.rdSamplingMinutes),
    supportOtherMachinesMinutes: toInputNumberString(item.supportOtherMachinesMinutes),
    machineBreakdownMinutes: toInputNumberString(item.machineBreakdownMinutes),
    machineAdjustmentMinutes: toInputNumberString(item.machineAdjustmentMinutes),
    othersMinutes: toInputNumberString(item.othersMinutes),
    waitingForDiesMinutes: toInputNumberString(item.waitingForDiesMinutes),
    testingDiesMinutes: toInputNumberString(item.testingDiesMinutes),
  };
}

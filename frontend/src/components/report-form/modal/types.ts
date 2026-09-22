import type { FormState } from "../types";

export const MODAL_FIELD_ORDER = [
  "operatorId",
  "date",
  "plannedIdle",
  "machineId",
  "inputOptions",
  "shiftType",
  "startTime",
  "endTime",
  "breakTime",
  "productionQty",
  "processCode",
  "reportType",
  "remark",
  "setupAdjustType",
  "setupAdjustMinutes",
  "countSetupTimeFlag",
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
] as const;

export type ModalFieldKey = (typeof MODAL_FIELD_ORDER)[number];

export function isModalFieldEmpty(key: ModalFieldKey, state: FormState): boolean {
  switch (key) {
    case "operatorId": return !state.operatorId;
    case "date": return !state.date;
    case "plannedIdle": return !state.plannedIdle;
    case "machineId": return !state.machineId;
    case "inputOptions": return !state.inputOptions;
    case "shiftType": return !state.shiftType;
    case "startTime": return !state.startTime;
    case "endTime": return !state.endTime;
    case "breakTime": return !state.breakTime;
    case "productionQty": return !state.productionQty;
    case "processCode": return !state.processCode;
    case "reportType": return !state.reportType;
    case "remark": return !state.remark;
    case "setupAdjustType": return !state.setupAdjustType;
    case "setupAdjustMinutes": return !state.setupAdjustMinutes;
    case "countSetupTimeFlag": return !state.countSetupTimeFlag;
    case "setupLossQtyPerPcs": return !state.setupLossQtyPerPcs;
    case "processLossQtyPerPcs": return !state.processLossQtyPerPcs;
    case "totalContainerQty": return !state.totalContainerQty;
    case "containerUnit": return !state.containerUnit;
    case "plannedIdleMinutes": return !state.plannedIdleMinutes;
    case "unplannedIdleMinutes": return !state.unplannedIdleMinutes;
    case "absentOrTrainingMinutes": return !state.absentOrTrainingMinutes;
    case "noMaterialMinutes": return !state.noMaterialMinutes;
    case "waitingQcApprovalMinutes": return !state.waitingQcApprovalMinutes;
    case "meetingMinutes": return !state.meetingMinutes;
    case "cleaningMinutes": return !state.cleaningMinutes;
    case "rdSamplingMinutes": return !state.rdSamplingMinutes;
    case "supportOtherMachinesMinutes": return !state.supportOtherMachinesMinutes;
    case "machineBreakdownMinutes": return !state.machineBreakdownMinutes;
    case "machineAdjustmentMinutes": return !state.machineAdjustmentMinutes;
    case "othersMinutes": return !state.othersMinutes;
    case "waitingForDiesMinutes": return !state.waitingForDiesMinutes;
    case "testingDiesMinutes": return !state.testingDiesMinutes;
  }
}

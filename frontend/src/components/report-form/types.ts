export interface FormState {
  date: string;
  plannedIdle: string;
  reportType: string;
  processCode: string;
  inputOptions: string;
  machineId: string;
  operatorId: string;
  operatorName: string;
  shiftType: string;
  startTime: string;
  endTime: string;
  breakTime: string;
  productionQty: string;
  remark: string;
  setupAdjustType: string;
  setupAdjustMinutes: string;
  countSetupTimeFlag: string;
  setupTimeStandardHours: string;
  setupLossQtyPerPcs: string;
  processLossQtyPerPcs: string;
  totalContainerQty: string;
  containerUnit: string;
  plannedIdleMinutes: string;
  unplannedIdleMinutes: string;
  absentOrTrainingMinutes: string;
  noMaterialMinutes: string;
  waitingQcApprovalMinutes: string;
  meetingMinutes: string;
  cleaningMinutes: string;
  rdSamplingMinutes: string;
  supportOtherMachinesMinutes: string;
  machineBreakdownMinutes: string;
  machineAdjustmentMinutes: string;
  othersMinutes: string;
  waitingForDiesMinutes: string;
  testingDiesMinutes: string;
}

export interface InputOptionDefaultRule {
  shiftType: string;
  startTime?: string;
  endTime?: string;
  breakTime?: string;
  plannedIdleMinutes?: string;
}

export type TranslateFunction = (
  key: string,
  options?: Record<string, unknown>
) => string;

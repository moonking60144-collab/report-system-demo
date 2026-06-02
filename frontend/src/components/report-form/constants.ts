import type { InputOptionDefaultRule, FormState } from "./types";

export const EMPTY_FORM: FormState = {
  date: "",
  plannedIdle: "",
  reportType: "",
  processCode: "",
  inputOptions: "",
  machineId: "",
  operatorId: "",
  operatorName: "",
  shiftType: "",
  startTime: "",
  endTime: "",
  breakTime: "",
  productionQty: "",
  remark: "",
  setupAdjustType: "",
  setupAdjustMinutes: "",
  countSetupTimeFlag: "",
  setupTimeStandardHours: "",
  setupLossQtyPerPcs: "",
  processLossQtyPerPcs: "",
  totalContainerQty: "",
  containerUnit: "",
  plannedIdleMinutes: "",
  unplannedIdleMinutes: "",
  absentOrTrainingMinutes: "",
  noMaterialMinutes: "",
  waitingQcApprovalMinutes: "",
  meetingMinutes: "",
  cleaningMinutes: "",
  rdSamplingMinutes: "",
  supportOtherMachinesMinutes: "",
  machineBreakdownMinutes: "",
  machineAdjustmentMinutes: "",
  othersMinutes: "",
  waitingForDiesMinutes: "",
  testingDiesMinutes: "",
};

export const SETUP_ADJUST_TYPE_VALUES = ["(BA)架車", "(SA)調機"] as const;
export const COUNT_SETUP_TIME_FLAG_VALUES = ["v"] as const;
export const CONTAINER_UNIT_VALUES = ["桶Barrel", "箱Box", "袋Bag"] as const;

export const REASON_MINUTE_FIELD_DEFS = [
  { key: "plannedIdleMinutes", i18nKey: "workReport:reportForm.reasonSection.fields.plannedIdleMinutes" },
  { key: "unplannedIdleMinutes", i18nKey: "workReport:reportForm.reasonSection.fields.unplannedIdleMinutes" },
  { key: "absentOrTrainingMinutes", i18nKey: "workReport:reportForm.reasonSection.fields.absentOrTrainingMinutes" },
  { key: "noMaterialMinutes", i18nKey: "workReport:reportForm.reasonSection.fields.noMaterialMinutes" },
  { key: "waitingQcApprovalMinutes", i18nKey: "workReport:reportForm.reasonSection.fields.waitingQcApprovalMinutes" },
  { key: "meetingMinutes", i18nKey: "workReport:reportForm.reasonSection.fields.meetingMinutes" },
  { key: "cleaningMinutes", i18nKey: "workReport:reportForm.reasonSection.fields.cleaningMinutes" },
  { key: "rdSamplingMinutes", i18nKey: "workReport:reportForm.reasonSection.fields.rdSamplingMinutes" },
  { key: "supportOtherMachinesMinutes", i18nKey: "workReport:reportForm.reasonSection.fields.supportOtherMachinesMinutes" },
  { key: "machineBreakdownMinutes", i18nKey: "workReport:reportForm.reasonSection.fields.machineBreakdownMinutes" },
  { key: "machineAdjustmentMinutes", i18nKey: "workReport:reportForm.reasonSection.fields.machineAdjustmentMinutes" },
  { key: "othersMinutes", i18nKey: "workReport:reportForm.reasonSection.fields.othersMinutes" },
  { key: "waitingForDiesMinutes", i18nKey: "workReport:reportForm.reasonSection.fields.waitingForDiesMinutes" },
  { key: "testingDiesMinutes", i18nKey: "workReport:reportForm.reasonSection.fields.testingDiesMinutes" },
] as const;

export const REPORT_TYPE_VALUE = {
  HF_FORGING: "HF-Forge",
  TI_THREAD_ROLLING: "TI-ProcessA",
  PROCESSING_LM: "PROC-LM",
  PROCESSING_EP: "PROC-EP",
  MANUAL_INSPECTION_A: "CH-ManualInspect",
  MACHINE_INSPECTION_H: "CH-MachineInspect",
  PACKAGING: "PA-Pack",
  STOCK_PREP: "SP-Stock",
} as const;

export const REPORT_TYPE_VALUES = [
  REPORT_TYPE_VALUE.HF_FORGING,
  REPORT_TYPE_VALUE.TI_THREAD_ROLLING,
  REPORT_TYPE_VALUE.PROCESSING_LM,
  REPORT_TYPE_VALUE.PROCESSING_EP,
  REPORT_TYPE_VALUE.MANUAL_INSPECTION_A,
  REPORT_TYPE_VALUE.MACHINE_INSPECTION_H,
  REPORT_TYPE_VALUE.PACKAGING,
  REPORT_TYPE_VALUE.STOCK_PREP,
] as const;

export const INPUT_OPTION_VALUE = {
  FULL_DAY: "整天",
  UNMANNED_1200: "無人12:00",
  UNMANNED_1700: "無人17:00",
  OVERTIME_2H: "加班2H",
  OVERTIME_35H: "加班3.5H",
  MORNING_1200: "上午12:00",
  AFTERNOON_1300: "下午13:00",
} as const;

export const INPUT_OPTION_VALUES = [
  INPUT_OPTION_VALUE.FULL_DAY,
  INPUT_OPTION_VALUE.UNMANNED_1200,
  INPUT_OPTION_VALUE.UNMANNED_1700,
  INPUT_OPTION_VALUE.OVERTIME_2H,
  INPUT_OPTION_VALUE.OVERTIME_35H,
  INPUT_OPTION_VALUE.MORNING_1200,
  INPUT_OPTION_VALUE.AFTERNOON_1300,
] as const;

export const SHIFT_TYPE_VALUE = {
  REGULAR: "正常班Reg",
  OVERTIME: "加班OT",
  UNMANNED: "無人生產班Unmanned",
  SAT_OVERTIME: "休息日加班SAT-OT",
  CHANGEOVER_CLEANING_SETUP: "換線/清機/改車",
  PARAMETER_SETUP: "參數設定",
  MACHINE_ADJUSTMENT: "調機(參數調整)",
} as const;

export const SHIFT_TYPE_VALUES = [
  SHIFT_TYPE_VALUE.REGULAR,
  SHIFT_TYPE_VALUE.OVERTIME,
  SHIFT_TYPE_VALUE.UNMANNED,
  SHIFT_TYPE_VALUE.SAT_OVERTIME,
  SHIFT_TYPE_VALUE.CHANGEOVER_CLEANING_SETUP,
  SHIFT_TYPE_VALUE.PARAMETER_SETUP,
  SHIFT_TYPE_VALUE.MACHINE_ADJUSTMENT,
] as const;

export const SHIFT_TYPE_ALIAS_TO_CANONICAL: Record<string, string> = {
  [SHIFT_TYPE_VALUE.REGULAR]: SHIFT_TYPE_VALUE.REGULAR,
  正常班: SHIFT_TYPE_VALUE.REGULAR,
  Reg: SHIFT_TYPE_VALUE.REGULAR,
  [SHIFT_TYPE_VALUE.OVERTIME]: SHIFT_TYPE_VALUE.OVERTIME,
  OT: SHIFT_TYPE_VALUE.OVERTIME,
  加班: SHIFT_TYPE_VALUE.OVERTIME,
  [SHIFT_TYPE_VALUE.UNMANNED]: SHIFT_TYPE_VALUE.UNMANNED,
  "無人生產班 Unmanned": SHIFT_TYPE_VALUE.UNMANNED,
  無人生產班: SHIFT_TYPE_VALUE.UNMANNED,
  Unmanned: SHIFT_TYPE_VALUE.UNMANNED,
  [SHIFT_TYPE_VALUE.SAT_OVERTIME]: SHIFT_TYPE_VALUE.SAT_OVERTIME,
  "休息日加班 SAT-OT": SHIFT_TYPE_VALUE.SAT_OVERTIME,
  "SAT-OT": SHIFT_TYPE_VALUE.SAT_OVERTIME,
  換線清機改車: SHIFT_TYPE_VALUE.CHANGEOVER_CLEANING_SETUP,
  [SHIFT_TYPE_VALUE.CHANGEOVER_CLEANING_SETUP]: SHIFT_TYPE_VALUE.CHANGEOVER_CLEANING_SETUP,
  [SHIFT_TYPE_VALUE.PARAMETER_SETUP]: SHIFT_TYPE_VALUE.PARAMETER_SETUP,
  [SHIFT_TYPE_VALUE.MACHINE_ADJUSTMENT]: SHIFT_TYPE_VALUE.MACHINE_ADJUSTMENT,
};

export const SHIFT_TYPE_ALLOWED_VALUES: ReadonlySet<string> = new Set(SHIFT_TYPE_VALUES);

export const INPUT_OPTION_DEFAULT_RULES: Record<string, InputOptionDefaultRule> = {
  [INPUT_OPTION_VALUE.FULL_DAY]: {
    shiftType: SHIFT_TYPE_VALUE.REGULAR,
    startTime: "08:00",
    endTime: "17:00",
    breakTime: "1.00",
  },
  [INPUT_OPTION_VALUE.MORNING_1200]: {
    shiftType: SHIFT_TYPE_VALUE.REGULAR,
    startTime: "08:00",
    endTime: "12:00",
    breakTime: "0.00",
  },
  [INPUT_OPTION_VALUE.AFTERNOON_1300]: {
    shiftType: SHIFT_TYPE_VALUE.REGULAR,
    startTime: "13:00",
    endTime: "17:00",
    breakTime: "0.00",
  },
  [INPUT_OPTION_VALUE.UNMANNED_1200]: {
    shiftType: SHIFT_TYPE_VALUE.UNMANNED,
    startTime: "12:00",
    endTime: "13:00",
    breakTime: "0.00",
  },
  [INPUT_OPTION_VALUE.UNMANNED_1700]: {
    shiftType: SHIFT_TYPE_VALUE.UNMANNED,
    startTime: "17:00",
    endTime: "17:30",
    breakTime: "0.00",
  },
  [INPUT_OPTION_VALUE.OVERTIME_2H]: {
    shiftType: SHIFT_TYPE_VALUE.OVERTIME,
    startTime: "17:30",
    endTime: "19:30",
    breakTime: "0.00",
  },
  [INPUT_OPTION_VALUE.OVERTIME_35H]: {
    shiftType: SHIFT_TYPE_VALUE.OVERTIME,
    startTime: "17:30",
    endTime: "21:00",
    breakTime: "0.00",
  },
};

export const PLANNED_IDLE_YES_DEFAULT_RULE: InputOptionDefaultRule = {
  shiftType: SHIFT_TYPE_VALUE.REGULAR,
  startTime: "08:00",
  endTime: "17:00",
  breakTime: "1.00",
  plannedIdleMinutes: "480",
};

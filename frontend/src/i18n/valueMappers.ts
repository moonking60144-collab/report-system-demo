import type { CreateReportTaskStatus } from "../api/workReport";
import {
  COLUMN_BLANK_TOKEN,
  COLUMN_BOOL_FALSE_TOKEN,
  COLUMN_BOOL_TRUE_TOKEN,
} from "../features/work-report/constants";
import type { ColumnDataType } from "../features/work-report/types";
import { FALSE_BOOLEAN_VALUES, TRUE_BOOLEAN_VALUES } from "../utils/semanticBoolean";

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

function normalizeText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim();
}

export function translateWorkOrderStatusValue(status: string, t: TranslateFn): string {
  const normalized = status.trim();
  if (!normalized) {
    return normalized;
  }
  if (normalized === "未結案") {
    return t("workReport:values.workOrderStatus.open");
  }
  if (normalized === "已結案") {
    return t("workReport:values.workOrderStatus.closed");
  }
  return normalized;
}

export function translateBooleanLikeDisplay(value: unknown, t: TranslateFn): string {
  const text = normalizeText(value);
  if (!text) {
    return "-";
  }

  const lowered = text.toLowerCase();
  if (TRUE_BOOLEAN_VALUES.has(lowered)) {
    return t("common:yesNo.yes");
  }
  if (FALSE_BOOLEAN_VALUES.has(lowered)) {
    return t("common:yesNo.no");
  }
  return text;
}

export function translateCreateTaskStatusValue(status: CreateReportTaskStatus, t: TranslateFn): string {
  if (status === "pending") {
    return t("workReport:values.createTaskStatus.pending");
  }
  if (status === "running") {
    return t("workReport:values.createTaskStatus.running");
  }
  if (status === "success") {
    return t("workReport:values.createTaskStatus.success");
  }
  return t("workReport:values.createTaskStatus.failed");
}

export function translateColumnFilterTypeLabel(type: ColumnDataType, t: TranslateFn): string {
  if (type === "number") {
    return t("workReport:values.columnFilterType.number");
  }
  if (type === "date") {
    return t("workReport:values.columnFilterType.date");
  }
  if (type === "boolean") {
    return t("workReport:values.columnFilterType.boolean");
  }
  return t("workReport:values.columnFilterType.text");
}

export function translateColumnFacetTokenLabel(
  token: string,
  type: ColumnDataType,
  t: TranslateFn
): string {
  if (token === COLUMN_BLANK_TOKEN) {
    return t("workReport:values.special.blankToken");
  }
  if (type === "boolean") {
    if (token === COLUMN_BOOL_TRUE_TOKEN) {
      return t("common:yesNo.yes");
    }
    if (token === COLUMN_BOOL_FALSE_TOKEN) {
      return t("common:yesNo.no");
    }
  }
  return token;
}

function translateByMap(
  value: string,
  t: TranslateFn,
  keyMap: Record<string, string>
): string {
  const normalized = value.trim();
  if (!normalized) {
    return normalized;
  }
  const targetKey = keyMap[normalized];
  return targetKey ? t(targetKey) : normalized;
}

const REPORT_TYPE_KEY_MAP: Record<string, string> = {
  "HF-Forge": "workReport:values.reportType.hfForging",
  "TI-ProcessA": "workReport:values.reportType.tiThreadRolling",
  "PROC-LM": "workReport:values.reportType.processingLm",
  "PROC-EP": "workReport:values.reportType.processingEp",
  "CH-ManualInspect": "workReport:values.reportType.manualInspectionA",
  "CH-MachineInspect": "workReport:values.reportType.machineInspectionH",
  "PA-Pack": "workReport:values.reportType.packaging",
  "SP-Stock": "workReport:values.reportType.stockPrep",
};

const INPUT_OPTION_KEY_MAP: Record<string, string> = {
  整天: "workReport:values.inputOption.fullDay",
  "無人12:00": "workReport:values.inputOption.unmanned1200",
  "無人17:00": "workReport:values.inputOption.unmanned1700",
  加班2H: "workReport:values.inputOption.overtime2h",
  "加班3.5H": "workReport:values.inputOption.overtime35h",
  "上午12:00": "workReport:values.inputOption.morning1200",
  "下午13:00": "workReport:values.inputOption.afternoon1300",
};

const SHIFT_TYPE_KEY_MAP: Record<string, string> = {
  "正常班Reg": "workReport:values.shiftType.regular",
  "加班OT": "workReport:values.shiftType.overtime",
  "無人生產班Unmanned": "workReport:values.shiftType.unmanned",
  "休息日加班SAT-OT": "workReport:values.shiftType.satOvertime",
  "換線/清機/改車": "workReport:values.shiftType.changeoverCleaningSetup",
  "參數設定": "workReport:values.shiftType.parameterSetup",
  "調機(參數調整)": "workReport:values.shiftType.machineAdjustment",
};

export function translateReportTypeValue(value: string, t: TranslateFn): string {
  return translateByMap(value, t, REPORT_TYPE_KEY_MAP);
}

export function translateInputOptionValue(value: string, t: TranslateFn): string {
  return translateByMap(value, t, INPUT_OPTION_KEY_MAP);
}

export function translateShiftTypeValue(value: string, t: TranslateFn): string {
  return translateByMap(value, t, SHIFT_TYPE_KEY_MAP);
}

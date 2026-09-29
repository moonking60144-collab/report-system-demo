import type { WorkReportRecord } from "../../api/workReport";
import type { ColumnKey, UiLanguage, WorkReportFormId, WorkReportFilterCondition } from "./types";
import { createWorkReportFilterCondition, getWorkReportFilterFields, isWorkReportFilterConditionComplete, parseSemanticBoolean } from "./utils";
import { formatPlannedEndDateDisplay } from "./utils/plannedEndDateUtils";
import { COLUMN_TYPE_MAP } from "./constants";
import { getWorkReportFilterDateKey, parseWorkReportFilterNumber } from "./utils/customFilterUtils";

export const WORK_REPORT_BOOLEAN_EDIT_EVENT = "work-report-boolean-edit";

export function getWorkReportCellCopyValue(
  record: WorkReportRecord,
  columnKey: ColumnKey,
  formId: WorkReportFormId,
  uiLanguage: UiLanguage
): string {
  const value = columnKey === "machineCode" && formId === "902"
    ? record.filterMachineCode : record[columnKey];
  if (value === null || value === undefined || String(value).trim() === "") return "";
  if (["startSchedule", "urgent", "siteRunning", "prevStationRunning"].includes(columnKey)) {
    const checked = parseSemanticBoolean(value);
    if (checked !== null) return uiLanguage === "en" ? checked ? "Yes" : "No" : checked ? "是" : "否";
  }
  if (columnKey === "plannedEndDate") return formatPlannedEndDateDisplay(value);
  if (["machineCode", "previousMachine"].includes(columnKey)) return String(value).trim();
  return String(value);
}

export function getWorkReportRowCopyValue(
  record: WorkReportRecord, columnKeys: ColumnKey[], formId: WorkReportFormId, uiLanguage: UiLanguage
): string {
  return columnKeys.map(key => {
    const value = getWorkReportCellCopyValue(record, key, formId, uiLanguage);
    return /[\t\r\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  }).join("\t");
}

export function getWorkReportCellFilterCondition(
  record: WorkReportRecord, columnKey: ColumnKey, formId: WorkReportFormId
): WorkReportFilterCondition | null {
  const field = getWorkReportFilterFields(formId).find(field => field === columnKey);
  if (!field) return null;
  const value = columnKey === "machineCode" && formId === "902" ? record.filterMachineCode : record[columnKey];
  const text = String(value ?? "").trim();
  const condition = createWorkReportFilterCondition(field);
  if (!text) return { ...condition, operator: "isEmpty", values: [] };
  if (text.length > 120) return null;
  if (COLUMN_TYPE_MAP[field] === "boolean") {
    const checked = parseSemanticBoolean(value);
    return checked === null ? null : { ...condition, values: [checked ? "yes" : "no"] };
  }
  if (COLUMN_TYPE_MAP[field] === "number") {
    const number = parseWorkReportFilterNumber(value);
    return number === null ? null : { ...condition, operator: "equals", values: [String(number)] };
  }
  if (COLUMN_TYPE_MAP[field] === "date") {
    const date = getWorkReportFilterDateKey(value);
    if (date === null) return null;
    const dated = { ...condition, operator: "between" as const, values: [date, date] };
    return isWorkReportFilterConditionComplete(dated) ? dated : null;
  }
  return { ...condition, operator: field === "machineCode" || field === "status" ? "isAnyOf" : "equals", values: [text] };
}

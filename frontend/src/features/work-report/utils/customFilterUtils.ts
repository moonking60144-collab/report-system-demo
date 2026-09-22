import type { WorkReportRecord } from "../../../api/workReport";
import {
  ALL_FILTER_VALUE,
  WORK_REPORT_MAX_FILTER_CONDITIONS,
  WORK_REPORT_MAX_FILTER_VALUES,
} from "../constants";
import type {
  GlobalFilters,
  WorkReportFilterCondition,
  WorkReportFilterField,
  WorkReportFilterGroup,
  WorkReportFilterOperator,
  WorkReportFormId,
} from "../types";
import { parseSemanticBoolean } from "./valueUtils";

const FILTER_FIELD_ORDER: WorkReportFilterField[] = [
  "machineCode",
  "status",
  "workOrderNo",
  "customerPartNo",
  "siteRunning",
  "startSchedule",
  "lastUpdatedAt",
];
const FILTER_FIELDS = new Set<WorkReportFilterField>(FILTER_FIELD_ORDER);

export function getWorkReportFilterFields(
  formId: WorkReportFormId
): WorkReportFilterField[] {
  return FILTER_FIELD_ORDER.filter(
    (field) => formId === "901" || field !== "startSchedule"
  );
}

const FILTER_OPERATORS_BY_FIELD: Record<WorkReportFilterField, readonly WorkReportFilterOperator[]> = {
  workOrderNo: ["contains", "notContains", "equals", "startsWith", "isEmpty", "isNotEmpty"],
  customerPartNo: ["contains", "notContains", "equals", "startsWith", "isEmpty", "isNotEmpty"],
  machineCode: ["isAnyOf", "isNotAnyOf", "isEmpty", "isNotEmpty"],
  status: ["isAnyOf", "isNotAnyOf", "isEmpty", "isNotEmpty"],
  siteRunning: ["isAnyOf", "isNotAnyOf", "isEmpty", "isNotEmpty"],
  startSchedule: ["isAnyOf", "isNotAnyOf", "isEmpty", "isNotEmpty"],
  lastUpdatedAt: ["before", "after", "between", "isEmpty", "isNotEmpty"],
};

const VALUELESS_FILTER_OPERATORS = new Set<WorkReportFilterOperator>(["isEmpty", "isNotEmpty"]);
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
let conditionSequence = 0;

export const EMPTY_WORK_REPORT_FILTER_GROUP: WorkReportFilterGroup = {
  joinMode: "all",
  conditions: [],
};

export function createWorkReportFilterCondition(
  field: WorkReportFilterField = "machineCode"
): WorkReportFilterCondition {
  conditionSequence += 1;
  const defaultOperator = FILTER_OPERATORS_BY_FIELD[field][0];
  return {
    id: `filter-${Date.now().toString(36)}-${conditionSequence.toString(36)}`,
    field,
    operator: defaultOperator,
    values: [],
  };
}

export function cloneWorkReportFilterGroup(group: WorkReportFilterGroup): WorkReportFilterGroup {
  return {
    joinMode: group.joinMode,
    conditions: group.conditions.map((condition) => ({
      ...condition,
      values: [...condition.values],
    })),
  };
}

export function getWorkReportFilterOperators(
  field: WorkReportFilterField
): readonly WorkReportFilterOperator[] {
  return FILTER_OPERATORS_BY_FIELD[field];
}

export function isWorkReportFilterConditionComplete(
  condition: WorkReportFilterCondition
): boolean {
  if (VALUELESS_FILTER_OPERATORS.has(condition.operator)) {
    return true;
  }
  if (condition.operator === "between") {
    return (
      condition.values.length >= 2 &&
      isValidDateOnly(condition.values[0] ?? "") &&
      isValidDateOnly(condition.values[1] ?? "") &&
      condition.values[0] <= condition.values[1]
    );
  }
  if (condition.field === "lastUpdatedAt") {
    return isValidDateOnly(condition.values[0] ?? "");
  }
  return condition.values.some((value) => value.trim().length > 0);
}

function isValidDateOnly(value: string): boolean {
  const matched = DATE_ONLY_PATTERN.exec(value);
  if (!matched) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function normalizeWorkReportFilterGroup(value: unknown): WorkReportFilterGroup {
  if (!value || typeof value !== "object") {
    return cloneWorkReportFilterGroup(EMPTY_WORK_REPORT_FILTER_GROUP);
  }
  const candidate = value as Partial<WorkReportFilterGroup>;
  const conditions = Array.isArray(candidate.conditions)
    ? candidate.conditions
        .slice(0, WORK_REPORT_MAX_FILTER_CONDITIONS)
        .map((rawCondition, index): WorkReportFilterCondition | null => {
          if (!rawCondition || typeof rawCondition !== "object") {
            return null;
          }
          const raw = rawCondition as Partial<WorkReportFilterCondition>;
          if (typeof raw.field !== "string" || !FILTER_FIELDS.has(raw.field as WorkReportFilterField)) {
            return null;
          }
          const field = raw.field as WorkReportFilterField;
          if (
            typeof raw.operator !== "string" ||
            !FILTER_OPERATORS_BY_FIELD[field].includes(raw.operator as WorkReportFilterOperator)
          ) {
            return null;
          }
          const values = Array.isArray(raw.values)
            ? Array.from(
                new Set(
                  raw.values
                    .filter((item): item is string => typeof item === "string")
                    .map((item) => item.trim().slice(0, 120))
                    .filter(Boolean)
                )
              ).slice(0, WORK_REPORT_MAX_FILTER_VALUES)
            : [];
          const normalized: WorkReportFilterCondition = {
            id:
              typeof raw.id === "string" && raw.id.trim()
                ? raw.id.trim().slice(0, 80)
                : `restored-${index + 1}`,
            field,
            operator: raw.operator as WorkReportFilterOperator,
            values: VALUELESS_FILTER_OPERATORS.has(raw.operator as WorkReportFilterOperator)
              ? []
              : values,
          };
          return isWorkReportFilterConditionComplete(normalized) ? normalized : null;
        })
        .filter((condition): condition is WorkReportFilterCondition => condition !== null)
    : [];

  return {
    joinMode: candidate.joinMode === "any" ? "any" : "all",
    conditions,
  };
}

export function isSameWorkReportFilterGroup(
  left: WorkReportFilterGroup,
  right: WorkReportFilterGroup
): boolean {
  const comparable = (group: WorkReportFilterGroup) => {
    return {
      joinMode: group.joinMode,
      conditions: group.conditions.map(({ field, operator, values }) => ({
        field,
        operator,
        values: values.map((value) => value.trim()),
      })),
    };
  };
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

function appendGlobalCondition(
  conditions: WorkReportFilterCondition[],
  field: WorkReportFilterField,
  operator: WorkReportFilterOperator,
  values: string[]
): void {
  conditions.push({
    ...createWorkReportFilterCondition(field),
    operator,
    values,
  });
}

export function buildWorkReportFilterGroupFromGlobalFilters(
  filters: GlobalFilters,
  formId: WorkReportFormId
): WorkReportFilterGroup {
  const conditions: WorkReportFilterCondition[] = [];
  if (filters.workOrderKeyword.trim()) {
    appendGlobalCondition(conditions, "workOrderNo", "contains", [filters.workOrderKeyword.trim()]);
  }
  if (filters.customerPartKeyword.trim()) {
    appendGlobalCondition(conditions, "customerPartNo", "contains", [filters.customerPartKeyword.trim()]);
  }
  const machineCode = formId === "902" ? filters.filterMachineCode : filters.machineCode;
  if (machineCode !== ALL_FILTER_VALUE) {
    appendGlobalCondition(conditions, "machineCode", "isAnyOf", [machineCode]);
  }
  if (filters.status !== ALL_FILTER_VALUE) {
    appendGlobalCondition(conditions, "status", "isAnyOf", [filters.status]);
  }
  if (filters.siteRunning !== "all") {
    appendGlobalCondition(conditions, "siteRunning", "isAnyOf", [filters.siteRunning]);
  }
  if (filters.startSchedule !== "all") {
    appendGlobalCondition(conditions, "startSchedule", "isAnyOf", [filters.startSchedule]);
  }
  if (filters.updatedDateFrom && filters.updatedDateTo) {
    appendGlobalCondition(conditions, "lastUpdatedAt", "between", [
      filters.updatedDateFrom,
      filters.updatedDateTo,
    ]);
  } else if (filters.updatedDateFrom) {
    appendGlobalCondition(conditions, "lastUpdatedAt", "after", [filters.updatedDateFrom]);
  } else if (filters.updatedDateTo) {
    appendGlobalCondition(conditions, "lastUpdatedAt", "before", [filters.updatedDateTo]);
  }
  return { joinMode: "all", conditions };
}

function getConditionRecordValue(
  record: WorkReportRecord,
  field: WorkReportFilterField,
  formId?: WorkReportFormId
): unknown {
  if (field === "machineCode") {
    if (formId === "902") {
      return record.filterMachineCode;
    }
    return record.machineCode || record.filterMachineCode;
  }
  return record[field];
}

function normalizeComparableText(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function getBooleanToken(value: unknown): string {
  const parsed = parseSemanticBoolean(value);
  return parsed === true ? "yes" : parsed === false ? "no" : "";
}

function endOfDateTimestamp(value: string): number {
  return Date.parse(`${value}T23:59:59.999`);
}

function startOfDateTimestamp(value: string): number {
  return Date.parse(`${value}T00:00:00.000`);
}

export function matchesWorkReportFilterCondition(
  record: WorkReportRecord,
  condition: WorkReportFilterCondition,
  formId?: WorkReportFormId
): boolean {
  const rawValue = getConditionRecordValue(record, condition.field, formId);
  const text = normalizeComparableText(rawValue);
  const values = condition.values.map(normalizeComparableText);

  switch (condition.operator) {
    case "contains":
      return text.includes(values[0] ?? "");
    case "notContains":
      return !text.includes(values[0] ?? "");
    case "equals":
      return text === (values[0] ?? "");
    case "startsWith":
      return text.startsWith(values[0] ?? "");
    case "isAnyOf": {
      const comparable =
        condition.field === "siteRunning" || condition.field === "startSchedule"
          ? getBooleanToken(rawValue)
          : text;
      return values.includes(comparable);
    }
    case "isNotAnyOf": {
      const comparable =
        condition.field === "siteRunning" || condition.field === "startSchedule"
          ? getBooleanToken(rawValue)
          : text;
      return !values.includes(comparable);
    }
    case "isEmpty":
      return text === "";
    case "isNotEmpty":
      return text !== "";
    case "before": {
      const timestamp = Date.parse(String(rawValue ?? ""));
      return Number.isFinite(timestamp) && timestamp <= endOfDateTimestamp(condition.values[0] ?? "");
    }
    case "after": {
      const timestamp = Date.parse(String(rawValue ?? ""));
      return Number.isFinite(timestamp) && timestamp >= startOfDateTimestamp(condition.values[0] ?? "");
    }
    case "between": {
      const timestamp = Date.parse(String(rawValue ?? ""));
      return (
        Number.isFinite(timestamp) &&
        timestamp >= startOfDateTimestamp(condition.values[0] ?? "") &&
        timestamp <= endOfDateTimestamp(condition.values[1] ?? "")
      );
    }
  }
}

export function applyWorkReportFilterGroup(
  records: WorkReportRecord[],
  group: WorkReportFilterGroup = EMPTY_WORK_REPORT_FILTER_GROUP,
  formId?: WorkReportFormId
): WorkReportRecord[] {
  const normalized = normalizeWorkReportFilterGroup(group);
  if (normalized.conditions.length === 0) {
    return records;
  }
  const predicate = normalized.joinMode === "any" ? "some" : "every";
  return records.filter((record) =>
    normalized.conditions[predicate]((condition) =>
      matchesWorkReportFilterCondition(record, condition, formId)
    )
  );
}

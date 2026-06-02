import type { WorkReportRecord } from "../../../api/workReport";
import type {
  BackendColumnFilterState,
  ColumnDataType,
  ColumnFilterRule,
  ColumnFilterState,
  ColumnKey,
  ColumnSortRule,
} from "../types";
import { getColumnFacetToken } from "./columnFacetUtils";
import { getColumnCellValue } from "./recordUtils";
import {
  compareAlphaNumeric,
  normalizeColumnText,
  normalizeText,
  parseSemanticBoolean,
  toSortableDate,
  toSortableNumber,
} from "./valueUtils";

export function hasActiveColumnFilterRule(rule: ColumnFilterRule | undefined): boolean {
  if (!rule) {
    return false;
  }
  const hasSelectedTokens = Array.isArray(rule.selectedTokens) && rule.selectedTokens.length > 0;
  const hasTextQuery = typeof rule.textQuery === "string" && rule.textQuery.trim().length > 0;
  return hasSelectedTokens || hasTextQuery;
}

export function hasActiveColumnFilters(state: ColumnFilterState): boolean {
  return Object.values(state).some((rule) => hasActiveColumnFilterRule(rule));
}

export function applyColumnFilters(
  records: WorkReportRecord[],
  filters: ColumnFilterState,
  columnTypeMap: Record<string, ColumnDataType>
): WorkReportRecord[] {
  const activeEntries = Object.entries(filters).filter(([, rule]) =>
    hasActiveColumnFilterRule(rule)
  ) as Array<[ColumnKey, ColumnFilterRule]>;

  if (activeEntries.length === 0) {
    return records;
  }

  return records.filter((record) =>
    activeEntries.every(([key, rule]) => {
      const type = columnTypeMap[key] ?? "text";
      const value = getColumnCellValue(record, key);

      if (type === "text" && rule.textQuery) {
        const keyword = normalizeText(rule.textQuery);
        if (keyword && !normalizeText(value).includes(keyword)) {
          return false;
        }
      }

      const selectedTokens = rule.selectedTokens ?? [];
      if (selectedTokens.length > 0) {
        const token = getColumnFacetToken(value, type);
        if (!selectedTokens.includes(token)) {
          return false;
        }
      }

      return true;
    })
  );
}

export function buildBackendColumnFilters(
  filters: ColumnFilterState,
  columnTypeMap: Record<string, ColumnDataType>,
  options: { excludeColumnKey?: ColumnKey } = {}
): BackendColumnFilterState | undefined {
  const result: BackendColumnFilterState = {};

  for (const [columnKey, rule] of Object.entries(filters)) {
    if (columnKey === options.excludeColumnKey) {
      continue;
    }

    if (!hasActiveColumnFilterRule(rule)) {
      continue;
    }

    const selectedTokens = Array.isArray(rule?.selectedTokens)
      ? rule.selectedTokens.filter(Boolean)
      : [];
    const textQuery = typeof rule?.textQuery === "string" ? rule.textQuery.trim() : "";

    result[columnKey] = {
      type: columnTypeMap[columnKey] ?? "text",
      ...(selectedTokens.length > 0 ? { selectedTokens } : {}),
      ...(textQuery ? { textQuery } : {}),
    };
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

export function compareColumnCellValues(
  leftValue: unknown,
  rightValue: unknown,
  type: ColumnDataType
): number {
  if (type === "number") {
    const left = toSortableNumber(leftValue);
    const right = toSortableNumber(rightValue);
    if (left === null && right === null) {
      return 0;
    }
    if (left === null) {
      return 1;
    }
    if (right === null) {
      return -1;
    }
    return left - right;
  }

  if (type === "date") {
    const left = toSortableDate(leftValue);
    const right = toSortableDate(rightValue);
    if (left === null && right === null) {
      return 0;
    }
    if (left === null) {
      return 1;
    }
    if (right === null) {
      return -1;
    }
    return left - right;
  }

  if (type === "boolean") {
    const toRank = (value: unknown) => {
      const parsed = parseSemanticBoolean(value);
      if (parsed === null) {
        return 0;
      }
      return parsed ? 2 : 1;
    };
    return toRank(leftValue) - toRank(rightValue);
  }

  const leftText = normalizeColumnText(leftValue);
  const rightText = normalizeColumnText(rightValue);
  if (!leftText && !rightText) {
    return 0;
  }
  if (!leftText) {
    return 1;
  }
  if (!rightText) {
    return -1;
  }
  return compareAlphaNumeric(leftText, rightText);
}

export function sortRecordsByColumnRules(
  records: WorkReportRecord[],
  rules: ColumnSortRule[]
): WorkReportRecord[] {
  if (rules.length === 0) {
    return records;
  }

  return records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => {
      for (const rule of rules) {
        const compareValue = compareColumnCellValues(
          getColumnCellValue(left.record, rule.key),
          getColumnCellValue(right.record, rule.key),
          rule.type
        );
        if (compareValue !== 0) {
          return rule.direction === "desc" ? compareValue * -1 : compareValue;
        }
      }
      return left.index - right.index;
    })
    .map((item) => item.record);
}

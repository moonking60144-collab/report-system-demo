import {
  COLUMN_BLANK_TOKEN,
  COLUMN_BOOL_FALSE_TOKEN,
  COLUMN_BOOL_TRUE_TOKEN,
  COLUMN_HEADER_LOCALE_MAP,
  COLUMN_TEXT_FILTER_MAX_LENGTH,
} from "../constants";
import type {
  ColumnDataType,
  ColumnFacetOption,
  ColumnHeaderLocaleText,
  ColumnKey,
  UiLanguage,
} from "../types";
import { getColumnCellValue } from "./recordUtils";
import {
  compareAlphaNumeric,
  normalizeColumnText,
  parseSemanticBoolean,
  toSortableDate,
  toSortableNumber,
} from "./valueUtils";
import {
  translateColumnFacetTokenLabel,
  translateColumnFilterTypeLabel,
} from "../../../i18n/valueMappers";
import type { WorkReportRecord } from "../../../api/workReport";

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

export function getColumnFacetToken(value: unknown, type: ColumnDataType): string {
  if (type === "boolean") {
    const parsed = parseSemanticBoolean(value);
    if (parsed === true) {
      return COLUMN_BOOL_TRUE_TOKEN;
    }
    if (parsed === false) {
      return COLUMN_BOOL_FALSE_TOKEN;
    }
    return COLUMN_BLANK_TOKEN;
  }

  const text = normalizeColumnText(value);
  if (!text) {
    return COLUMN_BLANK_TOKEN;
  }
  return text;
}

export function getColumnFacetLabelFromToken(
  token: string,
  type: ColumnDataType,
  uiLanguage: UiLanguage = "zh",
  t?: TranslateFn
): string {
  if (t) {
    return translateColumnFacetTokenLabel(token, type, t);
  }
  if (token === COLUMN_BLANK_TOKEN) {
    return uiLanguage === "en" ? "(Blank)" : "（空白）";
  }

  if (type === "boolean") {
    if (token === COLUMN_BOOL_TRUE_TOKEN) {
      return uiLanguage === "en" ? "Yes" : "是";
    }
    if (token === COLUMN_BOOL_FALSE_TOKEN) {
      return uiLanguage === "en" ? "No" : "否";
    }
  }

  return token;
}

export function getColumnMenuFilterTitle(
  type: ColumnDataType,
  uiLanguage: UiLanguage = "zh",
  t?: TranslateFn
): string {
  if (t) {
    return translateColumnFilterTypeLabel(type, t);
  }
  if (uiLanguage === "en") {
    if (type === "number") {
      return "Number Filter";
    }
    if (type === "date") {
      return "Date Filter";
    }
    if (type === "boolean") {
      return "Boolean Filter";
    }
    return "Text Filter";
  }

  if (type === "number") {
    return "數值篩選";
  }
  if (type === "date") {
    return "日期篩選";
  }
  if (type === "boolean") {
    return "布林篩選";
  }
  return "文字篩選";
}

export function getColumnHeaderLocaleText(columnKey: ColumnKey, fallbackZhTitle: string): ColumnHeaderLocaleText {
  return (
    COLUMN_HEADER_LOCALE_MAP[columnKey] ?? {
      zh: fallbackZhTitle,
      en: fallbackZhTitle,
    }
  );
}

export function sanitizeColumnTextFilterInput(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, COLUMN_TEXT_FILTER_MAX_LENGTH);
}

export function buildColumnFacetOptions(
  records: WorkReportRecord[],
  columnKey: ColumnKey,
  type: ColumnDataType,
  uiLanguage: UiLanguage = "zh",
  t?: TranslateFn
): ColumnFacetOption[] {
  const tokens = Array.from(
    new Set(records.map((record) => getColumnFacetToken(getColumnCellValue(record, columnKey), type)))
  );

  return tokens
    .sort((left, right) => {
      if (left === right) {
        return 0;
      }
      if (left === COLUMN_BLANK_TOKEN) {
        return 1;
      }
      if (right === COLUMN_BLANK_TOKEN) {
        return -1;
      }

      if (type === "boolean") {
        const booleanRank = (token: string) => {
          if (token === COLUMN_BOOL_FALSE_TOKEN) {
            return 1;
          }
          if (token === COLUMN_BOOL_TRUE_TOKEN) {
            return 2;
          }
          return 3;
        };
        return booleanRank(left) - booleanRank(right);
      }

      if (type === "number") {
        const leftNumber = toSortableNumber(left);
        const rightNumber = toSortableNumber(right);
        if (leftNumber !== null && rightNumber !== null && leftNumber !== rightNumber) {
          return leftNumber - rightNumber;
        }
        if (leftNumber !== null && rightNumber === null) {
          return -1;
        }
        if (leftNumber === null && rightNumber !== null) {
          return 1;
        }
      }

      if (type === "date") {
        const leftDate = toSortableDate(left);
        const rightDate = toSortableDate(right);
        if (leftDate !== null && rightDate !== null && leftDate !== rightDate) {
          return leftDate - rightDate;
        }
        if (leftDate !== null && rightDate === null) {
          return -1;
        }
        if (leftDate === null && rightDate !== null) {
          return 1;
        }
      }

      return compareAlphaNumeric(left, right);
    })
    .map((token) => ({
      token,
      label: getColumnFacetLabelFromToken(token, type, uiLanguage, t),
    }));
}

import {
  COLUMN_BLANK_TOKEN,
  COLUMN_BOOL_FALSE_TOKEN,
  COLUMN_BOOL_TRUE_TOKEN,
} from "../constants";
import type {
  ColumnAnalysisSummary,
  ColumnDataType,
  ColumnKey,
  UiLanguage,
} from "../types";
import type { WorkReportRecord } from "../../../api/workReport";
import { getColumnFacetLabelFromToken, getColumnFacetToken } from "./columnFacetUtils";
import { getColumnCellValue } from "./recordUtils";
import { compareAlphaNumeric, toSortableDate, toSortableNumber } from "./valueUtils";

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

export function buildColumnAnalysisSummary(
  records: WorkReportRecord[],
  columnKey: ColumnKey,
  type: ColumnDataType,
  uiLanguage: UiLanguage = "zh",
  t?: TranslateFn
): ColumnAnalysisSummary {
  const values = records.map((record) => getColumnCellValue(record, columnKey));
  const tokens = values.map((value) => getColumnFacetToken(value, type));
  const nonBlankTokens = tokens.filter((token) => token !== COLUMN_BLANK_TOKEN);
  const distinctCount = new Set(tokens).size;
  const topValueCountMap = new Map<string, number>();

  for (const token of tokens) {
    const label = getColumnFacetLabelFromToken(token, type, uiLanguage, t);
    topValueCountMap.set(label, (topValueCountMap.get(label) ?? 0) + 1);
  }

  const topValues = Array.from(topValueCountMap.entries())
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return compareAlphaNumeric(left[0], right[0]);
    })
    .slice(0, 10)
    .map(([label, count]) => ({ label, count }));

  const summary: ColumnAnalysisSummary = {
    totalCount: records.length,
    nonEmptyCount: nonBlankTokens.length,
    blankCount: tokens.length - nonBlankTokens.length,
    distinctCount,
    topValues,
  };

  if (type === "number") {
    const numericValues = values
      .map((value) => toSortableNumber(value))
      .filter((value): value is number => value !== null);
    if (numericValues.length > 0) {
      const sum = numericValues.reduce((acc, value) => acc + value, 0);
      summary.numberStats = {
        sum,
        avg: sum / numericValues.length,
        min: Math.min(...numericValues),
        max: Math.max(...numericValues),
        count: numericValues.length,
      };
    }
  }

  if (type === "date") {
    const dateValues = values
      .map((value) => {
        const timestamp = toSortableDate(value);
        return timestamp === null ? null : { timestamp, raw: String(value) };
      })
      .filter((value): value is { timestamp: number; raw: string } => value !== null)
      .sort((left, right) => left.timestamp - right.timestamp);
    if (dateValues.length > 0) {
      summary.dateStats = {
        earliest: dateValues[0].raw,
        latest: dateValues[dateValues.length - 1].raw,
        count: dateValues.length,
      };
    }
  }

  if (type === "boolean") {
    let yes = 0;
    let no = 0;
    let blank = 0;
    for (const token of tokens) {
      if (token === COLUMN_BOOL_TRUE_TOKEN) {
        yes += 1;
      } else if (token === COLUMN_BOOL_FALSE_TOKEN) {
        no += 1;
      } else {
        blank += 1;
      }
    }
    summary.booleanStats = { yes, no, blank };
  }

  return summary;
}

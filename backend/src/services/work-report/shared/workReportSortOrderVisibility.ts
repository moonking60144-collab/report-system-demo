import type { WorkReportRecord } from "../../../types/workReport";
import { parseSemanticBoolean } from "../../../utils/semanticBoolean";
import { normalizeComparableValue, parseNumericValue } from "./valueUtils";

const LINE_B_OUTPUT_MATERIAL_PATTERN = /-\d{2}PB$/i;

function hasPositiveValue(...values: unknown[]): boolean {
  return values.some((value) => {
    const parsed = parseNumericValue(normalizeComparableValue(value).replace(/,/g, ""));
    return parsed !== null && parsed > 0;
  });
}

export function isReadyConsecutiveLineBRecord(record: WorkReportRecord): boolean {
  const prodType = normalizeComparableValue(record.prodType).toUpperCase();
  const processCode = normalizeComparableValue(record.defaultProcessCode).toUpperCase();
  const defaultMainMaterial = normalizeComparableValue(record.defaultMainMaterial);
  const isConsecutiveLineBStage =
    prodType === "PB" &&
    processCode.startsWith("B") &&
    LINE_B_OUTPUT_MATERIAL_PATTERN.test(defaultMainMaterial);

  if (!isConsecutiveLineBStage) {
    return false;
  }

  const currentStageReady =
    parseSemanticBoolean(record.siteRunning) === true ||
    hasPositiveValue(record.reportCount, record.producedQtyStat, record.completedQty);
  const previousStageReady =
    parseSemanticBoolean(record.prevStationRunning) === true ||
    normalizeComparableValue(record.prevStationStatus) === "已結案" ||
    hasPositiveValue(
      record.prevReportQtyPc,
      record.prevReportQtyKg,
      record.prevReportContainerQty,
      record.prevCompletePc,
      record.prevCompleteKg,
      record.prevCompleteContainer
    );

  return currentStageReady || previousStageReady;
}

export function shouldExcludeSortOrder99Record(
  record: WorkReportRecord,
  formId: string | undefined,
  excludeSortOrder99: boolean | undefined
): boolean {
  if (!excludeSortOrder99 || parseNumericValue(record.sortOrder) !== 99) {
    return false;
  }
  return formId !== "902" || !isReadyConsecutiveLineBRecord(record);
}

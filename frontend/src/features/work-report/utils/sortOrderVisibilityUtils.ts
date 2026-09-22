import type { WorkReportRecord } from "../../../api/workReport";
import { normalizeText, parseSemanticBoolean, toSortableNumber } from "./valueUtils";

const LINE_B_OUTPUT_MATERIAL_PATTERN = /-\d{2}PB$/i;

function hasPositiveValue(...values: unknown[]): boolean {
  return values.some((value) => {
    const parsed = toSortableNumber(value);
    return parsed !== null && parsed > 0;
  });
}

export function isReadyConsecutiveLineBRecord(record: WorkReportRecord): boolean {
  const prodType = normalizeText(record.prodType).toUpperCase();
  const processCode = normalizeText(record.defaultProcessCode).toUpperCase();
  const defaultMainMaterial = String(record.defaultMainMaterial ?? "").trim();
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
    String(record.prevStationStatus ?? "").trim() === "已結案" ||
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
  formId: string,
  hideSortOrder99Records: boolean
): boolean {
  if (!hideSortOrder99Records || toSortableNumber(record.sortOrder) !== 99) {
    return false;
  }
  return formId !== "902" || !isReadyConsecutiveLineBRecord(record);
}

import { RagicRecord } from "../../../ragic/client";
import { FormConfig } from "../../../types/formConfig";
import { getFirstFieldValue } from "../shared/subtableUtils";
import {
  isEmptyValue,
  normalizeComparableValue,
  parseHourMinuteValue,
  parseNumericValue,
} from "../shared/valueUtils";

export interface RecalculateNeedCheck {
  needsRecalculate: boolean;
  missingFields: string[];
  checkedFields: string[];
  formulaGaps: string[];
}

export function evaluateCreateRepairRequirement(
  rowData: RagicRecord,
  expectedSubtableRowData: RagicRecord,
  config: FormConfig
): {
  needsRepair: boolean;
  missingFieldKeys: string[];
  mismatchedFieldKeys: string[];
} {
  const requiredSemanticFields = new Set<string>([
    ...config.writeConfig.requiredFields,
    "operatorName",
  ]);
  const requiredFieldKeys = Array.from(requiredSemanticFields)
    .map((field) => config.writeConfig.subtableWriteFields[field])
    .filter((field): field is string => Boolean(field));
  const missingFieldKeys: string[] = [];
  const mismatchedFieldKeys: string[] = [];

  for (const fieldKey of requiredFieldKeys) {
    const expectedValue = expectedSubtableRowData[fieldKey];
    if (expectedValue === undefined) {
      continue;
    }

    const actualValue = rowData[fieldKey];
    if (isEmptyValue(actualValue)) {
      missingFieldKeys.push(fieldKey);
      continue;
    }

    if (normalizeComparableValue(actualValue) !== normalizeComparableValue(expectedValue)) {
      mismatchedFieldKeys.push(fieldKey);
    }
  }

  return {
    needsRepair: missingFieldKeys.length > 0 || mismatchedFieldKeys.length > 0,
    missingFieldKeys,
    mismatchedFieldKeys,
  };
}

export function evaluatePostCreateRecalculateNeed(
  rowData: RagicRecord,
  config: FormConfig
): RecalculateNeedCheck {
  const plannedIdleCandidates = [
    config.writeConfig.subtableWriteFields.plannedIdle,
    config.subtableFields.plannedIdle,
  ].filter((candidate): candidate is string => Boolean(candidate));
  const plannedIdleValue = getFirstFieldValue(rowData, plannedIdleCandidates);
  const isPlannedIdleYes = String(plannedIdleValue ?? "").trim() === "Yes";

  const criticalFields = [
    "operatorId",
    "operatorName",
    "date",
    "machineId",
    "startTime",
    "endTime",
    ...(isPlannedIdleYes ? [] : (["productionQty"] as const)),
  ] as const;

  const missingFieldSet = new Set<string>();
  for (const field of criticalFields) {
    const writeFieldId = config.writeConfig.subtableWriteFields[field];
    const displayFieldName = config.subtableFields[field];
    const fieldCandidates = [writeFieldId, displayFieldName].filter(
      (candidate): candidate is string => Boolean(candidate)
    );
    const value = getFirstFieldValue(rowData, fieldCandidates);
    if (isEmptyValue(value)) {
      missingFieldSet.add(field);
    }
  }

  const startTimeCandidates = [
    config.writeConfig.subtableWriteFields.startTime,
    config.subtableFields.startTime,
    "1002142",
  ].filter((candidate): candidate is string => Boolean(candidate));
  const endTimeCandidates = [
    config.writeConfig.subtableWriteFields.endTime,
    config.subtableFields.endTime,
    "1002143",
  ].filter((candidate): candidate is string => Boolean(candidate));
  const shiftTypeCandidates = [config.subtableFields.shiftType, "1002145"].filter(
    (candidate): candidate is string => Boolean(candidate)
  );
  const breakTimeCandidates = [
    config.writeConfig.subtableWriteFields.breakTime,
    config.subtableFields.breakTime,
    "1005322",
  ].filter((candidate): candidate is string => Boolean(candidate));
  const totalWorkTimeCandidates = [
    config.writeConfig.subtableWriteFields.totalWorkTime,
    config.subtableFields.totalWorkTime,
    "1002218",
    "Total Work Time總工時(時Hr)",
    "Total Work Time總工時(Hr)",
  ].filter((candidate): candidate is string => Boolean(candidate));
  const normalWorkHourCandidates = ["1009096", "[實際]時間-正常班(Hr)", "[實際]時間-正常班 (Hr)"];
  const startTimeValue = getFirstFieldValue(rowData, startTimeCandidates);
  const endTimeValue = getFirstFieldValue(rowData, endTimeCandidates);
  const shiftTypeValue = getFirstFieldValue(rowData, shiftTypeCandidates);
  const breakTimeValue = getFirstFieldValue(rowData, breakTimeCandidates);
  const totalWorkTimeValue = getFirstFieldValue(rowData, totalWorkTimeCandidates);
  const normalWorkHourValue = getFirstFieldValue(rowData, normalWorkHourCandidates);
  const startMinutes = parseHourMinuteValue(startTimeValue);
  const endMinutes = parseHourMinuteValue(endTimeValue);
  const breakHours = Math.max(0, parseNumericValue(breakTimeValue) ?? 0);
  const totalWorkHours = parseNumericValue(totalWorkTimeValue);
  const normalWorkHours = parseNumericValue(normalWorkHourValue);

  const formulaGaps: string[] = [];
  const hasValidTimeRange = startMinutes !== null && endMinutes !== null;

  if (hasValidTimeRange && isEmptyValue(shiftTypeValue)) {
    missingFieldSet.add("shiftType");
    formulaGaps.push("shiftType-missing-with-time-range");
  }

  if (hasValidTimeRange) {
    let durationMinutes = endMinutes - startMinutes;
    if (durationMinutes < 0) {
      durationMinutes += 24 * 60;
    }
    const expectedHours = Math.max(0, durationMinutes / 60 - breakHours);
    const shiftTypeText = String(shiftTypeValue ?? "").trim();
    const shouldCheckTotalWorkHours = expectedHours > 0;
    const shouldCheckNormalHours = !shiftTypeText || shiftTypeText === "正常班Reg";

    if (shouldCheckTotalWorkHours) {
      if (totalWorkHours === null) {
        missingFieldSet.add("totalWorkTime");
        formulaGaps.push("totalWorkTime-not-calculated");
      } else if (totalWorkHours <= 0) {
        missingFieldSet.add("totalWorkTime");
        formulaGaps.push("totalWorkTime-zero-but-expected-positive");
      }
    }

    if (shouldCheckNormalHours && totalWorkHours !== null && totalWorkHours > 0) {
      if (normalWorkHours !== null && normalWorkHours < 0) {
        formulaGaps.push("normal-hours-negative");
      }
    }
  }

  const missingFields = Array.from(missingFieldSet);

  return {
    needsRecalculate: missingFields.length > 0 || formulaGaps.length > 0,
    missingFields,
    checkedFields: [...criticalFields, "shiftType", "totalWorkTime", "normalWorkHours"],
    formulaGaps,
  };
}

export function shouldUseComputedTotalWorkTimeFallback(lastCheck: RecalculateNeedCheck): boolean {
  return (
    lastCheck.missingFields.length === 1 &&
    lastCheck.missingFields[0] === "totalWorkTime" &&
    (lastCheck.formulaGaps.includes("totalWorkTime-not-calculated") ||
      lastCheck.formulaGaps.includes("totalWorkTime-zero-but-expected-positive"))
  );
}

export function computeTotalWorkTimeHours(
  rowData: RagicRecord,
  config: FormConfig
): number | null {
  const startTimeCandidates = [
    config.writeConfig.subtableWriteFields.startTime,
    config.subtableFields.startTime,
    "1002142",
  ].filter((candidate): candidate is string => Boolean(candidate));
  const endTimeCandidates = [
    config.writeConfig.subtableWriteFields.endTime,
    config.subtableFields.endTime,
    "1002143",
  ].filter((candidate): candidate is string => Boolean(candidate));
  const breakTimeCandidates = [
    config.writeConfig.subtableWriteFields.breakTime,
    config.subtableFields.breakTime,
    "1005322",
  ].filter((candidate): candidate is string => Boolean(candidate));

  const startTimeValue = getFirstFieldValue(rowData, startTimeCandidates);
  const endTimeValue = getFirstFieldValue(rowData, endTimeCandidates);
  const breakTimeValue = getFirstFieldValue(rowData, breakTimeCandidates);

  const startMinutes = parseHourMinuteValue(startTimeValue);
  const endMinutes = parseHourMinuteValue(endTimeValue);
  if (startMinutes === null || endMinutes === null) {
    return null;
  }

  let durationMinutes = endMinutes - startMinutes;
  if (durationMinutes < 0) {
    durationMinutes += 24 * 60;
  }

  const breakHours = Math.max(0, parseNumericValue(breakTimeValue) ?? 0);
  const computed = Math.max(0, durationMinutes / 60 - breakHours);
  return Math.round(computed * 100) / 100;
}

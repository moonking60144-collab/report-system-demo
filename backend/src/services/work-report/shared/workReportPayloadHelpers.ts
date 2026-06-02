import { env } from "../../../config/env";
import { RagicRecord } from "../../../ragic/client";
import { FormConfig } from "../../../types/formConfig";
import { ReportWritePayload } from "../../../types/workReport";
import { SubtableRow } from "./subtableUtils";
import { isEmptyValue, normalizeComparableValue } from "./valueUtils";

export function buildSubtableRowData(
  payload: ReportWritePayload,
  config: FormConfig
): RagicRecord {
  const mapped: RagicRecord = {};
  for (const [semanticField, value] of Object.entries(payload)) {
    const ragicField = config.writeConfig.subtableWriteFields[semanticField];
    if (!ragicField || value === undefined) {
      continue;
    }
    mapped[ragicField] = value;
  }
  return mapped;
}

export function findLikelyCreatedRow(
  latestRows: SubtableRow[],
  beforeRowIds: ReadonlySet<string>,
  normalizedPayload: ReportWritePayload,
  config: FormConfig
): SubtableRow | null {
  const fields = config.writeConfig.subtableWriteFields;
  const expectedValues: Array<[string, string]> = [
    [fields.date, String(normalizedPayload.date ?? "").trim()],
    [fields.machineId, String(normalizedPayload.machineId ?? "").trim()],
    [fields.operatorId, String(normalizedPayload.operatorId ?? "").trim()],
    [fields.processCode, String(normalizedPayload.processCode ?? "").trim()],
    [fields.startTime, String(normalizedPayload.startTime ?? "").trim()],
    [fields.endTime, String(normalizedPayload.endTime ?? "").trim()],
    [fields.productionQty, String(normalizedPayload.productionQty ?? "").trim()],
  ].filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1]));

  if (expectedValues.length === 0) {
    return null;
  }

  const candidates = latestRows.filter((row) => !beforeRowIds.has(row.rowId));
  for (const row of candidates) {
    const matched = expectedValues.every(([fieldId, expected]) => {
      const actual = normalizeComparableValue(row.rowData[fieldId] ?? "");
      return actual === normalizeComparableValue(expected);
    });
    if (matched) {
      return row;
    }
  }

  return null;
}

export function buildForm16FallbackWritePayload(
  normalizedPayload: ReportWritePayload,
  workOrderNo: string,
  reportType: string,
  depUnit: string,
  prodType: string,
  config: FormConfig
): RagicRecord {
  const payload: RagicRecord = {};
  const append = (fieldId: string, value: unknown): void => {
    if (!fieldId || isEmptyValue(value)) {
      return;
    }
    payload[fieldId] = value;
  };
  const fieldEntries: Array<[string, unknown]> = [
    [config.writeConfig.subtableWriteFields.date, normalizedPayload.date],
    [config.writeConfig.subtableWriteFields.processCode, normalizedPayload.processCode],
    [config.writeConfig.subtableWriteFields.machineId, normalizedPayload.machineId],
    [config.writeConfig.subtableWriteFields.operatorId, normalizedPayload.operatorId],
    [config.writeConfig.subtableWriteFields.operatorName, normalizedPayload.operatorName],
    [config.writeConfig.subtableWriteFields.inputOptions, normalizedPayload.inputOptions],
    [config.writeConfig.subtableWriteFields.shiftType, normalizedPayload.shiftType],
    [config.writeConfig.subtableWriteFields.startTime, normalizedPayload.startTime],
    [config.writeConfig.subtableWriteFields.endTime, normalizedPayload.endTime],
    [config.writeConfig.subtableWriteFields.breakTime, normalizedPayload.breakTime],
    [config.writeConfig.subtableWriteFields.productionQty, normalizedPayload.productionQty],
    [env.RAGIC_FORM_16_REMARK_FIELD_ID, normalizedPayload.remark],
    [env.RAGIC_FORM_16_WORK_ORDER_FIELD_ID, workOrderNo],
    [env.RAGIC_FORM_16_PROCESS_FIELD_ID, normalizedPayload.processCode],
    [env.RAGIC_FORM_16_TYPE_FIELD_ID, reportType],
    [env.RAGIC_FORM_16_DEP_FIELD_ID, depUnit],
    [env.RAGIC_FORM_16_PROD_TYPE_FIELD_ID, prodType],
  ];
  for (const [fieldId, value] of fieldEntries) {
    append(fieldId, value);
  }
  return payload;
}

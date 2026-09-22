import { RagicFormData, RagicRecord } from "../../../ragic/client";

export interface RagicRow {
  entryId: string;
  data: RagicRecord;
}

export type SourceDataMap = Map<string, RagicRecord>;

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeRows(rawData: RagicFormData): RagicRow[] {
  return Object.entries(rawData)
    .filter(([key, value]) => !key.startsWith("_") && isObject(value))
    .map(([entryId, data]) => ({ entryId, data }));
}

export function mapSourceDataById(
  rawData: RagicFormData,
  lookupFieldId?: string
): SourceDataMap {
  const rows = normalizeRows(rawData);
  const sourceMap: SourceDataMap = new Map();

  for (const row of rows) {
    const ragicId =
      String(row.data._ragicId ?? row.data._ragic_id ?? row.entryId) || row.entryId;
    sourceMap.set(ragicId, row.data);
    sourceMap.set(row.entryId, row.data);

    if (!lookupFieldId) {
      continue;
    }

    const lookupValue = row.data[lookupFieldId];
    if (lookupValue !== null && lookupValue !== undefined && lookupValue !== "") {
      sourceMap.set(String(lookupValue), row.data);
    }
  }

  return sourceMap;
}

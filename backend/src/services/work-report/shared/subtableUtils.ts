import { RagicRecord } from "../../../ragic/client";
import { isObject } from "./ragicRowUtils";
import { isEmptyValue } from "./valueUtils";

export interface SubtableRow {
  rowId: string;
  rowData: RagicRecord;
}

export function collectSubtableRows(subtableRaw: unknown): SubtableRow[] {
  if (!isObject(subtableRaw)) {
    return [];
  }

  return Object.entries(subtableRaw)
    .filter(([rowId, row]) => /^\d+$/.test(rowId) && isObject(row))
    .map(([rowId, row]) => ({
      rowId,
      rowData: row as RagicRecord,
    }))
    .sort((a, b) => Number(b.rowId) - Number(a.rowId));
}

export function getFirstFieldValue(row: RagicRecord, fields: string[]): unknown {
  for (const field of fields) {
    const value = row[field];
    if (!isEmptyValue(value)) {
      return value;
    }
  }
  return undefined;
}

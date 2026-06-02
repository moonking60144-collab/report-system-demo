import type { WorkReportRecord } from "../../../api/workReport";
import { GLOBAL_SEARCH_COLUMN_KEYS } from "../constants";
import type { ColumnKey, MergeResult } from "../types";
import { normalizeText } from "./valueUtils";

export function getColumnCellValue(record: WorkReportRecord, key: ColumnKey): unknown {
  if (key === "machineCode") {
    const displayMachineCode = String(record.machineCode ?? "").trim();
    if (displayMachineCode) {
      return displayMachineCode;
    }
    return String(record.filterMachineCode ?? "").trim();
  }
  return record[key];
}

export function matchesPageReportGroup(record: WorkReportRecord, prodTypeCode = "TI"): boolean {
  const requiredProdType = String(prodTypeCode ?? "")
    .trim()
    .toUpperCase();
  if (!requiredProdType) {
    return true;
  }

  const recordProdType = String(record.prodType ?? "")
    .trim()
    .toUpperCase();

  return recordProdType === requiredProdType;
}

export function applyPageReportGroupFilter(
  records: WorkReportRecord[],
  prodTypeCode = "TI"
): WorkReportRecord[] {
  // NOTE: 舊版 full cache/列表資料可能還沒有 prodType 欄位，先不要把畫面整頁濾空。
  const hasAnyProdType = records.some((record) => String(record.prodType ?? "").trim() !== "");
  if (!hasAnyProdType) {
    return records;
  }
  return records.filter((record) => matchesPageReportGroup(record, prodTypeCode));
}

export function normalizeRecord(record: WorkReportRecord, reportsLoaded = false): WorkReportRecord {
  return {
    ...record,
    id: String(record.id),
    reports: record.reports ?? [],
    reportsLoaded,
  };
}

export function dedupeRecordsById(records: WorkReportRecord[]): WorkReportRecord[] {
  const mergedById = new Map<string, WorkReportRecord>();
  for (const record of records) {
    mergedById.set(String(record.id), normalizeRecord(record, Boolean(record.reportsLoaded)));
  }
  return Array.from(mergedById.values());
}

export function mergeEntryRecordList(
  records: WorkReportRecord[],
  entryId: string,
  nextRecord: WorkReportRecord
): MergeResult {
  let replaced = false;
  const next = records.map((record) => {
    if (String(record.id) !== entryId) {
      return record;
    }

    replaced = true;
    return {
      ...record,
      ...nextRecord,
      reports: nextRecord.reports ?? [],
      reportsLoaded: true,
    };
  });

  return { next, replaced };
}

export function matchesRecordGlobalKeyword(
  record: WorkReportRecord,
  globalKeyword: string,
  searchableKeys: readonly ColumnKey[] = GLOBAL_SEARCH_COLUMN_KEYS
): boolean {
  const keyword = normalizeText(globalKeyword);
  if (!keyword) {
    return true;
  }

  return searchableKeys.some((key) => {
    const value = record[key];
    if (value === null || value === undefined || value === "") {
      return false;
    }
    return normalizeText(value).includes(keyword);
  });
}

import { useCallback, useState } from "react";
import type { WorkReportRecord } from "../../../api/workReport";
import type { WorkReportFormId } from "../types";

export interface MarkedWorkOrder {
  entryId: string;
  workOrderNo: string;
}

function storageKey(formId: WorkReportFormId): string {
  return `work-report:marked-row:${formId}`;
}

function readMarkedRow(formId: WorkReportFormId): MarkedWorkOrder | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(formId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !("entryId" in parsed) || !("workOrderNo" in parsed)) return null;
    if (typeof parsed.entryId !== "string" || typeof parsed.workOrderNo !== "string") return null;
    return { entryId: parsed.entryId, workOrderNo: parsed.workOrderNo };
  } catch {
    return null;
  }
}

function writeMarkedRow(formId: WorkReportFormId, markedRow: MarkedWorkOrder | null): void {
  try {
    if (markedRow) window.sessionStorage.setItem(storageKey(formId), JSON.stringify(markedRow));
    else window.sessionStorage.removeItem(storageKey(formId));
  } catch {
    // Browser storage can be unavailable while the in-memory mark still works.
  }
}

export function useWorkReportMarkedRow(formId: WorkReportFormId) {
  const [markedRows, setMarkedRows] = useState<Record<WorkReportFormId, MarkedWorkOrder | null>>(() => ({
    "901": readMarkedRow("901"),
    "902": readMarkedRow("902"),
  }));
  const markedRow = markedRows[formId];

  const toggleMarkedRow = useCallback((record: WorkReportRecord) => {
    const entryId = String(record.id);
    const nextMarkedRow = markedRow?.entryId === entryId
      ? null
      : { entryId, workOrderNo: String(record.workOrderNo ?? "").trim() || entryId };
    setMarkedRows((previous) => ({ ...previous, [formId]: nextMarkedRow }));
    writeMarkedRow(formId, nextMarkedRow);
  }, [formId, markedRow]);

  const clearMarkedRow = useCallback(() => {
    setMarkedRows((previous) => ({ ...previous, [formId]: null }));
    writeMarkedRow(formId, null);
  }, [formId]);

  return { markedRow, toggleMarkedRow, clearMarkedRow };
}

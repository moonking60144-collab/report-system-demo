import type { ActivityLogDowntimeRecord, UpdateActivityLogDowntimePayload } from "../../api/downtime";
import type { DowntimeEditDraft } from "./components/WorkReportDowntimeRecordsTable";

export const downtimeEditableFields = ["date", "machineId", "processCode", "operatorId", "plannedIdleMinutes", "remark"] as const;
export type DowntimeEditableField = typeof downtimeEditableFields[number];

export function buildDowntimeEditPatch(original: ActivityLogDowntimeRecord, draft: DowntimeEditDraft): UpdateActivityLogDowntimePayload {
  const entries: Array<[string, string | number]> = [];
  const expected: Array<[string, string | number | null]> = [];
  for (const key of downtimeEditableFields) {
    const text = draft[key].trim();
    if (key === "plannedIdleMinutes" && !text) continue;
    const intended = key === "plannedIdleMinutes" ? Math.trunc(Number(text)) : text;
    const before = key === "date" ? original.date?.trim().replaceAll("/", "-") ?? null
      : typeof original[key] === "string" ? (original[key] as string).trim() || null : original[key];
    if (Object.is(intended === "" ? null : intended, before)) continue;
    entries.push([key, intended]);
    expected.push([key, before]);
  }
  return {
    ...Object.fromEntries(entries),
    fieldPreconditionVersion: 1,
    expectedValues: Object.fromEntries(expected),
  };
}

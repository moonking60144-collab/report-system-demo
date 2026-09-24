import { createHash } from "node:crypto";
import type { WorkReportRecord } from "../../../types/workReport";

const DERIVED_KEYS = new Set(["lastUpdatedAt", "filterLastUpdatedAt", "snapshotHash", "entrySnapshotHash"]);

function comparable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(comparable);
  if (!value || typeof value !== "object") return value ?? null;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key, next]) => !DERIVED_KEYS.has(key) && !key.endsWith("Display") && next !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, next]) => [key, comparable(next)]));
}

export function buildEntrySnapshotHash(record: WorkReportRecord): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(comparable(record))).digest("hex")}`;
}

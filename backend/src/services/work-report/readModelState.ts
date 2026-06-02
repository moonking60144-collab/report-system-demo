import { READ_MODEL_SCHEMA_VERSION } from "../../storage/sqlite/readModelSchema";

export interface SqliteReadableSyncState {
  status: string;
  snapshotAt: string | null;
  readModelVersion?: number | null;
}

export function isSqliteReadModelVersionCurrent(
  syncState: Pick<SqliteReadableSyncState, "readModelVersion"> | null
): boolean {
  return syncState?.readModelVersion === READ_MODEL_SCHEMA_VERSION;
}

export function hasReadableSqliteSnapshot(
  syncState: SqliteReadableSyncState | null
): boolean {
  return Boolean(syncState?.snapshotAt) && isSqliteReadModelVersionCurrent(syncState);
}

export function resolveSqliteFullReportsCacheState(
  syncState: SqliteReadableSyncState | null
): "fresh" | "stale" | "building" {
  if (syncState?.status === "running") {
    return "building";
  }
  if (syncState?.status === "failed") {
    return "stale";
  }
  return "fresh";
}

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

/**
 * snapshot 是否超過 maxStalenessMs 沒更新。snapshotAt 由全量 sync 與 callback
 * 單筆 upsert 共同推進，兩者都停擺才會走到 stale → 視為背景同步機制故障，
 * caller 應回退 Ragic 直讀。maxStalenessMs <= 0 表示停用檢查（恆 false）。
 * snapshotAt 解析失敗（NaN）視為 stale，回退方向安全。
 */
export function isSqliteSnapshotStale(
  syncState: SqliteReadableSyncState | null,
  maxStalenessMs: number
): boolean {
  if (maxStalenessMs <= 0 || !syncState?.snapshotAt) {
    return false;
  }
  const snapshotAtMs = Date.parse(syncState.snapshotAt);
  return Number.isNaN(snapshotAtMs) || Date.now() - snapshotAtMs > maxStalenessMs;
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

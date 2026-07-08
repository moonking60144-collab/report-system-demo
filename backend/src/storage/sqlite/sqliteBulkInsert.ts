const SQLITE_SAFE_MAX_BIND_PARAMS = 900;

export function resolveSqliteInsertChunkSize(
  requestedBatchSize: number,
  columnCount: number
): number {
  const normalizedBatchSize = Number.isFinite(requestedBatchSize)
    ? Math.max(1, Math.trunc(requestedBatchSize))
    : 1;
  const maxRowsByParams = Math.max(1, Math.floor(SQLITE_SAFE_MAX_BIND_PARAMS / columnCount));
  return Math.min(normalizedBatchSize, maxRowsByParams);
}

export function buildSqliteMultiRowPlaceholders(rowCount: number, columnCount: number): string {
  const rowPlaceholders = `(${new Array(columnCount).fill("?").join(", ")})`;
  return new Array(rowCount).fill(rowPlaceholders).join(", ");
}

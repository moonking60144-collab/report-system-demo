import { SubtableRow } from "../shared/subtableUtils";

export interface PollCreatedSubtableRowParams {
  beforeRowIds: ReadonlySet<string>;
  beforeRowsCount: number;
  maxRetry: number;
  retryDelayMs: number;
  fetchLatestRows: () => Promise<SubtableRow[]>;
  sleep: (ms: number) => Promise<void>;
}

export interface PollCreatedSubtableRowResult {
  targetRow: SubtableRow | null;
  latestRows: SubtableRow[];
  elapsedMs: number;
}

export async function pollCreatedSubtableRow(
  params: PollCreatedSubtableRowParams
): Promise<PollCreatedSubtableRowResult> {
  const {
    beforeRowIds,
    beforeRowsCount,
    maxRetry,
    retryDelayMs,
    fetchLatestRows,
    sleep,
  } = params;

  let latestRows: SubtableRow[] = [];
  let createdRow: SubtableRow | null = null;
  const startedAt = Date.now();

  for (let attempt = 0; attempt < maxRetry; attempt += 1) {
    latestRows = await fetchLatestRows();
    const newRows = latestRows.filter((row) => !beforeRowIds.has(row.rowId));
    if (newRows.length > 0) {
      createdRow = newRows[0];
      break;
    }
    if (attempt < maxRetry - 1) {
      await sleep(retryDelayMs);
    }
  }

  const targetRow =
    createdRow ??
    (beforeRowsCount === 0 && latestRows.length > 0 ? latestRows[0] : null);

  return {
    targetRow,
    latestRows,
    elapsedMs: Date.now() - startedAt,
  };
}

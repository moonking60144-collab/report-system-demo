export function getWorkReportTaskStatusMergeRank(
  status: string | null | undefined
): number {
  if (status === "success") {
    return 3;
  }
  if (status === "failed") {
    return 2;
  }
  if (status === "running") {
    return 1;
  }
  return 0;
}

export function parseWorkReportTaskTimestamp(value: string | null | undefined): number {
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

import { createApiClient } from "./apiClient";

const api = createApiClient({ timeoutMs: 3_500 });

export interface WorkReportReadinessSnapshot {
  ready: boolean;
  mode: "ready" | "degraded" | "unavailable";
  checkedAt: string;
  bootId: string;
  deployVersion: string;
  capabilities: {
    frontend: true;
    workReportRead: boolean;
    workReportWrite: boolean;
    realtime: true;
  };
  issues: string[];
}

export function isWorkReportReadyForReentry(
  snapshot: WorkReportReadinessSnapshot | null | undefined
): boolean {
  return Boolean(
    snapshot?.ready &&
      snapshot.capabilities.workReportRead &&
      snapshot.capabilities.workReportWrite
  );
}

export async function fetchWorkReportReadiness(): Promise<WorkReportReadinessSnapshot> {
  const response = await api.get<WorkReportReadinessSnapshot>("/ready", {
    headers: { "Cache-Control": "no-cache" },
    validateStatus: (status) => status === 200 || status === 503,
  });
  return response.data;
}

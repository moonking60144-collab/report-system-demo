export const WORK_REPORT_MUTATION_FAILURE_PHASES = [
  "entry-queue",
  "sync-wait",
  "current-read",
  "write",
  "verify",
  "projection",
  "unknown",
] as const;

export type WorkReportMutationFailurePhase =
  (typeof WORK_REPORT_MUTATION_FAILURE_PHASES)[number];

export interface WorkReportMutationTimings {
  syncWaitMs: number;
  entryQueueWaitMs?: number;
  currentReadMs?: number;
  currentReadLaneWaitMs?: number;
  currentReadUpstreamMs?: number;
  currentReadAttempts?: number;
  writeMs?: number;
  writeLaneWaitMs?: number;
  writeUpstreamMs?: number;
  writeAttempts?: number;
  verifyMs?: number;
  verifyLaneWaitMs?: number;
  verifyUpstreamMs?: number;
  verifyAttempts?: number;
  projectionEnqueueMs?: number;
  failurePhase?: WorkReportMutationFailurePhase;
}

const OPTIONAL_TIMING_KEYS = [
  "entryQueueWaitMs",
  "currentReadMs",
  "currentReadLaneWaitMs",
  "currentReadUpstreamMs",
  "writeMs",
  "writeLaneWaitMs",
  "writeUpstreamMs",
  "verifyMs",
  "verifyLaneWaitMs",
  "verifyUpstreamMs",
  "projectionEnqueueMs",
] as const;

const OPTIONAL_ATTEMPT_KEYS = [
  "currentReadAttempts",
  "writeAttempts",
  "verifyAttempts",
] as const;

function normalizeDurationMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.trunc(value));
}

export function normalizeWorkReportMutationTimings(
  value: unknown,
  fallback?: WorkReportMutationTimings
): WorkReportMutationTimings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback ? { ...fallback } : undefined;
  }
  const candidate = value as Partial<
    Record<keyof WorkReportMutationTimings, unknown>
  >;
  const syncWaitMs = normalizeDurationMs(candidate.syncWaitMs) ?? fallback?.syncWaitMs;
  if (syncWaitMs === undefined) {
    return undefined;
  }
  const normalized: WorkReportMutationTimings = { syncWaitMs };
  for (const key of OPTIONAL_TIMING_KEYS) {
    const duration = normalizeDurationMs(candidate[key]) ?? fallback?.[key];
    if (duration !== undefined) {
      normalized[key] = duration;
    }
  }
  for (const key of OPTIONAL_ATTEMPT_KEYS) {
    const attempts = normalizeDurationMs(candidate[key]) ?? fallback?.[key];
    if (attempts !== undefined) {
      normalized[key] = attempts;
    }
  }
  const failurePhase = WORK_REPORT_MUTATION_FAILURE_PHASES.includes(
    candidate.failurePhase as WorkReportMutationFailurePhase
  )
    ? (candidate.failurePhase as WorkReportMutationFailurePhase)
    : fallback?.failurePhase;
  if (failurePhase) {
    normalized.failurePhase = failurePhase;
  }
  return normalized;
}

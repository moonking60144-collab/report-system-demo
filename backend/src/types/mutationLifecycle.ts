export const MUTATION_LIFECYCLE_STATES = [
  "accepted",
  "running",
  "success",
  "failed",
  "conflict",
  "indeterminate",
  "unknown",
] as const;

export type MutationLifecycleState = (typeof MUTATION_LIFECYCLE_STATES)[number];

export interface MutationLifecycleTiming {
  lifecycleState: MutationLifecycleState;
  acceptedAt: string | null;
  confirmedAt: string | null;
}

const CONFLICT_ERROR_CODES = new Set([
  "DOWNTIME_RECORD_STALE",
  "DUPLICATE_PLANNED_IDLE",
  "ENTRY_EDIT_LOCKED",
  "LOCK_VERSION_MISMATCH",
]);

export function isMutationLifecycleState(value: unknown): value is MutationLifecycleState {
  return MUTATION_LIFECYCLE_STATES.includes(value as MutationLifecycleState);
}

export function isMutationConflictErrorCode(errorCode: string | null | undefined): boolean {
  const normalized = String(errorCode ?? "").trim().toUpperCase();
  return normalized.endsWith("_CONFLICT") || CONFLICT_ERROR_CODES.has(normalized);
}

export function resolveMutationLifecycleState(input: {
  status: "pending" | "running" | "success" | "failed";
  errorCode?: string | null;
  writeIndeterminate?: boolean | null;
  batchWriteIndeterminate?: boolean | null;
}): MutationLifecycleState {
  if (input.status === "pending") {
    return "accepted";
  }
  if (input.status === "running") {
    return "running";
  }
  if (input.status === "success") {
    return "success";
  }
  if (input.writeIndeterminate === true || input.batchWriteIndeterminate === true) {
    return "indeterminate";
  }
  if (String(input.errorCode ?? "").trim().toUpperCase().endsWith("_INDETERMINATE")) {
    return "indeterminate";
  }
  if (isMutationConflictErrorCode(input.errorCode)) {
    return "conflict";
  }
  return "failed";
}

export function isConfirmedMutationLifecycleState(state: MutationLifecycleState): boolean {
  return state === "success" || state === "failed" || state === "conflict";
}

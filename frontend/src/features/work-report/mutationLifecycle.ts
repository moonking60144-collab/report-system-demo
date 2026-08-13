import type { MutationLifecycleState } from "../../api/mutationLifecycleTypes";

export type OptimisticMutationState =
  | "not-applied"
  | "applied"
  | "confirmed"
  | "rolled-back"
  | "frozen";

export type MutationOperationKind =
  | "work-report-create"
  | "work-report-update"
  | "work-report-delete"
  | "work-report-batch-create"
  | "work-report-batch-delete"
  | "work-report-sort-order"
  | "work-report-main-machine"
  | "work-report-close"
  | "work-report-reopen"
  | "form16-create"
  | "form16-update"
  | "form16-delete";

export type MutationReconcilePolicy =
  | "replace-target"
  | "refresh-entry"
  | "refresh-form"
  | "partial";

export type MutationFailurePolicy = "rollback" | "refresh-authoritative" | "freeze";

export interface OptimisticMutationTarget {
  domain: "work-report" | "form16-downtime";
  formId: "16" | "104" | "105";
  entryId: string;
  rowId?: string;
  clientRowKey?: string;
}

export interface OptimisticMutationLifecycle<TPreviousSnapshot = unknown> {
  version: 1;
  mutationId: string;
  taskId: string;
  operation: MutationOperationKind;
  target: OptimisticMutationTarget;
  lifecycleState: MutationLifecycleState;
  optimisticState: OptimisticMutationState;
  acceptedAt: string;
  confirmedAt: string | null;
  reconcilePolicy: MutationReconcilePolicy;
  failurePolicy: MutationFailurePolicy;
  previousSnapshot?: TPreviousSnapshot;
}

const LIFECYCLE_STATES = new Set<MutationLifecycleState>([
  "accepted",
  "running",
  "success",
  "failed",
  "conflict",
  "indeterminate",
  "unknown",
]);
const OPTIMISTIC_STATES = new Set<OptimisticMutationState>([
  "not-applied",
  "applied",
  "confirmed",
  "rolled-back",
  "frozen",
]);
const OPERATION_KINDS = new Set<MutationOperationKind>([
  "work-report-create",
  "work-report-update",
  "work-report-delete",
  "work-report-batch-create",
  "work-report-batch-delete",
  "work-report-sort-order",
  "work-report-main-machine",
  "work-report-close",
  "work-report-reopen",
  "form16-create",
  "form16-update",
  "form16-delete",
]);
const RECONCILE_POLICIES = new Set<MutationReconcilePolicy>([
  "replace-target",
  "refresh-entry",
  "refresh-form",
  "partial",
]);
const FAILURE_POLICIES = new Set<MutationFailurePolicy>([
  "rollback",
  "refresh-authoritative",
  "freeze",
]);

export function createAcceptedMutationLifecycle<TPreviousSnapshot = unknown>(input: {
  mutationId: string;
  taskId: string;
  operation: MutationOperationKind;
  target: OptimisticMutationTarget;
  acceptedAt: string;
  reconcilePolicy: MutationReconcilePolicy;
  failurePolicy: MutationFailurePolicy;
  previousSnapshot?: TPreviousSnapshot;
}): OptimisticMutationLifecycle<TPreviousSnapshot> {
  return {
    version: 1,
    mutationId: input.mutationId,
    taskId: input.taskId,
    operation: input.operation,
    target: input.target,
    lifecycleState: "accepted",
    optimisticState: "not-applied",
    acceptedAt: input.acceptedAt,
    confirmedAt: null,
    reconcilePolicy: input.reconcilePolicy,
    failurePolicy: input.failurePolicy,
    ...(Object.prototype.hasOwnProperty.call(input, "previousSnapshot")
      ? { previousSnapshot: input.previousSnapshot }
      : {}),
  };
}

export function applyOptimisticMutation<TPreviousSnapshot>(
  lifecycle: OptimisticMutationLifecycle<TPreviousSnapshot>
): OptimisticMutationLifecycle<TPreviousSnapshot> {
  return {
    ...lifecycle,
    optimisticState: "applied",
  };
}

export function reconcileOptimisticMutation<TPreviousSnapshot>(
  lifecycle: OptimisticMutationLifecycle<TPreviousSnapshot>,
  observation: {
    lifecycleState: MutationLifecycleState;
    confirmedAt?: string | null;
  }
): OptimisticMutationLifecycle<TPreviousSnapshot> {
  const confirmedAt = observation.confirmedAt ?? lifecycle.confirmedAt;
  if (observation.lifecycleState === "accepted" || observation.lifecycleState === "running") {
    return {
      ...lifecycle,
      lifecycleState: observation.lifecycleState,
    };
  }
  if (observation.lifecycleState === "success") {
    return {
      ...lifecycle,
      lifecycleState: "success",
      optimisticState: "confirmed",
      confirmedAt,
    };
  }
  if (observation.lifecycleState === "indeterminate" || observation.lifecycleState === "unknown") {
    return {
      ...lifecycle,
      lifecycleState: observation.lifecycleState,
      optimisticState: "frozen",
      confirmedAt: null,
    };
  }

  const canRollback =
    lifecycle.failurePolicy === "rollback" &&
    Object.prototype.hasOwnProperty.call(lifecycle, "previousSnapshot");
  return {
    ...lifecycle,
    lifecycleState: observation.lifecycleState,
    optimisticState: canRollback ? "rolled-back" : "frozen",
    confirmedAt,
  };
}

export function normalizeStoredMutationLifecycle<TPreviousSnapshot>(
  value: unknown,
  fallback: OptimisticMutationLifecycle<TPreviousSnapshot>
): OptimisticMutationLifecycle<TPreviousSnapshot> {
  return isStoredMutationLifecycle<TPreviousSnapshot>(value) ? value : fallback;
}

export function isStoredMutationLifecycle<TPreviousSnapshot = unknown>(
  value: unknown
): value is OptimisticMutationLifecycle<TPreviousSnapshot> {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<OptimisticMutationLifecycle<TPreviousSnapshot>>;
  const target = candidate.target as Partial<OptimisticMutationTarget> | undefined;
  if (
    candidate.version !== 1 ||
    typeof candidate.mutationId !== "string" ||
    typeof candidate.taskId !== "string" ||
    !OPERATION_KINDS.has(candidate.operation as MutationOperationKind) ||
    !target ||
    (target.domain !== "work-report" && target.domain !== "form16-downtime") ||
    (target.formId !== "16" && target.formId !== "104" && target.formId !== "105") ||
    (target.domain === "work-report" && target.formId === "16") ||
    (target.domain === "form16-downtime" && target.formId !== "16") ||
    typeof target.entryId !== "string" ||
    (target.rowId !== undefined && typeof target.rowId !== "string") ||
    (target.clientRowKey !== undefined && typeof target.clientRowKey !== "string") ||
    !LIFECYCLE_STATES.has(candidate.lifecycleState as MutationLifecycleState) ||
    !OPTIMISTIC_STATES.has(candidate.optimisticState as OptimisticMutationState) ||
    typeof candidate.acceptedAt !== "string" ||
    (candidate.confirmedAt !== null && typeof candidate.confirmedAt !== "string") ||
    !RECONCILE_POLICIES.has(candidate.reconcilePolicy as MutationReconcilePolicy) ||
    !FAILURE_POLICIES.has(candidate.failurePolicy as MutationFailurePolicy)
  ) {
    return false;
  }
  return true;
}

function isConflictErrorCode(errorCode: string | null | undefined): boolean {
  const normalized = String(errorCode ?? "").trim().toUpperCase();
  return (
    normalized.endsWith("_CONFLICT") ||
    normalized === "DOWNTIME_RECORD_STALE" ||
    normalized === "DUPLICATE_PLANNED_IDLE" ||
    normalized === "ENTRY_EDIT_LOCKED" ||
    normalized === "LOCK_VERSION_MISMATCH"
  );
}

export function resolveTaskMutationLifecycleState(input: {
  status: "pending" | "running" | "success" | "failed";
  lifecycleState?: MutationLifecycleState | null;
  errorCode?: string | null;
  writeIndeterminate?: boolean | null;
  batchWriteIndeterminate?: boolean | null;
}): MutationLifecycleState {
  if (input.lifecycleState && LIFECYCLE_STATES.has(input.lifecycleState)) {
    return input.lifecycleState;
  }
  if (input.status === "pending") return "accepted";
  if (input.status === "running") return "running";
  if (input.status === "success") return "success";
  if (input.writeIndeterminate === true || input.batchWriteIndeterminate === true) {
    return "indeterminate";
  }
  if (String(input.errorCode ?? "").trim().toUpperCase().endsWith("_INDETERMINATE")) {
    return "indeterminate";
  }
  return isConflictErrorCode(input.errorCode) ? "conflict" : "failed";
}

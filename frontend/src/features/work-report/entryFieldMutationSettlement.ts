import {
  fetchWorkReportEntry,
  type WorkReportRecord,
} from "../../api/workReport";
import {
  authoritativeEntryFieldMutationMatches,
  getRetryableEntryFieldMutationByTaskId,
  isEntryFieldMutationOperation,
  previousEntryFieldMutationMatches,
  type RetryableEntryFieldMutation,
} from "./entryFieldTaskRetryStore";
import { reconcileWorkReportOptimisticMutation } from "./workReportOptimisticMutation";
import type { CreateTaskMonitor } from "./types";
import { toSortableDate } from "./utils/valueUtils";
import { normalizeRecord } from "./utils/recordUtils";

export interface EntryFieldMutationSettlement {
  authoritativeRecord: WorkReportRecord;
  monitor: CreateTaskMonitor;
  shouldDeleteRetryMutation: boolean;
}

export function orderEntryFieldSettlementTasksForConsumption<
  TTask extends Pick<
    CreateTaskMonitor,
    | "acceptedAt"
    | "confirmedAt"
    | "entryFieldSettlementRecord"
    | "updatedAt"
  >
>(tasks: readonly TTask[]): TTask[] {
  const getOrderingValues = (task: TTask): Array<number | null> => [
    toSortableDate(task.entryFieldSettlementRecord?.lastUpdatedAt),
    toSortableDate(task.confirmedAt),
    toSortableDate(task.updatedAt),
    toSortableDate(task.acceptedAt),
  ];
  const orderedSettlements = tasks
    .filter((task) => task.entryFieldSettlementRecord)
    .sort((left, right) => {
      const leftValues = getOrderingValues(left);
      const rightValues = getOrderingValues(right);
      for (let index = 0; index < leftValues.length; index += 1) {
        const leftValue = leftValues[index];
        const rightValue = rightValues[index];
        if (
          leftValue !== null &&
          rightValue !== null &&
          leftValue !== rightValue
        ) {
          return leftValue - rightValue;
        }
      }
      return 0;
    });
  let settlementIndex = 0;
  return tasks.map((task) =>
    task.entryFieldSettlementRecord
      ? orderedSettlements[settlementIndex++]
      : task
  );
}

export function shouldReplayEntryFieldMutationPatch(
  mutationVersion: unknown,
  mutation: RetryableEntryFieldMutation,
  currentRecord?: WorkReportRecord | null,
  monitor?: Pick<CreateTaskMonitor, "status" | "lifecycleState" | "stale">
): boolean {
  if (!currentRecord) {
    return true;
  }
  if (String(currentRecord.id) !== mutation.entryId) {
    return false;
  }
  if (authoritativeEntryFieldMutationMatches(currentRecord, mutation)) {
    return true;
  }
  const lifecycleState = monitor?.lifecycleState ?? mutation.lifecycle?.lifecycleState;
  const isPending = monitor
    ? monitor.stale !== true &&
      (monitor.status === "pending" || monitor.status === "running")
    : lifecycleState === "accepted" || lifecycleState === "running";
  if (isPending && previousEntryFieldMutationMatches(currentRecord, mutation)) {
    return true;
  }
  const observedVersion = toSortableDate(mutationVersion);
  const currentVersion = toSortableDate(currentRecord.lastUpdatedAt);
  if (observedVersion === null || currentVersion === null) {
    return false;
  }
  return observedVersion > currentVersion;
}

export function isEntryFieldMutationConfirmationReusable(
  confirmedEntry: CreateTaskMonitor["confirmedEntry"],
  currentRecord: WorkReportRecord | null | undefined,
  mutation: RetryableEntryFieldMutation
): boolean {
  if (
    !confirmedEntry ||
    !currentRecord ||
    String(currentRecord.id) !== confirmedEntry.entryId ||
    confirmedEntry.entryId !== mutation.entryId ||
    confirmedEntry.operation !== mutation.operation
  ) {
    return false;
  }
  const confirmedVersion = toSortableDate(confirmedEntry.entryLastUpdatedAt);
  const currentVersion = toSortableDate(currentRecord.lastUpdatedAt);
  if (confirmedVersion === null || currentVersion === null) {
    return false;
  }
  if (confirmedVersion !== currentVersion) {
    return confirmedVersion > currentVersion;
  }
  return authoritativeEntryFieldMutationMatches(currentRecord, mutation);
}

export function shouldReplayEntryFieldOptimisticTask(
  monitor: Pick<
    CreateTaskMonitor,
    | "taskId"
    | "status"
    | "lifecycleState"
    | "stale"
    | "entryFieldOperation"
    | "optimisticMutation"
    | "confirmedEntry"
  >,
  currentRecord?: WorkReportRecord | null,
  getRetryMutation = getRetryableEntryFieldMutationByTaskId
): boolean {
  const operation =
    monitor.entryFieldOperation ?? monitor.optimisticMutation?.lifecycle.operation;
  if (!isEntryFieldMutationOperation(operation)) {
    return true;
  }
  const retryMutation = getRetryMutation(monitor.taskId);
  if (!retryMutation) {
    return false;
  }
  return monitor.confirmedEntry
    ? isEntryFieldMutationConfirmationReusable(
        monitor.confirmedEntry,
        currentRecord,
        retryMutation
      )
    : shouldReplayEntryFieldMutationPatch(
        retryMutation.expectedEntryLastUpdatedAt,
        retryMutation,
        currentRecord,
        monitor
      );
}

export function isEntryFieldConfirmationPending(
  monitor: Pick<
    CreateTaskMonitor,
    | "taskId"
    | "status"
    | "stale"
    | "retryableStale"
    | "entryFieldSettlementOutcome"
    | "entryFieldOperation"
    | "optimisticMutation"
  >
): boolean {
  const operation =
    monitor.entryFieldOperation ?? monitor.optimisticMutation?.lifecycle.operation;
  return (
    isEntryFieldMutationOperation(operation) &&
    monitor.entryFieldSettlementOutcome === undefined &&
    (monitor.status === "success" ||
      monitor.status === "failed" ||
      (monitor.stale === true && monitor.retryableStale !== true))
  );
}

export function shouldSettleEntryFieldMutationTask(
  monitor: Parameters<typeof isEntryFieldConfirmationPending>[0] &
    Pick<CreateTaskMonitor, "entryFieldSettlementErrorCode">
): boolean {
  return isEntryFieldConfirmationPending(monitor) && monitor.entryFieldSettlementErrorCode === undefined;
}

export function entryFieldConfirmationMessage(
  task: CreateTaskMonitor,
  t: (key: string) => string
): string | null {
  if (!isEntryFieldConfirmationPending(task)) return null;
  const unknown = task.stale === true || task.lifecycleState === "unknown" || task.lifecycleState === "indeterminate";
  const key = unknown ? "workReport:messages.entryFieldUnknownConfirmationPending"
    : task.status === "success" ? "workReport:messages.entryFieldConfirmationPending"
    : "workReport:messages.entryFieldFailureConfirmationPending";
  return [
    unknown || task.status !== "success" ? task.message : null,
    t(key),
    task.entryFieldSettlementErrorCode ? t("workReport:messages.entryFieldConfirmationMissing") : null,
  ].filter(Boolean).join(" ");
}

export async function settleEntryFieldMutationWithAuthority(input: {
  monitor: CreateTaskMonitor;
  retryMutation: RetryableEntryFieldMutation;
  currentRecord?: WorkReportRecord | null;
  fetchEntry?: typeof fetchWorkReportEntry;
  successMessage: string;
  supersededMessage: string;
  nowIso?: () => string;
  nowMs?: () => number;
}): Promise<EntryFieldMutationSettlement> {
  const operation =
    input.monitor.entryFieldOperation ??
    input.monitor.optimisticMutation?.lifecycle.operation ??
    input.retryMutation.operation;
  if (!isEntryFieldMutationOperation(operation)) {
    throw new Error("不是可收斂的工令主表欄位任務");
  }

  const nowMs = input.nowMs ?? Date.now;
  const confirmedEntry = input.monitor.confirmedEntry;
  let confirmedRecord: WorkReportRecord | null = null;
  let confirmedObservedAt: string | null = null;
  if (
    input.monitor.status === "success" &&
    confirmedEntry &&
    confirmedEntry.entryId === input.retryMutation.entryId &&
    confirmedEntry.operation === operation &&
    typeof confirmedEntry.observedAt === "string" &&
    !Number.isNaN(Date.parse(confirmedEntry.observedAt)) &&
    input.currentRecord &&
    input.currentRecord.reportsLoaded === true &&
    toSortableDate(input.currentRecord.lastUpdatedAt) ===
      toSortableDate(confirmedEntry.entryLastUpdatedAt) &&
    authoritativeEntryFieldMutationMatches(input.currentRecord, input.retryMutation) &&
    String(input.currentRecord.id) === input.retryMutation.entryId &&
    isEntryFieldMutationConfirmationReusable(
      confirmedEntry,
      input.currentRecord,
      input.retryMutation
    )
  ) {
    // A field observation cannot advance the version of unrelated fields or detail rows.
    confirmedRecord = input.currentRecord;
    confirmedObservedAt = confirmedEntry.observedAt;
  }

  const refreshStartedAt = nowMs();
  let authoritativeRecord: WorkReportRecord;
  let authoritativeRefreshMs: number;
  let observedAt: string;
  if (confirmedRecord && confirmedObservedAt) {
    authoritativeRecord = confirmedRecord;
    authoritativeRefreshMs = 0;
    observedAt = confirmedObservedAt;
  } else {
    authoritativeRecord = normalizeRecord(await (input.fetchEntry ?? fetchWorkReportEntry)(
      input.retryMutation.formId,
      input.retryMutation.entryId,
      true,
      { strictRefresh: true }
    ), true);
    authoritativeRefreshMs = Math.max(0, nowMs() - refreshStartedAt);
    observedAt = (input.nowIso ?? (() => new Date().toISOString()))();
  }
  const observedSuccess = authoritativeEntryFieldMutationMatches(
    authoritativeRecord,
    input.retryMutation
  );
  const observedPrevious = previousEntryFieldMutationMatches(
    authoritativeRecord,
    input.retryMutation
  );
  const superseded =
    !observedSuccess &&
    (input.monitor.status === "success" || !observedPrevious);
  const status = superseded
    ? "failed"
    : input.monitor.status === "success" || observedSuccess
      ? "success"
      : "failed";
  const lifecycleState = superseded ? "conflict" : status;
  const settlementSourceMutation =
    input.monitor.optimisticMutation ??
    (input.retryMutation.lifecycle
      ? {
          lifecycle: input.retryMutation.lifecycle,
          patch: {
            kind: "update-entry" as const,
            patch: input.retryMutation.successPatch,
          },
        }
      : undefined);
  const settledOptimisticMutation = settlementSourceMutation
    ? reconcileWorkReportOptimisticMutation(settlementSourceMutation, {
          lifecycleState,
          confirmedAt: input.monitor.confirmedAt ?? observedAt,
        })
    : undefined;

  return {
    authoritativeRecord,
    shouldDeleteRetryMutation: !superseded,
    monitor: {
      ...input.monitor,
      status,
      lifecycleState,
      confirmedAt: input.monitor.confirmedAt ?? observedAt,
      stale: undefined,
      retryableStale: undefined,
      entryFieldOperation: operation,
      entryFieldSettlementOutcome: superseded ? "superseded" : undefined,
      optimisticMutation: settledOptimisticMutation,
      authoritativeRefreshMs,
      message:
        status === "success"
          ? input.successMessage
          : superseded
            ? input.supersededMessage
            : input.monitor.message,
      updatedAt: observedAt,
    },
  };
}

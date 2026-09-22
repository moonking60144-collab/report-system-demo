import { downtimeEditableFields, type DowntimeEditableField } from "./downtimeEditPatch";
import type { ActivityLogDowntimeRecord } from "../../api/downtime";
import {
  applyOptimisticMutation,
  createAcceptedMutationLifecycle,
  isStoredMutationLifecycle,
  reconcileOptimisticMutation,
  type OptimisticMutationLifecycle,
  type OptimisticMutationState,
} from "./mutationLifecycle";
import { ACTIVITY_LOG_OPTIMISTIC_MUTATIONS_ENABLED } from "./optimisticMutationFeatureFlags";

export type DowntimeOptimisticPatch =
  | { kind: "create"; record: ActivityLogDowntimeRecord }
  | { kind: "update"; record: ActivityLogDowntimeRecord; changedFields?: DowntimeEditableField[] }
  | { kind: "delete"; entryId: string };

export interface DowntimeOptimisticMutation {
  lifecycle: OptimisticMutationLifecycle<ActivityLogDowntimeRecord | null>;
  patch: DowntimeOptimisticPatch;
}

export interface DowntimeOptimisticTaskObservation {
  taskId: string;
  entryId?: string | null;
  optimisticMutation: DowntimeOptimisticMutation;
}

export interface OptimisticActivityLogDowntimeRecord extends ActivityLogDowntimeRecord {
  __optimisticMutationId?: string;
  __optimisticState?: OptimisticMutationState;
}

const STORE_KEY = "work-report:activityLog-optimistic-mutations:v1";
const STORE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STORE_MAX_ITEMS = 50;

function hasVisibleOptimisticState(mutation: DowntimeOptimisticMutation): boolean {
  return (
    mutation.lifecycle.optimisticState === "applied" ||
    mutation.lifecycle.optimisticState === "confirmed"
  );
}

function withOptimisticState(
  record: ActivityLogDowntimeRecord,
  mutation: DowntimeOptimisticMutation
): OptimisticActivityLogDowntimeRecord {
  return {
    ...record,
    __optimisticMutationId: mutation.lifecycle.mutationId,
    __optimisticState: mutation.lifecycle.optimisticState,
  };
}

function applyOneMutation(
  records: OptimisticActivityLogDowntimeRecord[],
  observation: DowntimeOptimisticTaskObservation
): OptimisticActivityLogDowntimeRecord[] {
  const mutation = observation.optimisticMutation;
  if (!hasVisibleOptimisticState(mutation)) {
    return records;
  }
  if (mutation.patch.kind === "delete") {
    const entryId = mutation.patch.entryId;
    return records.filter((record) => record.id !== entryId);
  }
  if (mutation.patch.kind === "update") {
    const optimisticRecord = mutation.patch.record;
    const changedFields = mutation.patch.changedFields;
    const changedValues = changedFields ? {
      ...Object.fromEntries(changedFields.map((key) => [key, optimisticRecord[key]])),
      ...(changedFields.includes("operatorId") ? { operatorName: optimisticRecord.operatorName } : {}),
      ...(changedFields.includes("processCode") ? { reportType: optimisticRecord.reportType } : {}),
    } : optimisticRecord;
    return records.map((record) =>
      record.id === optimisticRecord.id
        ? withOptimisticState({ ...record, ...changedValues }, mutation)
        : record
    );
  }

  const entryId =
    mutation.lifecycle.lifecycleState === "success" && observation.entryId
      ? observation.entryId
      : mutation.patch.record.id;
  if (records.some((record) => record.id === entryId)) {
    return records;
  }
  return [
    withOptimisticState({ ...mutation.patch.record, id: entryId }, mutation),
    ...records,
  ];
}

export function createDowntimeOptimisticMutation(input: {
  mutationId: string;
  taskId: string;
  acceptedAt: string;
  patch: DowntimeOptimisticPatch;
  previousSnapshot: ActivityLogDowntimeRecord | null;
}): DowntimeOptimisticMutation {
  const operation =
    input.patch.kind === "create"
      ? "activityLog-create"
      : input.patch.kind === "update"
        ? "activityLog-update"
        : "activityLog-delete";
  const entryId =
    input.patch.kind === "delete" ? input.patch.entryId : input.patch.record.id;
  return {
    lifecycle: applyOptimisticMutation(
      createAcceptedMutationLifecycle({
        mutationId: input.mutationId,
        taskId: input.taskId,
        operation,
        target: {
          domain: "activityLog-downtime",
          formId: "903",
          entryId,
          ...(input.patch.kind === "create"
            ? { clientRowKey: input.mutationId }
            : {}),
        },
        acceptedAt: input.acceptedAt,
        reconcilePolicy: "refresh-form",
        failurePolicy: "rollback",
        previousSnapshot: input.previousSnapshot,
      })
    ),
    patch: input.patch,
  };
}

export function reconcileDowntimeOptimisticMutation(
  mutation: DowntimeOptimisticMutation,
  observation: {
    lifecycleState: OptimisticMutationLifecycle["lifecycleState"];
    confirmedAt?: string | null;
  }
): DowntimeOptimisticMutation {
  return {
    ...mutation,
    lifecycle: reconcileOptimisticMutation(mutation.lifecycle, observation),
  };
}

export function applyDowntimeOptimisticMutations(
  records: ActivityLogDowntimeRecord[],
  observations: DowntimeOptimisticTaskObservation[],
  options: { includeCreates?: boolean } = {}
): OptimisticActivityLogDowntimeRecord[] {
  if (!ACTIVITY_LOG_OPTIMISTIC_MUTATIONS_ENABLED) {
    return records;
  }
  return observations
    .filter(
      (observation) =>
        observation.optimisticMutation.lifecycle.target.domain === "activityLog-downtime" &&
        (options.includeCreates !== false ||
          observation.optimisticMutation.patch.kind !== "create")
    )
    .sort(
      (left, right) =>
        Date.parse(left.optimisticMutation.lifecycle.acceptedAt) -
        Date.parse(right.optimisticMutation.lifecycle.acceptedAt)
    )
    .reduce(applyOneMutation, records);
}

function normalizeDate(value: string | null): string {
  return String(value ?? "").trim().replaceAll("-", "/");
}

function recordMatches(
  authoritative: ActivityLogDowntimeRecord,
  optimistic: ActivityLogDowntimeRecord,
  fields: readonly DowntimeEditableField[] = downtimeEditableFields
): boolean {
  return fields.every((key) => key === "date"
    ? normalizeDate(authoritative.date) === normalizeDate(optimistic.date)
    : (authoritative[key] ?? null) === (optimistic[key] ?? null));
}

export function pruneProjectedDowntimeMutations(
  records: ActivityLogDowntimeRecord[],
  observations: DowntimeOptimisticTaskObservation[]
): DowntimeOptimisticTaskObservation[] {
  return observations.filter((observation) => {
    const mutation = observation.optimisticMutation;
    if (mutation.lifecycle.optimisticState === "rolled-back") {
      return false;
    }
    if (mutation.lifecycle.optimisticState !== "confirmed") {
      return true;
    }
    if (mutation.patch.kind === "delete") {
      const deletedEntryId = mutation.patch.entryId;
      return records.some((record) => record.id === deletedEntryId);
    }
    const entryId =
      mutation.patch.kind === "create" && observation.entryId
        ? observation.entryId
        : mutation.patch.record.id;
    const authoritative = records.find((record) => record.id === entryId);
    return !authoritative || !recordMatches(authoritative, mutation.patch.record, mutation.patch.kind === "update" ? mutation.patch.changedFields : undefined);
  });
}

function isStoredRecord(value: unknown): value is ActivityLogDowntimeRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<ActivityLogDowntimeRecord>;
  return typeof record.id === "string";
}

export function isStoredDowntimeOptimisticObservation(
  value: unknown
): value is DowntimeOptimisticTaskObservation {
  if (!value || typeof value !== "object") {
    return false;
  }
  const observation = value as Partial<DowntimeOptimisticTaskObservation>;
  const mutation = observation.optimisticMutation as
    | Partial<DowntimeOptimisticMutation>
    | undefined;
  if (
    typeof observation.taskId !== "string" ||
    (observation.entryId !== undefined &&
      observation.entryId !== null &&
      typeof observation.entryId !== "string") ||
    !mutation ||
    !isStoredMutationLifecycle(mutation.lifecycle) ||
    mutation.lifecycle.target.domain !== "activityLog-downtime" ||
    !mutation.patch
  ) {
    return false;
  }
  if (mutation.patch.kind === "delete") {
    return typeof mutation.patch.entryId === "string";
  }
  return (
    (mutation.patch.kind === "create" || mutation.patch.kind === "update") &&
    isStoredRecord(mutation.patch.record) &&
    (mutation.patch.kind !== "update" || mutation.patch.changedFields === undefined ||
      (Array.isArray(mutation.patch.changedFields) && mutation.patch.changedFields.length > 0 &&
        mutation.patch.changedFields.every((key) => downtimeEditableFields.includes(key))))
  );
}

export function readDowntimeOptimisticObservations(): DowntimeOptimisticTaskObservation[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) {
      return [];
    }
    const now = Date.now();
    return (JSON.parse(raw) as unknown[])
      .filter(isStoredDowntimeOptimisticObservation)
      .filter((observation) => {
        const acceptedAt = Date.parse(observation.optimisticMutation.lifecycle.acceptedAt);
        return Number.isNaN(acceptedAt) || now - acceptedAt < STORE_TTL_MS;
      })
      .slice(-STORE_MAX_ITEMS);
  } catch {
    return [];
  }
}

export function writeDowntimeOptimisticObservations(
  observations: DowntimeOptimisticTaskObservation[]
): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (observations.length === 0) {
      window.localStorage.removeItem(STORE_KEY);
      return;
    }
    window.localStorage.setItem(
      STORE_KEY,
      JSON.stringify(observations.slice(-STORE_MAX_ITEMS))
    );
  } catch {
    // localStorage 無法使用時仍可維持當前分頁的樂觀狀態。
  }
}

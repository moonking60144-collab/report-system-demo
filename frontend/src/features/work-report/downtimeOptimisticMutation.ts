import type { Form16DowntimeRecord } from "../../api/downtime";
import {
  applyOptimisticMutation,
  createAcceptedMutationLifecycle,
  isStoredMutationLifecycle,
  reconcileOptimisticMutation,
  type OptimisticMutationLifecycle,
  type OptimisticMutationState,
} from "./mutationLifecycle";
import { FORM16_OPTIMISTIC_MUTATIONS_ENABLED } from "./optimisticMutationFeatureFlags";

export type DowntimeOptimisticPatch =
  | { kind: "create"; record: Form16DowntimeRecord }
  | { kind: "update"; record: Form16DowntimeRecord }
  | { kind: "delete"; entryId: string };

export interface DowntimeOptimisticMutation {
  lifecycle: OptimisticMutationLifecycle<Form16DowntimeRecord | null>;
  patch: DowntimeOptimisticPatch;
}

export interface DowntimeOptimisticTaskObservation {
  taskId: string;
  entryId?: string | null;
  optimisticMutation: DowntimeOptimisticMutation;
}

export interface OptimisticForm16DowntimeRecord extends Form16DowntimeRecord {
  __optimisticMutationId?: string;
  __optimisticState?: OptimisticMutationState;
}

const STORE_KEY = "work-report:form16-optimistic-mutations:v1";
const STORE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STORE_MAX_ITEMS = 50;

function hasVisibleOptimisticState(mutation: DowntimeOptimisticMutation): boolean {
  return (
    mutation.lifecycle.optimisticState === "applied" ||
    mutation.lifecycle.optimisticState === "confirmed" ||
    mutation.lifecycle.optimisticState === "frozen"
  );
}

function withOptimisticState(
  record: Form16DowntimeRecord,
  mutation: DowntimeOptimisticMutation
): OptimisticForm16DowntimeRecord {
  return {
    ...record,
    __optimisticMutationId: mutation.lifecycle.mutationId,
    __optimisticState: mutation.lifecycle.optimisticState,
  };
}

function applyOneMutation(
  records: OptimisticForm16DowntimeRecord[],
  observation: DowntimeOptimisticTaskObservation
): OptimisticForm16DowntimeRecord[] {
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
    return records.map((record) =>
      record.id === optimisticRecord.id
        ? withOptimisticState(optimisticRecord, mutation)
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
  previousSnapshot: Form16DowntimeRecord | null;
}): DowntimeOptimisticMutation {
  const operation =
    input.patch.kind === "create"
      ? "form16-create"
      : input.patch.kind === "update"
        ? "form16-update"
        : "form16-delete";
  const entryId =
    input.patch.kind === "delete" ? input.patch.entryId : input.patch.record.id;
  return {
    lifecycle: applyOptimisticMutation(
      createAcceptedMutationLifecycle({
        mutationId: input.mutationId,
        taskId: input.taskId,
        operation,
        target: {
          domain: "form16-downtime",
          formId: "16",
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
  records: Form16DowntimeRecord[],
  observations: DowntimeOptimisticTaskObservation[],
  options: { includeCreates?: boolean } = {}
): OptimisticForm16DowntimeRecord[] {
  if (!FORM16_OPTIMISTIC_MUTATIONS_ENABLED) {
    return records;
  }
  return observations
    .filter(
      (observation) =>
        observation.optimisticMutation.lifecycle.target.domain === "form16-downtime" &&
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
  authoritative: Form16DowntimeRecord,
  optimistic: Form16DowntimeRecord
): boolean {
  return (
    normalizeDate(authoritative.date) === normalizeDate(optimistic.date) &&
    authoritative.machineId === optimistic.machineId &&
    authoritative.processCode === optimistic.processCode &&
    authoritative.operatorId === optimistic.operatorId &&
    authoritative.plannedIdleMinutes === optimistic.plannedIdleMinutes &&
    authoritative.remark === optimistic.remark
  );
}

export function pruneProjectedDowntimeMutations(
  records: Form16DowntimeRecord[],
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
    return !authoritative || !recordMatches(authoritative, mutation.patch.record);
  });
}

function isStoredRecord(value: unknown): value is Form16DowntimeRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<Form16DowntimeRecord>;
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
    mutation.lifecycle.target.domain !== "form16-downtime" ||
    !mutation.patch
  ) {
    return false;
  }
  if (mutation.patch.kind === "delete") {
    return typeof mutation.patch.entryId === "string";
  }
  return (
    (mutation.patch.kind === "create" || mutation.patch.kind === "update") &&
    isStoredRecord(mutation.patch.record)
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

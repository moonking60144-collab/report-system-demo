import type { WorkReportRecord } from "../../api/workReport";
import { getOrCreateClientId } from "../../utils/clientIdentity";
import type {
  WorkReportEntryFieldMutationOperation,
  WorkReportFormId,
} from "./types";
import { createRetryClientMutationId } from "./taskRetryStore";
import {
  applyOptimisticMutation,
  createAcceptedMutationLifecycle,
  isStoredMutationLifecycle,
  type OptimisticMutationLifecycle,
} from "./mutationLifecycle";
import { normalizePlannedEndDate } from "./utils/plannedEndDateUtils";
import { parseSemanticBoolean } from "./utils";

const STORE_KEYS = {
  "work-report-start-schedule": "work-report:start-schedule-retry-store:v1",
  "work-report-main-machine": "work-report:main-machine-retry-store:v1",
  "work-report-sort-order": "work-report:sort-order-retry-store:v1",
  "work-report-planned-end-date": "work-report:planned-end-date-retry-store:v1",
  "work-report-urgent": "work-report:urgent-retry-store:v1",
} as const;
const MAX_ITEMS = 50;
export const ENTRY_FIELD_TASK_RETRY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let retryStoreRevision = 0;
const retryStoreListeners = new Set<() => void>();
const retryStoreStorageKeys = new Set<string>(Object.values(STORE_KEYS));
let storageListenerAttached = false;

export type EntryFieldMutationOperation = WorkReportEntryFieldMutationOperation;

interface StoredEntryFieldMutation {
  operation: EntryFieldMutationOperation;
  clientMutationId: string;
  taskId?: string;
  formId: WorkReportFormId;
  entryId: string;
  value: number | string | boolean;
  previousValue: number | string | boolean | null;
  hasPreviousValue: boolean;
  fieldPreconditionVersion?: 1;
  workOrderNo?: string | null;
  expectedEntryLastUpdatedAt?: string;
  actorClientId: string;
  createdAt: string;
  lifecycle?: OptimisticMutationLifecycle;
  settlementOutcome?: "superseded";
}

export type RetryableEntryFieldMutationInput =
  | {
      operation: "work-report-start-schedule";
      formId: WorkReportFormId;
      entryId: string;
      value: boolean;
      previousValue: boolean;
      workOrderNo?: string | null;
      expectedEntryLastUpdatedAt?: string;
    }
  | {
      operation: "work-report-main-machine";
      formId: WorkReportFormId;
      entryId: string;
      value: string;
      previousValue: string | null;
      workOrderNo?: string | null;
      expectedEntryLastUpdatedAt?: string;
    }
  | {
      operation: "work-report-sort-order";
      formId: WorkReportFormId;
      entryId: string;
      value: number;
      previousValue: number | null;
      workOrderNo?: string | null;
      expectedEntryLastUpdatedAt?: string;
    }
  | {
      operation: "work-report-planned-end-date";
      formId: WorkReportFormId;
      entryId: string;
      value: string;
      previousValue: string | null;
      workOrderNo?: string | null;
      expectedEntryLastUpdatedAt?: string;
    }
  | {
      operation: "work-report-urgent";
      formId: WorkReportFormId;
      entryId: string;
      value: boolean;
      previousValue: boolean;
      workOrderNo?: string | null;
      expectedEntryLastUpdatedAt?: string;
    };

export interface RetryableEntryFieldMutation extends StoredEntryFieldMutation {
  pendingPatch: Partial<WorkReportRecord> | null;
  successPatch: Partial<WorkReportRecord>;
  rollbackPatch: Partial<WorkReportRecord> | null;
}

export function getEntryFieldTaskRetryStoreRevision(): number {
  return retryStoreRevision;
}

export function subscribeEntryFieldTaskRetryStore(listener: () => void): () => void {
  retryStoreListeners.add(listener);
  if (!storageListenerAttached && typeof window !== "undefined") {
    window.addEventListener("storage", handleEntryFieldTaskRetryStorage);
    storageListenerAttached = true;
  }
  return () => {
    retryStoreListeners.delete(listener);
    if (storageListenerAttached && retryStoreListeners.size === 0) {
      window.removeEventListener("storage", handleEntryFieldTaskRetryStorage);
      storageListenerAttached = false;
    }
  };
}

function publishEntryFieldTaskRetryStoreChange(): void {
  retryStoreRevision += 1;
  for (const listener of retryStoreListeners) {
    listener();
  }
}

function handleEntryFieldTaskRetryStorage(event: StorageEvent): void {
  if (
    (event.storageArea && event.storageArea !== window.localStorage) ||
    (event.key !== null && !retryStoreStorageKeys.has(event.key))
  ) {
    return;
  }
  publishEntryFieldTaskRetryStoreChange();
}

function parseCommonRecord(
  value: unknown,
  operation: EntryFieldMutationOperation
): Omit<StoredEntryFieldMutation, "operation" | "value" | "previousValue" | "hasPreviousValue"> | null {
  const candidate = value as Record<string, unknown> | null;
  if (
    !candidate ||
    typeof candidate.clientMutationId !== "string" ||
    (candidate.formId !== "901" && candidate.formId !== "902") ||
    typeof candidate.entryId !== "string" ||
    typeof candidate.actorClientId !== "string" ||
    typeof candidate.createdAt !== "string" ||
    (candidate.taskId !== undefined && typeof candidate.taskId !== "string") ||
    (candidate.settlementOutcome !== undefined &&
      candidate.settlementOutcome !== "superseded") ||
    (candidate.lifecycle !== undefined &&
      (!isStoredMutationLifecycle(candidate.lifecycle) ||
        candidate.lifecycle.operation !== operation))
  ) {
    return null;
  }
  return {
    clientMutationId: candidate.clientMutationId,
    formId: candidate.formId,
    entryId: candidate.entryId,
    actorClientId: candidate.actorClientId,
    createdAt: candidate.createdAt,
    ...(typeof candidate.taskId === "string" ? { taskId: candidate.taskId } : {}),
    ...(typeof candidate.workOrderNo === "string" || candidate.workOrderNo === null
      ? { workOrderNo: candidate.workOrderNo }
      : {}),
    ...(typeof candidate.expectedEntryLastUpdatedAt === "string"
      ? { expectedEntryLastUpdatedAt: candidate.expectedEntryLastUpdatedAt }
      : {}),
    ...(candidate.lifecycle
      ? { lifecycle: candidate.lifecycle as OptimisticMutationLifecycle }
      : {}),
    ...(candidate.settlementOutcome === "superseded"
      ? { settlementOutcome: candidate.settlementOutcome }
      : {}),
  };
}

function parseStoredRecord(
  value: unknown,
  operation: EntryFieldMutationOperation
): StoredEntryFieldMutation | null {
  const candidate = value as Record<string, unknown> | null;
  const common = parseCommonRecord(candidate, operation);
  if (!candidate || !common) return null;
  if (candidate.fieldPreconditionVersion === 1 || common.clientMutationId.startsWith("entry-field-v1:")) common.fieldPreconditionVersion = 1;

  if (operation === "work-report-sort-order") {
    if (typeof candidate.sortOrder !== "number" || !Number.isFinite(candidate.sortOrder)) {
      return null;
    }
    const hasPreviousValue = Object.prototype.hasOwnProperty.call(
      candidate,
      "previousSortOrder"
    );
    if (
      hasPreviousValue &&
      candidate.previousSortOrder !== null &&
      (typeof candidate.previousSortOrder !== "number" ||
        !Number.isFinite(candidate.previousSortOrder))
    ) {
      return null;
    }
    return {
      ...common,
      operation,
      value: candidate.sortOrder,
      previousValue:
        typeof candidate.previousSortOrder === "number"
          ? candidate.previousSortOrder
          : null,
      hasPreviousValue,
      ...(candidate.fieldPreconditionVersion === 1 || common.clientMutationId.startsWith("sort-field-v1:")
        ? { fieldPreconditionVersion: 1 as const } : {}),
    };
  }

  if (operation === "work-report-planned-end-date") {
    if (
      typeof candidate.plannedEndDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(candidate.plannedEndDate) ||
      (candidate.previousPlannedEndDate !== null &&
        typeof candidate.previousPlannedEndDate !== "string")
    ) {
      return null;
    }
    return {
      ...common,
      operation,
      value: candidate.plannedEndDate,
      previousValue: candidate.previousPlannedEndDate,
      hasPreviousValue: true,
    };
  }

  if (operation === "work-report-main-machine") {
    if (
      typeof candidate.machineCode !== "string" ||
      !candidate.machineCode.trim() ||
      (candidate.previousMachineCode !== null &&
        typeof candidate.previousMachineCode !== "string")
    ) {
      return null;
    }
    return {
      ...common,
      operation,
      value: candidate.machineCode.trim(),
      previousValue:
        typeof candidate.previousMachineCode === "string"
          ? candidate.previousMachineCode.trim()
          : null,
      hasPreviousValue: true,
    };
  }

  const valueKey =
    operation === "work-report-start-schedule" ? "startSchedule" : "urgent";
  const previousValueKey =
    operation === "work-report-start-schedule"
      ? "previousStartSchedule"
      : "previousUrgent";
  if (
    typeof candidate[valueKey] !== "boolean" ||
    typeof candidate[previousValueKey] !== "boolean"
  ) {
    return null;
  }
  return {
    ...common,
    operation,
    value: candidate[valueKey],
    previousValue: candidate[previousValueKey],
    hasPreviousValue: true,
  };
}

function serializeStoredRecord(record: StoredEntryFieldMutation): Record<string, unknown> {
  const common = {
    clientMutationId: record.clientMutationId,
    ...(record.fieldPreconditionVersion === 1 ? { fieldPreconditionVersion: 1 } : {}),
    ...(record.taskId ? { taskId: record.taskId } : {}),
    formId: record.formId,
    entryId: record.entryId,
    workOrderNo: record.workOrderNo,
    ...(record.expectedEntryLastUpdatedAt
      ? { expectedEntryLastUpdatedAt: record.expectedEntryLastUpdatedAt }
      : {}),
    actorClientId: record.actorClientId,
    createdAt: record.createdAt,
    ...(record.lifecycle ? { lifecycle: record.lifecycle } : {}),
    ...(record.settlementOutcome
      ? { settlementOutcome: record.settlementOutcome }
      : {}),
  };
  if (record.operation === "work-report-sort-order") {
    return {
      ...common,
      sortOrder: record.value,
      ...(record.fieldPreconditionVersion === 1 ? { fieldPreconditionVersion: 1 } : {}),
      ...(record.hasPreviousValue
        ? { previousSortOrder: record.previousValue }
        : {}),
    };
  }
  if (record.operation === "work-report-planned-end-date") {
    return {
      ...common,
      plannedEndDate: record.value,
      previousPlannedEndDate: record.previousValue,
    };
  }
  if (record.operation === "work-report-main-machine") {
    return {
      ...common,
      machineCode: record.value,
      previousMachineCode: record.previousValue,
    };
  }
  if (record.operation === "work-report-start-schedule") {
    return {
      ...common,
      startSchedule: record.value,
      previousStartSchedule: record.previousValue,
    };
  }
  return {
    ...common,
    urgent: record.value,
    previousUrgent: record.previousValue,
  };
}

function readStore(
  operation: EntryFieldMutationOperation
): Record<string, StoredEntryFieldMutation> {
  if (typeof window === "undefined") return {};
  try {
    const raw = String(window.localStorage.getItem(STORE_KEYS[operation]) ?? "").trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const now = Date.now();
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([key, value]) => [key, parseStoredRecord(value, operation)] as const)
        .filter((entry): entry is [string, StoredEntryFieldMutation] => Boolean(entry[1]))
        .filter(([, record]) => {
          const createdAt = Date.parse(record.createdAt);
          return Number.isNaN(createdAt) || now - createdAt < ENTRY_FIELD_TASK_RETRY_TTL_MS;
        })
        .slice(-MAX_ITEMS)
    );
  } catch {
    return {};
  }
}

function writeStore(
  operation: EntryFieldMutationOperation,
  store: Record<string, StoredEntryFieldMutation>
): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(
      STORE_KEYS[operation],
      JSON.stringify(
        Object.fromEntries(
          Object.entries(store).map(([key, record]) => [key, serializeStoredRecord(record)])
        )
      )
    );
  } catch {
    return false;
  }
  publishEntryFieldTaskRetryStoreChange();
  return true;
}

function patchFor(
  operation: EntryFieldMutationOperation,
  value: number | string | boolean | null,
  formId: WorkReportFormId
): Partial<WorkReportRecord> {
  if (operation === "work-report-sort-order") {
    return { sortOrder: value as number | null };
  }
  if (operation === "work-report-planned-end-date") {
    return { plannedEndDate: value as string | null };
  }
  if (operation === "work-report-main-machine") {
    return formId === "902"
      ? { filterMachineCode: value as string | null }
      : { machineCode: value as string | null };
  }
  if (operation === "work-report-start-schedule") {
    return { startSchedule: value === true ? "Yes" : "No" };
  }
  return { urgent: value === true ? "Yes" : "No" };
}

function describe(record: StoredEntryFieldMutation): RetryableEntryFieldMutation {
  return {
    ...record,
    pendingPatch:
      record.taskId && record.hasPreviousValue
        ? patchFor(record.operation, record.value, record.formId)
        : null,
    successPatch: patchFor(record.operation, record.value, record.formId),
    rollbackPatch: record.hasPreviousValue
      ? patchFor(record.operation, record.previousValue, record.formId)
      : null,
  };
}

function canReuseEntryFieldMutationIntent(
  record: StoredEntryFieldMutation
): boolean {
  if (record.settlementOutcome === "superseded") {
    return false;
  }
  const lifecycleState = record.lifecycle?.lifecycleState;
  return (
    lifecycleState !== "success" &&
    lifecycleState !== "failed" &&
    lifecycleState !== "conflict"
  );
}

export function getOrCreateRetryableEntryFieldMutation(
  input: RetryableEntryFieldMutationInput
): RetryableEntryFieldMutation {
  const store = readStore(input.operation);
  const actorClientId = getOrCreateClientId();
  const entryId = String(input.entryId).trim();
  const expectedEntryLastUpdatedAt = String(
    input.expectedEntryLastUpdatedAt ?? ""
  ).trim();
  const existing = Object.values(store).find(
    (record) =>
      record.actorClientId === actorClientId &&
      record.formId === input.formId &&
      record.entryId === entryId &&
      record.value === input.value &&
      canReuseEntryFieldMutationIntent(record) &&
      String(record.expectedEntryLastUpdatedAt ?? "").trim() ===
        expectedEntryLastUpdatedAt
  );
  if (existing) return describe(existing);

  for (const [key, record] of Object.entries(store)) {
    if (
      record.actorClientId === actorClientId &&
      record.formId === input.formId &&
      record.entryId === entryId
    ) {
      delete store[key];
    }
  }

  const clientMutationId = input.operation === "work-report-sort-order"
    ? `sort-field-v1:${createRetryClientMutationId()}`
    : `entry-field-v1:${createRetryClientMutationId()}`;
  const record: StoredEntryFieldMutation = {
    operation: input.operation,
    clientMutationId,
    formId: input.formId,
    entryId,
    value: input.value,
    previousValue: input.previousValue,
    hasPreviousValue: true,
    workOrderNo: input.workOrderNo,
    fieldPreconditionVersion: 1,
    ...(expectedEntryLastUpdatedAt ? { expectedEntryLastUpdatedAt } : {}),
    actorClientId,
    createdAt: new Date().toISOString(),
  };
  store[clientMutationId] = record;
  const persisted = writeStore(
    input.operation,
    Object.fromEntries(
      Object.entries(store)
        .sort((left, right) => Date.parse(left[1].createdAt) - Date.parse(right[1].createdAt))
        .slice(-MAX_ITEMS)
    )
  );
  if (!persisted) {
    throw new Error("無法保存工令欄位更新的安全重試資料，已停止送出。");
  }
  return describe(record);
}

export function bindRetryableEntryFieldMutationTask(
  operation: EntryFieldMutationOperation,
  clientMutationId: string,
  taskId: string,
  acceptedAt = new Date().toISOString()
): boolean {
  const store = readStore(operation);
  const record = store[clientMutationId];
  if (!record) return false;
  store[clientMutationId] = {
    ...record,
    taskId,
    settlementOutcome: undefined,
    lifecycle: applyOptimisticMutation(
      createAcceptedMutationLifecycle({
        mutationId: clientMutationId,
        taskId,
        operation,
        target: {
          domain: "work-report",
          formId: record.formId,
          entryId: record.entryId,
        },
        acceptedAt,
        reconcilePolicy: "replace-target",
        failurePolicy: "rollback",
        previousSnapshot: patchFor(
          record.operation,
          record.previousValue,
          record.formId
        ),
      })
    ),
  };
  return writeStore(operation, store);
}

export function listRetryableEntryFieldMutations(
  formId?: WorkReportFormId
): RetryableEntryFieldMutation[] {
  const actorClientId = getOrCreateClientId();
  return (Object.keys(STORE_KEYS) as EntryFieldMutationOperation[])
    .flatMap((operation) => Object.values(readStore(operation)))
    .filter(
      (record) =>
        record.actorClientId === actorClientId &&
        (!formId || record.formId === formId)
    )
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .map(describe);
}

export function getRetryableEntryFieldMutationByTaskId(
  taskId: string
): RetryableEntryFieldMutation | null {
  const normalizedTaskId = String(taskId ?? "").trim();
  if (!normalizedTaskId) return null;
  return (
    listRetryableEntryFieldMutations().find(
      (record) => record.taskId === normalizedTaskId
    ) ?? null
  );
}

export function getRetryableEntryFieldMutationByClientMutationId(
  operation: EntryFieldMutationOperation,
  clientMutationId: string
): RetryableEntryFieldMutation | null {
  const normalizedClientMutationId = String(clientMutationId ?? "").trim();
  if (!normalizedClientMutationId) return null;
  const record = readStore(operation)[normalizedClientMutationId];
  if (!record || record.actorClientId !== getOrCreateClientId()) {
    return null;
  }
  return describe(record);
}

export function isEntryFieldMutationOperation(
  value: unknown
): value is EntryFieldMutationOperation {
  return (
    value === "work-report-start-schedule" ||
    value === "work-report-main-machine" ||
    value === "work-report-sort-order" ||
    value === "work-report-planned-end-date" ||
    value === "work-report-urgent"
  );
}

export function isEntryFieldMutationSettlementTerminal(
  value: { entryFieldSettlementOutcome?: "settled" | "superseded" }
): boolean {
  return value.entryFieldSettlementOutcome !== undefined;
}

function entryFieldMutationValueMatches(
  record: WorkReportRecord,
  mutation: RetryableEntryFieldMutation,
  value: number | string | boolean | null
): boolean {
  if (mutation.operation === "work-report-sort-order") {
    const currentText = String(record.sortOrder ?? "").trim();
    if (value === null) return currentText === "";
    if (!currentText || typeof value !== "number") return false;
    const current = Number(currentText);
    return Number.isInteger(current) && current >= 0 && current === value;
  }
  if (mutation.operation === "work-report-planned-end-date") {
    return normalizePlannedEndDate(record.plannedEndDate) === normalizePlannedEndDate(value);
  }
  if (mutation.operation === "work-report-main-machine") {
    const current = String(
      mutation.formId === "902" ? record.filterMachineCode : record.machineCode
    ).trim();
    return current === String(value ?? "").trim();
  }
  if (typeof value !== "boolean") return false;
  const rawValue =
    mutation.operation === "work-report-start-schedule"
      ? record.startSchedule
      : record.urgent;
  const current = parseSemanticBoolean(rawValue);
  const normalizedCurrent =
    current === null && String(rawValue ?? "").trim() === "" ? false : current;
  return normalizedCurrent === value;
}

export function authoritativeEntryFieldMutationMatches(
  record: WorkReportRecord,
  mutation: RetryableEntryFieldMutation
): boolean {
  return entryFieldMutationValueMatches(record, mutation, mutation.value);
}

export function previousEntryFieldMutationMatches(
  record: WorkReportRecord,
  mutation: RetryableEntryFieldMutation
): boolean {
  return (
    mutation.hasPreviousValue === true &&
    entryFieldMutationValueMatches(record, mutation, mutation.previousValue)
  );
}

export function isRetryableEntryFieldMutationBlocking(
  mutation: RetryableEntryFieldMutation,
  monitor?: { entryFieldSettlementOutcome?: "settled" | "superseded" }
): boolean {
  return (
    Boolean(mutation.taskId) &&
    !isEntryFieldMutationSettlementTerminal({
      entryFieldSettlementOutcome:
        monitor?.entryFieldSettlementOutcome ?? mutation.settlementOutcome,
    })
  );
}

export function updateRetryableEntryFieldMutationLifecycleByTaskId(
  taskId: string,
  lifecycle: OptimisticMutationLifecycle,
  settlementOutcome?: "superseded"
): void {
  const normalizedTaskId = String(taskId ?? "").trim();
  if (!normalizedTaskId) return;
  for (const operation of Object.keys(STORE_KEYS) as EntryFieldMutationOperation[]) {
    const store = readStore(operation);
    const entry = Object.entries(store).find(
      ([, record]) => record.taskId === normalizedTaskId
    );
    if (!entry) continue;
    const [key, record] = entry;
    if (
      record.lifecycle?.lifecycleState === lifecycle.lifecycleState &&
      record.lifecycle.optimisticState === lifecycle.optimisticState &&
      record.lifecycle.confirmedAt === lifecycle.confirmedAt &&
      record.settlementOutcome === settlementOutcome
    ) {
      continue;
    }
    store[key] = {
      ...record,
      lifecycle,
      ...(settlementOutcome ? { settlementOutcome } : {}),
    };
    writeStore(operation, store);
  }
}

export function markRetryableEntryFieldMutationSupersededByClientMutationId(
  operation: EntryFieldMutationOperation,
  clientMutationId: string,
  lifecycle?: OptimisticMutationLifecycle
): void {
  const normalizedClientMutationId = String(clientMutationId ?? "").trim();
  if (!normalizedClientMutationId) return;
  const store = readStore(operation);
  const record = store[normalizedClientMutationId];
  if (!record) return;
  if (
    record.settlementOutcome === "superseded" &&
    (!lifecycle ||
      (record.lifecycle?.lifecycleState === lifecycle.lifecycleState &&
        record.lifecycle.optimisticState === lifecycle.optimisticState &&
        record.lifecycle.confirmedAt === lifecycle.confirmedAt))
  ) {
    return;
  }
  store[normalizedClientMutationId] = {
    ...record,
    ...(lifecycle ? { lifecycle } : {}),
    settlementOutcome: "superseded",
  };
  writeStore(operation, store);
}

export function deleteRetryableEntryFieldMutationByTaskId(taskId: string): void {
  if (!taskId) return;
  for (const operation of Object.keys(STORE_KEYS) as EntryFieldMutationOperation[]) {
    const store = readStore(operation);
    const next = Object.fromEntries(
      Object.entries(store).filter(([, record]) => record.taskId !== taskId)
    );
    if (Object.keys(next).length !== Object.keys(store).length) {
      writeStore(operation, next);
    }
  }
}

export function deleteRetryableEntryFieldMutationByClientMutationId(
  operation: EntryFieldMutationOperation,
  clientMutationId: string
): void {
  const normalizedClientMutationId = String(clientMutationId ?? "").trim();
  if (!normalizedClientMutationId) return;
  const store = readStore(operation);
  if (!store[normalizedClientMutationId]) return;
  delete store[normalizedClientMutationId];
  writeStore(operation, store);
}

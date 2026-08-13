import { getOrCreateClientId } from "../../utils/clientIdentity";
import type { WorkReportFormId } from "./types";
import { createRetryClientMutationId } from "./taskRetryStore";
import {
  applyOptimisticMutation,
  createAcceptedMutationLifecycle,
  isStoredMutationLifecycle,
  type OptimisticMutationLifecycle,
} from "./mutationLifecycle";

const SORT_ORDER_RETRY_STORE_KEY = "work-report:sort-order-retry-store:v1";
const SORT_ORDER_RETRY_MAX_ITEMS = 50;
const SORT_ORDER_RETRY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface RetryableSortOrderMutationRecord {
  clientMutationId: string;
  taskId?: string;
  formId: WorkReportFormId;
  entryId: string;
  sortOrder: number;
  previousSortOrder?: number | null;
  workOrderNo?: string | null;
  expectedEntryLastUpdatedAt?: string;
  actorClientId: string;
  createdAt: string;
  lifecycle?: OptimisticMutationLifecycle<number | null>;
}

export interface SortOrderTaskRecordPatch {
  formId: WorkReportFormId;
  entryId: string;
  sortOrder: number | null;
}

type SortOrderRetryStore = Record<string, RetryableSortOrderMutationRecord>;

function readStore(): SortOrderRetryStore {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = String(window.localStorage.getItem(SORT_ORDER_RETRY_STORE_KEY) ?? "").trim();
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const now = Date.now();
    return Object.fromEntries(
      Object.entries(parsed)
        .filter((entry): entry is [string, RetryableSortOrderMutationRecord] => {
          const candidate = entry[1] as Partial<RetryableSortOrderMutationRecord> | null;
          return Boolean(
            candidate &&
              typeof candidate.clientMutationId === "string" &&
              (candidate.formId === "104" || candidate.formId === "105") &&
              typeof candidate.entryId === "string" &&
              typeof candidate.sortOrder === "number" &&
              Number.isFinite(candidate.sortOrder) &&
              (candidate.previousSortOrder === undefined ||
                candidate.previousSortOrder === null ||
                (typeof candidate.previousSortOrder === "number" &&
                  Number.isFinite(candidate.previousSortOrder))) &&
              typeof candidate.actorClientId === "string" &&
              typeof candidate.createdAt === "string" &&
              (candidate.taskId === undefined || typeof candidate.taskId === "string") &&
              (candidate.lifecycle === undefined ||
                isStoredMutationLifecycle<number | null>(candidate.lifecycle))
          );
        })
        .filter(([, record]) => {
          const createdAt = Date.parse(record.createdAt);
          return Number.isNaN(createdAt) || now - createdAt < SORT_ORDER_RETRY_TTL_MS;
        })
        .slice(-SORT_ORDER_RETRY_MAX_ITEMS)
    );
  } catch {
    return {};
  }
}

function writeStore(store: SortOrderRetryStore): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(SORT_ORDER_RETRY_STORE_KEY, JSON.stringify(store));
  } catch {
    // NOTE: localStorage 寫入失敗不阻塞排序更新主流程。
  }
}

function normalizeOptionalValue(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

export function getOrCreateRetryableSortOrderMutation(input: {
  formId: WorkReportFormId;
  entryId: string;
  sortOrder: number;
  previousSortOrder: number | null;
  workOrderNo?: string | null;
  expectedEntryLastUpdatedAt?: string;
}): RetryableSortOrderMutationRecord {
  const store = readStore();
  const actorClientId = getOrCreateClientId();
  const entryId = String(input.entryId).trim();
  const expectedEntryLastUpdatedAt = normalizeOptionalValue(
    input.expectedEntryLastUpdatedAt
  );
  const existing = Object.values(store).find(
    (record) =>
      record.actorClientId === actorClientId &&
      record.formId === input.formId &&
      record.entryId === entryId &&
      record.sortOrder === input.sortOrder &&
      normalizeOptionalValue(record.expectedEntryLastUpdatedAt) ===
        expectedEntryLastUpdatedAt
  );
  if (existing) {
    return existing;
  }

  for (const [key, record] of Object.entries(store)) {
    if (
      record.actorClientId === actorClientId &&
      record.formId === input.formId &&
      record.entryId === entryId
    ) {
      delete store[key];
    }
  }

  const clientMutationId = createRetryClientMutationId();
  const record: RetryableSortOrderMutationRecord = {
    clientMutationId,
    formId: input.formId,
    entryId,
    sortOrder: input.sortOrder,
    previousSortOrder: input.previousSortOrder,
    workOrderNo: input.workOrderNo,
    ...(expectedEntryLastUpdatedAt
      ? { expectedEntryLastUpdatedAt }
      : {}),
    actorClientId,
    createdAt: new Date().toISOString(),
  };
  store[clientMutationId] = record;
  const orderedEntries = Object.entries(store)
    .sort((left, right) => Date.parse(left[1].createdAt) - Date.parse(right[1].createdAt))
    .slice(-SORT_ORDER_RETRY_MAX_ITEMS);
  writeStore(Object.fromEntries(orderedEntries));
  return record;
}

export function bindRetryableSortOrderMutationTask(
  clientMutationId: string,
  taskId: string,
  acceptedAt = new Date().toISOString()
): void {
  const store = readStore();
  const record = store[clientMutationId];
  if (!record) {
    return;
  }
  store[clientMutationId] = {
    ...record,
    taskId,
    lifecycle: applyOptimisticMutation(
      createAcceptedMutationLifecycle({
        mutationId: clientMutationId,
        taskId,
        operation: "work-report-sort-order",
        target: {
          domain: "work-report",
          formId: record.formId,
          entryId: record.entryId,
        },
        acceptedAt,
        reconcilePolicy: "replace-target",
        failurePolicy: "rollback",
        previousSnapshot: record.previousSortOrder ?? null,
      })
    ),
  };
  writeStore(store);
}

export function listRetryableSortOrderMutations(
  formId?: WorkReportFormId
): RetryableSortOrderMutationRecord[] {
  const actorClientId = getOrCreateClientId();
  return Object.values(readStore())
    .filter(
      (record) =>
        record.actorClientId === actorClientId &&
        (!formId || record.formId === formId)
    )
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
}

export function getRetryableSortOrderMutationByTaskId(
  taskId: string
): RetryableSortOrderMutationRecord | null {
  const normalizedTaskId = String(taskId ?? "").trim();
  if (!normalizedTaskId) {
    return null;
  }
  const actorClientId = getOrCreateClientId();
  return (
    Object.values(readStore()).find(
      (record) =>
        record.actorClientId === actorClientId && record.taskId === normalizedTaskId
    ) ?? null
  );
}

export function resolveSortOrderTaskRecordPatch(
  record: RetryableSortOrderMutationRecord | null,
  status: "pending" | "success" | "failed"
): SortOrderTaskRecordPatch | null {
  if (!record) {
    return null;
  }
  if (status === "pending") {
    if (
      !record.taskId ||
      !Object.prototype.hasOwnProperty.call(record, "previousSortOrder")
    ) {
      return null;
    }
    return {
      formId: record.formId,
      entryId: record.entryId,
      sortOrder: record.sortOrder,
    };
  }
  if (status === "failed") {
    if (!Object.prototype.hasOwnProperty.call(record, "previousSortOrder")) {
      return null;
    }
    return {
      formId: record.formId,
      entryId: record.entryId,
      sortOrder: record.previousSortOrder ?? null,
    };
  }
  return {
    formId: record.formId,
    entryId: record.entryId,
    sortOrder: record.sortOrder,
  };
}

export function deleteRetryableSortOrderMutationByTaskId(taskId: string): void {
  if (!taskId) {
    return;
  }
  const store = readStore();
  let changed = false;
  for (const [key, record] of Object.entries(store)) {
    if (record.taskId === taskId) {
      delete store[key];
      changed = true;
    }
  }
  if (changed) {
    writeStore(store);
  }
}

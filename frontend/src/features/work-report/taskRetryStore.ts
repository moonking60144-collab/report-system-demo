import { getOrCreateClientId } from "./debug/clientIdentity";
import type { ReportMutationPayload } from "../../api/workReport";
import type { WorkReportFormId, WorkReportMutationTaskKind } from "./types";

const WORK_REPORT_RETRYABLE_MUTATION_STORE_KEY =
  "work-report:retryable-mutation-store:v1";
const RETRYABLE_MUTATION_MAX_ITEMS = 50;
const RETRYABLE_MUTATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface RetryableMutationRecord {
  taskId: string;
  retryRootTaskId: string;
  retriedFromTaskId?: string;
  latestRetryTaskId?: string;
  kind: Extract<WorkReportMutationTaskKind, "create" | "update">;
  formId: WorkReportFormId;
  entryId: string;
  rowId?: string;
  workOrderNo?: string | null;
  payload: ReportMutationPayload;
  clientMutationId: string;
  expectedEntryLastUpdatedAt?: string;
  editSessionId?: string;
  editLockVersion?: number;
  actorClientId: string;
  createdAt: string;
}

type RetryableMutationStore = Record<string, RetryableMutationRecord>;

function readLocalStorageValue(key: string): string {
  if (typeof window === "undefined") {
    return "";
  }
  try {
    return String(window.localStorage.getItem(key) ?? "").trim();
  } catch {
    return "";
  }
}

function writeLocalStorageValue(key: string, value: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (!value) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, value);
  } catch {
    // NOTE: localStorage 寫入失敗不阻塞主流程
  }
}

function isRetryableMutationRecord(
  value: unknown
): value is RetryableMutationRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<RetryableMutationRecord>;
  return (
    typeof candidate.taskId === "string" &&
    typeof candidate.retryRootTaskId === "string" &&
    (candidate.kind === "create" || candidate.kind === "update") &&
    typeof candidate.formId === "string" &&
    typeof candidate.entryId === "string" &&
    typeof candidate.payload === "object" &&
    candidate.payload !== null &&
    typeof candidate.clientMutationId === "string" &&
    typeof candidate.actorClientId === "string" &&
    typeof candidate.createdAt === "string"
  );
}

function readRetryableMutationStore(): RetryableMutationStore {
  const raw = readLocalStorageValue(WORK_REPORT_RETRYABLE_MUTATION_STORE_KEY);
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const now = Date.now();
    return Object.fromEntries(
      Object.entries(parsed)
        .filter((entry): entry is [string, RetryableMutationRecord] =>
          isRetryableMutationRecord(entry[1])
        )
        .filter(([, record]) => {
          const createdAt = Date.parse(record.createdAt);
          return Number.isNaN(createdAt) || now - createdAt < RETRYABLE_MUTATION_TTL_MS;
        })
        .slice(-RETRYABLE_MUTATION_MAX_ITEMS)
    );
  } catch {
    return {};
  }
}

function writeRetryableMutationStore(store: RetryableMutationStore): void {
  writeLocalStorageValue(
    WORK_REPORT_RETRYABLE_MUTATION_STORE_KEY,
    JSON.stringify(store)
  );
}

export function createRetryClientMutationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function saveRetryableMutationRecord(
  record: Omit<RetryableMutationRecord, "actorClientId">
): void {
  const store = readRetryableMutationStore();
  store[record.taskId] = {
    ...record,
    actorClientId: getOrCreateClientId(),
  };

  const orderedEntries = Object.entries(store)
    .sort((left, right) => {
      const leftTime = Date.parse(left[1].createdAt);
      const rightTime = Date.parse(right[1].createdAt);
      return leftTime - rightTime;
    })
    .slice(-RETRYABLE_MUTATION_MAX_ITEMS);

  writeRetryableMutationStore(Object.fromEntries(orderedEntries));
}

export function getRetryableMutationRecord(
  taskId: string
): RetryableMutationRecord | null {
  const store = readRetryableMutationStore();
  return store[taskId] ?? null;
}

export function deleteRetryableMutationRecord(taskId: string): void {
  if (!taskId) {
    return;
  }
  const store = readRetryableMutationStore();
  if (!(taskId in store)) {
    return;
  }
  delete store[taskId];
  writeRetryableMutationStore(store);
}

export function replaceRetryableMutationRecord(
  previousTaskId: string,
  nextRecord: Omit<RetryableMutationRecord, "actorClientId">
): void {
  const store = readRetryableMutationStore();
  if (previousTaskId && store[previousTaskId]) {
    store[previousTaskId] = {
      ...store[previousTaskId],
      latestRetryTaskId: nextRecord.taskId,
    };
  }
  store[nextRecord.taskId] = {
    ...nextRecord,
    actorClientId: getOrCreateClientId(),
  };
  writeRetryableMutationStore(store);
}

import type { CreateForm16DowntimePayload } from "../../api/downtime";
import { getOrCreateClientId } from "../../utils/clientIdentity";
import {
  isStoredMutationLifecycle,
  type OptimisticMutationLifecycle,
} from "./mutationLifecycle";

const DOWNTIME_RETRYABLE_CREATE_STORE_KEY =
  "work-report:retryable-downtime-create-store:v1";
const RETRYABLE_DOWNTIME_CREATE_MAX_ITEMS = 50;
const RETRYABLE_DOWNTIME_CREATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface RetryableDowntimeCreateRecord {
  taskId: string;
  retryRootTaskId: string;
  retriedFromTaskId?: string;
  latestRetryTaskId?: string;
  payload: CreateForm16DowntimePayload & { clientRowKey: string };
  actorClientId: string;
  createdAt: string;
  lifecycle?: OptimisticMutationLifecycle;
}

type RetryableDowntimeCreateStore = Record<string, RetryableDowntimeCreateRecord>;

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
    // localStorage 寫入失敗不阻塞主流程
  }
}

function isRetryableDowntimeCreateRecord(
  value: unknown
): value is RetryableDowntimeCreateRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<RetryableDowntimeCreateRecord>;
  const payload = candidate.payload as Partial<CreateForm16DowntimePayload> | undefined;
  return (
    typeof candidate.taskId === "string" &&
    typeof candidate.retryRootTaskId === "string" &&
    typeof candidate.actorClientId === "string" &&
    typeof candidate.createdAt === "string" &&
    (candidate.lifecycle === undefined ||
      isStoredMutationLifecycle(candidate.lifecycle)) &&
    Boolean(payload) &&
    typeof payload?.date === "string" &&
    typeof payload.machineId === "string" &&
    typeof payload.processCode === "string" &&
    typeof payload.clientRowKey === "string" &&
    payload.clientRowKey.trim().length > 0
  );
}

function readRetryableDowntimeCreateStore(): RetryableDowntimeCreateStore {
  const raw = readLocalStorageValue(DOWNTIME_RETRYABLE_CREATE_STORE_KEY);
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const now = Date.now();
    return Object.fromEntries(
      Object.entries(parsed)
        .filter((entry): entry is [string, RetryableDowntimeCreateRecord] =>
          isRetryableDowntimeCreateRecord(entry[1])
        )
        .filter(([, record]) => {
          const createdAt = Date.parse(record.createdAt);
          return Number.isNaN(createdAt) || now - createdAt < RETRYABLE_DOWNTIME_CREATE_TTL_MS;
        })
        .slice(-RETRYABLE_DOWNTIME_CREATE_MAX_ITEMS)
    );
  } catch {
    return {};
  }
}

function writeRetryableDowntimeCreateStore(store: RetryableDowntimeCreateStore): void {
  writeLocalStorageValue(DOWNTIME_RETRYABLE_CREATE_STORE_KEY, JSON.stringify(store));
}

export function createDowntimeClientRowKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `downtime-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function saveRetryableDowntimeCreateRecord(
  record: Omit<RetryableDowntimeCreateRecord, "actorClientId">
): void {
  const store = readRetryableDowntimeCreateStore();
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
    .slice(-RETRYABLE_DOWNTIME_CREATE_MAX_ITEMS);
  writeRetryableDowntimeCreateStore(Object.fromEntries(orderedEntries));
}

export function getRetryableDowntimeCreateRecord(
  taskId: string
): RetryableDowntimeCreateRecord | null {
  const store = readRetryableDowntimeCreateStore();
  return store[taskId] ?? null;
}

export function replaceRetryableDowntimeCreateRecord(
  previousTaskId: string,
  nextRecord: Omit<RetryableDowntimeCreateRecord, "actorClientId">
): void {
  const store = readRetryableDowntimeCreateStore();
  const actorClientId = getOrCreateClientId();
  if (previousTaskId && store[previousTaskId]) {
    store[previousTaskId] = {
      ...store[previousTaskId],
      latestRetryTaskId: nextRecord.taskId,
    };
  }
  store[nextRecord.taskId] = {
    ...nextRecord,
    actorClientId,
  };
  writeRetryableDowntimeCreateStore(store);
}

export function deleteRetryableDowntimeCreateRecordChain(taskId: string): void {
  if (!taskId) {
    return;
  }
  const store = readRetryableDowntimeCreateStore();
  const target = store[taskId];
  if (!target) {
    return;
  }
  const rootId = target.retryRootTaskId || taskId;
  let mutated = false;
  for (const [key, record] of Object.entries(store)) {
    if ((record.retryRootTaskId || key) === rootId) {
      delete store[key];
      mutated = true;
    }
  }
  if (mutated) {
    writeRetryableDowntimeCreateStore(store);
  }
}

import type { ReportMutationPayload } from "../../../api/workReport";
import { reportDebugClientEventBatch } from "../../../api/debugClients";
import type {
  WorkReportFrontendEventAction,
  WorkReportFrontendEventCategory,
} from "../debug/workReportDeveloperContract";
import { getOrCreateClientId, getOrCreateTabId } from "../debug/clientIdentity";
import { resolveWorkReportFrontendEventCategory } from "../debug/workReportDeveloperContract";

export type FrontendEventLogLevel = "info" | "warn" | "error";
export type FrontendEventLogCategory = WorkReportFrontendEventCategory;

export type FrontendEventLogMetaValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | string[];

export interface FrontendEventLogEntry {
  id: string;
  ts: string;
  level: FrontendEventLogLevel;
  category: FrontendEventLogCategory;
  action: WorkReportFrontendEventAction;
  summary: string;
  operationId?: string;
  operationType?: string;
  phase?: string;
  durationMs?: number;
  startedAt?: string;
  endedAt?: string;
  formId?: string;
  entryId?: string;
  rowId?: string;
  taskId?: string;
  clientMutationId?: string;
  meta?: Record<string, FrontendEventLogMetaValue>;
}

// category 會由 resolveWorkReportFrontendEventCategory(action) 自動推算，caller 不用傳；
// 留 optional 給特殊測試情境覆寫用
interface FrontendEventLogEntryInput
  extends Omit<FrontendEventLogEntry, "id" | "ts" | "category"> {
  ts?: string;
  category?: FrontendEventLogCategory;
}

const FRONTEND_EVENT_LOG_LIMIT = 200;
const FRONTEND_EVENT_LOG_STORAGE_KEY = "work-report:frontend-event-log:v1";
const FRONTEND_EVENT_MIRROR_FLUSH_DELAY_MS = 800;
const FRONTEND_EVENT_MIRROR_BATCH_SIZE = 20;
const FRONTEND_EVENT_MIRROR_RETRY_DELAY_MS = 3_000;

let eventSequence = 0;
const listeners = new Set<() => void>();
let pendingMirrorEntries: FrontendEventLogEntry[] = [];
let mirrorFlushTimer: ReturnType<typeof setTimeout> | null = null;
let mirrorFlushInFlight = false;

function readPersistedFrontendEventLog(): FrontendEventLogEntry[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(FRONTEND_EVENT_LOG_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((item): item is FrontendEventLogEntry => Boolean(item && typeof item === "object"))
      .slice(-FRONTEND_EVENT_LOG_LIMIT);
  } catch {
    return [];
  }
}

let entries: FrontendEventLogEntry[] = readPersistedFrontendEventLog();

function persistEntries(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(FRONTEND_EVENT_LOG_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // NOTE: localStorage 寫入失敗時不阻塞主要流程
  }
}

function emitChange(): void {
  listeners.forEach((listener) => {
    listener();
  });
}

function nextEventId(): string {
  eventSequence += 1;
  return `evt-${Date.now()}-${eventSequence}`;
}

function shouldMirrorEventToDebugCenter(entry: FrontendEventLogEntry): boolean {
  if (entry.level === "error" || entry.level === "warn") {
    return true;
  }
  return (
    entry.category === "api" ||
    entry.category === "task" ||
    entry.category === "realtime"
  );
}

function mirrorFrontendEvent(entry: FrontendEventLogEntry): void {
  if (typeof window === "undefined") {
    return;
  }
  if (!shouldMirrorEventToDebugCenter(entry)) {
    return;
  }
  pendingMirrorEntries = [...pendingMirrorEntries, entry];
  scheduleMirrorFlush();
}

function scheduleMirrorFlush(delayMs = FRONTEND_EVENT_MIRROR_FLUSH_DELAY_MS): void {
  if (mirrorFlushTimer) {
    return;
  }
  mirrorFlushTimer = setTimeout(() => {
    mirrorFlushTimer = null;
    void flushMirroredEvents();
  }, delayMs);
}

async function flushMirroredEvents(): Promise<void> {
  if (
    typeof window === "undefined" ||
    pendingMirrorEntries.length === 0 ||
    mirrorFlushInFlight
  ) {
    return;
  }
  mirrorFlushInFlight = true;
  const batch = pendingMirrorEntries.slice(0, FRONTEND_EVENT_MIRROR_BATCH_SIZE);

  const clientId = getOrCreateClientId();
  const tabId = getOrCreateTabId();
  let nextDelayMs = FRONTEND_EVENT_MIRROR_FLUSH_DELAY_MS;

  try {
    await reportDebugClientEventBatch(
      batch.map((entry) => ({
        clientId,
        tabId,
        ts: entry.ts,
        level: entry.level,
        category: entry.category,
        action: entry.action,
        summary: entry.summary,
        formId: entry.formId,
        entryId: entry.entryId,
        rowId: entry.rowId,
        taskId: entry.taskId,
        operationId: entry.operationId,
        durationMs: entry.durationMs,
      }))
    );
    pendingMirrorEntries = pendingMirrorEntries.slice(batch.length);
  } catch {
    nextDelayMs = FRONTEND_EVENT_MIRROR_RETRY_DELAY_MS;
  } finally {
    mirrorFlushInFlight = false;
    if (pendingMirrorEntries.length > 0) {
      scheduleMirrorFlush(nextDelayMs);
    }
  }
}

export function createFrontendOperationId(prefix = "op"): string {
  eventSequence += 1;
  return `${prefix}-${Date.now()}-${eventSequence}`;
}

export function calculateDurationMs(startedAt: string, endedAt?: string): number | undefined {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt ?? new Date().toISOString());
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return undefined;
  }
  return Math.max(0, end - start);
}

export function pushFrontendEvent(input: FrontendEventLogEntryInput): FrontendEventLogEntry {
  const category = resolveWorkReportFrontendEventCategory(input.action);
  const entry: FrontendEventLogEntry = {
    ...input,
    category,
    id: nextEventId(),
    ts: input.ts ?? new Date().toISOString(),
  };
  entries = [...entries.slice(-(FRONTEND_EVENT_LOG_LIMIT - 1)), entry];
  persistEntries();
  mirrorFrontendEvent(entry);
  emitChange();
  return entry;
}

export function clearFrontendEventLog(): void {
  if (entries.length === 0) {
    return;
  }
  entries = [];
  persistEntries();
  emitChange();
}

export function subscribeFrontendEventLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getFrontendEventLogSnapshot(): readonly FrontendEventLogEntry[] {
  return entries;
}

export function summarizeChangedPayloadFields(
  payload: ReportMutationPayload
): string[] {
  return Object.entries(payload)
    .filter(([, value]) => {
      if (value === null || value === undefined) {
        return false;
      }
      if (typeof value === "string") {
        return value.trim().length > 0;
      }
      return true;
    })
    .map(([key]) => key)
    .sort();
}

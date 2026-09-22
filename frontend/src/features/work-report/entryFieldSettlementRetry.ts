import { AxiosError } from "axios";
import type { CreateTaskMonitor } from "./types";
import type { fetchWorkReportEntry } from "../../api/workReport";

// Share only reads requested by the same recovery pass, never a later write's observation.
export function createEntryFieldSettlementReader(fetchEntry: typeof fetchWorkReportEntry): typeof fetchWorkReportEntry {
  const reads = new Map<string, ReturnType<typeof fetchWorkReportEntry>>();
  return (...args) => {
    const key = JSON.stringify(args);
    const existing = reads.get(key);
    if (existing) return existing;
    const request = fetchEntry(...args);
    reads.set(key, request);
    const release = () => { reads.delete(key); };
    void request.then(release, release);
    return request;
  };
}

export function settlementReadRequiresManualRetry(error: unknown): boolean {
  return error instanceof AxiosError && error.response?.status === 404 &&
    error.response.data?.error?.code === "REPORT_NOT_FOUND";
}

export function settlementRetryAfterMs(error: unknown, now = Date.now()): number | null {
  if (!(error instanceof AxiosError)) return null;
  const body = error.response?.data?.error?.retryAfterMs;
  const header = error.response?.headers?.["retry-after"];
  const bodyMs = typeof body === "number" && Number.isFinite(body) && body >= 0 ? body : 0;
  const seconds = typeof header === "string" || typeof header === "number" ? Number(header) : NaN;
  const headerMs = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000
    : typeof header === "string" ? Math.max(0, Date.parse(header) - now) : 0;
  const delay = Math.max(bodyMs, Number.isFinite(headerMs) ? headerMs : 0);
  return delay > 0 ? delay : null;
}

// A single owner gates polling, restored tasks and render-triggered retries.
export class EntryFieldSettlementRetry {
  private readonly active = new Set<string>();
  private readonly paused = new Set<string>();
  private readonly deadlines = new Map<string, number>();
  private cooldownUntil = 0;
  private warned = false;
  private readonly now: () => number;

  constructor(now: () => number = Date.now, restored: CreateTaskMonitor[] = []) {
    this.now = now;
    this.cooldownUntil = Math.max(0, ...restored.map(monitor => monitor.entryFieldSettlementRetryAt ?? 0));
    for (const monitor of restored) if (monitor.entryFieldSettlementErrorCode) this.paused.add(monitor.taskId);
  }

  retryAt(monitor: CreateTaskMonitor): number {
    return Math.max(this.cooldownUntil, this.deadlines.get(monitor.taskId) ?? 0,
      monitor.entryFieldSettlementRetryAt ?? 0);
  }

  begin(monitor: CreateTaskMonitor): boolean {
    if (monitor.entryFieldSettlementErrorCode || this.paused.has(monitor.taskId) || this.active.has(monitor.taskId) || this.active.size >= 2 || this.retryAt(monitor) > this.now()) return false;
    this.active.add(monitor.taskId);
    return true;
  }

  defer(monitor: CreateTaskMonitor, error: unknown) {
    const attempts = (monitor.entryFieldSettlementAttempts ?? 0) + 1;
    const hint = settlementRetryAfterMs(error, this.now());
    const delay = hint ?? Math.min(30_000, 5_000 * 2 ** Math.min(attempts - 1, 3));
    if (hint !== null) this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + hint);
    const retryAt = Math.max(this.now() + delay, this.cooldownUntil);
    this.deadlines.set(monitor.taskId, retryAt);
    const notify = !this.warned;
    this.warned = true;
    return { attempts, retryAt, notify };
  }

  finish(taskId: string): void { this.active.delete(taskId); }
  retainTaskIds(taskIds: Set<string>, monitors: CreateTaskMonitor[], trackingTaskIds: Set<string>): void {
    const retained = new Set([...monitors.map(monitor => monitor.taskId), ...this.active, ...trackingTaskIds]);
    for (const taskId of taskIds) if (!retained.has(taskId)) taskIds.delete(taskId);
    for (const taskId of this.deadlines.keys()) if (!retained.has(taskId)) this.deadlines.delete(taskId);
    for (const taskId of this.paused) if (!retained.has(taskId)) this.paused.delete(taskId);
  }
  pause(taskId: string): void { this.paused.add(taskId); }
  resume(taskId: string): void { this.paused.delete(taskId); }
  settled(taskId: string): void { this.deadlines.delete(taskId); this.paused.delete(taskId); }
  recovered(): void { this.warned = false; }
}

import type { RealtimeEventPayload } from "@shared-types/realtime";
import { acquireWorkReportConnection } from "./workReportRealtimeConnection";

export function parseWorkReportTaskEvent(raw: string): RealtimeEventPayload | null {
  try {
    const payload = JSON.parse(raw) as RealtimeEventPayload;
    const task = payload?.workReportTask;
    if (payload?.type !== "work-report-task-updated" || !payload.id ||
        typeof payload.formId !== "string" || !task || typeof task.taskId !== "string" ||
        typeof task.taskType !== "string" || typeof task.updatedAt !== "string" ||
        !["pending", "running", "success", "failed"].includes(task.status)) return null;
    return payload;
  } catch { return null; }
}

export function subscribeWorkReportTaskEvents(
  onTask: (event: RealtimeEventPayload) => void,
  onConnection: (connected: boolean) => void = () => {},
): () => void {
  if (typeof window === "undefined" || !window.EventSource) return () => {};
  const { source, release } = acquireWorkReportConnection();
  const seen = new Set<string>();
  const receive = (event: Event) => {
    const payload = parseWorkReportTaskEvent((event as MessageEvent).data);
    if (!payload || seen.has(payload.id)) return;
    seen.add(payload.id);
    if (seen.size > 256) seen.delete(seen.values().next().value!);
    onTask(payload);
  };
  const opened = () => onConnection(true);
  const closed = () => onConnection(false);
  source.addEventListener("work-report-event", receive);
  source.addEventListener("open", opened);
  source.addEventListener("error", closed);
  source.addEventListener("shutdown", closed);
  onConnection(source.readyState === 1);
  return () => {
    source.removeEventListener("work-report-event", receive);
    source.removeEventListener("open", opened);
    source.removeEventListener("error", closed);
    source.removeEventListener("shutdown", closed);
    release();
  };
}

export function createTaskEventWakeup(formId: string, taskId: string) {
  let dirty = false;
  let connected = false;
  let wake: (() => void) | null = null;
  let finishWait: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const notify = () => { dirty = true; wake?.(); };
  const unsubscribe = subscribeWorkReportTaskEvents((event) => {
    if (event.formId === formId && event.workReportTask?.taskId === taskId) notify();
  }, (value) => { const changed = connected !== value; connected = value; if (changed || value) notify(); });
  const foreground = () => { if (!document.hidden) notify(); };
  if (typeof window !== "undefined") {
    window.addEventListener("focus", foreground);
    document.addEventListener("visibilitychange", foreground);
  }
  return {
    connected: () => connected,
    wait: (ms: number, allowEvents = true): Promise<void> => new Promise((resolve) => {
      if (disposed) { resolve(); return; }
      const finish = () => {
        clearTimeout(timer);
        wake = null;
        finishWait = null;
        dirty = false;
        resolve();
      };
      finishWait = finish;
      // Events during a GET remain pending until the next wait; one follow-up reads fresh state.
      if (allowEvents) wake = () => {
        wake = null;
        clearTimeout(timer);
        timer = setTimeout(finish, 100);
      };
      timer = setTimeout(finish, allowEvents && dirty ? 100 : ms);
    }),
    dispose: () => {
      disposed = true;
      unsubscribe();
      finishWait?.();
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", foreground);
        document.removeEventListener("visibilitychange", foreground);
      }
    },
  };
}

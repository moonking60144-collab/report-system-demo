import { acquireWorkReportConnection, observeWorkReportConnection } from "../../work-report/workReportRealtimeConnection";

export function subscribeMeetingStateEvents(refresh: () => void, connection: (connected: boolean) => void = () => {}): () => void {
  const lease = typeof window.EventSource === "undefined" ? null : acquireWorkReportConnection();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wake = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 100);
  };
  const receive = (event: Event) => {
    try {
      if (JSON.parse((event as MessageEvent).data)?.type === "meeting-state-changed") wake();
    } catch { /* Ignore unrelated or malformed events. */ }
  };
  const unobserve = lease ? observeWorkReportConnection(lease.source, () => { connection(true); wake(); }, () => connection(false)) : () => {};
  lease?.source.addEventListener("work-report-event", receive);
  const foreground = () => { if (!document.hidden) wake(); };
  window.addEventListener("focus", foreground);
  document.addEventListener("visibilitychange", foreground);
  // Reconcile missed IPC messages after worker failure without relying on event delivery for correctness.
  const reconciliation = setInterval(foreground, 60_000);
  return () => {
    clearTimeout(timer);
    clearInterval(reconciliation);
    window.removeEventListener("focus", foreground);
    document.removeEventListener("visibilitychange", foreground);
    unobserve();
    lease?.source.removeEventListener("work-report-event", receive);
    lease?.release();
  };
}

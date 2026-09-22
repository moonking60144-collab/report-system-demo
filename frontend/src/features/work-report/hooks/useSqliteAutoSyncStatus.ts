import { useEffect, useState } from "react";
import { createApiClient } from "../../../api/apiClient";
import { acquireWorkReportConnection } from "../workReportRealtimeConnection";

const api = createApiClient();

function readActiveForms(value: unknown): string[] | null {
  const forms = (value as { activeFormIds?: unknown } | null)?.activeFormIds;
  return Array.isArray(forms) && forms.every(form => typeof form === "string") ? forms : null;
}

export function subscribeSqliteAutoSyncStatus(onChange: (forms: string[] | null) => void): () => void {
  let revision = 0;
  let disposed = false;
  let request: AbortController | null = null;
  const refresh = () => {
    if (document.hidden) return;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    const started = ++revision;
    void api.get("/auto-sync/status", { signal: controller.signal }).then(response => {
      if (!disposed && started === revision) onChange(readActiveForms(response.data.data));
    }).catch(() => {
      if (!disposed && started === revision) onChange(null);
    });
  };
  const receive = (event: Event) => {
    try {
      const payload = JSON.parse((event as MessageEvent).data);
      if (payload?.type !== "sqlite-auto-sync-status") return;
      const forms = readActiveForms(payload.sqliteAutoSync);
      if (!forms) return;
      revision += 1;
      onChange(forms);
    } catch { /* Ignore unrelated or malformed SSE messages. */ }
  };
  const disconnected = () => {
    revision += 1;
    onChange(null);
  };
  const lease = window.EventSource ? acquireWorkReportConnection() : null;
  lease?.source.addEventListener("work-report-event", receive);
  lease?.source.addEventListener("open", refresh);
  lease?.source.addEventListener("error", disconnected);
  lease?.source.addEventListener("shutdown", disconnected);
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", refresh);
  // 記憶體狀態的低頻補查，補上斷線或休眠期間錯過的事件。
  const timer = window.setInterval(refresh, 60_000);
  refresh();
  return () => {
    disposed = true;
    request?.abort();
    clearInterval(timer);
    window.removeEventListener("focus", refresh);
    document.removeEventListener("visibilitychange", refresh);
    lease?.source.removeEventListener("work-report-event", receive);
    lease?.source.removeEventListener("open", refresh);
    lease?.source.removeEventListener("error", disconnected);
    lease?.source.removeEventListener("shutdown", disconnected);
    lease?.release();
  };
}

export function useSqliteAutoSyncStatus(): string[] | null {
  const [forms, setForms] = useState<string[] | null>(null);
  useEffect(() => subscribeSqliteAutoSyncStatus(setForms), []);
  return forms;
}

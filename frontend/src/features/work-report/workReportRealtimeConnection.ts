import { getOrCreateClientBootId, getOrCreateClientId, getOrCreateTabId } from "../../utils/clientIdentity";
import { checkFrontendLifecycleVersion } from "../../frontendUpdateGuard";

let connection: { url: string; source: EventSource; users: number } | null = null;

export function observeWorkReportConnection(source: EventSource, opened: () => void, errored: () => void) {
  source.addEventListener("open", opened);
  source.addEventListener("error", errored);
  if (source.readyState === 1) opened();
  return () => {
    source.removeEventListener("open", opened);
    source.removeEventListener("error", errored);
  };
}

export function workReportEventsUrl(): string {
  const base = String(import.meta.env.VITE_API_BASE_URL ?? "/api").trim() || "/api";
  const normalized = /^https?:\/\//i.test(base) || base.startsWith("/") ? base : `/${base}`;
  const params = new URLSearchParams({
    clientId: getOrCreateClientId(), tabId: getOrCreateTabId(), bootId: getOrCreateClientBootId(),
  });
  return `${normalized.replace(/\/+$/, "")}/events?${params}`;
}

export function acquireWorkReportConnection(url = workReportEventsUrl()) {
  if (!connection) {
    const source = new window.EventSource(url);
    source.addEventListener("ready", checkFrontendLifecycleVersion);
    source.addEventListener("ping", checkFrontendLifecycleVersion);
    connection = { url, source, users: 0 };
  }
  const current = connection;
  current.users += 1;
  let released = false;
  return {
    source: current.source,
    release: () => {
      if (released) return;
      released = true;
      current.users -= 1;
      if (current.users === 0) {
        current.source.close();
        if (connection === current) connection = null;
      }
    },
  };
}

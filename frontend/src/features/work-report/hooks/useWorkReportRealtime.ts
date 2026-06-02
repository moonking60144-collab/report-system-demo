import { useEffect, useMemo, useRef, useState } from "react";
import {
  getOrCreateClientBootId,
  getOrCreateClientId,
  getOrCreateTabId,
} from "../debug/clientIdentity";

type RealtimeEventType =
  | "work-report-form-updated"
  | "work-report-entry-updated"
  | "system-notice-force-refresh"
  | "system-notice-content-updated";

interface RealtimeEventPayload {
  id: string;
  type: RealtimeEventType;
  occurredAt: string;
  formId?: string;
  entryId?: string;
  forceRefreshToken?: string;
  noticeRevision?: number;
}

interface RealtimeLifecyclePayload {
  bootId?: string;
}

interface UseWorkReportRealtimeArgs {
  enabled?: boolean;
  onFormUpdated?: (payload: RealtimeEventPayload) => void;
  onEntryUpdated?: (payload: RealtimeEventPayload) => void;
  onSystemNoticeForceRefresh?: (payload: RealtimeEventPayload) => void;
  onServerBootIdChanged?: (payload: { bootId: string }) => void;
}

interface UseWorkReportRealtimeResult {
  connected: boolean;
  disconnectedSince: number | null;
}

function resolveEventsUrl(): string {
  const apiBaseUrl = String(import.meta.env.VITE_API_BASE_URL ?? "/api").trim() || "/api";
  if (/^https?:\/\//i.test(apiBaseUrl)) {
    return `${apiBaseUrl.replace(/\/+$/, "")}/events`;
  }
  const normalizedBase = apiBaseUrl.startsWith("/") ? apiBaseUrl : `/${apiBaseUrl}`;
  return `${normalizedBase.replace(/\/+$/, "")}/events`;
}

function parseRealtimeEventPayload(rawData: string): RealtimeEventPayload | null {
  try {
    const parsed = JSON.parse(rawData) as Partial<RealtimeEventPayload>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const type = String(parsed.type ?? "").trim() as RealtimeEventType;
    if (
      type !== "work-report-form-updated" &&
      type !== "work-report-entry-updated" &&
      type !== "system-notice-force-refresh" &&
      type !== "system-notice-content-updated"
    ) {
      return null;
    }
    return {
      id: String(parsed.id ?? ""),
      type,
      occurredAt: String(parsed.occurredAt ?? ""),
      formId: typeof parsed.formId === "string" ? parsed.formId : undefined,
      entryId: typeof parsed.entryId === "string" ? parsed.entryId : undefined,
      forceRefreshToken:
        typeof parsed.forceRefreshToken === "string" ? parsed.forceRefreshToken : undefined,
      noticeRevision:
        typeof parsed.noticeRevision === "number" ? parsed.noticeRevision : undefined,
    };
  } catch {
    return null;
  }
}

function parseRealtimeLifecyclePayload(rawData: string): RealtimeLifecyclePayload | null {
  try {
    const parsed = JSON.parse(rawData) as Partial<RealtimeLifecyclePayload>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return {
      bootId: typeof parsed.bootId === "string" ? parsed.bootId.trim() : undefined,
    };
  } catch {
    return null;
  }
}

export function useWorkReportRealtime({
  enabled = true,
  onFormUpdated,
  onEntryUpdated,
  onSystemNoticeForceRefresh,
  onServerBootIdChanged,
}: UseWorkReportRealtimeArgs): UseWorkReportRealtimeResult {
  const [connected, setConnected] = useState(false);
  const [disconnectedSince, setDisconnectedSince] = useState<number | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const onFormUpdatedRef = useRef(onFormUpdated);
  const onEntryUpdatedRef = useRef(onEntryUpdated);
  const onSystemNoticeForceRefreshRef = useRef(onSystemNoticeForceRefresh);
  const onServerBootIdChangedRef = useRef(onServerBootIdChanged);
  const lastBootIdRef = useRef("");
  const eventsUrl = useMemo(() => {
    const baseUrl = resolveEventsUrl();
    // 帶 clientId / tabId / bootId 進 query，讓 backend SSE endpoint 綁到 presence store
    const params = new URLSearchParams({
      clientId: getOrCreateClientId(),
      tabId: getOrCreateTabId(),
      bootId: getOrCreateClientBootId(),
    });
    return `${baseUrl}?${params.toString()}`;
  }, []);

  useEffect(() => {
    onFormUpdatedRef.current = onFormUpdated;
  }, [onFormUpdated]);

  useEffect(() => {
    onEntryUpdatedRef.current = onEntryUpdated;
  }, [onEntryUpdated]);

  useEffect(() => {
    onSystemNoticeForceRefreshRef.current = onSystemNoticeForceRefresh;
  }, [onSystemNoticeForceRefresh]);

  useEffect(() => {
    onServerBootIdChangedRef.current = onServerBootIdChanged;
  }, [onServerBootIdChanged]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof window.EventSource === "undefined") {
      return;
    }

    const source = new window.EventSource(eventsUrl);
    eventSourceRef.current = source;

    source.onopen = () => {
      setConnected(true);
      setDisconnectedSince(null);
    };

    source.onerror = () => {
      setConnected(false);
      setDisconnectedSince((prev) => prev ?? Date.now());
    };

    const handleLifecycleEvent = (event: MessageEvent) => {
      const payload = parseRealtimeLifecyclePayload(event.data);
      const nextBootId = String(payload?.bootId ?? "").trim();
      if (!nextBootId) {
        return;
      }
      if (!lastBootIdRef.current) {
        lastBootIdRef.current = nextBootId;
        return;
      }
      if (lastBootIdRef.current === nextBootId) {
        return;
      }
      lastBootIdRef.current = nextBootId;
      onServerBootIdChangedRef.current?.({ bootId: nextBootId });
    };

    source.addEventListener("work-report-event", (event) => {
      const payload = parseRealtimeEventPayload((event as MessageEvent).data);
      if (!payload) {
        return;
      }

      if (payload.type === "work-report-form-updated") {
        onFormUpdatedRef.current?.(payload);
        return;
      }

      if (payload.type === "work-report-entry-updated") {
        onEntryUpdatedRef.current?.(payload);
        return;
      }

      if (payload.type === "system-notice-force-refresh") {
        onSystemNoticeForceRefreshRef.current?.(payload);
        return;
      }

      if (payload.type === "system-notice-content-updated") {
        // 用 custom DOM event 廣播，讓 SystemNoticePanel 不依賴 prop drilling 直接訂閱
        // 取代原本 SystemNoticePanel /system-notice/version 的 polling
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("app:system-notice-content-updated", {
              detail: { revision: payload.noticeRevision ?? null },
            })
          );
        }
      }
    });

    source.addEventListener("ready", (event) => {
      handleLifecycleEvent(event as MessageEvent);
    });

    source.addEventListener("ping", (event) => {
      handleLifecycleEvent(event as MessageEvent);
    });

    return () => {
      source.close();
      if (eventSourceRef.current === source) {
        eventSourceRef.current = null;
      }
      setConnected(false);
      setDisconnectedSince(null);
    };
  }, [enabled, eventsUrl]);

  return { connected, disconnectedSince };
}

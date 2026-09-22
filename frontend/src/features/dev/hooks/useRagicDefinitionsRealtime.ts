import { useEffect, useMemo, useRef, useState } from "react";
import {
  getOrCreateClientBootId,
  getOrCreateClientId,
  getOrCreateTabId,
} from "../../../utils/clientIdentity";
import type {
  RagicDefinitionsRealtimePayload,
  RagicDefinitionsSyncStatus,
  RealtimeEventPayload,
} from "@shared-types/realtime";

export type { RagicDefinitionsRealtimePayload };
export type RagicDefinitionsRealtimeStatus = RagicDefinitionsSyncStatus;

type RealtimeEventEnvelope = Partial<RealtimeEventPayload>;

interface UseRagicDefinitionsRealtimeArgs {
  enabled?: boolean;
  onSyncStatus?: (payload: RagicDefinitionsRealtimePayload) => void;
}

interface UseRagicDefinitionsRealtimeResult {
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

function normalizeStatus(raw: unknown): RagicDefinitionsRealtimeStatus | null {
  const status = String(raw ?? "").trim();
  if (
    status === "disabled" ||
    status === "watching" ||
    status === "syncing" ||
    status === "synced" ||
    status === "error"
  ) {
    return status;
  }
  return null;
}

function parseNumber(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function parseRagicDefinitionsEvent(
  rawData: string
): RagicDefinitionsRealtimePayload | null {
  try {
    const parsed = JSON.parse(rawData) as RealtimeEventEnvelope;
    if (String(parsed.type ?? "") !== "ragic-definitions-sync-status") {
      return null;
    }
    const status = normalizeStatus(parsed.ragicDefinitions?.status);
    if (!status) return null;
    const summary = parsed.ragicDefinitions?.summary;
    const normalizedSummary =
      summary &&
      typeof summary.forms === "number" &&
      typeof summary.fields === "number" &&
      typeof summary.formulas === "number" &&
      typeof summary.workflows === "number"
        ? {
            forms: summary.forms,
            fields: summary.fields,
            formulas: summary.formulas,
            workflows: summary.workflows,
          }
        : undefined;
    return {
      id: String(parsed.id ?? ""),
      occurredAt: String(parsed.occurredAt ?? ""),
      status,
      message: String(parsed.ragicDefinitions?.message ?? ""),
      changedCount: parseNumber(parsed.ragicDefinitions?.changedCount),
      summary: normalizedSummary,
    };
  } catch {
    return null;
  }
}

export function useRagicDefinitionsRealtime({
  enabled = true,
  onSyncStatus,
}: UseRagicDefinitionsRealtimeArgs): UseRagicDefinitionsRealtimeResult {
  const [connected, setConnected] = useState(false);
  const [disconnectedSince, setDisconnectedSince] = useState<number | null>(null);
  const onSyncStatusRef = useRef(onSyncStatus);
  const eventsUrl = useMemo(() => {
    const baseUrl = resolveEventsUrl();
    const params = new URLSearchParams({
      clientId: getOrCreateClientId(),
      tabId: getOrCreateTabId(),
      bootId: getOrCreateClientBootId(),
    });
    return `${baseUrl}?${params.toString()}`;
  }, []);

  useEffect(() => {
    onSyncStatusRef.current = onSyncStatus;
  }, [onSyncStatus]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof window.EventSource === "undefined") {
      return;
    }

    const source = new window.EventSource(eventsUrl);

    source.onopen = () => {
      setConnected(true);
      setDisconnectedSince(null);
    };

    source.onerror = () => {
      setConnected(false);
      setDisconnectedSince((current) => current ?? Date.now());
    };

    source.addEventListener("work-report-event", (event) => {
      const payload = parseRagicDefinitionsEvent((event as MessageEvent).data);
      if (!payload) return;
      onSyncStatusRef.current?.(payload);
    });

    return () => {
      source.close();
      setConnected(false);
      setDisconnectedSince(null);
    };
  }, [enabled, eventsUrl]);

  return { connected, disconnectedSince };
}

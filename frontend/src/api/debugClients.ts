import { createApiClient } from "./apiClient";

const api = createApiClient();

function resolveDebugApiUrl(path: string): string {
  const apiBaseUrl = String(import.meta.env.VITE_API_BASE_URL ?? "/api").trim() || "/api";
  if (/^https?:\/\//i.test(apiBaseUrl)) {
    return `${apiBaseUrl.replace(/\/+$/, "")}${path}`;
  }
  const normalizedBase = apiBaseUrl.startsWith("/") ? apiBaseUrl : `/${apiBaseUrl}`;
  return `${normalizedBase.replace(/\/+$/, "")}${path}`;
}

export interface DebugClientPresence {
  clientId: string;
  tabId: string;
  effectiveIp: string | null;
  ip: string | null;
  forwardedFor: string | null;
  realIp: string | null;
  userAgent: string | null;
  connected: boolean;
  connectedAt: string | null;
  lastSeenAt: string;
  lastEventAt: string | null;
  currentPath: string | null;
  currentFormId: string | null;
  currentEntryId: string | null;
  currentTopView: string | null;
  currentLandingPageKey: string | null;
  realtimeConnected: boolean;
  lastSseConnectedAt: string | null;
  lastSseDisconnectedAt: string | null;
  lastAction: string | null;
  lastActionSummary: string | null;
  lastErrorAt: string | null;
  lastErrorSummary: string | null;
  clientBootId: string | null;
  serverBootIdAtConnect: string | null;
  deployVersionAtConnect: string | null;
  maintenanceMessage: string | null;
  blocked: boolean;
  blockedReason: string | null;
  status: "online" | "offline" | "stale";
  updatedAt: string;
}

export interface DebugClientEventSummary {
  clientId: string;
  tabId: string;
  ts: string;
  level: "info" | "warn" | "error";
  category: "ui" | "api" | "task" | "realtime" | "navigation";
  action: string;
  summary: string;
  formId?: string;
  entryId?: string;
  rowId?: string;
  taskId?: string;
  operationId?: string;
  durationMs?: number;
}

export interface DebugClientCommand {
  id: string;
  clientId: string;
  tabId?: string;
  type:
    | "force-refresh"
    | "force-session-expired"
    | "set-maintenance-message"
    | "clear-maintenance-message"
    | "set-blocked"
    | "clear-blocked";
  createdAt: string;
  createdBy: string;
  message?: string;
  reason?: string;
}

export interface DebugClientSummary {
  totalClients: number;
  onlineClients: number;
  blockedClients: number;
  clientsWithErrors: number;
  realtimeDisconnectedClients: number;
}

export async function reportDebugClientPresence(payload: {
  clientId: string;
  tabId: string;
  currentPath: string;
  currentFormId?: string | null;
  currentEntryId?: string | null;
  currentTopView?: string | null;
  currentLandingPageKey?: string | null;
  realtimeConnected: boolean;
  clientBootId: string;
  serverBootIdAtConnect?: string | null;
  deployVersionAtConnect?: string | null;
}): Promise<{ presence: DebugClientPresence; commands: DebugClientCommand[] }> {
  const response = await api.post<{ data: { presence: DebugClientPresence; commands: DebugClientCommand[] } }>(
    "/debug/clients/presence",
    payload
  );
  return response.data.data;
}

export async function reportDebugClientDisconnect(payload: {
  clientId: string;
  tabId: string;
}): Promise<void> {
  await api.post("/debug/clients/disconnect", payload);
}

export function sendDebugClientDisconnectBeacon(payload: {
  clientId: string;
  tabId: string;
}): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") {
    return false;
  }
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  return navigator.sendBeacon(resolveDebugApiUrl("/debug/clients/disconnect"), blob);
}

export async function reportDebugClientEvent(payload: {
  clientId: string;
  tabId: string;
  ts: string;
  level: "info" | "warn" | "error";
  category: "ui" | "api" | "task" | "realtime" | "navigation";
  action: string;
  summary: string;
  formId?: string;
  entryId?: string;
  rowId?: string;
  taskId?: string;
  operationId?: string;
  durationMs?: number;
}): Promise<void> {
  await api.post("/debug/clients/event", payload);
}

export async function reportDebugClientEventBatch(
  payloads: Array<{
    clientId: string;
    tabId: string;
    ts: string;
    level: "info" | "warn" | "error";
    category: "ui" | "api" | "task" | "realtime" | "navigation";
    action: string;
    summary: string;
    formId?: string;
    entryId?: string;
    rowId?: string;
    taskId?: string;
    operationId?: string;
    durationMs?: number;
  }>
): Promise<void> {
  if (payloads.length === 0) {
    return;
  }
  await api.post("/debug/clients/event", { events: payloads });
}

export async function fetchDebugClients(token: string): Promise<DebugClientPresence[]> {
  const response = await api.get<{ data: DebugClientPresence[] }>("/debug/clients", {
    headers: { Authorization: `Bearer ${token}` },
  });
  return response.data.data;
}

export async function fetchDebugClientSummary(token: string): Promise<DebugClientSummary> {
  const response = await api.get<{ data: DebugClientSummary }>("/debug/clients/summary", {
    headers: { Authorization: `Bearer ${token}` },
  });
  return response.data.data;
}

export async function fetchDebugClientDetail(
  token: string,
  clientId: string,
  tabId?: string
): Promise<{ presence: DebugClientPresence | null; events: DebugClientEventSummary[] }> {
  const response = await api.get<{ data: { presence: DebugClientPresence | null; events: DebugClientEventSummary[] } }>(
    `/debug/clients/${encodeURIComponent(clientId)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      params: tabId ? { tabId } : undefined,
    }
  );
  return response.data.data;
}

export async function sendDebugClientCommand(
  token: string,
  clientId: string,
  payload: {
    tabId?: string;
    type:
      | "force-refresh"
      | "force-session-expired"
      | "set-maintenance-message"
      | "clear-maintenance-message"
      | "set-blocked"
      | "clear-blocked";
    message?: string;
    reason?: string;
  }
): Promise<DebugClientCommand> {
  const response = await api.post<{ data: DebugClientCommand }>(
    `/debug/clients/${encodeURIComponent(clientId)}/commands`,
    payload,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  return response.data.data;
}

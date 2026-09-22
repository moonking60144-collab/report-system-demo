import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ackDebugClientCommands,
  fetchDebugClientCommands,
  fetchDebugClients,
  reportDebugClientDisconnect,
  reportDebugClientPresence,
  sendDebugClientDisconnectBeacon,
  type DebugClientCommand,
  type DebugClientPresence,
} from "../../../api/debugClients";
import {
  getOrCreateClientBootId,
  getOrCreateClientId,
  getOrCreateTabId,
} from "../../../utils/clientIdentity";

const DEV_DEFINITIONS_PATH = "/dev/definitions";
const DEV_DEFINITIONS_PRESENCE_PREFIX = "dev-definitions:";
const DEV_DEFINITIONS_PRESENCE_POLL_MS = 15_000;
// 在線以「最近是否回報」判定，而非後端 status==="online"：後者由 SSE 的 connected 旗標驅動，
// 反向代理下 SSE 掉線會把 connected 卡成 false，但 dev tab 的 heartbeat 其實是這個 POST 輪詢。
const DEV_DEFINITIONS_PRESENCE_FRESH_MS = DEV_DEFINITIONS_PRESENCE_POLL_MS * 3;

export type DevDefinitionsPresenceOperation =
  | "viewing"
  | "refresh"
  | "rollback"
  | "apply"
  | "commit"
  | "push";

export interface DevDefinitionsPresenceClient {
  clientId: string;
  tabId: string;
  label: string;
  formPath: string | null;
  operation: DevDefinitionsPresenceOperation;
  realtimeConnected: boolean;
  lastSeenAt: string;
  isSelf: boolean;
  isBusy: boolean;
}

export interface DevDefinitionsPresenceSummary {
  clients: DevDefinitionsPresenceClient[];
  onlineCount: number;
  busyCount: number;
  loading: boolean;
  error: string | null;
  maintenanceMessage: string | null;
  blocked: boolean;
  blockedReason: string | null;
}

interface UseDevDefinitionsPresenceOptions {
  token: string;
  enabled: boolean;
  displayName: string;
  selectedFormPath: string | null;
  operation: DevDefinitionsPresenceOperation;
  realtimeConnected: boolean;
  onForceSessionExpired?: () => void;
}

function normalizeDisplayName(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 48);
}

function operationFromTopView(value: string | null): DevDefinitionsPresenceOperation {
  const normalized = String(value ?? "").trim();
  if (!normalized.startsWith(DEV_DEFINITIONS_PRESENCE_PREFIX)) {
    return "viewing";
  }
  const operation = normalized.slice(DEV_DEFINITIONS_PRESENCE_PREFIX.length);
  if (
    operation === "refresh" ||
    operation === "rollback" ||
    operation === "apply" ||
    operation === "commit" ||
    operation === "push"
  ) {
    return operation;
  }
  return "viewing";
}

function displayNameFromPresence(client: DebugClientPresence): string {
  const raw = String(client.currentLandingPageKey ?? "").trim();
  if (raw.startsWith(DEV_DEFINITIONS_PRESENCE_PREFIX)) {
    const label = normalizeDisplayName(raw.slice(DEV_DEFINITIONS_PRESENCE_PREFIX.length));
    if (label) return label;
  }
  return `client ${client.clientId.slice(-6)}`;
}

function isBusyOperation(operation: DevDefinitionsPresenceOperation): boolean {
  return (
    operation === "refresh" ||
    operation === "rollback" ||
    operation === "apply" ||
    operation === "commit" ||
    operation === "push"
  );
}

function summarizeClients(
  clients: DebugClientPresence[],
  identity: { clientId: string; tabId: string }
): Pick<DevDefinitionsPresenceSummary, "clients" | "onlineCount" | "busyCount"> {
  const activeClients = clients
    .filter(
      (client) =>
        client.currentPath === DEV_DEFINITIONS_PATH &&
        Date.now() - Date.parse(client.lastSeenAt) < DEV_DEFINITIONS_PRESENCE_FRESH_MS
    )
    .map<DevDefinitionsPresenceClient>((client) => {
      const operation = operationFromTopView(client.currentTopView);
      const isSelf = client.clientId === identity.clientId && client.tabId === identity.tabId;
      return {
        clientId: client.clientId,
        tabId: client.tabId,
        label: isSelf ? "你" : displayNameFromPresence(client),
        formPath: client.currentFormId,
        operation,
        realtimeConnected: client.realtimeConnected,
        lastSeenAt: client.lastSeenAt,
        isSelf,
        isBusy: isBusyOperation(operation),
      };
    })
    .sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || b.lastSeenAt.localeCompare(a.lastSeenAt));

  return {
    clients: activeClients,
    onlineCount: activeClients.length,
    busyCount: activeClients.filter((client) => client.isBusy).length,
  };
}

function describeError(err: unknown): string {
  if (err instanceof Error && err.message.trim()) {
    return err.message;
  }
  return "Dev presence 載入失敗";
}

export function useDevDefinitionsPresence({
  token,
  enabled,
  displayName,
  selectedFormPath,
  operation,
  realtimeConnected,
  onForceSessionExpired,
}: UseDevDefinitionsPresenceOptions): DevDefinitionsPresenceSummary {
  const identityRef = useRef({
    clientId: getOrCreateClientId(),
    tabId: getOrCreateTabId(),
    clientBootId: getOrCreateClientBootId(),
  });
  const [clients, setClients] = useState<DebugClientPresence[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [maintenanceMessage, setMaintenanceMessage] = useState<string | null>(null);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  const latestStateRef = useRef({
    displayName,
    selectedFormPath,
    operation,
    realtimeConnected,
    onForceSessionExpired,
  });

  useEffect(() => {
    latestStateRef.current = {
      displayName,
      selectedFormPath,
      operation,
      realtimeConnected,
      onForceSessionExpired,
    };
  }, [displayName, onForceSessionExpired, operation, realtimeConnected, selectedFormPath]);

  const ackCommands = useCallback(async (commands: DebugClientCommand[]) => {
    if (commands.length === 0) return;
    const identity = identityRef.current;
    await ackDebugClientCommands({
      clientId: identity.clientId,
      tabId: identity.tabId,
      clientBootId: identity.clientBootId,
      commandIds: commands.map((command) => command.id),
    });
  }, []);

  const applyCommands = useCallback(async (commands: DebugClientCommand[]) => {
    const appliedCommands: DebugClientCommand[] = [];
    for (const command of commands) {
      appliedCommands.push(command);
      if (command.type === "force-refresh") {
        await ackCommands(appliedCommands);
        window.location.reload();
        return;
      }
      if (command.type === "set-maintenance-message") {
        setMaintenanceMessage(command.message ?? null);
        continue;
      }
      if (command.type === "clear-maintenance-message") {
        setMaintenanceMessage(null);
        continue;
      }
      if (command.type === "set-blocked") {
        setBlockedReason(command.reason ?? command.message ?? "blocked");
        continue;
      }
      if (command.type === "clear-blocked") {
        setBlockedReason(null);
        continue;
      }
      if (command.type === "force-session-expired") {
        await ackCommands(appliedCommands);
        latestStateRef.current.onForceSessionExpired?.();
        return;
      }
    }
    await ackCommands(appliedCommands);
  }, [ackCommands]);

  const syncPresenceState = useCallback((presence: DebugClientPresence) => {
    setMaintenanceMessage(presence.maintenanceMessage ?? null);
    setBlockedReason(presence.blocked ? presence.blockedReason ?? "blocked" : null);
  }, []);

  const reportPresence = useCallback(async () => {
    if (!enabled) return;
    const identity = identityRef.current;
    const latest = latestStateRef.current;
    const normalizedDisplayName = normalizeDisplayName(latest.displayName) || "Dev user";
    const result = await reportDebugClientPresence({
      clientId: identity.clientId,
      tabId: identity.tabId,
      currentPath: DEV_DEFINITIONS_PATH,
      currentFormId: latest.selectedFormPath,
      currentEntryId: null,
      currentTopView: `${DEV_DEFINITIONS_PRESENCE_PREFIX}${latest.operation}`,
      currentLandingPageKey: `${DEV_DEFINITIONS_PRESENCE_PREFIX}${normalizedDisplayName}`,
      realtimeConnected: latest.realtimeConnected,
      clientBootId: identity.clientBootId,
    });
    syncPresenceState(result.presence);
    const commands = await fetchDebugClientCommands({
      clientId: identity.clientId,
      tabId: identity.tabId,
      clientBootId: identity.clientBootId,
    });
    await applyCommands(commands);
  }, [applyCommands, enabled, syncPresenceState]);

  const refreshClients = useCallback(async () => {
    if (!enabled || !token.trim()) {
      setClients([]);
      setError(null);
      return;
    }
    setLoading(true);
    try {
      const nextClients = await fetchDebugClients(token);
      setClients(nextClients);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [enabled, token]);

  useEffect(() => {
    if (!enabled) return;
    void reportPresence().catch(() => undefined);
  }, [displayName, enabled, operation, realtimeConnected, reportPresence, selectedFormPath]);

  useEffect(() => {
    if (!enabled) return;

    void reportPresence().catch(() => undefined);
    void refreshClients();
    const intervalId = window.setInterval(() => {
      void reportPresence().catch(() => undefined);
      void refreshClients();
    }, DEV_DEFINITIONS_PRESENCE_POLL_MS);

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      void reportPresence().catch(() => undefined);
      void refreshClients();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [enabled, refreshClients, reportPresence]);

  useEffect(() => {
    if (!enabled) return;
    const identity = identityRef.current;
    const payload = {
      clientId: identity.clientId,
      tabId: identity.tabId,
      clientBootId: identity.clientBootId,
    };

    const handlePageLeave = () => {
      if (!sendDebugClientDisconnectBeacon(payload)) {
        void reportDebugClientDisconnect(payload).catch(() => undefined);
      }
    };

    window.addEventListener("pagehide", handlePageLeave);
    window.addEventListener("beforeunload", handlePageLeave);
    return () => {
      window.removeEventListener("pagehide", handlePageLeave);
      window.removeEventListener("beforeunload", handlePageLeave);
      void reportDebugClientDisconnect(payload).catch(() => undefined);
    };
  }, [enabled]);

  const summary = useMemo(
    () => summarizeClients(clients, identityRef.current),
    [clients]
  );

  return {
    ...summary,
    loading,
    error,
    maintenanceMessage,
    blocked: Boolean(blockedReason),
    blockedReason,
  };
}

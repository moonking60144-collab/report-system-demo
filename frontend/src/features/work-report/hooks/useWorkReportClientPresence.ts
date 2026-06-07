import { useEffect, useMemo, useRef, useState } from "react";
import {
  reportDebugClientDisconnect,
  reportDebugClientPresence,
  sendDebugClientDisconnectBeacon,
  type DebugClientCommand,
  type DebugClientPresence,
} from "../../../api/debugClients";
import { getOrCreateClientBootId, getOrCreateClientId, getOrCreateTabId } from "../debug/clientIdentity";

// presence 改事件驅動：SSE 連線當 heartbeat（backend /events route 會寫 presence.connected），
// 此 hook 只在狀態變動（path/form/entry/topView/realtime 翻）時送 presence 補 state 欄位。
// 額外再加：visibilitychange → 進入可見時再 push 一次，讓剛切回的 tab 很快被 admin 看到。

interface UseWorkReportClientPresenceArgs {
  currentPath: string;
  currentFormId?: string | null;
  currentEntryId?: string | null;
  currentTopView?: string | null;
  currentLandingPageKey?: string | null;
  realtimeConnected: boolean;
  onForceSessionExpired?: (reason: "forced-by-admin") => void;
}

export function useWorkReportClientPresence({
  currentPath,
  currentFormId,
  currentEntryId,
  currentTopView,
  currentLandingPageKey,
  realtimeConnected,
  onForceSessionExpired,
}: UseWorkReportClientPresenceArgs) {
  const clientId = useMemo(() => getOrCreateClientId(), []);
  const tabId = useMemo(() => getOrCreateTabId(), []);
  const clientBootId = useMemo(() => getOrCreateClientBootId(), []);
  const [maintenanceMessage, setMaintenanceMessage] = useState<string | null>(null);
  const [serverBootId, setServerBootId] = useState<string | null>(null);
  const latestStateRef = useRef({
    currentPath,
    currentFormId,
    currentEntryId,
    currentTopView,
    currentLandingPageKey,
    realtimeConnected,
    onForceSessionExpired,
  });
  const sendPresenceRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    latestStateRef.current = {
      currentPath,
      currentFormId,
      currentEntryId,
      currentTopView,
      currentLandingPageKey,
      realtimeConnected,
      onForceSessionExpired,
    };
  }, [
    currentEntryId,
    currentFormId,
    currentLandingPageKey,
    currentPath,
    currentTopView,
    onForceSessionExpired,
    realtimeConnected,
  ]);

  useEffect(() => {
    let cancelled = false;

    const syncPresenceState = (presence: DebugClientPresence) => {
      setServerBootId(String(presence.serverBootIdAtConnect ?? "").trim() || null);
      setMaintenanceMessage(presence.maintenanceMessage ?? null);
    };

    const applyCommands = (commands: DebugClientCommand[]) => {
      for (const command of commands) {
        if (command.type === "force-refresh") {
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
        if (command.type === "force-session-expired") {
          latestStateRef.current.onForceSessionExpired?.("forced-by-admin");
        }
      }
    };

    const sendPresence = async () => {
      const latestState = latestStateRef.current;
      const result = await reportDebugClientPresence({
        clientId,
        tabId,
        currentPath: latestState.currentPath,
        currentFormId: latestState.currentFormId,
        currentEntryId: latestState.currentEntryId,
        currentTopView: latestState.currentTopView,
        currentLandingPageKey: latestState.currentLandingPageKey,
        realtimeConnected: latestState.realtimeConnected,
        clientBootId,
      });
      if (!cancelled) {
        syncPresenceState(result.presence);
        applyCommands(result.commands);
      }
    };
    sendPresenceRef.current = sendPresence;

    // 初始送一次補齊 state 欄位（path / form / entry 等）
    void sendPresence();

    // tab 從隱藏變成可見時也送一次（補足 SSE 未斷但 admin 可能想確認的情況）
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        void sendPresence();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    const handleDisconnect = () => {
      const payload = { clientId, tabId };
      const accepted = sendDebugClientDisconnectBeacon(payload);
      if (!accepted) {
        void reportDebugClientDisconnect(payload).catch(() => {
          // ignore disconnect telemetry failures
        });
      }
    };

    window.addEventListener("pagehide", handleDisconnect);
    window.addEventListener("beforeunload", handleDisconnect);

    return () => {
      cancelled = true;
      sendPresenceRef.current = null;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handleDisconnect);
      window.removeEventListener("beforeunload", handleDisconnect);
    };
  }, [clientBootId, clientId, tabId]);

  useEffect(() => {
    if (!sendPresenceRef.current) {
      return;
    }
    void sendPresenceRef.current();
  }, [
    currentEntryId,
    currentFormId,
    currentLandingPageKey,
    currentPath,
    currentTopView,
    realtimeConnected,
  ]);

  return {
    clientId,
    tabId,
    maintenanceMessage,
    serverBootId,
  };
}

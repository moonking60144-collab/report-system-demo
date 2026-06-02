import { useCallback, useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  reportDebugClientDisconnect,
  sendDebugClientDisconnectBeacon,
} from "../../../api/debugClients";
import {
  getOrCreateClientId,
  getOrCreateTabId,
} from "../debug/clientIdentity";
import {
  buildWorkReportSessionExpiredPath,
  clearWorkReportSessionExpiryState,
  ensureWorkReportSessionState,
  markWorkReportSessionActivity,
  type WorkReportSessionExpiredReason,
  WORK_REPORT_SESSION_IDLE_TIMEOUT_MS,
} from "../session/sessionExpiry";

interface UseWorkReportSessionExpiryGuardArgs {
  enabled?: boolean;
  currentPath: string;
}

const ACTIVITY_WRITE_THROTTLE_MS = 5_000;
const EXPIRY_CHECK_MAX_DELAY_MS = 60_000;

export function useWorkReportSessionExpiryGuard({
  enabled = true,
  currentPath,
}: UseWorkReportSessionExpiryGuardArgs): {
  expireSession: (reason: WorkReportSessionExpiredReason) => void;
} {
  const navigate = useNavigate();
  const clientId = useMemo(() => getOrCreateClientId(), []);
  const tabId = useMemo(() => getOrCreateTabId(), []);
  const expiredRef = useRef(false);
  const currentPathRef = useRef(currentPath);
  const lastActivityWriteAtRef = useRef(0);

  useEffect(() => {
    currentPathRef.current = currentPath;
  }, [currentPath]);

  const expireSession = useCallback(
    (reason: WorkReportSessionExpiredReason) => {
      if (typeof window === "undefined" || expiredRef.current) {
        return;
      }
      expiredRef.current = true;
      const disconnectPayload = { clientId, tabId };
      const accepted = sendDebugClientDisconnectBeacon(disconnectPayload);
      if (!accepted) {
        void reportDebugClientDisconnect(disconnectPayload).catch(() => {
          // NOTE: session 過期時 disconnect telemetry 失敗不阻塞導頁
        });
      }
      navigate(
        buildWorkReportSessionExpiredPath(currentPathRef.current, reason),
        { replace: true }
      );
    },
    [clientId, navigate, tabId]
  );

  useEffect(() => {
    if (typeof window === "undefined" || !enabled) {
      return;
    }
    expiredRef.current = false;

    let disposed = false;
    let timer: number | null = null;

    const evaluateExpiry = (): void => {
      const now = Date.now();
      const { lastActivityAt } = ensureWorkReportSessionState(now);

      if (now - lastActivityAt >= WORK_REPORT_SESSION_IDLE_TIMEOUT_MS) {
        expireSession("idle-timeout");
        return;
      }

      const msUntilIdle = lastActivityAt + WORK_REPORT_SESSION_IDLE_TIMEOUT_MS - now;
      const nextDelay = Math.min(
        EXPIRY_CHECK_MAX_DELAY_MS,
        Math.max(1_000, msUntilIdle)
      );

      if (timer !== null) {
        window.clearTimeout(timer);
      }
      timer = window.setTimeout(() => {
        if (!disposed) {
          evaluateExpiry();
        }
      }, nextDelay);
    };

    const markActivity = () => {
      if (expiredRef.current) {
        return;
      }
      const now = Date.now();
      if (now - lastActivityWriteAtRef.current < ACTIVITY_WRITE_THROTTLE_MS) {
        return;
      }
      lastActivityWriteAtRef.current = now;
      markWorkReportSessionActivity(now);
      evaluateExpiry();
    };

    ensureWorkReportSessionState();
    evaluateExpiry();

    const activityEvents: Array<keyof WindowEventMap> = [
      "pointerdown",
      "keydown",
      "focus",
    ];
    activityEvents.forEach((eventName) => {
      window.addEventListener(eventName, markActivity, { passive: true });
    });
    document.addEventListener("input", markActivity, true);
    document.addEventListener("change", markActivity, true);

    return () => {
      disposed = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      activityEvents.forEach((eventName) => {
        window.removeEventListener(eventName, markActivity);
      });
      document.removeEventListener("input", markActivity, true);
      document.removeEventListener("change", markActivity, true);
    };
  }, [enabled, expireSession]);

  return {
    expireSession,
  };
}

export { clearWorkReportSessionExpiryState };

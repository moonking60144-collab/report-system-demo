import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  clearServerBootRedirectFlash,
  hasServerBootRedirectPending,
  readHandledServerBootRedirectDeployVersion,
  redirectToWorkReportHomeAfterBootUpdate,
} from "../features/work-report/utils";

// 原本有 /health polling（每 20s/60s）來偵測重新部署，現在拿掉：
// SSE `ready` + `ping` event 本來就帶 deployVersion，fallback 機制夠；
// health polling 純粹重複造成 network tab 雜訊
const SERVER_BOOT_GUARD_SESSION_KEY = "work-report:server-boot-guard-session:v1";

function resolveApiBaseUrl(): string {
  return String(import.meta.env.VITE_API_BASE_URL ?? "/api").trim() || "/api";
}

function resolveEventsUrl(): string {
  const apiBaseUrl = resolveApiBaseUrl();
  if (/^https?:\/\//i.test(apiBaseUrl)) {
    return `${apiBaseUrl.replace(/\/+$/, "")}/events`;
  }
  const normalizedBase = apiBaseUrl.startsWith("/") ? apiBaseUrl : `/${apiBaseUrl}`;
  return `${normalizedBase.replace(/\/+$/, "")}/events`;
}

function parseLifecycleDeployVersion(rawData: string): string {
  try {
    const parsed = JSON.parse(rawData) as Partial<{ deployVersion?: string }>;
    return String(parsed.deployVersion ?? "").trim();
  } catch {
    return "";
  }
}

function buildGuardSessionId(): string {
  return `boot-guard-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function readNavigationType(): string {
  if (typeof window === "undefined" || typeof performance === "undefined") {
    return "";
  }
  const navigationEntry = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  return String(navigationEntry?.type ?? "").trim().toLowerCase();
}

function shouldResetBootGuardForClonedTab(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    const existing = String(window.sessionStorage.getItem(SERVER_BOOT_GUARD_SESSION_KEY) ?? "").trim();
    const navigationType = readNavigationType();
    const hasSessionState = window.sessionStorage.length > 0;
    const redirectPending = hasServerBootRedirectPending();
    const shouldReset =
      navigationType === "navigate" && hasSessionState && !redirectPending;
    if (!existing || shouldReset) {
      window.sessionStorage.setItem(SERVER_BOOT_GUARD_SESSION_KEY, buildGuardSessionId());
    }
    return shouldReset;
  } catch {
    return false;
  }
}

export interface ServerBootGuardState {
  sseConnected: boolean;
  sseDisconnectedSince: number | null;
}

export function useServerBootGuard(enabled = true): ServerBootGuardState {
  const knownDeployVersionRef = useRef("");
  const redirectedDeployVersionRef = useRef("");
  const eventsUrl = useMemo(() => resolveEventsUrl(), []);
  const [sseConnected, setSseConnected] = useState(false);
  const [sseDisconnectedSince, setSseDisconnectedSince] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (typeof window === "undefined" || !enabled) {
      return;
    }

    if (shouldResetBootGuardForClonedTab()) {
      // NOTE: duplicated tab 可能會把舊分頁尚未消耗的「系統已更新」flash 一起複製過來。
      // 這裡用 layout effect 先清掉，避免子元件的 useEffect 在同一輪 commit 先把它 consume 掉。
      knownDeployVersionRef.current = "";
      redirectedDeployVersionRef.current = "";
      clearServerBootRedirectFlash();
    }
  }, [enabled]);

  useEffect(() => {
    if (typeof window === "undefined" || !enabled) {
      return;
    }

    const handleDeployVersion = (nextDeployVersion: string) => {
      const normalizedDeployVersion = String(nextDeployVersion ?? "").trim();
      if (!normalizedDeployVersion) {
        return;
      }
      if (!knownDeployVersionRef.current) {
        knownDeployVersionRef.current = normalizedDeployVersion;
        return;
      }
      if (knownDeployVersionRef.current === normalizedDeployVersion) {
        return;
      }
      knownDeployVersionRef.current = normalizedDeployVersion;
      const handledDeployVersion = readHandledServerBootRedirectDeployVersion();
      if (handledDeployVersion === normalizedDeployVersion) {
        return;
      }
      if (redirectedDeployVersionRef.current === normalizedDeployVersion) {
        return;
      }
      redirectedDeployVersionRef.current = normalizedDeployVersion;
      redirectToWorkReportHomeAfterBootUpdate(normalizedDeployVersion);
    };

    if (typeof window.EventSource === "undefined") {
      return;
    }

    const source = new window.EventSource(eventsUrl);

    source.onopen = () => {
      setSseConnected(true);
      setSseDisconnectedSince(null);
    };

    source.onerror = () => {
      setSseConnected(false);
      setSseDisconnectedSince((prev) => prev ?? Date.now());
    };

    const handleLifecycleEvent = (event: MessageEvent) => {
      handleDeployVersion(parseLifecycleDeployVersion(event.data));
    };

    source.addEventListener("ready", (event) => {
      handleLifecycleEvent(event as MessageEvent);
    });

    source.addEventListener("ping", (event) => {
      handleLifecycleEvent(event as MessageEvent);
    });

    return () => {
      source.close();
    };
  }, [enabled, eventsUrl]);

  return { sseConnected, sseDisconnectedSince };
}

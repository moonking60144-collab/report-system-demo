import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  buildWorkReportSystemUnavailablePath,
  readCachedSystemNoticeAvailabilitySnapshot,
} from "../systemAvailability";

// 改用 SSE 連線狀態當 backend 可用性訊號（原本 /health polling 拿掉，與 useServerBootGuard 共用同一條 SSE）
// 一般模式：SSE 斷線持續 >= 20 秒 → 視為 backend 掛掉，redirect 到 system-unavailable 頁
//   （deploy 重啟通常 3~10s，20s 閾值不會誤傷）
// 維護模式：shorter — 維護中使用者應該快一點看到不可用畫面
const UNAVAILABLE_THRESHOLD_MS = 20_000;
const MAINTENANCE_UNAVAILABLE_THRESHOLD_MS = 5_000;
const CHECK_INTERVAL_MS = 2_000;

export function useWorkReportAvailabilityGuard(
  enabled: boolean,
  currentPath: string,
  sseState: {
    sseConnected: boolean;
    sseDisconnectedSince: number | null;
  }
): void {
  const navigate = useNavigate();
  const redirectedRef = useRef(false);
  const { sseDisconnectedSince } = sseState;

  useEffect(() => {
    redirectedRef.current = false;
  }, [currentPath]);

  useEffect(() => {
    if (typeof window === "undefined" || !enabled) {
      return;
    }

    const checkAndRedirect = () => {
      if (redirectedRef.current) return;
      if (sseDisconnectedSince === null) return;

      const cachedSnapshot = readCachedSystemNoticeAvailabilitySnapshot();
      const threshold = cachedSnapshot.maintenanceMode
        ? MAINTENANCE_UNAVAILABLE_THRESHOLD_MS
        : UNAVAILABLE_THRESHOLD_MS;
      const disconnectedFor = Date.now() - sseDisconnectedSince;
      if (disconnectedFor < threshold) return;

      redirectedRef.current = true;
      const nextPath = cachedSnapshot.maintenanceMode
        ? buildWorkReportSystemUnavailablePath(
            currentPath,
            "maintenance",
            cachedSnapshot.maintenanceMessage
          )
        : buildWorkReportSystemUnavailablePath(currentPath, "backend-unavailable");
      navigate(nextPath, { replace: true });
    };

    // 立刻檢查一次（某些情況 mount 時 SSE 已經斷了很久）
    checkAndRedirect();

    // 每 2s tick 一次，時間夠長就觸發 redirect（閾值判定用，不是 polling backend）
    const timer = window.setInterval(checkAndRedirect, CHECK_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [currentPath, enabled, sseDisconnectedSince, navigate]);
}

import { useEffect, useMemo, useState } from "react";
import { Tooltip } from "antd";
import { createApiClient } from "../api/apiClient";

interface HealthResponse {
  demoMode?: boolean;
}

export function DemoBadge() {
  const [isDemo, setIsDemo] = useState(false);
  const apiClient = useMemo(() => createApiClient({ timeoutMs: 5000 }), []);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<HealthResponse>("/health")
      .then((res) => {
        if (!cancelled && res.data?.demoMode) {
          setIsDemo(true);
        }
      })
      .catch(() => {
        // 健康檢查失敗就不顯示徽章
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient]);

  if (!isDemo) return null;

  return (
    <Tooltip
      title="目前以記憶體假倉執行。上游 Ragic SaaS 已替換為 MockRagicClient，所有業務邏輯（SSE、SQLite read model、token bucket、Form 16 idempotency 等）原樣運作。"
      placement="bottomLeft"
    >
      <div
        style={{
          position: "fixed",
          top: 8,
          right: 8,
          zIndex: 9999,
          padding: "4px 12px",
          background: "linear-gradient(135deg, #f59e0b 0%, #dc2626 100%)",
          color: "white",
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: "0.1em",
          borderRadius: 4,
          boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
          cursor: "help",
          userSelect: "none",
        }}
      >
        DEMO MODE
      </div>
    </Tooltip>
  );
}

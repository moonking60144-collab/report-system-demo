import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Slider, Space, Switch, Tooltip, Typography, message } from "antd";
import { createApiClient } from "../api/apiClient";

/**
 * Demo-only fault-injection control panel.
 *
 * 浮動在右下角，預設摺疊；展開後可即時調整三個參數，每次變更 debounce 300ms 後
 * PUT /api/__demo/fault-injection。Demo 模式下可直接操作。
 *
 * 設計目的：給面試官現場 toggle 故障，搭配畫面同步觀察：
 * - 失敗率 → circuit breaker 開啟
 * - 延遲   → token bucket 排隊
 * - 掉欄位 → activity log idempotency 自動 rollback
 *
 * 讀取故障設定成功後才顯示；公開 Demo 未掛控制端點時不渲染。
 */

interface FaultInjectionState {
  enabled: boolean;
  failureRate: number; // 0-1
  latencyMs: number; // 0-5000
  dropFieldRate: number; // 0-1
}

interface FaultInjectionApiResponse {
  data?: Partial<FaultInjectionState>;
}

const DEFAULT_STATE: FaultInjectionState = {
  enabled: false,
  failureRate: 0,
  latencyMs: 0,
  dropFieldRate: 0,
};

const DEBOUNCE_MS = 300;

export function FaultInjectionPanel() {
  const [isDemo, setIsDemo] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<FaultInjectionState>(DEFAULT_STATE);
  const apiClient = useMemo(() => createApiClient({ timeoutMs: 5000 }), []);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 初始 GET 完成前不要 PUT，避免把 DEFAULT_STATE 覆蓋上去
  const initialLoadedRef = useRef(false);

  // 故障設定載入完成後才提供控制項，避免初次點擊被 GET 結果覆蓋。
  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<FaultInjectionApiResponse>("/__demo/fault-injection")
      .then((res) => {
        if (cancelled) return;
        const payload = res.data?.data ?? {};
        setState({
          enabled: payload.enabled ?? DEFAULT_STATE.enabled,
          failureRate: payload.failureRate ?? DEFAULT_STATE.failureRate,
          latencyMs: payload.latencyMs ?? DEFAULT_STATE.latencyMs,
          dropFieldRate: payload.dropFieldRate ?? DEFAULT_STATE.dropFieldRate,
        });
        initialLoadedRef.current = true;
        setIsDemo(true);
      })
      .catch(() => {
        // 公開 Demo 未提供控制端點，或讀取失敗時不顯示面板。
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient]);

  const pushUpdate = useCallback(
    (next: FaultInjectionState) => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
      debounceTimer.current = setTimeout(() => {
        apiClient
          .put("/__demo/fault-injection", next)
          .catch(() => {
            message.error("更新 fault-injection 失敗");
          });
      }, DEBOUNCE_MS);
    },
    [apiClient],
  );

  // 元件卸載時清掉 pending timer
  useEffect(() => {
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, []);

  const update = useCallback(
    (patch: Partial<FaultInjectionState>) => {
      setState((prev) => {
        const next = { ...prev, ...patch };
        // 只有在初始載入完成後才推送，避免覆蓋 server 真實狀態
        if (initialLoadedRef.current) {
          pushUpdate(next);
        }
        return next;
      });
    },
    [pushUpdate],
  );

  const handleToggleExpand = useCallback(() => {
    setExpanded((v) => !v);
  }, []);

  if (!isDemo) return null;

  if (!expanded) {
    return (
      <Button
        className="demo-fault-injection-trigger"
        type="primary"
        danger
        onClick={handleToggleExpand}
        style={{
          position: "fixed",
          right: 16,
          bottom: 16,
          zIndex: 900,
          boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
        }}
      >
        故障模擬
      </Button>
    );
  }

  return (
    <Card
      className="demo-fault-injection-panel"
      size="small"
      title="故障注入（demo 控制台）"
      extra={
        <Button size="small" type="text" onClick={handleToggleExpand}>
          收起
        </Button>
      }
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 900,
        width: 360,
        boxShadow: "0 6px 20px rgba(0,0,0,0.25)",
      }}
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Space style={{ width: "100%", justifyContent: "space-between" }}>
          <Typography.Text strong>啟用故障注入</Typography.Text>
          <Switch
            checked={state.enabled}
            onChange={(checked) => update({ enabled: checked })}
          />
        </Space>

        <div>
          <Tooltip title="上游 Ragic 回傳 5xx 的機率；觀察 circuit breaker 從 closed → open → half-open 的轉態">
            <Typography.Text>
              上游失敗率：{Math.round(state.failureRate * 100)}%
            </Typography.Text>
          </Tooltip>
          <Slider
            min={0}
            max={100}
            value={Math.round(state.failureRate * 100)}
            onChange={(v) => update({ failureRate: (v as number) / 100 })}
            disabled={!state.enabled}
          />
        </div>

        <div>
          <Tooltip title="上游 Ragic 回應前注入的人為延遲；觀察 token bucket 排隊與 SSE 等待">
            <Typography.Text>上游延遲：{state.latencyMs} ms</Typography.Text>
          </Tooltip>
          <Slider
            min={0}
            max={5000}
            step={100}
            value={state.latencyMs}
            onChange={(v) => update({ latencyMs: v as number })}
            disabled={!state.enabled}
          />
        </div>

        <div>
          <Tooltip title="寫入時隨機丟欄位的機率；觀察 activity log idempotency check 失敗後自動 rollback">
            <Typography.Text>
              寫入時掉欄位機率：{Math.round(state.dropFieldRate * 100)}%
            </Typography.Text>
          </Tooltip>
          <Slider
            min={0}
            max={100}
            value={Math.round(state.dropFieldRate * 100)}
            onChange={(v) => update({ dropFieldRate: (v as number) / 100 })}
            disabled={!state.enabled}
          />
        </div>

        <Typography.Paragraph
          type="secondary"
          style={{ fontSize: 12, marginBottom: 0 }}
        >
          失敗率 → 觀察 circuit breaker 開啟；延遲 → 觀察 token bucket 排隊；
          掉欄位 → 觀察 activityLog 自動 rollback。
        </Typography.Paragraph>
      </Space>
    </Card>
  );
}

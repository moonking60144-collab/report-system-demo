import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Slider, Space, Switch, Tooltip, Typography, message } from "antd";
import { createApiClient } from "../api/apiClient";

/**
 * Demo-only fault-injection control panel.
 *
 * 浮動在右下角，預設摺疊；展開後可即時調整三個參數，每次變更 debounce 300ms 後
 * PUT /api/__demo/fault-injection。需 X-Demo-Key header，key 從 sessionStorage 取，
 * 沒設定就在第一次展開時用 prompt 跟使用者要。
 *
 * 設計目的：給面試官現場 toggle 故障，搭配畫面同步觀察：
 * - 失敗率 → circuit breaker 開啟
 * - 延遲   → token bucket 排隊
 * - 掉欄位 → Form 16 idempotency 自動 rollback
 *
 * 與 DemoBadge 同樣：先 GET /api/health 確認 demoMode=true 才掛上，否則不渲染。
 */

interface HealthResponse {
  demoMode?: boolean;
}

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

const DEMO_KEY_STORAGE = "ragic-demo-key";
const DEBOUNCE_MS = 300;

function readStoredDemoKey(): string {
  try {
    return sessionStorage.getItem(DEMO_KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

function writeStoredDemoKey(key: string): void {
  try {
    sessionStorage.setItem(DEMO_KEY_STORAGE, key);
  } catch {
    // sessionStorage 不可用就放棄，下次展開會再 prompt
  }
}

function clearStoredDemoKey(): void {
  try {
    sessionStorage.removeItem(DEMO_KEY_STORAGE);
  } catch {
    // ignore
  }
}

export function FaultInjectionPanel() {
  const [isDemo, setIsDemo] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<FaultInjectionState>(DEFAULT_STATE);
  const [demoKey, setDemoKey] = useState<string>(() => readStoredDemoKey());

  const apiClient = useMemo(() => createApiClient({ timeoutMs: 5000 }), []);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 初始 GET 完成前不要 PUT，避免把 DEFAULT_STATE 覆蓋上去
  const initialLoadedRef = useRef(false);

  // 健康檢查 → 確認 demoMode
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
        // 健康檢查失敗就不掛 panel
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient]);

  // 展開後第一次 GET 當前 fault-injection state
  useEffect(() => {
    if (!isDemo || !expanded || !demoKey || initialLoadedRef.current) return;
    let cancelled = false;
    apiClient
      .get<FaultInjectionApiResponse>("/__demo/fault-injection", {
        headers: { "X-Demo-Key": demoKey },
      })
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
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status === 403) {
          message.error("X-Demo-Key 不正確，請重新輸入");
          clearStoredDemoKey();
          setDemoKey("");
        } else {
          message.error("讀取 fault-injection 狀態失敗");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient, demoKey, expanded, isDemo]);

  const pushUpdate = useCallback(
    (next: FaultInjectionState) => {
      if (!demoKey) return;
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
      debounceTimer.current = setTimeout(() => {
        apiClient
          .put("/__demo/fault-injection", next, {
            headers: { "X-Demo-Key": demoKey },
          })
          .catch((err: unknown) => {
            const status = (err as { response?: { status?: number } })?.response?.status;
            if (status === 403) {
              message.error("X-Demo-Key 不正確，請重新輸入");
              clearStoredDemoKey();
              setDemoKey("");
            } else {
              message.error("更新 fault-injection 失敗");
            }
          });
      }, DEBOUNCE_MS);
    },
    [apiClient, demoKey],
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
    if (!expanded) {
      // 第一次展開時若沒有 key，prompt 使用者
      if (!demoKey) {
        const input = window.prompt("請輸入 X-Demo-Key");
        if (!input) return;
        writeStoredDemoKey(input);
        setDemoKey(input);
      }
    }
    setExpanded((v) => !v);
  }, [demoKey, expanded]);

  if (!isDemo) return null;

  if (!expanded) {
    return (
      <Button
        type="primary"
        danger
        onClick={handleToggleExpand}
        style={{
          position: "fixed",
          right: 16,
          bottom: 16,
          zIndex: 9999,
          boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
        }}
      >
        故障模擬
      </Button>
    );
  }

  return (
    <Card
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
        zIndex: 9999,
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
          <Tooltip title="寫入時隨機丟欄位的機率；觀察 Form 16 idempotency check 失敗後自動 rollback">
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
          掉欄位 → 觀察 form16 自動 rollback。
        </Typography.Paragraph>
      </Space>
    </Card>
  );
}

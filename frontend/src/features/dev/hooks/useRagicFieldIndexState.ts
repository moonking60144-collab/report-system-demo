import { useCallback, useEffect, useRef, useState } from "react";
import { message } from "antd";
import {
  fetchRagicFieldIndexState,
  refreshRagicFieldIndex,
  type RagicFieldIndexState,
} from "../../../api/devRagicFieldIndex";
import {
  extractErrorMessage,
  getErrorCode,
  isUnauthorized,
} from "../../../api/apiErrors";

const POLL_REFRESH_INTERVAL_MS = 1500;

export interface UseRagicFieldIndexStateResult {
  state: RagicFieldIndexState | null;
  refreshError: string | null;
  refresh: () => Promise<void>;
  /** 強制重讀 state（refresh 完成後 detail modal 用來 reload entries 時可用）*/
  reload: () => Promise<RagicFieldIndexState | null>;
}

/**
 * 開發者 panel 共用的 Ragic 欄位索引狀態。
 *
 * 為何要 hook：之前 RagicFieldInlineSearch 跟 RagicFormDetailModal 各自 poll
 * GET /state，refresh 期間 1.3 RPS 打 backend 還會 state 不同步。lift 到 panel
 * 用一份 hook 拉狀態，兩個元件透過 props 共享同一份 snapshot。
 */
export function useRagicFieldIndexState(
  token: string,
  onAuthFailure: () => void,
  enabled = true
): UseRagicFieldIndexStateResult {
  const [state, setState] = useState<RagicFieldIndexState | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const onAuthFailureRef = useRef(onAuthFailure);
  useEffect(() => {
    onAuthFailureRef.current = onAuthFailure;
  }, [onAuthFailure]);

  const reload = useCallback(async (): Promise<RagicFieldIndexState | null> => {
    if (!enabled || !token) {
      return null;
    }
    try {
      const next = await fetchRagicFieldIndexState(token);
      setState(next);
      return next;
    } catch (error) {
      if (isUnauthorized(error)) {
        onAuthFailureRef.current();
        return null;
      }
      console.error("[ragic-fields] state load failed", error);
      return null;
    }
  }, [enabled, token]);

  // 啟動拉一次（reload 內部 setState 是 data-fetching 固有行為，無法避免）
  useEffect(() => {
    if (!enabled) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [enabled, reload]);

  // refreshing 期間 polling；非 refreshing 立即停掉
  useEffect(() => {
    if (!enabled || state?.status !== "refreshing") return;
    const id = window.setInterval(() => {
      void reload();
    }, POLL_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [enabled, state?.status, reload]);

  const refresh = useCallback(async () => {
    if (!enabled || !token) {
      setRefreshError("尚未完成開發者登入驗證");
      return;
    }
    setRefreshError(null);
    try {
      await refreshRagicFieldIndex(token);
      await reload();
    } catch (error) {
      if (isUnauthorized(error)) {
        onAuthFailureRef.current();
        return;
      }
      // 背景排程正在跑（409 REFRESH_IN_PROGRESS）→ 不是錯誤，給友善提示即可
      if (getErrorCode(error) === "REFRESH_IN_PROGRESS") {
        void message.info("背景正在自動更新，請稍候再試");
        // 讀一次 state 讓 UI 立刻反映「refreshing 中」（含背景旗標）
        await reload();
        return;
      }
      setRefreshError(extractErrorMessage(error, "refresh failed"));
    }
  }, [enabled, token, reload]);

  return { state: enabled ? state : null, refreshError, refresh, reload };
}

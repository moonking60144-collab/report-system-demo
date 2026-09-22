import type { RagicFieldIndexState } from "../../../api/devRagicFieldIndex";
import { formatRelativeTime, syncHealth } from "../utils/devSyncHealth";

// 文字描述抽成 module function：Date.now() 不能在 component render 直接呼叫（React Compiler 純度）
function describeSync(state: RagicFieldIndexState | null): {
  dot: string;
  dotTitle: string;
  text: string;
} {
  const { dot, title } = syncHealth(state);
  let text: string;
  if (!state) text = "載入中…";
  else if (state.status === "refreshing") text = "正在重新抓取…";
  else if (state.status === "error") text = `錯誤：${state.message ?? "unknown"}`;
  else if (state.status === "idle" || !state.refreshedAt) text = "尚未抓取";
  else
    text = `已索引 ${state.totalForms} 表 / ${state.totalFields} 欄位 · 更新於 ${formatRelativeTime(state.refreshedAt)}`;
  return { dot, dotTitle: title, text };
}

interface DevSyncStatusProps {
  state: RagicFieldIndexState | null;
  onRefresh: () => void | Promise<void>;
}

/**
 * Ragic 索引同步狀態：健康燈（綠=新鮮 / 黃=過久 / 紅=錯誤 / 灰=未抓）＋ 索引統計 ＋ 重新抓取。
 * 索引是「欄位索引」工具的資源，所以這條收在該 view 頂部。
 */
export function DevSyncStatus({ state, onRefresh }: DevSyncStatusProps) {
  const refreshing = state?.status === "refreshing";
  const { dot, dotTitle, text } = describeSync(state);

  return (
    <div className="dev-sync">
      <span className={`dev-sync__dot ${dot}`} title={dotTitle} aria-hidden />
      <span className={`dev-sync__text${!state || refreshing ? " ragic-loading-inline" : ""}`}>
        {text}
      </span>
      <button
        type="button"
        className="dev-mode-btn dev-sync__refresh"
        onClick={() => void onRefresh()}
        disabled={refreshing}
        title="重新從 Ragic /sims/doc.jsp 抓取最新欄位索引"
      >
        {refreshing ? "抓取中…" : "↻ 重新抓取"}
      </button>
    </div>
  );
}

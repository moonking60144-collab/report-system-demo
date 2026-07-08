import type { RagicFieldIndexState } from "../../../api/devRagicFieldIndex";

// 索引超過這個時間沒更新就亮黃燈（背景排程每 30 分自動刷新一次，>45 分代表排程可能沒跑）
const STALE_MINUTES = 45;

export function formatRelativeTime(iso: string | null): string {
  if (!iso) return "尚未抓取";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))} 秒前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分鐘前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小時前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

// 健康燈：綠=新鮮 / 黃=過久 / 紅=錯誤 / 灰=未抓或載入中。Date.now() 在 module function 算（避開 render 純度規則）
export function syncHealth(state: RagicFieldIndexState | null): { dot: string; title: string } {
  if (!state) return { dot: "is-idle", title: "載入中" };
  if (state.status === "refreshing") return { dot: "is-busy", title: "抓取中" };
  if (state.status === "error") return { dot: "is-error", title: "錯誤" };
  if (state.status === "idle" || !state.refreshedAt) return { dot: "is-idle", title: "尚未抓取" };
  const ageMin = (Date.now() - Date.parse(state.refreshedAt)) / 60_000;
  return ageMin >= STALE_MINUTES
    ? { dot: "is-stale", title: `已超過 ${STALE_MINUTES} 分未更新` }
    : { dot: "is-ok", title: "索引新鮮" };
}

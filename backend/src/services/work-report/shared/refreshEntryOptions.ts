import { env } from "../../../config/env";
import type { RagicReadPriority } from "../../../infra/ragicRequestScheduler";

/**
 * 根據 priority 選對應的 Ragic read timeout env。
 * - user: 使用者即時讀，短 timeout
 * - sync: 全表 bulk 讀，最長 timeout
 * - background: 背景單筆 entry 讀，中等 timeout
 */
function resolveRefreshTimeoutMs(priority: RagicReadPriority): number {
  switch (priority) {
    case "sync":
      return env.RAGIC_SYNC_READ_TIMEOUT_MS;
    case "background":
      return env.RAGIC_BACKGROUND_READ_TIMEOUT_MS;
    case "user":
      return env.RAGIC_READ_TIMEOUT_MS;
    default: {
      const _never: never = priority;
      throw new Error(`unknown priority: ${String(_never)}`);
    }
  }
}

/**
 * workReportReadService.getReportByEntryId 非 user 路徑的 options。
 * callback refresh / sync replay / mutation projection 等 caller 使用。
 *
 * 不提供 default —— caller 必須明確選 priority，避免 silent drop 回 user lane。
 */
export function buildRefreshEntryOptions(priority: RagicReadPriority): {
  refresh: true;
  ragicReadTimeoutMs: number;
  priority: RagicReadPriority;
} {
  return {
    refresh: true,
    ragicReadTimeoutMs: resolveRefreshTimeoutMs(priority),
    priority,
  };
}

/**
 * 直接打 ragicClient.getEntry / getFormPage 時的 options。
 * 不經 workReportReadService 那層（例：Form 16 自己的 refresh）。
 *
 * Priority **必填**，不提供 default —— 跟 buildRefreshEntryOptions 一致，
 * 避免未來 bulk caller 不小心走錯 lane（例：寫 background 但其實該走 sync）。
 */
export function buildBackgroundReadOptions(priority: RagicReadPriority): {
  timeoutMs: number;
  priority: RagicReadPriority;
} {
  return {
    timeoutMs: resolveRefreshTimeoutMs(priority),
    priority,
  };
}

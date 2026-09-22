import { env } from "../../../config/env";
import type { RagicReadPriority } from "../../../infra/ragicRequestScheduler";

/**
 * 根據 priority 選對應的 Ragic read timeout env。
 * - user: 使用者即時讀，短 timeout
 * - mutation: 寫入前 precondition，獨立 lane / bucket，避免被一般 user refresh 或 sync 擠住
 * - sync: 全表 bulk 讀，最長 timeout
 * - background: 背景單筆 entry 讀，中等 timeout
 */
function resolveRefreshTimeoutMs(priority: RagicReadPriority): number {
  switch (priority) {
    case "mutation":
      return env.RAGIC_MUTATION_READ_TIMEOUT_MS;
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
 * 不經 workReportReadService 那層（例：activity log 自己的 refresh）。
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

export type MutationCommandReadPhase = "current" | "verify";

/**
 * Work-order command 直接讀 Ragic entry 時的共用 budget。
 *
 * current 是寫入前的安全讀，可使用 mutation read 的有限 retry；verify 已在寫入後，
 * 只允許單次 bounded read。verify timeout／不一致會進既有 indeterminate reconciliation，
 * 不可因 read retry budget 用完而重送 write。
 */
export function buildMutationCommandReadOptions(
  phase: MutationCommandReadPhase
): {
  timeoutMs: number;
  totalBudgetMs: number;
  maxRetries: number;
  priority: "mutation";
} {
  const timeoutMs =
    phase === "verify"
      ? env.RAGIC_MUTATION_VERIFY_TIMEOUT_MS
      : env.RAGIC_MUTATION_READ_TIMEOUT_MS;
  return {
    timeoutMs,
    totalBudgetMs:
      phase === "current"
        ? env.RAGIC_MUTATION_READ_TOTAL_BUDGET_MS
        : timeoutMs,
    maxRetries: phase === "current" ? env.RAGIC_MUTATION_READ_MAX_RETRIES : 0,
    priority: "mutation",
  };
}

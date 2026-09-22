import { env } from "../config/env";
import { ragicFieldIndexRepository } from "../storage/sqlite/ragicFieldIndexRepository";
import { ragicFieldIndexService } from "../services/dev/ragicFieldIndexService";
import { sqliteClient } from "../storage/sqlite/sqliteClient";

let intervalTimer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;

/**
 * 背景一次 refresh cycle：
 *   - 先 claimRefresh（atomic 搶鎖）；若已在 refreshing（手動「重新抓取」或上一輪
 *     背景還沒跑完）→ claim 失敗、skip，不重複觸發。
 *   - 搶到才 fire-and-forget 跑 service.refresh()，state 由 service 內部結算
 *     (ready / error)，跟手動 refresh 同一條路。
 *   - hash skip 命中時 refresh 幾乎 no-op（只 fetch + parse + 比對，不寫 DB）。
 *   - 不傳 AbortSignal：背景排程不需要中途取消。
 *
 * 除背景排程外，definitions「重新匯入」route 也呼叫這個 cycle 連動同步索引
 * （使用者預期重新匯入＝全部同步；新建多版本表單的跨版本判定靠索引）。
 * 回傳是否真的觸發（false = 已有一輪在跑）。
 */
export async function runAutoRefreshCycle(
  claimMessage = "auto-refresh"
): Promise<boolean> {
  const claimed = await ragicFieldIndexRepository.claimRefresh(claimMessage);
  if (!claimed) {
    console.info("[ragic-field-index-auto-refresh-skipped]", {
      reason: "already-refreshing",
      claimMessage,
    });
    return false;
  }
  let refreshPromise: ReturnType<typeof ragicFieldIndexService.refresh>;
  try {
    refreshPromise = ragicFieldIndexService.refresh({ source: "auto" });
  } catch (error) {
    await ragicFieldIndexRepository.resetStuckRefreshing("auto-refresh failed before start");
    console.warn("[ragic-field-index-auto-refresh-failed]", {
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }

  void refreshPromise
    .then(async (counts) => {
      console.info("[ragic-field-index-auto-refresh-done]", {
        totalForms: counts.totalForms,
        totalFields: counts.totalFields,
      });
      // refresh 寫 54k rows 時順手 checkpoint 控 WAL（hash-skip 命中沒寫時 no-op）。
      await sqliteClient.checkpoint();
    })
    .catch((error) => {
      // source:"auto" 時 service.refresh 已 settle 成 status:'idle'（非 error）；
      // 這層只防 unhandledRejection
      console.warn("[ragic-field-index-auto-refresh-failed]", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  return true;
}

export function startRagicFieldIndexAutoRefresh(): void {
  if (!env.SQLITE_ENABLED || !env.RAGIC_FIELD_INDEX_AUTO_REFRESH_ENABLED) {
    return;
  }
  if (intervalTimer || startupTimer) {
    return;
  }

  const scheduleCycle = () => {
    void runAutoRefreshCycle().catch((error) => {
      // runAutoRefreshCycle 內已處理 refresh 的 reject；這層保險防 claimRefresh
      // 本身 reject 變 unhandledRejection
      console.warn("[ragic-field-index-auto-refresh-cycle-failed]", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  startupTimer = setTimeout(() => {
    startupTimer = null;
    scheduleCycle();
    intervalTimer = setInterval(
      scheduleCycle,
      env.RAGIC_FIELD_INDEX_AUTO_REFRESH_INTERVAL_MS
    );
    intervalTimer.unref?.();
  }, env.RAGIC_FIELD_INDEX_AUTO_REFRESH_STARTUP_DELAY_MS);
  startupTimer.unref?.();

  console.info("[ragic-field-index-auto-refresh-scheduled]", {
    intervalMs: env.RAGIC_FIELD_INDEX_AUTO_REFRESH_INTERVAL_MS,
    startupDelayMs: env.RAGIC_FIELD_INDEX_AUTO_REFRESH_STARTUP_DELAY_MS,
  });
}

export function stopRagicFieldIndexAutoRefresh(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
}

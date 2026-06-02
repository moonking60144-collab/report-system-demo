import { env } from "../config/env";
import { runBackgroundTask } from "../infra/backgroundTaskRunner";
import { createLogger } from "../observability/logger";
import { form16ClientRowKeyRepository } from "../storage/sqlite/form16ClientRowKeyRepository";

const log = createLogger("form16-client-row-key-cleanup");

// 跟 batch_create_row_keys 保留 14 天的節奏對齊
// 映射只需覆蓋「使用者會重送的時間窗」，保留太久對 dedup 也沒幫助
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CLEANUP_RETENTION_DAYS = 14;

let cleanupTimer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;

function resolveThresholdIso(): string {
  const threshold = new Date(Date.now() - CLEANUP_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  return threshold.toISOString();
}

async function runOnce(): Promise<void> {
  if (!env.SQLITE_ENABLED) return;
  const thresholdIso = resolveThresholdIso();
  const deleted = await form16ClientRowKeyRepository.cleanupOlderThan(thresholdIso);
  if (deleted > 0) {
    log.info({ event: "cleaned", deleted, thresholdIso });
  }
}

export function startForm16ClientRowKeyCleanup(): void {
  if (cleanupTimer || startupTimer) return;
  if (!env.SQLITE_ENABLED) return;

  startupTimer = setTimeout(() => {
    runBackgroundTask("form16-client-row-key-cleanup.startup", runOnce);
    startupTimer = null;
  }, 5 * 60 * 1000);
  startupTimer.unref();

  cleanupTimer = setInterval(() => {
    runBackgroundTask("form16-client-row-key-cleanup.interval", runOnce);
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
}

export function stopForm16ClientRowKeyCleanup(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

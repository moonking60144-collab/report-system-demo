import { env } from "../config/env";
import { runBackgroundTask } from "../infra/backgroundTaskRunner";
import { createLogger } from "../observability/logger";
import { batchCreateRowKeyRepository } from "../storage/sqlite/batchCreateRowKeyRepository";

const log = createLogger("batch-create-row-key-cleanup");

const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 小時跑一次
const CLEANUP_RETENTION_DAYS = 14; // 保留 14 天內的 idempotency 映射

let cleanupTimer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;

function resolveThresholdIso(): string {
  const threshold = new Date(Date.now() - CLEANUP_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  return threshold.toISOString();
}

async function runOnce(): Promise<void> {
  if (!env.SQLITE_ENABLED) return;
  const thresholdIso = resolveThresholdIso();
  const deleted = await batchCreateRowKeyRepository.cleanupOlderThan(thresholdIso);
  if (deleted > 0) {
    log.info({ event: "cleaned", deleted, thresholdIso });
  }
}

// 啟動後延遲 5 分鐘先跑一次避免與其他啟動任務搶 I/O，之後每 6 小時跑一次
export function startBatchCreateRowKeyCleanup(): void {
  if (cleanupTimer || startupTimer) return;
  if (!env.SQLITE_ENABLED) return;

  startupTimer = setTimeout(() => {
    runBackgroundTask("batch-create-row-key-cleanup.startup", runOnce);
    startupTimer = null;
  }, 5 * 60 * 1000);
  startupTimer.unref();

  cleanupTimer = setInterval(() => {
    runBackgroundTask("batch-create-row-key-cleanup.interval", runOnce);
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
}

export function stopBatchCreateRowKeyCleanup(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

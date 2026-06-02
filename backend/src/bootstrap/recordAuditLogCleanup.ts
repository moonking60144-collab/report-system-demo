import { env } from "../config/env";
import { runBackgroundTask } from "../infra/backgroundTaskRunner";
import { createLogger } from "../observability/logger";
import { recordAuditLogRepository } from "../storage/sqlite/recordAuditLogRepository";

const log = createLogger("record-audit-log-cleanup");

// 每天跑一次 cleanup；保留 1 年內的 audit，更舊的刪掉
// 1 年是工廠稽核的常見保留期；之後若要改 retention 就改這兩個常數
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_RETENTION_DAYS = 365;

let cleanupTimer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;

function resolveThresholdIso(): string {
  const threshold = new Date(Date.now() - CLEANUP_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  return threshold.toISOString();
}

async function runOnce(): Promise<void> {
  if (!env.SQLITE_ENABLED) return;
  const thresholdIso = resolveThresholdIso();
  const deleted = await recordAuditLogRepository.cleanupOlderThan(thresholdIso);
  if (deleted > 0) {
    log.info({ event: "cleaned", deleted, thresholdIso });
  }
}

// 啟動後延遲 10 分鐘先跑一次避免與其他啟動任務搶 I/O，之後每天跑一次
export function startRecordAuditLogCleanup(): void {
  if (cleanupTimer || startupTimer) return;
  if (!env.SQLITE_ENABLED) return;

  startupTimer = setTimeout(() => {
    runBackgroundTask("record-audit-log-cleanup.startup", runOnce);
    startupTimer = null;
  }, 10 * 60 * 1000);
  startupTimer.unref();

  cleanupTimer = setInterval(() => {
    runBackgroundTask("record-audit-log-cleanup.interval", runOnce);
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
}

export function stopRecordAuditLogCleanup(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

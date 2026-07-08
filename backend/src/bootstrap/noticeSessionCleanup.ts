import { noticeSessionsRepository } from "../storage/sqlite/noticeSessionsRepository";
import { createLogger } from "../observability/logger";
import { runBackgroundTask } from "../infra/backgroundTaskRunner";

const log = createLogger("notice-session-cleanup");
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_STARTUP_DELAY_MS = 60 * 1000;

let startupTimer: NodeJS.Timeout | null = null;
let cleanupTimer: NodeJS.Timeout | null = null;

async function runOnce(): Promise<void> {
  const deleted = await noticeSessionsRepository.deleteExpired(Date.now());
  if (deleted > 0) {
    log.info({ event: "done", deleted });
  }
}

export function startNoticeSessionCleanup(): void {
  if (cleanupTimer || startupTimer) return;
  startupTimer = setTimeout(() => {
    startupTimer = null;
    runBackgroundTask("notice-session-cleanup.startup", runOnce);
  }, CLEANUP_STARTUP_DELAY_MS);
  startupTimer.unref();

  cleanupTimer = setInterval(() => {
    runBackgroundTask("notice-session-cleanup.interval", runOnce);
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
}

export function stopNoticeSessionCleanup(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

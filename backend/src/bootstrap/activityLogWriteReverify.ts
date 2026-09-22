import { env } from "../config/env";
import { runBackgroundTask } from "../infra/backgroundTaskRunner";
import { createLogger } from "../observability/logger";
import { activityLogWriteReverifyService } from "../services/activityLog/activityLogWriteReverifyService";

const log = createLogger("activityLog-write-reverify-bootstrap");

let startupTimer: NodeJS.Timeout | null = null;
let intervalTimer: NodeJS.Timeout | null = null;

async function runOnce(): Promise<void> {
  if (!env.ACTIVITY_LOG_WRITE_REVERIFY_ENABLED) return;
  const stats = await activityLogWriteReverifyService.runOnce();
  if (stats.scanned > 0 || stats.failed > 0) {
    log.info({ event: "run-complete", ...stats });
  }
}

export function startActivityLogWriteReverify(): void {
  if (startupTimer || intervalTimer) return;
  if (!env.ACTIVITY_LOG_WRITE_REVERIFY_ENABLED) {
    log.info({ event: "disabled", reason: "ACTIVITY_LOG_WRITE_REVERIFY_ENABLED=false" });
    return;
  }

  void activityLogWriteReverifyService.initialize().catch((error) => {
    log.warn({
      event: "initialize-failed",
      error: error instanceof Error ? error.message : String(error),
    });
  });

  log.info({
    event: "enabled",
    intervalMs: env.ACTIVITY_LOG_WRITE_REVERIFY_INTERVAL_MS,
    startupDelayMs: env.ACTIVITY_LOG_WRITE_REVERIFY_STARTUP_DELAY_MS,
    maxPerRun: env.ACTIVITY_LOG_WRITE_REVERIFY_MAX_PER_RUN,
    maxAttempts: env.ACTIVITY_LOG_WRITE_REVERIFY_MAX_ATTEMPTS,
  });

  startupTimer = setTimeout(() => {
    runBackgroundTask("activityLog-write-reverify.startup", runOnce);
    startupTimer = null;
  }, env.ACTIVITY_LOG_WRITE_REVERIFY_STARTUP_DELAY_MS);
  startupTimer.unref();

  intervalTimer = setInterval(() => {
    runBackgroundTask("activityLog-write-reverify.interval", runOnce);
  }, env.ACTIVITY_LOG_WRITE_REVERIFY_INTERVAL_MS);
  intervalTimer.unref();
}

export function stopActivityLogWriteReverify(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
}

export async function flushActivityLogWriteReverify(): Promise<void> {
  await activityLogWriteReverifyService.flush();
}

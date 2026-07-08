import { env } from "../config/env";
import { runBackgroundTask } from "../infra/backgroundTaskRunner";
import { createLogger } from "../observability/logger";
import { form16WriteReverifyService } from "../services/form16/form16WriteReverifyService";

const log = createLogger("form16-write-reverify-bootstrap");

let startupTimer: NodeJS.Timeout | null = null;
let intervalTimer: NodeJS.Timeout | null = null;

async function runOnce(): Promise<void> {
  if (!env.FORM16_WRITE_REVERIFY_ENABLED) return;
  const stats = await form16WriteReverifyService.runOnce();
  if (stats.scanned > 0 || stats.failed > 0) {
    log.info({ event: "run-complete", ...stats });
  }
}

export function startForm16WriteReverify(): void {
  if (startupTimer || intervalTimer) return;
  if (!env.FORM16_WRITE_REVERIFY_ENABLED) {
    log.info({ event: "disabled", reason: "FORM16_WRITE_REVERIFY_ENABLED=false" });
    return;
  }

  void form16WriteReverifyService.initialize().catch((error) => {
    log.warn({
      event: "initialize-failed",
      error: error instanceof Error ? error.message : String(error),
    });
  });

  log.info({
    event: "enabled",
    intervalMs: env.FORM16_WRITE_REVERIFY_INTERVAL_MS,
    startupDelayMs: env.FORM16_WRITE_REVERIFY_STARTUP_DELAY_MS,
    maxPerRun: env.FORM16_WRITE_REVERIFY_MAX_PER_RUN,
    maxAttempts: env.FORM16_WRITE_REVERIFY_MAX_ATTEMPTS,
  });

  startupTimer = setTimeout(() => {
    runBackgroundTask("form16-write-reverify.startup", runOnce);
    startupTimer = null;
  }, env.FORM16_WRITE_REVERIFY_STARTUP_DELAY_MS);
  startupTimer.unref();

  intervalTimer = setInterval(() => {
    runBackgroundTask("form16-write-reverify.interval", runOnce);
  }, env.FORM16_WRITE_REVERIFY_INTERVAL_MS);
  intervalTimer.unref();
}

export function stopForm16WriteReverify(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
}

export async function flushForm16WriteReverify(): Promise<void> {
  await form16WriteReverifyService.flush();
}

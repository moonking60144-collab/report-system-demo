import { env } from "../config/env";
import { runBackgroundTask } from "../infra/backgroundTaskRunner";
import { createLogger } from "../observability/logger";
import { form16EfficiencyReportArchiveService } from "../services/form16/form16EfficiencyReportArchiveService";

const log = createLogger("efficiency-report-archive-cleanup");
let startupTimer: NodeJS.Timeout | null = null;
let cleanupTimer: NodeJS.Timeout | null = null;

async function runOnce(): Promise<void> {
  const result = await form16EfficiencyReportArchiveService.cleanupExpiredSnapshots();
  log.info({ event: result.dryRun ? "preview" : "completed", ...result });
}

export function startEfficiencyReportArchiveCleanup(): void {
  if (!env.EFFICIENCY_REPORT_CLEANUP_ENABLED || startupTimer || cleanupTimer) return;
  startupTimer = setTimeout(() => {
    startupTimer = null;
    runBackgroundTask("efficiency-report-archive-cleanup.startup", runOnce);
  }, env.EFFICIENCY_REPORT_CLEANUP_STARTUP_DELAY_MS);
  startupTimer.unref();

  cleanupTimer = setInterval(() => {
    runBackgroundTask("efficiency-report-archive-cleanup.interval", runOnce);
  }, env.EFFICIENCY_REPORT_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
}

export function stopEfficiencyReportArchiveCleanup(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

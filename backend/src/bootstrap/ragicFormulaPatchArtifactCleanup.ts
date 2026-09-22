import { cleanupRagicFormulaPatchArtifacts } from "../services/dev/ragicFormulaPatchApplyService";
import { createLogger } from "../observability/logger";
import { runBackgroundTask } from "../infra/backgroundTaskRunner";

const log = createLogger("ragic-formula-patch-artifact-cleanup");
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_STARTUP_DELAY_MS = 60 * 1000;

let startupTimer: NodeJS.Timeout | null = null;
let cleanupTimer: NodeJS.Timeout | null = null;

async function runOnce(): Promise<void> {
  const result = await cleanupRagicFormulaPatchArtifacts();
  log.info({
    event: "done",
    deletedBackupFiles: result.deletedBackupFiles,
    deletedRollbackSafetyFiles: result.deletedRollbackSafetyFiles,
    removedAuditLines: result.removedAuditLines,
    protectedBackupFiles: result.protectedBackupFiles,
  });
}

export function startRagicFormulaPatchArtifactCleanup(): void {
  if (cleanupTimer || startupTimer) return;
  startupTimer = setTimeout(() => {
    startupTimer = null;
    runBackgroundTask("ragic-formula-patch-artifact-cleanup.startup", runOnce);
  }, CLEANUP_STARTUP_DELAY_MS);
  startupTimer.unref();

  cleanupTimer = setInterval(() => {
    runBackgroundTask("ragic-formula-patch-artifact-cleanup.interval", runOnce);
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
}

export function stopRagicFormulaPatchArtifactCleanup(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

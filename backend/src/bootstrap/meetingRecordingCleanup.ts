import { env } from "../config/env";
import { runBackgroundTask } from "../infra/backgroundTaskRunner";
import { createLogger } from "../observability/logger";
import { meetingRecordingStorageService } from "../services/meeting-minutes/meetingRecordingStorageService";

const log = createLogger("meeting-recording-cleanup");
let startupTimer: NodeJS.Timeout | null = null;
let cleanupTimer: NodeJS.Timeout | null = null;

async function runOnce(): Promise<void> {
  const result = await meetingRecordingStorageService.cleanupStorage();
  log.info({ event: "completed", ...result });
}

export function startMeetingRecordingCleanup(): void {
  if (!env.MEETING_RECORDING_CLEANUP_ENABLED || startupTimer || cleanupTimer) return;
  startupTimer = setTimeout(() => {
    startupTimer = null;
    runBackgroundTask("meeting-recording-cleanup.startup", runOnce);
  }, env.MEETING_RECORDING_CLEANUP_STARTUP_DELAY_MS);
  startupTimer.unref();

  cleanupTimer = setInterval(() => {
    runBackgroundTask("meeting-recording-cleanup.interval", runOnce);
  }, env.MEETING_RECORDING_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
}

export function stopMeetingRecordingCleanup(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

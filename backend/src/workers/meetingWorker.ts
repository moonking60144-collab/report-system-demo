import { env } from "../config/env";
import { createLogger } from "../observability/logger";
import { meetingProcessingService } from "../services/meeting-minutes/meetingProcessingService";
import { meetingProcessingJobRepository } from "../storage/meeting-minutes/meetingProcessingJobRepository";
import { meetingTranscriptionService } from "../services/meeting-minutes/meetingTranscriptionService";
import { meetingTranscriptionJobRepository } from "../storage/meeting-minutes/meetingTranscriptionJobRepository";
import { meetingMinutesService } from "../services/meeting-minutes/meetingMinutesService";
import { meetingMinutesJobRepository } from "../storage/meeting-minutes/meetingMinutesJobRepository";
import { MeetingWorkerRuntime } from "./meetingWorkerRuntime";

const log = createLogger("meeting-worker-entry");

if (!env.MEETING_WORKER_ENABLED) {
  log.info({ event: "disabled" });
  process.exit(0);
}

const runtime = new MeetingWorkerRuntime({
  repository: meetingProcessingJobRepository,
  processingService: meetingProcessingService,
  transcriptionRepository: meetingTranscriptionJobRepository,
  transcriptionService: meetingTranscriptionService,
  minutesRepository: meetingMinutesJobRepository,
  minutesService: meetingMinutesService,
});

let shuttingDown = false;
async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ event: "shutdown", signal });
  try {
    await runtime.stop();
    process.exit(exitCode);
  } catch (error) {
    log.error({
      event: "shutdown-failed",
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT", 0));
process.on("SIGTERM", () => void shutdown("SIGTERM", 0));

runtime.start().catch((error) => {
  log.fatal({
    event: "startup-failed",
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});

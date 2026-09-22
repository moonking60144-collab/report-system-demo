import { createLogger } from "../observability/logger";

const log = createLogger("ragic-startup-job");

export interface RagicStartupJobHandle {
  stop(): void;
}

export interface ScheduleRagicStartupJobOptions {
  jobLabel: string;
  scheduledLogLabel: string;
  scheduledLogPayload: Record<string, unknown>;
  startupDelayMs: number;
  intervalMs?: number;
  run: () => Promise<void> | void;
  onError?: (error: unknown) => Promise<void> | void;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function scheduleRagicStartupJob(
  options: ScheduleRagicStartupJobOptions
): RagicStartupJobHandle {
  let startupTimer: NodeJS.Timeout | null = null;
  let intervalTimer: NodeJS.Timeout | null = null;
  let stopped = false;

  const runOnce = () => {
    void Promise.resolve()
      .then(() => options.run())
      .catch(async (error) => {
        if (options.onError) {
          try {
            await options.onError(error);
          } catch (handlerError) {
            log.error({
              event: "onError.failed",
              jobLabel: options.jobLabel,
              originalError: getErrorMessage(error),
              handlerError: getErrorMessage(handlerError),
            });
          }
          return;
        }
        log.warn({
          event: "failed",
          jobLabel: options.jobLabel,
          error: getErrorMessage(error),
        });
      });
  };

  const start = () => {
    if (stopped) {
      return;
    }
    startupTimer = null;
    runOnce();
    if (typeof options.intervalMs === "number" && options.intervalMs > 0) {
      intervalTimer = setInterval(runOnce, options.intervalMs);
      intervalTimer.unref?.();
    }
  };

  console.info(options.scheduledLogLabel, options.scheduledLogPayload);

  if (options.startupDelayMs <= 0) {
    start();
  } else {
    startupTimer = setTimeout(start, options.startupDelayMs);
    startupTimer.unref?.();
  }

  return {
    stop(): void {
      stopped = true;
      if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = null;
      }
      if (intervalTimer) {
        clearInterval(intervalTimer);
        intervalTimer = null;
      }
    },
  };
}

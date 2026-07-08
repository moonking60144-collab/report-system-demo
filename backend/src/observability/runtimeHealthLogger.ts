import { monitorEventLoopDelay } from "perf_hooks";
import { env } from "../config/env";
import { ragicRequestScheduler } from "../infra/ragicRequestScheduler";
import { createReportTaskService } from "../services/createReportTaskService";
import { form16WriteReverifyService } from "../services/form16/form16WriteReverifyService";
import { createLogger } from "./logger";

const log = createLogger("runtime-health");

let runtimeHealthTimer: NodeJS.Timeout | null = null;
let eventLoopHistogram: ReturnType<typeof monitorEventLoopDelay> | null = null;

function toMs(nanoseconds: number): number {
  if (!Number.isFinite(nanoseconds)) {
    return 0;
  }
  return Number((nanoseconds / 1_000_000).toFixed(2));
}

export function startRuntimeHealthLogger(): void {
  if (!env.RUNTIME_HEALTH_LOG_ENABLED) {
    return;
  }
  if (runtimeHealthTimer) {
    return;
  }

  eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
  eventLoopHistogram.enable();

  const logIntervalMs = Math.max(5000, env.RUNTIME_HEALTH_LOG_INTERVAL_MS);
  const emitRuntimeHealth = (): void => {
    const ragic = ragicRequestScheduler.getStats();
    const tasks = createReportTaskService.getStats();
    const form16WriteReverify = form16WriteReverifyService.getStats();
    const lag = eventLoopHistogram;

    log.info({
      event: "sample",
      at: new Date().toISOString(),
      ragic,
      createTasks: tasks,
      form16WriteReverify,
      eventLoopLagMs: {
        mean: lag ? toMs(lag.mean) : 0,
        p95: lag ? toMs(lag.percentile(95)) : 0,
        max: lag ? toMs(lag.max) : 0,
      },
    });

    lag?.reset();
  };

  runtimeHealthTimer = setInterval(emitRuntimeHealth, logIntervalMs);
  runtimeHealthTimer.unref?.();
}

export function stopRuntimeHealthLogger(): void {
  if (runtimeHealthTimer) {
    clearInterval(runtimeHealthTimer);
    runtimeHealthTimer = null;
  }
  if (eventLoopHistogram) {
    eventLoopHistogram.disable();
    eventLoopHistogram = null;
  }
}

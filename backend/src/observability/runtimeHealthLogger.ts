import { monitorEventLoopDelay } from "node:perf_hooks";
import { env } from "../config/env";
import { ragicRequestScheduler } from "../infra/ragicRequestScheduler";
import { createReportTaskService } from "../services/createReportTaskService";
import { form16WriteReverifyService } from "../services/form16/form16WriteReverifyService";
import { getWorkReportEntryMutationQueueHealthStats } from "../services/work-report/workReportEntryMutationQueue";
import { meetingMinutesJobRepository } from "../storage/meeting-minutes/meetingMinutesJobRepository";
import type { MeetingJobQueueHealthStats } from "../storage/meeting-minutes/meetingJobQueueHealth";
import { meetingProcessingJobRepository } from "../storage/meeting-minutes/meetingProcessingJobRepository";
import { meetingTranscriptionJobRepository } from "../storage/meeting-minutes/meetingTranscriptionJobRepository";
import { createLogger } from "./logger";

const log = createLogger("runtime-health");

interface EventLoopLagStats {
  mean: number;
  p95: number;
  max: number;
}

interface RuntimeMemoryStats {
  rssBytes: number;
  heapTotalBytes: number;
  heapUsedBytes: number;
  heapUsedRatio: number;
  externalBytes: number;
  arrayBuffersBytes: number;
}

interface MeetingJobHealthStats {
  processing: MeetingJobQueueHealthStats;
  transcription: MeetingJobQueueHealthStats;
  minutes: MeetingJobQueueHealthStats;
}

export interface RuntimeHealthSnapshot {
  at: string;
  ragic: ReturnType<typeof ragicRequestScheduler.getStats>;
  createTasks: ReturnType<typeof createReportTaskService.getStats>;
  form16WriteReverify: ReturnType<typeof form16WriteReverifyService.getStats>;
  workReportMutationQueue: ReturnType<typeof getWorkReportEntryMutationQueueHealthStats>;
  meetingJobs: MeetingJobHealthStats | null;
  memory: RuntimeMemoryStats;
  eventLoopLagMs: EventLoopLagStats;
  warnings: string[];
}

interface RuntimeHealthCollectorDeps {
  now?: () => Date;
  getRagicStats?: () => ReturnType<typeof ragicRequestScheduler.getStats>;
  getCreateTaskStats?: () => ReturnType<typeof createReportTaskService.getStats>;
  getForm16WriteReverifyStats?: () => ReturnType<typeof form16WriteReverifyService.getStats>;
  getMutationQueueStats?: () => ReturnType<typeof getWorkReportEntryMutationQueueHealthStats>;
  getMeetingJobStats?: () => Promise<MeetingJobHealthStats>;
  getMemoryUsage?: () => NodeJS.MemoryUsage;
  getEventLoopLagStats?: () => EventLoopLagStats;
}

let runtimeHealthTimer: NodeJS.Timeout | null = null;
let eventLoopHistogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
let latestRuntimeHealthSnapshot: RuntimeHealthSnapshot | null = null;
let sampleInProgress = false;

function toMs(nanoseconds: number): number {
  if (!Number.isFinite(nanoseconds)) {
    return 0;
  }
  return Number((nanoseconds / 1_000_000).toFixed(2));
}

function readEventLoopLagStats(): EventLoopLagStats {
  const lag = eventLoopHistogram;
  return {
    mean: lag ? toMs(lag.mean) : 0,
    p95: lag ? toMs(lag.percentile(95)) : 0,
    max: lag ? toMs(lag.max) : 0,
  };
}

async function readMeetingJobStats(): Promise<MeetingJobHealthStats> {
  const [processing, transcription, minutes] = await Promise.all([
    meetingProcessingJobRepository.getQueueHealthStats(),
    meetingTranscriptionJobRepository.getQueueHealthStats(),
    meetingMinutesJobRepository.getQueueHealthStats(),
  ]);
  return { processing, transcription, minutes };
}

function resolveWarnings(input: {
  eventLoopLagMs: EventLoopLagStats;
  memory: RuntimeMemoryStats;
  mutationQueue: ReturnType<typeof getWorkReportEntryMutationQueueHealthStats>;
  meetingJobs: MeetingJobHealthStats | null;
}): string[] {
  const warnings: string[] = [];
  if (input.eventLoopLagMs.p95 >= env.RUNTIME_HEALTH_EVENT_LOOP_P95_WARN_MS) {
    warnings.push("EVENT_LOOP_LAG_HIGH");
  }
  if (input.memory.heapUsedRatio >= 0.85) {
    warnings.push("HEAP_USAGE_HIGH");
  }
  if (
    input.mutationQueue.pendingTaskCount >=
      Math.ceil(input.mutationQueue.maxPendingTaskCount * 0.8) ||
    input.mutationQueue.highestPendingTaskCountPerKey >=
      Math.ceil(input.mutationQueue.maxPendingTaskCountPerKey * 0.8) ||
    input.mutationQueue.oldestPendingTaskAgeMs >=
      input.mutationQueue.maxOldestPendingTaskAgeMs
  ) {
    warnings.push("WORK_REPORT_MUTATION_QUEUE_PRESSURE");
  }
  if (!input.meetingJobs) {
    warnings.push("MEETING_JOB_HEALTH_UNAVAILABLE");
  } else if (
    Object.values(input.meetingJobs).some(
      (stats) =>
        stats.pending > 0 &&
        stats.oldestPendingAgeMs >= env.RUNTIME_HEALTH_MEETING_PENDING_WARN_MS
    )
  ) {
    warnings.push("MEETING_JOB_BACKLOG_OLD");
  }
  return warnings;
}

export async function collectRuntimeHealthSnapshot(
  deps: RuntimeHealthCollectorDeps = {}
): Promise<RuntimeHealthSnapshot> {
  const memoryUsage = (deps.getMemoryUsage ?? process.memoryUsage)();
  const memory: RuntimeMemoryStats = {
    rssBytes: memoryUsage.rss,
    heapTotalBytes: memoryUsage.heapTotal,
    heapUsedBytes: memoryUsage.heapUsed,
    heapUsedRatio:
      memoryUsage.heapTotal > 0
        ? Number((memoryUsage.heapUsed / memoryUsage.heapTotal).toFixed(4))
        : 0,
    externalBytes: memoryUsage.external,
    arrayBuffersBytes: memoryUsage.arrayBuffers,
  };
  const eventLoopLagMs = (deps.getEventLoopLagStats ?? readEventLoopLagStats)();
  const workReportMutationQueue = (
    deps.getMutationQueueStats ?? getWorkReportEntryMutationQueueHealthStats
  )();
  let meetingJobs: MeetingJobHealthStats | null = null;
  try {
    meetingJobs = await (deps.getMeetingJobStats ?? readMeetingJobStats)();
  } catch {
    meetingJobs = null;
  }

  return {
    at: (deps.now?.() ?? new Date()).toISOString(),
    ragic: (deps.getRagicStats ?? (() => ragicRequestScheduler.getStats()))(),
    createTasks: (
      deps.getCreateTaskStats ?? (() => createReportTaskService.getStats())
    )(),
    form16WriteReverify: (
      deps.getForm16WriteReverifyStats ??
      (() => form16WriteReverifyService.getStats())
    )(),
    workReportMutationQueue,
    meetingJobs,
    memory,
    eventLoopLagMs,
    warnings: resolveWarnings({
      eventLoopLagMs,
      memory,
      mutationQueue: workReportMutationQueue,
      meetingJobs,
    }),
  };
}

export function getRuntimeHealthSnapshot(): RuntimeHealthSnapshot | null {
  return latestRuntimeHealthSnapshot;
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

  const emitRuntimeHealth = async (): Promise<void> => {
    if (sampleInProgress) return;
    sampleInProgress = true;
    try {
      const snapshot = await collectRuntimeHealthSnapshot();
      latestRuntimeHealthSnapshot = snapshot;
      if (env.RUNTIME_HEALTH_LOG_ENABLED) {
        if (snapshot.warnings.length > 0) {
          log.warn({ event: "sample", ...snapshot });
        } else {
          log.info({ event: "sample", ...snapshot });
        }
      }
    } catch (error) {
      log.warn({
        event: "sample-failed",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      eventLoopHistogram?.reset();
      sampleInProgress = false;
    }
  };

  runtimeHealthTimer = setInterval(
    () => void emitRuntimeHealth(),
    Math.max(5000, env.RUNTIME_HEALTH_LOG_INTERVAL_MS)
  );
  runtimeHealthTimer.unref();
  void emitRuntimeHealth();
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
  sampleInProgress = false;
}

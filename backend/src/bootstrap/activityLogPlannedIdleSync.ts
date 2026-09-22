import { env } from "../config/env";
import { activityLogDowntimeService } from "../services/activityLog/activityLogDowntimeService";
import {
  scheduleRagicStartupJob,
  type RagicStartupJobHandle,
} from "./ragicStartupJobScheduler";

let plannedIdleSyncJob: RagicStartupJobHandle | null = null;

async function runCycle(): Promise<void> {
  try {
    const { total } = await activityLogDowntimeService.syncPlannedIdleHalfYear();
    console.info("[planned-idle-sync-done]", { total });
  } catch (error) {
    console.warn("[planned-idle-sync-failed]", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// 背景定時把近半年 (P)計畫停機分同步進 SQLite，讓統計圖表查 SQLite 秒回（不再每次切月撈 7~19 秒）。
export function startActivityLogPlannedIdleSync(): void {
  if (!env.SQLITE_ENABLED || !env.ACTIVITY_LOG_PLANNED_IDLE_SYNC_ENABLED) {
    return;
  }
  if (plannedIdleSyncJob) {
    return;
  }

  plannedIdleSyncJob = scheduleRagicStartupJob({
    jobLabel: "planned-idle-sync",
    scheduledLogLabel: "[planned-idle-sync-scheduled]",
    scheduledLogPayload: {
      intervalMs: env.ACTIVITY_LOG_PLANNED_IDLE_SYNC_INTERVAL_MS,
      startupDelayMs: env.ACTIVITY_LOG_PLANNED_IDLE_SYNC_STARTUP_DELAY_MS,
    },
    startupDelayMs: env.ACTIVITY_LOG_PLANNED_IDLE_SYNC_STARTUP_DELAY_MS,
    intervalMs: env.ACTIVITY_LOG_PLANNED_IDLE_SYNC_INTERVAL_MS,
    run: runCycle,
  });
}

export function stopActivityLogPlannedIdleSync(): void {
  plannedIdleSyncJob?.stop();
  plannedIdleSyncJob = null;
}

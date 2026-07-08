import { env } from "../config/env";
import { form16DowntimeService } from "../services/form16/form16DowntimeService";
import {
  scheduleRagicStartupJob,
  type RagicStartupJobHandle,
} from "./ragicStartupJobScheduler";

let plannedIdleSyncJob: RagicStartupJobHandle | null = null;

async function runCycle(): Promise<void> {
  try {
    const { total } = await form16DowntimeService.syncPlannedIdleHalfYear();
    console.info("[planned-idle-sync-done]", { total });
  } catch (error) {
    console.warn("[planned-idle-sync-failed]", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// 背景定時把近半年 (P)計畫停機分同步進 SQLite，讓統計圖表查 SQLite 秒回（不再每次切月撈 7~19 秒）。
export function startForm16PlannedIdleSync(): void {
  if (!env.SQLITE_ENABLED || !env.FORM16_PLANNED_IDLE_SYNC_ENABLED) {
    return;
  }
  if (plannedIdleSyncJob) {
    return;
  }

  plannedIdleSyncJob = scheduleRagicStartupJob({
    jobLabel: "planned-idle-sync",
    scheduledLogLabel: "[planned-idle-sync-scheduled]",
    scheduledLogPayload: {
      intervalMs: env.FORM16_PLANNED_IDLE_SYNC_INTERVAL_MS,
      startupDelayMs: env.FORM16_PLANNED_IDLE_SYNC_STARTUP_DELAY_MS,
    },
    startupDelayMs: env.FORM16_PLANNED_IDLE_SYNC_STARTUP_DELAY_MS,
    intervalMs: env.FORM16_PLANNED_IDLE_SYNC_INTERVAL_MS,
    run: runCycle,
  });
}

export function stopForm16PlannedIdleSync(): void {
  plannedIdleSyncJob?.stop();
  plannedIdleSyncJob = null;
}

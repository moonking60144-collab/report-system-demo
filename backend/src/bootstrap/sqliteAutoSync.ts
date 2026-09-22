import { env, shouldUseSqliteReadForForm } from "../config/env";
import { activityLogDowntimeService } from "../services/activityLog/activityLogDowntimeService";
import { workReportSyncService } from "../services/work-report-sync/workReportSyncService";
import { withSqliteAutoSyncActivity } from "../services/work-report-sync/sqliteAutoSyncStatus";

let autoSyncIntervalTimer: NodeJS.Timeout | null = null;
let autoSyncStartupTimer: NodeJS.Timeout | null = null;
let autoSyncCyclePromise: Promise<void> | null = null;

function shouldAutoSyncActivityLog(): boolean {
  return env.SQLITE_ENABLED && env.ACTIVITY_LOG_SQLITE_AUTO_SYNC_ENABLED;
}

function resolveAutoSyncForms(): string[] {
  const preferredForms =
    env.SQLITE_AUTO_SYNC_FORMS.length > 0 ? env.SQLITE_AUTO_SYNC_FORMS : env.SQLITE_READ_FORMS;

  return preferredForms
    .map((formId) => String(formId).trim())
    .filter((formId, index, list) => {
      if (!formId) {
        return false;
      }
      if (!shouldUseSqliteReadForForm(formId)) {
        return false;
      }
      return list.indexOf(formId) === index;
    });
}

async function runAutoSyncCycle(forms: string[]): Promise<void> {
  for (const formId of forms) {
    if (workReportSyncService.shouldDeferAutoSyncForMutation()) {
      console.info("[sqlite-auto-sync-skipped]", {
        formId,
        reason: "work-report-mutation-pending",
      });
      continue;
    }
    try {
      const task = await withSqliteAutoSyncActivity(formId, () => workReportSyncService.requestSync(formId, {
        triggeredBy: "auto-schedule",
        waitForCompletion: true,
      }));
      console.info("[sqlite-auto-sync-triggered]", {
        formId,
        taskId: task.taskId,
        accepted: task.accepted,
        status: task.status,
      });
    } catch (error) {
      console.warn("[sqlite-auto-sync-failed]", {
        formId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (
    shouldAutoSyncActivityLog() &&
    workReportSyncService.shouldDeferAutoSyncForMutation()
  ) {
    console.info("[sqlite-auto-sync-skipped]", {
      formId: "903",
      reason: "work-report-mutation-pending",
    });
  } else if (shouldAutoSyncActivityLog()) {
    const snapshotState = await activityLogDowntimeService.checkSnapshotStaleness();
    if (snapshotState.isStale) {
      try {
        const records = await withSqliteAutoSyncActivity("903", () => activityLogDowntimeService.refreshSqliteSnapshotFromRagic({
          yieldToMutation: true,
        }));
        console.info("[sqlite-auto-sync-triggered]", {
          formId: "903",
          count: records.length,
          source: "activityLog-downtime",
        });
      } catch (error) {
        console.warn("[sqlite-auto-sync-failed]", {
          formId: "903",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      console.info("[sqlite-auto-sync-skipped]", {
        formId: "903",
        reason: "snapshot-still-fresh",
      });
    }
  }
}

export function startSqliteAutoSync(): void {
  if (!env.SQLITE_AUTO_SYNC_ENABLED) {
    return;
  }
  if (autoSyncIntervalTimer || autoSyncStartupTimer) {
    return;
  }

  const forms = resolveAutoSyncForms();
  const includeActivityLog = shouldAutoSyncActivityLog();
  if (forms.length === 0 && !includeActivityLog) {
    console.info("[sqlite-auto-sync-skipped]", {
      reason: "no-readable-sqlite-forms",
    });
    return;
  }

  const scheduleCycle = () => {
    if (autoSyncCyclePromise) {
      console.info("[sqlite-auto-sync-skipped]", {
        reason: "previous-cycle-running",
      });
      return;
    }

    autoSyncCyclePromise = runAutoSyncCycle(forms)
      .catch((error) => {
        // runAutoSyncCycle 內已逐 form try/catch，但 activityLog staleness 檢查等
        // 仍可能 reject 整個 cycle；補一層保險避免變成 unhandledRejection
        console.warn("[sqlite-auto-sync-cycle-failed]", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        autoSyncCyclePromise = null;
      });
  };

  autoSyncStartupTimer = setTimeout(() => {
    autoSyncStartupTimer = null;
    scheduleCycle();
    autoSyncIntervalTimer = setInterval(scheduleCycle, env.SQLITE_AUTO_SYNC_INTERVAL_MS);
    autoSyncIntervalTimer.unref?.();
  }, env.SQLITE_AUTO_SYNC_STARTUP_DELAY_MS);
  autoSyncStartupTimer.unref?.();

  console.info("[sqlite-auto-sync-scheduled]", {
    forms,
    includeActivityLog,
    intervalMs: env.SQLITE_AUTO_SYNC_INTERVAL_MS,
    startupDelayMs: env.SQLITE_AUTO_SYNC_STARTUP_DELAY_MS,
  });
}

export function stopSqliteAutoSync(): void {
  if (autoSyncStartupTimer) {
    clearTimeout(autoSyncStartupTimer);
    autoSyncStartupTimer = null;
  }

  if (autoSyncIntervalTimer) {
    clearInterval(autoSyncIntervalTimer);
    autoSyncIntervalTimer = null;
  }
}

import { env, shouldUseSqliteReadForForm } from "../config/env";
import { form16DowntimeService } from "../services/form16/form16DowntimeService";
import { workReportSyncService } from "../services/work-report-sync/workReportSyncService";

let autoSyncIntervalTimer: NodeJS.Timeout | null = null;
let autoSyncStartupTimer: NodeJS.Timeout | null = null;

function shouldAutoSyncForm16(): boolean {
  return env.SQLITE_ENABLED && env.FORM16_SQLITE_AUTO_SYNC_ENABLED;
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
    try {
      const task = await workReportSyncService.requestSync(formId, {
        triggeredBy: "auto-schedule",
        waitForCompletion: false,
      });
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

  if (shouldAutoSyncForm16()) {
    const snapshotState = await form16DowntimeService.checkSnapshotStaleness();
    if (snapshotState.isStale) {
      // 跟 104/105 一樣 fire-and-forget，不阻塞 auto-sync cycle
      void form16DowntimeService.refreshSqliteSnapshotFromRagic()
        .then((records) => {
          console.info("[sqlite-auto-sync-triggered]", {
            formId: "16",
            count: records.length,
            source: "form16-downtime",
          });
        })
        .catch((error) => {
          console.warn("[sqlite-auto-sync-failed]", {
            formId: "16",
            error: error instanceof Error ? error.message : String(error),
          });
        });
    } else {
      console.info("[sqlite-auto-sync-skipped]", {
        formId: "16",
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
  const includeForm16 = shouldAutoSyncForm16();
  if (forms.length === 0 && !includeForm16) {
    console.info("[sqlite-auto-sync-skipped]", {
      reason: "no-readable-sqlite-forms",
    });
    return;
  }

  const scheduleCycle = () => {
    void runAutoSyncCycle(forms);
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
    includeForm16,
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

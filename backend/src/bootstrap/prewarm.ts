import { env, shouldUseSqliteReadForForm } from "../config/env";
import { workReportReadService } from "../services/work-report/workReportReadService";
import {
  scheduleRagicStartupJob,
  type RagicStartupJobHandle,
} from "./ragicStartupJobScheduler";

const optionsPrewarmFormIds = ["104", "105"] as const;
const optionsPrewarmTargetFields = ["machineId", "operatorId", "processCode"];

let optionsPrewarmJob: RagicStartupJobHandle | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function prewarmReportFullCacheOnStartup(): void {
  const prewarmFormId = "104";
  if (!env.REPORT_FULL_CACHE_PREWARM_ON_START) {
    console.info("[full-cache-prewarm-skipped]", {
      formId: prewarmFormId,
      reason: "disabled-by-env",
    });
    return;
  }
  if (shouldUseSqliteReadForForm(prewarmFormId)) {
    console.info("[full-cache-prewarm-skipped]", {
      formId: prewarmFormId,
      reason: "sqlite-primary-read-model",
    });
    return;
  }

  const triggered = workReportReadService.prewarmFullReports(prewarmFormId);
  console.info(triggered ? "[full-cache-prewarm-triggered]" : "[full-cache-prewarm-skipped]", {
    formId: prewarmFormId,
    reason: env.REPORT_FULL_CACHE_ENABLED ? "already-building" : "cache-disabled",
  });
}

/**
 * 啟動後背景預熱 options cache，避免使用者第一次進頁面時才讀 linked options。
 * 預熱 104/105 的 machineId / operatorId / processCode 選項（含 linked source form 資料）
 */
export function prewarmFormOptionsOnStartup(): void {
  if (optionsPrewarmJob) {
    return;
  }

  const startupDelayMs = env.WORK_REPORT_OPTIONS_PREWARM_STARTUP_DELAY_MS;
  const betweenFormsDelayMs = env.WORK_REPORT_OPTIONS_PREWARM_BETWEEN_FORMS_DELAY_MS;

  optionsPrewarmJob = scheduleRagicStartupJob({
    jobLabel: "options-prewarm",
    scheduledLogLabel: "[options-prewarm-scheduled]",
    scheduledLogPayload: {
      forms: [...optionsPrewarmFormIds],
      targetFields: optionsPrewarmTargetFields,
      startupDelayMs,
      betweenFormsDelayMs,
    },
    startupDelayMs,
    run: () => runFormOptionsPrewarmSequence(betweenFormsDelayMs),
  });
}

export function stopFormOptionsPrewarm(): void {
  optionsPrewarmJob?.stop();
  optionsPrewarmJob = null;
}

async function runFormOptionsPrewarmSequence(betweenFormsDelayMs: number): Promise<void> {
  let isFirst = true;
  for (const formId of optionsPrewarmFormIds) {
    if (!isFirst && betweenFormsDelayMs > 0) {
      await sleep(betweenFormsDelayMs);
    }
    isFirst = false;

    try {
      await workReportReadService.getFormOptions(
        formId,
        optionsPrewarmTargetFields,
        "background"
      );
      console.info("[options-prewarm-done]", { formId });
    } catch (error) {
      console.warn("[options-prewarm-failed]", {
        formId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

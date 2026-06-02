import { env, shouldUseSqliteReadForForm } from "../config/env";
import { runBackgroundTask } from "../infra/backgroundTaskRunner";
import { workReportReadService } from "../services/work-report/workReportReadService";

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
 * 啟動後背景預熱 options cache，避免使用者第一次進頁面時撞到 auto-sync 搶 concurrency
 * 預熱 104/105 的 machineId / operatorId / processCode 選項（含 linked source form 資料）
 */
export function prewarmFormOptionsOnStartup(): void {
  const targetFields = ["machineId", "operatorId", "processCode"];
  for (const formId of ["104", "105"]) {
    runBackgroundTask(
      `prewarm-options:${formId}`,
      async () => {
        // 啟動 prewarm 是背景任務，明確走 background lane 避免污染 user lane circuit breaker
        await workReportReadService.getFormOptions(formId, targetFields, "background");
        console.info("[options-prewarm-done]", { formId });
      },
      (error) => {
        console.warn("[options-prewarm-failed]", {
          formId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    );
  }
}

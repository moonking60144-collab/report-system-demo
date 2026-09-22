import { env } from "../config/env";

type WorkReportDebugLevel = "info" | "warn" | "error";

export interface WorkReportDebugMeta {
  [key: string]: unknown;
}

export function workReportDebugLog(
  scope: string,
  action: string,
  meta: WorkReportDebugMeta = {},
  level: WorkReportDebugLevel = "info"
): void {
  if (!env.WORK_REPORT_DEBUG_LOG_ENABLED) {
    return;
  }

  const payload = {
    scope,
    action,
    at: new Date().toISOString(),
    ...meta,
  };

  if (level === "error") {
    console.error("[work-report-debug]", payload);
    return;
  }
  if (level === "warn") {
    console.warn("[work-report-debug]", payload);
    return;
  }
  console.info("[work-report-debug]", payload);
}

import type { CreateReportTaskStatus } from "../../../api/workReport";
import type { UiLanguage } from "../types";
import { translateCreateTaskStatusValue } from "../../../i18n/valueMappers";

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function formatStatusDateTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return "--";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }

  return new Intl.DateTimeFormat("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

export function getCreateTaskStatusText(
  status: CreateReportTaskStatus,
  uiLanguage: UiLanguage = "zh",
  t?: TranslateFn
): string {
  if (t) {
    return translateCreateTaskStatusValue(status, t);
  }
  if (uiLanguage === "en") {
    if (status === "pending") {
      return "Queued";
    }
    if (status === "running") {
      return "Running";
    }
    if (status === "success") {
      return "Done";
    }
    return "Failed";
  }
  if (status === "pending") {
    return "排隊中";
  }
  if (status === "running") {
    return "處理中";
  }
  if (status === "success") {
    return "完成";
  }
  return "失敗";
}

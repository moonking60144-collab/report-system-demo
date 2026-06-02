import type { WorkReportRecord } from "../../../api/workReport";
import {
  FORM_ID,
  HYDRATION_CACHE_TTL_MS,
  HYDRATION_CACHE_VERSION,
  WORK_REPORT_COLUMN_MODE_STORAGE_KEY,
} from "../constants";
import type {
  ColumnDisplayMode,
  ColumnKey,
  ColumnWidthOverrides,
  HydrationCachePayload,
  HydrationCacheWriteJob,
} from "../types";
import { dedupeRecordsById } from "./recordUtils";

const hydrationCacheWriteTimers = new Map<string, number>();

export function getHydrationCacheKey(formId: string = FORM_ID): string {
  return `work-reports:${formId}:global-cache:${HYDRATION_CACHE_VERSION}`;
}

export function readHydrationCache(formId: string = FORM_ID): WorkReportRecord[] | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(getHydrationCacheKey(formId));
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<HydrationCachePayload>;
    if (
      parsed.version !== HYDRATION_CACHE_VERSION ||
      parsed.formId !== formId ||
      typeof parsed.hydratedAt !== "number" ||
      !Array.isArray(parsed.records)
    ) {
      window.localStorage.removeItem(getHydrationCacheKey(formId));
      return null;
    }

    if (Date.now() - parsed.hydratedAt > HYDRATION_CACHE_TTL_MS) {
      window.localStorage.removeItem(getHydrationCacheKey(formId));
      return null;
    }

    return dedupeRecordsById(parsed.records as WorkReportRecord[]);
  } catch {
    return null;
  }
}

export function writeHydrationCache(formId: string = FORM_ID, records: WorkReportRecord[]): void {
  if (typeof window === "undefined") {
    return;
  }

  const payload: HydrationCachePayload = {
    version: HYDRATION_CACHE_VERSION,
    formId,
    records: dedupeRecordsById(records),
    hydratedAt: Date.now(),
  };

  try {
    window.localStorage.setItem(getHydrationCacheKey(formId), JSON.stringify(payload));
  } catch {
    // NOTE: 儲存空間不足或隱私模式限制時，直接略過快取，不阻斷功能。
  }
}

export function scheduleHydrationCacheWrite(
  job: HydrationCacheWriteJob,
  delayMs = 600
): void {
  if (typeof window === "undefined") {
    return;
  }

  const key = job.formId;
  const existingTimer = hydrationCacheWriteTimers.get(key);
  if (existingTimer !== undefined) {
    window.clearTimeout(existingTimer);
  }

  const timer = window.setTimeout(() => {
    hydrationCacheWriteTimers.delete(key);
    writeHydrationCache(job.formId, job.records);
  }, Math.max(0, delayMs));
  hydrationCacheWriteTimers.set(key, timer);
}

export function clearScheduledHydrationCacheWrite(formId: string = FORM_ID): void {
  if (typeof window === "undefined") {
    return;
  }

  const existingTimer = hydrationCacheWriteTimers.get(formId);
  if (existingTimer === undefined) {
    return;
  }
  window.clearTimeout(existingTimer);
  hydrationCacheWriteTimers.delete(formId);
}

export function clearHydrationCache(formId: string = FORM_ID): void {
  if (typeof window === "undefined") {
    return;
  }

  clearScheduledHydrationCacheWrite(formId);
  try {
    window.localStorage.removeItem(getHydrationCacheKey(formId));
  } catch {
    // NOTE: localStorage 清除失敗時不阻塞主流程
  }
}

export function readColumnDisplayMode(): ColumnDisplayMode {
  if (typeof window === "undefined") {
    return "compact";
  }

  try {
    const raw = String(
      window.localStorage.getItem(WORK_REPORT_COLUMN_MODE_STORAGE_KEY) ?? ""
    ).trim();
    if (raw === "full" || raw === "fit" || raw === "compact") {
      return raw;
    }
    return "compact";
  } catch {
    return "compact";
  }
}

export function writeColumnDisplayMode(mode: ColumnDisplayMode): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(WORK_REPORT_COLUMN_MODE_STORAGE_KEY, mode);
  } catch {
    // NOTE: localStorage 寫入失敗時不阻塞主流程
  }
}

function getColumnWidthOverridesStorageKey(
  formId: string,
  mode: ColumnDisplayMode
): string {
  return `work-report:${formId}:column-widths:${mode}:v1`;
}

function getHiddenColumnsStorageKey(formId: string, mode: ColumnDisplayMode): string {
  return `work-report:${formId}:hidden-columns:${mode}:v1`;
}

export function readColumnWidthOverrides(
  formId: string,
  mode: ColumnDisplayMode
): ColumnWidthOverrides {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const raw = String(
      window.localStorage.getItem(getColumnWidthOverridesStorageKey(formId, mode)) ?? ""
    ).trim();
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => {
        return typeof value === "number" && Number.isFinite(value) && value >= 48;
      })
    ) as ColumnWidthOverrides;
  } catch {
    return {};
  }
}

export function writeColumnWidthOverrides(
  formId: string,
  mode: ColumnDisplayMode,
  overrides: ColumnWidthOverrides
): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const entries = Object.entries(overrides).filter(([, value]) => {
      return typeof value === "number" && Number.isFinite(value) && value >= 48;
    });
    if (entries.length === 0) {
      window.localStorage.removeItem(getColumnWidthOverridesStorageKey(formId, mode));
      return;
    }
    window.localStorage.setItem(
      getColumnWidthOverridesStorageKey(formId, mode),
      JSON.stringify(Object.fromEntries(entries))
    );
  } catch {
    // NOTE: localStorage 寫入失敗時不阻塞主流程
  }
}

export function readHiddenColumns(
  formId: string,
  mode: ColumnDisplayMode
): ColumnKey[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = String(window.localStorage.getItem(getHiddenColumnsStorageKey(formId, mode)) ?? "").trim();
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((value): value is ColumnKey => typeof value === "string" && value.trim().length > 0);
  } catch {
    return [];
  }
}

export function writeHiddenColumns(
  formId: string,
  mode: ColumnDisplayMode,
  hiddenColumnKeys: ColumnKey[]
): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const next = Array.from(
      new Set(
        hiddenColumnKeys.filter((value): value is ColumnKey => typeof value === "string" && value.trim().length > 0)
      )
    );
    if (next.length === 0) {
      window.localStorage.removeItem(getHiddenColumnsStorageKey(formId, mode));
      return;
    }
    window.localStorage.setItem(getHiddenColumnsStorageKey(formId, mode), JSON.stringify(next));
  } catch {
    // NOTE: localStorage 寫入失敗時不阻塞主流程
  }
}

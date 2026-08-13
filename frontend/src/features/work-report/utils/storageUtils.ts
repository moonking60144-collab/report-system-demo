import type { WorkReportRecord } from "../../../api/workReport";
import {
  FORM_ID,
  HYDRATION_CACHE_TTL_MS,
  HYDRATION_CACHE_VERSION,
  WORK_REPORT_COLUMN_MODE_STORAGE_KEY,
} from "../constants";
import type {
  ColumnColorOverrides,
  ColumnDisplayMode,
  ColumnKey,
  ColumnWidthOverrides,
  HydrationCachePayload,
  HydrationCacheWriteJob,
  WorkReportColumnColor,
  WorkReportTableLayoutPreferences,
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
    if (raw === "full") {
      try {
        window.localStorage.setItem(WORK_REPORT_COLUMN_MODE_STORAGE_KEY, "fit");
      } catch {
        // NOTE: 偏好遷移寫回失敗時仍使用合法的 fit 模式
      }
      return "fit";
    }
    if (raw === "fit" || raw === "compact") {
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

function getTableLayoutStorageKey(formId: string, mode: ColumnDisplayMode): string {
  return `work-report:${formId}:table-layout:${mode}:v2`;
}

const WORK_REPORT_COLUMN_COLORS = new Set<WorkReportColumnColor>([
  "none",
  "gray-soft",
  "amber-soft",
  "blue-soft",
  "cyan-soft",
  "green-soft",
  "rose-soft",
  "violet-soft",
]);

function reconcileColumnKeys(values: unknown, availableColumnKeys: ColumnKey[]): ColumnKey[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const available = new Set(availableColumnKeys);
  return Array.from(
    new Set(
      values.filter(
        (value): value is ColumnKey =>
          typeof value === "string" && available.has(value)
      )
    )
  );
}

export function createDefaultWorkReportTableLayout(
  availableColumnKeys: ColumnKey[]
): WorkReportTableLayoutPreferences {
  return {
    version: 2,
    hiddenColumnKeys: [],
    columnOrder: [...availableColumnKeys],
    columnWidths: {},
    columnColors: {},
  };
}

export function reconcileWorkReportTableLayout(
  value: unknown,
  availableColumnKeys: ColumnKey[],
  legacy: {
    hiddenColumnKeys?: ColumnKey[];
    columnWidths?: ColumnWidthOverrides;
  } = {}
): WorkReportTableLayoutPreferences {
  const candidate =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<WorkReportTableLayoutPreferences>)
      : null;
  const available = new Set(availableColumnKeys);
  const savedOrder = reconcileColumnKeys(candidate?.columnOrder, availableColumnKeys);
  const missingColumnKeys = availableColumnKeys.filter((key) => !savedOrder.includes(key));
  const rawWidths = candidate?.columnWidths ?? legacy.columnWidths ?? {};
  const rawColors = candidate?.columnColors ?? {};

  const columnWidths = Object.fromEntries(
    Object.entries(rawWidths).filter(([key, width]) => {
      return available.has(key) && typeof width === "number" && Number.isFinite(width) && width >= 48;
    })
  ) as ColumnWidthOverrides;
  const columnColors = Object.fromEntries(
    Object.entries(rawColors).filter(([key, color]) => {
      return available.has(key) && WORK_REPORT_COLUMN_COLORS.has(color as WorkReportColumnColor);
    })
  ) as ColumnColorOverrides;

  return {
    version: 2,
    hiddenColumnKeys: reconcileColumnKeys(
      candidate?.hiddenColumnKeys ?? legacy.hiddenColumnKeys ?? [],
      availableColumnKeys
    ),
    columnOrder: [...savedOrder, ...missingColumnKeys],
    columnWidths,
    columnColors,
  };
}

export function readWorkReportTableLayout(
  formId: string,
  mode: ColumnDisplayMode,
  availableColumnKeys: ColumnKey[]
): WorkReportTableLayoutPreferences {
  const legacy = {
    hiddenColumnKeys: readHiddenColumns(formId, mode),
    columnWidths: readColumnWidthOverrides(formId, mode),
  };
  if (typeof window === "undefined") {
    return reconcileWorkReportTableLayout(null, availableColumnKeys, legacy);
  }

  try {
    const raw = window.localStorage.getItem(getTableLayoutStorageKey(formId, mode));
    return reconcileWorkReportTableLayout(
      raw ? JSON.parse(raw) : null,
      availableColumnKeys,
      legacy
    );
  } catch {
    return reconcileWorkReportTableLayout(null, availableColumnKeys, legacy);
  }
}

export function writeWorkReportTableLayout(
  formId: string,
  mode: ColumnDisplayMode,
  layout: WorkReportTableLayoutPreferences,
  availableColumnKeys: ColumnKey[]
): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const normalized = reconcileWorkReportTableLayout(layout, availableColumnKeys);
    window.localStorage.setItem(
      getTableLayoutStorageKey(formId, mode),
      JSON.stringify(normalized)
    );
  } catch {
    // NOTE: localStorage 寫入失敗時不阻塞主流程
  }
}

export function resetWorkReportTableLayout(
  formId: string,
  mode: ColumnDisplayMode
): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(getTableLayoutStorageKey(formId, mode));
    window.localStorage.removeItem(getColumnWidthOverridesStorageKey(formId, mode));
    window.localStorage.removeItem(getHiddenColumnsStorageKey(formId, mode));
  } catch {
    // NOTE: localStorage 清除失敗時不阻塞主流程
  }
}

function readColumnWidthOverrides(
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

function readHiddenColumns(
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

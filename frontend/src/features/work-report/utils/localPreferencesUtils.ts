import {
  DEFAULT_WORK_REPORT_LOCAL_PREFERENCES,
  FIXED_FILTER_PRESET_IDS_BY_FORM,
  WORK_REPORT_LANDING_PAGE_KEYS,
  WORK_REPORT_LOCAL_PREFS_STORAGE_KEY,
  WORK_REPORT_LOCAL_PREFS_VERSION,
} from "../constants";
import type {
  FixedFilterPresetId,
  WorkReportLandingPageKey,
  WorkReportLocalPreferences,
} from "../types";

export function sanitizeWorkReportLocalPreferences(
  value: unknown
): WorkReportLocalPreferences {
  const fallback = DEFAULT_WORK_REPORT_LOCAL_PREFERENCES;
  if (!value || typeof value !== "object") {
    return { ...fallback };
  }

  const raw = value as Partial<WorkReportLocalPreferences>;
  const defaultLandingPageKey =
    typeof raw.defaultLandingPageKey === "string" &&
    (WORK_REPORT_LANDING_PAGE_KEYS as readonly string[]).includes(raw.defaultLandingPageKey)
      ? (raw.defaultLandingPageKey as WorkReportLandingPageKey)
      : fallback.defaultLandingPageKey;

  const defaultFixedPresetId104 =
    typeof raw.defaultFixedPresetId104 === "string" &&
    FIXED_FILTER_PRESET_IDS_BY_FORM["104"].includes(raw.defaultFixedPresetId104 as FixedFilterPresetId)
      ? (raw.defaultFixedPresetId104 as FixedFilterPresetId)
      : fallback.defaultFixedPresetId104;
  const defaultFixedPresetId105 =
    typeof raw.defaultFixedPresetId105 === "string" &&
    FIXED_FILTER_PRESET_IDS_BY_FORM["105"].includes(raw.defaultFixedPresetId105 as FixedFilterPresetId)
      ? (raw.defaultFixedPresetId105 as FixedFilterPresetId)
      : fallback.defaultFixedPresetId105;
  const hideTestCustomerPartRecords =
    typeof raw.hideTestCustomerPartRecords === "boolean"
      ? raw.hideTestCustomerPartRecords
      : fallback.hideTestCustomerPartRecords;

  return {
    version: WORK_REPORT_LOCAL_PREFS_VERSION,
    defaultLandingPageKey,
    defaultFixedPresetId104,
    defaultFixedPresetId105,
    hideTestCustomerPartRecords,
  };
}

export function readWorkReportLocalPreferences(): WorkReportLocalPreferences {
  if (typeof window === "undefined") {
    return { ...DEFAULT_WORK_REPORT_LOCAL_PREFERENCES };
  }

  try {
    const raw = window.localStorage.getItem(WORK_REPORT_LOCAL_PREFS_STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_WORK_REPORT_LOCAL_PREFERENCES };
    }
    const parsed = JSON.parse(raw) as unknown;
    return sanitizeWorkReportLocalPreferences(parsed);
  } catch {
    return { ...DEFAULT_WORK_REPORT_LOCAL_PREFERENCES };
  }
}

export function writeWorkReportLocalPreferences(preferences: WorkReportLocalPreferences): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const sanitized = sanitizeWorkReportLocalPreferences(preferences);
    window.localStorage.setItem(WORK_REPORT_LOCAL_PREFS_STORAGE_KEY, JSON.stringify(sanitized));
  } catch {
    // NOTE: localStorage 寫入失敗時不阻塞主流程（例如隱私模式/配額限制）
  }
}

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

  const defaultFixedPresetId901 =
    typeof raw.defaultFixedPresetId901 === "string" &&
    FIXED_FILTER_PRESET_IDS_BY_FORM["901"].includes(raw.defaultFixedPresetId901 as FixedFilterPresetId)
      ? (raw.defaultFixedPresetId901 as FixedFilterPresetId)
      : fallback.defaultFixedPresetId901;
  const defaultFixedPresetId902 =
    typeof raw.defaultFixedPresetId902 === "string" &&
    FIXED_FILTER_PRESET_IDS_BY_FORM["902"].includes(raw.defaultFixedPresetId902 as FixedFilterPresetId)
      ? (raw.defaultFixedPresetId902 as FixedFilterPresetId)
      : fallback.defaultFixedPresetId902;
  const hideTestCustomerPartRecords =
    typeof raw.hideTestCustomerPartRecords === "boolean"
      ? raw.hideTestCustomerPartRecords
      : fallback.hideTestCustomerPartRecords;
  const hideSortOrder99Records =
    typeof raw.hideSortOrder99Records === "boolean"
      ? raw.hideSortOrder99Records
      : fallback.hideSortOrder99Records;
  const showListScrollHintButton =
    typeof raw.showListScrollHintButton === "boolean"
      ? raw.showListScrollHintButton
      : fallback.showListScrollHintButton;

  return {
    version: WORK_REPORT_LOCAL_PREFS_VERSION,
    defaultLandingPageKey,
    defaultFixedPresetId901,
    defaultFixedPresetId902,
    hideTestCustomerPartRecords,
    hideSortOrder99Records,
    showListScrollHintButton,
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

export function writeWorkReportLocalPreferences(preferences: WorkReportLocalPreferences): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    const sanitized = sanitizeWorkReportLocalPreferences(preferences);
    window.localStorage.setItem(WORK_REPORT_LOCAL_PREFS_STORAGE_KEY, JSON.stringify(sanitized));
    return true;
  } catch {
    return false;
  }
}

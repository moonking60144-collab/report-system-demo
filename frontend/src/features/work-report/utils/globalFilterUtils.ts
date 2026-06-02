import type { WorkReportRecord } from "../../../api/workReport";
import {
  ALL_FILTER_VALUE,
  DEFAULT_GLOBAL_FILTERS,
  FIXED_FILTER_PRESETS,
  FIXED_FILTER_PRESET_IDS_BY_FORM,
  FIXED_FILTER_QUERY_KEYS,
  WORK_REPORT_LANDING_PAGE_CONFIGS,
} from "../constants";
import type {
  ColumnSortRule,
  SidebarMachinePreset,
  FixedFilterPreset,
  FixedFilterPresetId,
  WorkReportFormId,
  GlobalFilters,
  WorkReportLandingPageKey,
  WorkReportLocalPreferences,
} from "../types";
import { readWorkReportLocalPreferences } from "./localPreferencesUtils";
import { matchesRecordGlobalKeyword } from "./recordUtils";
import { normalizeText, parseSemanticBoolean } from "./valueUtils";

function getExpectedLandingPageKeyForForm(formId: WorkReportFormId): WorkReportLandingPageKey {
  return formId === "105" ? "heading-105" : "thread-rolling-104";
}

export function normalizeColumnSortRules(sortRules: readonly ColumnSortRule[]): ColumnSortRule[] {
  return sortRules.map((rule) => ({
    key: rule.key,
    direction: rule.direction,
    type: rule.type,
  }));
}

export function isSameColumnSortRules(
  left: readonly ColumnSortRule[],
  right: readonly ColumnSortRule[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((rule, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      rule.key === other.key &&
      rule.direction === other.direction &&
      rule.type === other.type
    );
  });
}

const SIDEBAR_MACHINE_SORT_RULES: readonly ColumnSortRule[] = Object.freeze([
  { key: "machineCode", direction: "asc", type: "text" },
  { key: "sortOrder", direction: "asc", type: "number" },
]);

export const FORM_104_UNFINISHED_DEFAULT_SORT_RULES: readonly ColumnSortRule[] = Object.freeze([
  { key: "machineCode", direction: "asc", type: "text" },
  { key: "sortOrder", direction: "asc", type: "number" },
]);

export const FORM_105_UNFINISHED_DEFAULT_SORT_RULES: readonly ColumnSortRule[] = Object.freeze([
  { key: "machineCode", direction: "asc", type: "text" },
  { key: "plannedStartDate", direction: "asc", type: "date" },
]);

export const FORM_105_MACHINE_SHORTCUT_SORT_RULES: readonly ColumnSortRule[] = Object.freeze([
  { key: "machineCode", direction: "asc", type: "text" },
  { key: "sortOrder", direction: "asc", type: "number" },
]);

function isExactUnfinishedMachineShortcut(
  filters: GlobalFilters,
  formId: WorkReportFormId
): boolean {
  const normalized = normalizeFilters(filters);
  if (
    normalized.globalKeyword !== "" ||
    normalized.workOrderKeyword !== "" ||
    normalized.customerPartKeyword !== "" ||
    normalized.ragicUnfinishedStatus !== ALL_FILTER_VALUE ||
    normalized.siteRunning !== "all"
  ) {
    return false;
  }

  if (formId === "105") {
    return (
      normalized.machineCode === ALL_FILTER_VALUE &&
      normalized.filterMachineCode !== ALL_FILTER_VALUE &&
      normalized.status === "未結案" &&
      normalized.startSchedule === "all"
    );
  }

  return (
    normalized.machineCode !== ALL_FILTER_VALUE &&
    normalized.filterMachineCode === ALL_FILTER_VALUE &&
    normalized.status === "未結案" &&
    normalized.startSchedule === "yes"
  );
}

export function hasActiveGlobalFilters(filters: GlobalFilters): boolean {
  return (
    filters.globalKeyword.trim() !== "" ||
    filters.workOrderKeyword.trim() !== "" ||
    filters.customerPartKeyword.trim() !== "" ||
    filters.machineCode !== ALL_FILTER_VALUE ||
    filters.filterMachineCode !== ALL_FILTER_VALUE ||
    filters.status !== ALL_FILTER_VALUE ||
    filters.ragicUnfinishedStatus !== ALL_FILTER_VALUE ||
    filters.siteRunning !== "all" ||
    filters.startSchedule !== "all"
  );
}

export function normalizeFilters(filters: GlobalFilters): GlobalFilters {
  return {
    globalKeyword: filters.globalKeyword.trim(),
    workOrderKeyword: filters.workOrderKeyword.trim(),
    customerPartKeyword: filters.customerPartKeyword.trim(),
    machineCode: filters.machineCode || ALL_FILTER_VALUE,
    filterMachineCode: filters.filterMachineCode || ALL_FILTER_VALUE,
    status: filters.status || ALL_FILTER_VALUE,
    ragicUnfinishedStatus: filters.ragicUnfinishedStatus || ALL_FILTER_VALUE,
    siteRunning:
      filters.siteRunning === "yes" || filters.siteRunning === "no"
        ? filters.siteRunning
        : "all",
    startSchedule:
      filters.startSchedule === "yes" || filters.startSchedule === "no"
        ? filters.startSchedule
        : "all",
  };
}

export function isSameGlobalFilters(left: GlobalFilters, right: GlobalFilters): boolean {
  const a = normalizeFilters(left);
  const b = normalizeFilters(right);
  return (
    a.globalKeyword === b.globalKeyword &&
    a.workOrderKeyword === b.workOrderKeyword &&
    a.customerPartKeyword === b.customerPartKeyword &&
    a.machineCode === b.machineCode &&
    a.filterMachineCode === b.filterMachineCode &&
    a.status === b.status &&
    a.ragicUnfinishedStatus === b.ragicUnfinishedStatus &&
    a.siteRunning === b.siteRunning &&
    a.startSchedule === b.startSchedule
  );
}

export function readFiltersFromUrl(): GlobalFilters {
  const params = new URLSearchParams(window.location.search);
  const legacyKeyword = params.get("q")?.trim() ?? "";
  const siteRunningRaw = (params.get("fSite") ?? "all").trim().toLowerCase();
  const startScheduleRaw = (params.get("fStartSchedule") ?? "all").trim().toLowerCase();

  return {
    globalKeyword: params.get("fGlobal")?.trim() ?? "",
    workOrderKeyword: params.get("fWorkOrder")?.trim() ?? legacyKeyword,
    customerPartKeyword: params.get("fPart")?.trim() ?? "",
    machineCode: params.get("fMachine")?.trim() || ALL_FILTER_VALUE,
    filterMachineCode: params.get("fFilterMachine")?.trim() || ALL_FILTER_VALUE,
    status: params.get("fStatus")?.trim() || ALL_FILTER_VALUE,
    ragicUnfinishedStatus: params.get("fRagicUnfinished")?.trim() || ALL_FILTER_VALUE,
    siteRunning:
      siteRunningRaw === "yes" || siteRunningRaw === "no"
        ? (siteRunningRaw as "yes" | "no")
        : "all",
    startSchedule:
      startScheduleRaw === "yes" || startScheduleRaw === "no"
        ? (startScheduleRaw as "yes" | "no")
        : "all",
  };
}

export function hasExplicitGlobalFilterParamsInUrl(): boolean {
  const params = new URLSearchParams(window.location.search);
  const explicitQueryKeys: readonly string[] = [
    ...FIXED_FILTER_QUERY_KEYS,
    "page",
    "pageSize",
  ];
  return explicitQueryKeys.some((key) => {
    const value = params.get(key);
    return typeof value === "string" && value.trim() !== "";
  });
}

export function getFixedFilterPresetById(id: FixedFilterPresetId): FixedFilterPreset {
  const preset = FIXED_FILTER_PRESETS.find((item) => item.id === id);
  if (!preset) {
    return FIXED_FILTER_PRESETS[0];
  }
  return preset;
}

export function cloneGlobalFilters(filters: GlobalFilters): GlobalFilters {
  return { ...filters };
}

export function buildUnfinishedMachineFilters(
  machineCode: string,
  formId: WorkReportFormId = "104"
): GlobalFilters {
  return {
    ...DEFAULT_GLOBAL_FILTERS,
    machineCode: formId === "105" ? ALL_FILTER_VALUE : machineCode,
    filterMachineCode: formId === "105" ? machineCode : ALL_FILTER_VALUE,
    status: "未結案",
    ragicUnfinishedStatus: ALL_FILTER_VALUE,
    startSchedule: formId === "105" ? "all" : "yes",
  };
}

export function buildUnfinishedMachineShortcut(
  machineCode: string,
  formId: WorkReportFormId = "104"
): SidebarMachinePreset {
  const sortRules =
    formId === "105"
      ? FORM_105_MACHINE_SHORTCUT_SORT_RULES
      : SIDEBAR_MACHINE_SORT_RULES;
  return {
    key: `${formId}:${machineCode}`,
    machineCode,
    filters: buildUnfinishedMachineFilters(machineCode, formId),
    sortRules: sortRules.map((rule) => ({ ...rule })),
  };
}

export function getDefaultSortRulesForFixedPreset(
  formId: WorkReportFormId,
  presetId: FixedFilterPresetId | null
): ColumnSortRule[] {
  if (!presetId) {
    return [];
  }

  if (formId === "104" && (presetId === "unfinished-runnable" || presetId === "unfinished-orders")) {
    return FORM_104_UNFINISHED_DEFAULT_SORT_RULES.map((rule) => ({ ...rule }));
  }

  if (formId === "105" && presetId === "unfinished-orders") {
    return FORM_105_UNFINISHED_DEFAULT_SORT_RULES.map((rule) => ({ ...rule }));
  }

  return [];
}

export function getDefaultSortRulesForCurrentFilters(
  formId: WorkReportFormId,
  filters: GlobalFilters,
  presetId: FixedFilterPresetId | null
): ColumnSortRule[] {
  const presetRules = getDefaultSortRulesForFixedPreset(formId, presetId);
  if (presetRules.length > 0) {
    return presetRules;
  }

  if (!isExactUnfinishedMachineShortcut(filters, formId)) {
    return [];
  }

  return (
    formId === "105"
      ? FORM_105_MACHINE_SHORTCUT_SORT_RULES
      : FORM_104_UNFINISHED_DEFAULT_SORT_RULES
  ).map((rule) => ({ ...rule }));
}

export function getViewIdentitySortRules(
  formId: WorkReportFormId,
  filters: GlobalFilters,
  presetId: FixedFilterPresetId | null,
  sortRules: readonly ColumnSortRule[]
): ColumnSortRule[] {
  const normalizedSortRules = normalizeColumnSortRules(sortRules);
  if (normalizedSortRules.length > 0) {
    return normalizedSortRules;
  }
  return getDefaultSortRulesForCurrentFilters(formId, filters, presetId);
}

export function getDefaultSortBootstrapKey(
  formId: WorkReportFormId,
  filters: GlobalFilters,
  presetId: FixedFilterPresetId | null
): string | null {
  if (presetId) {
    return `${formId}:preset:${presetId}`;
  }

  if (!isExactUnfinishedMachineShortcut(filters, formId)) {
    return null;
  }

  const machineCode =
    formId === "105" ? normalizeFilters(filters).filterMachineCode : normalizeFilters(filters).machineCode;
  return `${formId}:machine:${machineCode}`;
}

function getPreferredPresetIdForLandingPage(
  localPreferences: WorkReportLocalPreferences,
  landingPageKey: WorkReportLandingPageKey
): FixedFilterPresetId {
  const landingPageConfig = WORK_REPORT_LANDING_PAGE_CONFIGS[landingPageKey];
  const presetId =
    localPreferences[landingPageConfig.defaultFixedPresetPreferenceKey] ??
    landingPageConfig.fallbackFixedPresetId;
  const allowedPresetIds = FIXED_FILTER_PRESET_IDS_BY_FORM[landingPageConfig.formId];
  return allowedPresetIds.includes(presetId)
    ? presetId
    : landingPageConfig.fallbackFixedPresetId;
}

export function getInitialGlobalFilters(
  landingPageKey: WorkReportLandingPageKey = "thread-rolling-104"
): GlobalFilters {
  if (hasExplicitGlobalFilterParamsInUrl()) {
    return readFiltersFromUrl();
  }
  const localPreferences = readWorkReportLocalPreferences();
  const preferredPresetId = getPreferredPresetIdForLandingPage(localPreferences, landingPageKey);
  return getFixedFilterPresetFilters(
    preferredPresetId,
    WORK_REPORT_LANDING_PAGE_CONFIGS[landingPageKey].formId
  );
}

export function getFixedFilterPresetFilters(
  presetId: FixedFilterPresetId,
  formId: WorkReportFormId
): GlobalFilters {
  const preset = getFixedFilterPresetById(presetId);
  const baseFilters = cloneGlobalFilters(preset.filters);

  if (formId !== "105") {
    return baseFilters;
  }

  if (presetId === "unfinished-orders") {
    return {
      ...baseFilters,
      status: "未結案",
      ragicUnfinishedStatus: ALL_FILTER_VALUE,
    };
  }

  return {
    ...baseFilters,
    ragicUnfinishedStatus: ALL_FILTER_VALUE,
  };
}

export function detectFixedFilterPresetId(
  filters: GlobalFilters,
  formId: WorkReportFormId
): FixedFilterPresetId | null {
  const match = FIXED_FILTER_PRESETS.find((preset) =>
    isSameGlobalFilters(filters, getFixedFilterPresetFilters(preset.id, formId))
  );
  return match?.id ?? null;
}

export function detectActiveFixedFilterPresetId(
  filters: GlobalFilters,
  sortRules: readonly ColumnSortRule[],
  landingPageKey: WorkReportLandingPageKey,
  formId: WorkReportFormId
): FixedFilterPresetId | null {
  void sortRules;
  if (landingPageKey !== getExpectedLandingPageKeyForForm(formId)) {
    return null;
  }

  const detectedPresetId = detectFixedFilterPresetId(filters, formId);
  if (!detectedPresetId) {
    return null;
  }

  return detectedPresetId;
}

export function isActiveUnfinishedMachineShortcut(
  preset: SidebarMachinePreset,
  filters: GlobalFilters,
  sortRules: readonly ColumnSortRule[],
  landingPageKey: WorkReportLandingPageKey,
  formId: WorkReportFormId
): boolean {
  void sortRules;
  if (landingPageKey !== getExpectedLandingPageKeyForForm(formId)) {
    return false;
  }

  return isSameGlobalFilters(filters, preset.filters);
}

export function applyGlobalFilters(records: WorkReportRecord[], filters: GlobalFilters): WorkReportRecord[] {
  const globalKeyword = normalizeText(filters.globalKeyword);
  const workOrderKeyword = normalizeText(filters.workOrderKeyword);
  const customerPartKeyword = normalizeText(filters.customerPartKeyword);

  return records.filter((record) => {
    if (globalKeyword && !matchesRecordGlobalKeyword(record, globalKeyword)) {
      return false;
    }

    if (workOrderKeyword && !normalizeText(record.workOrderNo).includes(workOrderKeyword)) {
      return false;
    }

    if (
      customerPartKeyword &&
      !normalizeText(record.customerPartNo).includes(customerPartKeyword)
    ) {
      return false;
    }

    if (
      filters.machineCode !== ALL_FILTER_VALUE &&
      String(record.machineCode ?? "").trim() !== filters.machineCode
    ) {
      return false;
    }

    if (
      filters.filterMachineCode !== ALL_FILTER_VALUE &&
      String(record.filterMachineCode ?? "").trim() !== filters.filterMachineCode
    ) {
      return false;
    }

    if (filters.status !== ALL_FILTER_VALUE && String(record.status ?? "").trim() !== filters.status) {
      return false;
    }

    if (
      filters.ragicUnfinishedStatus !== ALL_FILTER_VALUE &&
      String(record.ragicUnfinishedStatus ?? "").trim() !== filters.ragicUnfinishedStatus
    ) {
      return false;
    }

    if (filters.siteRunning !== "all") {
      const siteRunning = parseSemanticBoolean(record.siteRunning);
      if (filters.siteRunning === "yes" && siteRunning !== true) {
        return false;
      }
      if (filters.siteRunning === "no" && siteRunning !== false) {
        return false;
      }
    }

    if (filters.startSchedule !== "all") {
      const startSchedule = parseSemanticBoolean(record.startSchedule);
      if (filters.startSchedule === "yes" && startSchedule !== true) {
        return false;
      }
      if (filters.startSchedule === "no" && startSchedule !== false) {
        return false;
      }
    }

    return true;
  });
}

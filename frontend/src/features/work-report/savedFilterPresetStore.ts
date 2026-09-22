import {
  WORK_REPORT_MAX_SAVED_FILTERS,
  WORK_REPORT_MAX_SAVED_FILTER_NAME_LENGTH,
  WORK_REPORT_SAVED_FILTER_SCHEMA_VERSION,
  WORK_REPORT_SAVED_FILTERS_STORAGE_KEY,
} from "./constants";
import type {
  ColumnSortRule,
  SavedWorkReportFilterPreset,
  WorkReportFilterGroup,
  WorkReportFormId,
  WorkReportLandingPageKey,
} from "./types";
import { normalizeWorkReportFilterGroup } from "./utils/customFilterUtils";

function normalizeSortRules(value: unknown): ColumnSortRule[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(
      (rule): rule is ColumnSortRule =>
        Boolean(rule) &&
        typeof rule === "object" &&
        typeof (rule as ColumnSortRule).key === "string" &&
        ((rule as ColumnSortRule).direction === "asc" ||
          (rule as ColumnSortRule).direction === "desc") &&
        ["text", "number", "date", "boolean"].includes((rule as ColumnSortRule).type)
    )
    .slice(0, 12)
    .map((rule) => ({ ...rule }));
}

export function normalizeSavedWorkReportFilterPresets(
  value: unknown
): SavedWorkReportFilterPreset[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: SavedWorkReportFilterPreset[] = [];
  const seenIds = new Set<string>();
  for (const rawPreset of value) {
    if (!rawPreset || typeof rawPreset !== "object") {
      continue;
    }
    const raw = rawPreset as Partial<SavedWorkReportFilterPreset>;
    const id = typeof raw.id === "string" ? raw.id.trim().slice(0, 80) : "";
    const name =
      typeof raw.name === "string"
        ? raw.name.trim().slice(0, WORK_REPORT_MAX_SAVED_FILTER_NAME_LENGTH)
        : "";
    if (
      raw.schemaVersion !== WORK_REPORT_SAVED_FILTER_SCHEMA_VERSION ||
      !id ||
      seenIds.has(id) ||
      !name ||
      (raw.formId !== "901" && raw.formId !== "902") ||
      (raw.landingPageKey !== "line-a-901" && raw.landingPageKey !== "line-b-902")
    ) {
      continue;
    }
    const expectedLandingPageKey =
      raw.formId === "901" ? "line-a-901" : "line-b-902";
    if (raw.landingPageKey !== expectedLandingPageKey) {
      continue;
    }
    const filterGroup = normalizeWorkReportFilterGroup(raw.filterGroup);
    if (filterGroup.conditions.length === 0) {
      continue;
    }
    const createdAt =
      typeof raw.createdAt === "string" && Number.isFinite(Date.parse(raw.createdAt))
        ? raw.createdAt
        : new Date(0).toISOString();
    const updatedAt =
      typeof raw.updatedAt === "string" && Number.isFinite(Date.parse(raw.updatedAt))
        ? raw.updatedAt
        : createdAt;
    seenIds.add(id);
    result.push({
      schemaVersion: 1,
      id,
      name,
      formId: raw.formId,
      landingPageKey: raw.landingPageKey,
      filterGroup,
      sortRules: normalizeSortRules(raw.sortRules),
      isDefault: raw.isDefault === true,
      createdAt,
      updatedAt,
    });
  }
  return result;
}

function readAllSavedFilters(): SavedWorkReportFilterPreset[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(WORK_REPORT_SAVED_FILTERS_STORAGE_KEY);
    return raw ? normalizeSavedWorkReportFilterPresets(JSON.parse(raw) as unknown) : [];
  } catch {
    return [];
  }
}

function writeAllSavedFilters(presets: SavedWorkReportFilterPreset[]): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    window.localStorage.setItem(
      WORK_REPORT_SAVED_FILTERS_STORAGE_KEY,
      JSON.stringify(normalizeSavedWorkReportFilterPresets(presets))
    );
    return true;
  } catch {
    return false;
  }
}

export function readSavedWorkReportFilters(
  formId: WorkReportFormId,
  landingPageKey: WorkReportLandingPageKey
): SavedWorkReportFilterPreset[] {
  return readAllSavedFilters()
    .filter((preset) => preset.formId === formId && preset.landingPageKey === landingPageKey)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, WORK_REPORT_MAX_SAVED_FILTERS);
}

export function saveWorkReportFilterPreset(input: {
  name: string;
  formId: WorkReportFormId;
  landingPageKey: WorkReportLandingPageKey;
  filterGroup: WorkReportFilterGroup;
  sortRules: ColumnSortRule[];
}): SavedWorkReportFilterPreset | null {
  const scoped = readSavedWorkReportFilters(input.formId, input.landingPageKey);
  if (scoped.length >= WORK_REPORT_MAX_SAVED_FILTERS) {
    return null;
  }
  const filterGroup = normalizeWorkReportFilterGroup(input.filterGroup);
  const name = input.name.trim().slice(0, WORK_REPORT_MAX_SAVED_FILTER_NAME_LENGTH);
  if (!name || filterGroup.conditions.length === 0) {
    return null;
  }
  const now = new Date().toISOString();
  const preset: SavedWorkReportFilterPreset = {
    schemaVersion: 1,
    id: `saved-filter-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    formId: input.formId,
    landingPageKey: input.landingPageKey,
    filterGroup,
    sortRules: normalizeSortRules(input.sortRules),
    isDefault: false,
    createdAt: now,
    updatedAt: now,
  };
  return writeAllSavedFilters([...readAllSavedFilters(), preset]) ? preset : null;
}

export function deleteWorkReportFilterPreset(id: string): boolean {
  return writeAllSavedFilters(readAllSavedFilters().filter((preset) => preset.id !== id));
}

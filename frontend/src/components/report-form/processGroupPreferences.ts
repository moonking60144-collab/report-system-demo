import type { FormOptionItem } from "../../api/workReport";
import type { WorkReportFormId } from "../../features/work-report/types";

export interface ProcessGroupOption {
  key: string;
  label: string;
  count: number;
}

export const ALL_PROCESS_GROUP_KEY = "__all__";

const STORAGE_KEY = "work-report:process-group-preference:v1";

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

export function buildProcessGroupOptions(options: FormOptionItem[]): ProcessGroupOption[] {
  const groupMap = new Map<string, ProcessGroupOption>();

  for (const option of options) {
    const label =
      normalizeText(option.processGroupLabel) || normalizeText(option.processGroupKey);
    if (!label) {
      continue;
    }

    const key = normalizeText(option.processGroupKey) || label;
    const existing = groupMap.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }

    groupMap.set(key, {
      key,
      label,
      count: 1,
    });
  }

  return Array.from(groupMap.values()).sort((left, right) =>
    left.label.localeCompare(right.label, "zh-Hant")
  );
}

export function filterProcessOptionsByGroup(
  options: FormOptionItem[],
  selectedGroupKey: string
): FormOptionItem[] {
  const normalizedGroupKey = normalizeText(selectedGroupKey);
  if (!normalizedGroupKey || normalizedGroupKey === ALL_PROCESS_GROUP_KEY) {
    return options;
  }

  return options.filter((option) => {
    const optionGroupKey =
      normalizeText(option.processGroupKey) || normalizeText(option.processGroupLabel);
    return optionGroupKey === normalizedGroupKey;
  });
}

export function readProcessGroupPreference(formId: WorkReportFormId): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<Record<WorkReportFormId, string>>;
    const value = parsed?.[formId];
    return normalizeText(value) || null;
  } catch {
    return null;
  }
}

export function writeProcessGroupPreference(
  formId: WorkReportFormId,
  groupKey: string
): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Record<WorkReportFormId, string>>) : {};
    parsed[formId] = groupKey;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // Ignore localStorage errors and keep UI usable.
  }
}

export function resolveProcessGroupPreference(
  groupOptions: ProcessGroupOption[],
  storedGroupKey: string | null
): string {
  const normalizedStored = normalizeText(storedGroupKey);
  if (normalizedStored === ALL_PROCESS_GROUP_KEY) {
    return ALL_PROCESS_GROUP_KEY;
  }
  if (normalizedStored && groupOptions.some((option) => option.key === normalizedStored)) {
    return normalizedStored;
  }

  return ALL_PROCESS_GROUP_KEY;
}

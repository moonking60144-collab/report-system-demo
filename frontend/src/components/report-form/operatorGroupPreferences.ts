import type { FormOptionItem } from "../../api/workReport";
import type { WorkReportFormId } from "../../features/work-report/types";

export interface OperatorGroupOption {
  key: string;
  label: string;
  count: number;
}

export const ALL_OPERATOR_GROUP_KEY = "__all__";

const STORAGE_KEY = "work-report:operator-group-preference:v1";

const DEFAULT_OPERATOR_GROUP_BY_FORM: Record<WorkReportFormId, string> = {
  "104": "DEPT-PROCA",
  "105": "DEPT-FORGE",
};

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

export function buildOperatorGroupOptions(options: FormOptionItem[]): OperatorGroupOption[] {
  const groupMap = new Map<string, OperatorGroupOption>();

  for (const option of options) {
    const label =
      normalizeText(option.operatorGroupLabel) || normalizeText(option.operatorGroupKey);
    if (!label) {
      continue;
    }

    const key = normalizeText(option.operatorGroupKey) || label;
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

export function filterOperatorOptionsByGroup(
  options: FormOptionItem[],
  selectedGroupKey: string
): FormOptionItem[] {
  const normalizedGroupKey = normalizeText(selectedGroupKey);
  if (!normalizedGroupKey || normalizedGroupKey === ALL_OPERATOR_GROUP_KEY) {
    return options;
  }

  return options.filter((option) => {
    const optionGroupKey =
      normalizeText(option.operatorGroupKey) || normalizeText(option.operatorGroupLabel);
    return optionGroupKey === normalizedGroupKey;
  });
}

export function readOperatorGroupPreference(formId: WorkReportFormId): string | null {
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

export function writeOperatorGroupPreference(
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

export function resolveOperatorGroupPreference(
  formId: WorkReportFormId,
  groupOptions: OperatorGroupOption[],
  storedGroupKey: string | null
): string {
  const normalizedStored = normalizeText(storedGroupKey);
  if (normalizedStored === ALL_OPERATOR_GROUP_KEY) {
    return ALL_OPERATOR_GROUP_KEY;
  }
  if (normalizedStored && groupOptions.some((option) => option.key === normalizedStored)) {
    return normalizedStored;
  }

  const defaultGroupKey = DEFAULT_OPERATOR_GROUP_BY_FORM[formId];
  if (groupOptions.some((option) => option.key === defaultGroupKey)) {
    return defaultGroupKey;
  }

  return ALL_OPERATOR_GROUP_KEY;
}

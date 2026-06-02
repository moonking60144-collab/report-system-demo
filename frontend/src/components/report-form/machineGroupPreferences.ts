import type { FormOptionItem } from "../../api/workReport";
import type { WorkReportFormId } from "../../features/work-report/types";

export interface MachineGroupOption {
  key: string;
  label: string;
  count: number;
}

export const ALL_MACHINE_GROUP_KEY = "__all__";

const STORAGE_KEY = "work-report:machine-group-preference:v1";

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function resolveMachineGroup(option: FormOptionItem): { key: string; label: string } | null {
  const group = normalizeText(option.machineDefault?.processCategoryCode);
  if (!group) {
    return null;
  }

  return {
    key: group,
    label: group,
  };
}

export function buildMachineGroupOptions(options: FormOptionItem[]): MachineGroupOption[] {
  const groupMap = new Map<string, MachineGroupOption>();

  for (const option of options) {
    const group = resolveMachineGroup(option);
    if (!group) {
      continue;
    }

    const existing = groupMap.get(group.key);
    if (existing) {
      existing.count += 1;
      continue;
    }

    groupMap.set(group.key, {
      key: group.key,
      label: group.label,
      count: 1,
    });
  }

  return Array.from(groupMap.values()).sort((left, right) =>
    left.label.localeCompare(right.label, "zh-Hant")
  );
}

export function filterMachineOptionsByGroup(
  options: FormOptionItem[],
  selectedGroupKey: string
): FormOptionItem[] {
  const normalizedGroupKey = normalizeText(selectedGroupKey);
  if (!normalizedGroupKey || normalizedGroupKey === ALL_MACHINE_GROUP_KEY) {
    return options;
  }

  return options.filter((option) => {
    return normalizeText(option.machineDefault?.processCategoryCode) === normalizedGroupKey;
  });
}

export function readMachineGroupPreference(formId: WorkReportFormId): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<Record<WorkReportFormId, string>>;
    return normalizeText(parsed?.[formId]) || null;
  } catch {
    return null;
  }
}

export function writeMachineGroupPreference(
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
    // Ignore localStorage errors.
  }
}

export function resolveMachineGroupPreference(
  groupOptions: MachineGroupOption[],
  storedGroupKey: string | null,
  preferredGroupKey?: string
): string {
  const normalizedStored = normalizeText(storedGroupKey);
  if (normalizedStored === ALL_MACHINE_GROUP_KEY) {
    return ALL_MACHINE_GROUP_KEY;
  }
  if (normalizedStored && groupOptions.some((option) => option.key === normalizedStored)) {
    return normalizedStored;
  }

  const normalizedPreferred = normalizeText(preferredGroupKey);
  if (normalizedPreferred && groupOptions.some((option) => option.key === normalizedPreferred)) {
    return normalizedPreferred;
  }

  return ALL_MACHINE_GROUP_KEY;
}

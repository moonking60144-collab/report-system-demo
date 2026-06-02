import {
  ALL_FILTER_VALUE,
  WORK_REPORT_LANDING_PAGE_KEYS,
  WORK_REPORT_LIST_ANCHOR_STORAGE_KEY,
} from "../constants";
import type {
  ColumnFilterRule,
  ColumnFilterState,
  ColumnSortRule,
  GlobalFilters,
  SidebarPlaceholderView,
  WorkReportLandingPageKey,
  WorkReportListAnchor,
  WorkReportListLocationState,
  WorkReportListViewState,
} from "../types";

const COLUMN_SORT_RULE_PARAM_KEY = "fSort";

export interface WorkReportListAnchorPayload {
  listSearch?: string;
  listAnchor: WorkReportListAnchor;
  listViewState?: WorkReportListViewState;
}

function normalizePositiveNumber(value: unknown): number | undefined {
  const nextValue = Number(value);
  return Number.isFinite(nextValue) && nextValue > 0 ? nextValue : undefined;
}

function normalizeGlobalFilters(value: unknown): GlobalFilters | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Partial<GlobalFilters>;
  return {
    globalKeyword: String(candidate.globalKeyword ?? "").trim(),
    workOrderKeyword: String(candidate.workOrderKeyword ?? "").trim(),
    customerPartKeyword: String(candidate.customerPartKeyword ?? "").trim(),
    machineCode: String(candidate.machineCode ?? "").trim() || ALL_FILTER_VALUE,
    filterMachineCode:
      String(candidate.filterMachineCode ?? "").trim() || ALL_FILTER_VALUE,
    status: String(candidate.status ?? "").trim() || ALL_FILTER_VALUE,
    ragicUnfinishedStatus:
      String(candidate.ragicUnfinishedStatus ?? "").trim() || ALL_FILTER_VALUE,
    siteRunning:
      candidate.siteRunning === "yes" || candidate.siteRunning === "no" ? candidate.siteRunning : "all",
    startSchedule:
      candidate.startSchedule === "yes" || candidate.startSchedule === "no"
        ? candidate.startSchedule
        : "all",
  };
}

function normalizeColumnFilterRule(value: unknown): ColumnFilterRule | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as ColumnFilterRule;
  const selectedTokens = Array.isArray(candidate.selectedTokens)
    ? candidate.selectedTokens
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : [];
  const textQuery = typeof candidate.textQuery === "string" ? candidate.textQuery.trim() : "";

  if (selectedTokens.length === 0 && !textQuery) {
    return null;
  }

  return {
    ...(selectedTokens.length > 0 ? { selectedTokens } : {}),
    ...(textQuery ? { textQuery } : {}),
  };
}

function normalizeColumnFilterState(value: unknown): ColumnFilterState | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const nextState: ColumnFilterState = {};
  for (const [key, rule] of Object.entries(value as Record<string, unknown>)) {
    const normalizedRule = normalizeColumnFilterRule(rule);
    if (normalizedRule) {
      nextState[key] = normalizedRule;
    }
  }

  return Object.keys(nextState).length > 0 ? nextState : undefined;
}

function normalizeColumnSortRules(value: unknown): ColumnSortRule[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const nextRules = value.filter(
    (rule): rule is ColumnSortRule =>
      Boolean(rule) &&
      typeof rule === "object" &&
      typeof (rule as ColumnSortRule).key === "string" &&
      ((rule as ColumnSortRule).direction === "asc" || (rule as ColumnSortRule).direction === "desc") &&
      ((rule as ColumnSortRule).type === "text" ||
        (rule as ColumnSortRule).type === "number" ||
        (rule as ColumnSortRule).type === "date" ||
        (rule as ColumnSortRule).type === "boolean")
  );

  return nextRules.length > 0 ? nextRules : undefined;
}

export function parseColumnSortRulesFromSearch(search: string | undefined | null): ColumnSortRule[] | undefined {
  const params = new URLSearchParams(normalizeListSearch(search));
  const raw = String(params.get(COLUMN_SORT_RULE_PARAM_KEY) ?? "").trim();
  if (!raw) {
    return undefined;
  }

  const nextRules: ColumnSortRule[] = raw
    .split(",")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const [key = "", direction = "", type = "text"] = segment.split(":");
      return {
        key: key.trim(),
        direction: direction.trim(),
        type: type.trim(),
      } as ColumnSortRule;
    })
    .filter(
      (rule): rule is ColumnSortRule =>
        Boolean(rule.key) &&
        (rule.direction === "asc" || rule.direction === "desc") &&
        (rule.type === "text" ||
          rule.type === "number" ||
          rule.type === "date" ||
          rule.type === "boolean")
    );

  return nextRules.length > 0 ? nextRules : undefined;
}

export function serializeColumnSortRulesToSearchParam(
  sortRules: readonly ColumnSortRule[]
): string | undefined {
  const normalized = normalizeColumnSortRules(sortRules);
  if (!normalized || normalized.length === 0) {
    return undefined;
  }
  return normalized.map((rule) => `${rule.key}:${rule.direction}:${rule.type}`).join(",");
}

function normalizeLandingPageKey(value: unknown): WorkReportLandingPageKey | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return WORK_REPORT_LANDING_PAGE_KEYS.includes(value as WorkReportLandingPageKey)
    ? (value as WorkReportLandingPageKey)
    : undefined;
}

function normalizePlaceholderViewId(
  value: unknown
): SidebarPlaceholderView["id"] | null | undefined {
  if (value === null) {
    return null;
  }
  if (value === "starred" || value === "last-updated") {
    return value;
  }
  return undefined;
}

export function normalizeListSearch(search: string | undefined | null): string {
  const raw = String(search ?? "").trim();
  if (!raw) {
    return "";
  }
  return raw.startsWith("?") ? raw : `?${raw}`;
}

export function normalizeWorkReportListViewState(value: unknown): WorkReportListViewState | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as WorkReportListViewState;
  const normalizedState: WorkReportListViewState = {};
  const landingPageKey = normalizeLandingPageKey(candidate.landingPageKey);
  const globalFilterDraft = normalizeGlobalFilters(candidate.globalFilterDraft);
  const globalFilters = normalizeGlobalFilters(candidate.globalFilters);
  const page = normalizePositiveNumber(candidate.page);
  const pageSize = normalizePositiveNumber(candidate.pageSize);
  const activePlaceholderViewId = normalizePlaceholderViewId(candidate.activePlaceholderViewId);
  const columnFilterState = normalizeColumnFilterState(candidate.columnFilterState);
  const columnSortRules = normalizeColumnSortRules(candidate.columnSortRules);

  if (landingPageKey) {
    normalizedState.landingPageKey = landingPageKey;
  }
  if (globalFilterDraft) {
    normalizedState.globalFilterDraft = globalFilterDraft;
  }
  if (globalFilters) {
    normalizedState.globalFilters = globalFilters;
  }
  if (page) {
    normalizedState.page = page;
  }
  if (pageSize) {
    normalizedState.pageSize = pageSize;
  }
  if (activePlaceholderViewId !== undefined) {
    normalizedState.activePlaceholderViewId = activePlaceholderViewId;
  }
  if (columnFilterState) {
    normalizedState.columnFilterState = columnFilterState;
  }
  if (columnSortRules) {
    normalizedState.columnSortRules = columnSortRules;
  }

  return Object.keys(normalizedState).length > 0 ? normalizedState : undefined;
}

export function readWorkReportListAnchorPayloadFromSession(): WorkReportListAnchorPayload | null {
  try {
    const raw = window.sessionStorage.getItem(WORK_REPORT_LIST_ANCHOR_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as WorkReportListAnchorPayload;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !parsed.listAnchor ||
      typeof parsed.listAnchor.entryId !== "string" ||
      !Number.isFinite(parsed.listAnchor.scrollY) ||
      !Number.isFinite(parsed.listAnchor.at)
    ) {
      return null;
    }
    return {
      listSearch: normalizeListSearch(parsed.listSearch),
      listAnchor: {
        entryId: parsed.listAnchor.entryId,
        scrollY: parsed.listAnchor.scrollY,
        at: parsed.listAnchor.at,
      },
      listViewState: normalizeWorkReportListViewState(parsed.listViewState),
    };
  } catch {
    return null;
  }
}

export function writeWorkReportListAnchorPayloadToSession(
  payload: WorkReportListAnchorPayload
): void {
  window.sessionStorage.setItem(WORK_REPORT_LIST_ANCHOR_STORAGE_KEY, JSON.stringify(payload));
}

export function clearWorkReportListAnchorPayloadFromSession(): void {
  window.sessionStorage.removeItem(WORK_REPORT_LIST_ANCHOR_STORAGE_KEY);
}

export function resolveWorkReportListLocationState(
  locationState: WorkReportListLocationState | null | undefined,
  locationSearch: string,
  sessionPayload: WorkReportListAnchorPayload | null
): WorkReportListLocationState | undefined {
  const state = locationState ?? null;
  const listSearch =
    normalizeListSearch(state?.listSearch) ||
    normalizeListSearch(sessionPayload?.listSearch) ||
    normalizeListSearch(locationSearch);
  const listAnchor = state?.listAnchor ?? sessionPayload?.listAnchor;
  const listViewState =
    normalizeWorkReportListViewState(state?.listViewState) ??
    normalizeWorkReportListViewState(sessionPayload?.listViewState);

  if (!listSearch && !listAnchor && !listViewState) {
    return undefined;
  }

  return {
    listSearch: listSearch || undefined,
    listAnchor,
    listViewState,
  };
}

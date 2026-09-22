import { useEffect, useMemo, useState } from "react";
import {
  ALL_FILTER_VALUE,
  COLUMN_TYPE_MAP,
  FIXED_FILTER_PRESET_IDS_BY_FORM,
} from "../../constants";
import type {
  ColumnFilterState,
  ColumnSortRule,
  FixedFilterPresetId,
  GlobalFilters,
  SidebarPlaceholderView,
  WorkReportFilterGroup,
} from "../../types";
import {
  buildUpdatedDateRangeQuery,
  getDefaultSortRulesForCurrentFilters,
  buildBackendColumnFilters,
  getFixedFilterPresetFilters,
  hasActiveGlobalFilters,
  normalizeColumnFilterStateForForm,
  normalizeColumnSortRulesForForm,
  normalizeGlobalFiltersForForm,
} from "../../utils";

interface UseWorkReportListQueryControllerArgs {
  activePlaceholderViewId: SidebarPlaceholderView["id"] | null;
  activeFixedFilterPresetId: FixedFilterPresetId | null;
  currentFormId: "901" | "902";
  pageProdTypeCode: string;
  globalFilters: GlobalFilters;
  columnSortRules: ColumnSortRule[];
  isColumnAnalysisOpen: boolean;
  hasActiveColumnSortRules: boolean;
  columnFilterState: ColumnFilterState;
  customFilters: WorkReportFilterGroup;
  analysisColumnKey: string | null;
  excludeTestCustomerPart: boolean;
  excludeSortOrder99: boolean;
}

export function isServerSupportedWorkReportColumn(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(COLUMN_TYPE_MAP, key);
}

export function areColumnSortRulesServerSupported(
  rules: readonly ColumnSortRule[]
): boolean {
  return rules.every((rule) => isServerSupportedWorkReportColumn(rule.key));
}

export function useWorkReportListQueryController({
  activePlaceholderViewId,
  activeFixedFilterPresetId,
  currentFormId,
  pageProdTypeCode,
  globalFilters,
  columnSortRules,
  isColumnAnalysisOpen,
  hasActiveColumnSortRules,
  columnFilterState,
  customFilters,
  analysisColumnKey,
  excludeTestCustomerPart,
  excludeSortOrder99,
}: UseWorkReportListQueryControllerArgs) {
  const prodTypeScope = currentFormId === "901" ? pageProdTypeCode : undefined;
  const effectiveGlobalFilters = useMemo(
    () => normalizeGlobalFiltersForForm(globalFilters, currentFormId),
    [currentFormId, globalFilters]
  );
  const effectiveColumnSortRules = useMemo(
    () => normalizeColumnSortRulesForForm(columnSortRules, currentFormId),
    [columnSortRules, currentFormId]
  );
  const effectiveColumnFilterState = useMemo(
    () => normalizeColumnFilterStateForForm(columnFilterState, currentFormId),
    [columnFilterState, currentFormId]
  );
  const [localDayStartTimestamp, setLocalDayStartTimestamp] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  });

  useEffect(() => {
    const nextLocalMidnight = new Date(localDayStartTimestamp);
    nextLocalMidnight.setDate(nextLocalMidnight.getDate() + 1);
    const timeoutId = window.setTimeout(() => {
      const nextDate = new Date();
      setLocalDayStartTimestamp(
        new Date(nextDate.getFullYear(), nextDate.getMonth(), nextDate.getDate()).getTime()
      );
    }, Math.max(0, nextLocalMidnight.getTime() - Date.now()));

    return () => window.clearTimeout(timeoutId);
  }, [localDayStartTimestamp]);

  const isGlobalFilterActive = useMemo(
    () => hasActiveGlobalFilters(effectiveGlobalFilters),
    [effectiveGlobalFilters]
  );

  const hasOnlyServerPreviewSortRules = useMemo(
    () => areColumnSortRulesServerSupported(effectiveColumnSortRules),
    [effectiveColumnSortRules]
  );

  const backendColumnFilters = useMemo(
    () => buildBackendColumnFilters(effectiveColumnFilterState, COLUMN_TYPE_MAP),
    [effectiveColumnFilterState]
  );
  const hasUnsupportedColumnFilter = useMemo(
    () =>
      Object.keys(columnFilterState).some(
        (key) => !isServerSupportedWorkReportColumn(key)
      ),
    [columnFilterState]
  );
  const hasUnsupportedAnalysis = Boolean(
    isColumnAnalysisOpen &&
      (!analysisColumnKey ||
        !isServerSupportedWorkReportColumn(analysisColumnKey))
  );

  const shouldUseServerSidePreview = useMemo(() => {
    if (hasUnsupportedColumnFilter || hasUnsupportedAnalysis) {
      return false;
    }
    if (!hasOnlyServerPreviewSortRules) {
      return false;
    }

    const hasSupportedFilters =
      effectiveGlobalFilters.globalKeyword.trim() !== "" ||
      effectiveGlobalFilters.workOrderKeyword.trim() !== "" ||
      effectiveGlobalFilters.customerPartKeyword.trim() !== "" ||
      effectiveGlobalFilters.filterMachineCode !== ALL_FILTER_VALUE ||
      effectiveGlobalFilters.status !== ALL_FILTER_VALUE ||
      effectiveGlobalFilters.ragicUnfinishedStatus !== ALL_FILTER_VALUE ||
      effectiveGlobalFilters.machineCode !== ALL_FILTER_VALUE ||
      effectiveGlobalFilters.siteRunning !== "all" ||
      effectiveGlobalFilters.startSchedule !== "all" ||
      effectiveGlobalFilters.updatedDateFrom !== "" ||
      effectiveGlobalFilters.updatedDateTo !== "";
    const hasSupportedColumnFilters = Boolean(backendColumnFilters);
    const hasSupportedCustomFilters = customFilters.conditions.length > 0;
    const hasSupportedSorts =
      effectiveColumnSortRules.length > 0 || activePlaceholderViewId === "last-updated";
    const hasSupportedQuickView = activePlaceholderViewId === "starred";
    return (
      hasSupportedFilters ||
      hasSupportedColumnFilters ||
      hasSupportedCustomFilters ||
      hasSupportedSorts ||
      hasSupportedQuickView ||
      excludeTestCustomerPart ||
      excludeSortOrder99 ||
      Boolean(prodTypeScope)
    );
  }, [
    activePlaceholderViewId,
    backendColumnFilters,
    customFilters.conditions.length,
    effectiveColumnSortRules.length,
    effectiveGlobalFilters,
    excludeSortOrder99,
    excludeTestCustomerPart,
    prodTypeScope,
    hasUnsupportedAnalysis,
    hasUnsupportedColumnFilter,
    hasOnlyServerPreviewSortRules,
  ]);

  const shouldUseFullHydrationForList =
    hasUnsupportedColumnFilter ||
    (hasActiveColumnSortRules && !hasOnlyServerPreviewSortRules) ||
    hasUnsupportedAnalysis;

  const serverPreviewQuery = useMemo(() => {
    if (!shouldUseServerSidePreview) {
      return { enabled: false as const };
    }

    const todayStart = new Date(localDayStartTimestamp);
    const todayEnd = new Date(localDayStartTimestamp);
    todayEnd.setHours(23, 59, 59, 999);
    const updatedDateRange = buildUpdatedDateRangeQuery(effectiveGlobalFilters);
    const sort = effectiveColumnSortRules
      .filter((rule) => isServerSupportedWorkReportColumn(rule.key))
      .map((rule) => `${rule.key}:${rule.direction}`)
      .join(",");

    const defaultPresetSortRules =
      effectiveColumnSortRules.length === 0
        ? getDefaultSortRulesForCurrentFilters(
            currentFormId,
            effectiveGlobalFilters,
            activeFixedFilterPresetId
          )
        : [];
    const defaultPresetSort =
      defaultPresetSortRules.length > 0
        ? defaultPresetSortRules.map((rule) => `${rule.key}:${rule.direction}`).join(",")
        : undefined;

    return {
      enabled: true as const,
      keyword: effectiveGlobalFilters.globalKeyword.trim() || undefined,
      workOrderKeyword: effectiveGlobalFilters.workOrderKeyword.trim() || undefined,
      customerPartKeyword: effectiveGlobalFilters.customerPartKeyword.trim() || undefined,
      prodType: prodTypeScope,
      excludeTestCustomerPart,
      excludeSortOrder99,
      status:
        effectiveGlobalFilters.status !== ALL_FILTER_VALUE
          ? effectiveGlobalFilters.status
          : undefined,
      ragicUnfinishedStatus:
        effectiveGlobalFilters.ragicUnfinishedStatus !== ALL_FILTER_VALUE
          ? effectiveGlobalFilters.ragicUnfinishedStatus
          : undefined,
      machineCode:
        effectiveGlobalFilters.machineCode !== ALL_FILTER_VALUE
          ? effectiveGlobalFilters.machineCode
          : undefined,
      filterMachineCode:
        effectiveGlobalFilters.filterMachineCode !== ALL_FILTER_VALUE
          ? effectiveGlobalFilters.filterMachineCode
          : undefined,
      siteRunning: effectiveGlobalFilters.siteRunning,
      startSchedule: effectiveGlobalFilters.startSchedule,
      updatedDateFrom:
        activePlaceholderViewId === "starred"
          ? todayStart.toISOString()
          : updatedDateRange.updatedDateFrom,
      updatedDateTo:
        activePlaceholderViewId === "starred"
          ? todayEnd.toISOString()
          : updatedDateRange.updatedDateTo,
      columnFilters: backendColumnFilters,
      filterGroup: customFilters.conditions.length > 0 ? customFilters : undefined,
      sort:
        sort ||
        defaultPresetSort ||
        (activePlaceholderViewId === "last-updated" ? "lastUpdatedAt:desc" : undefined),
    };
  }, [
    activeFixedFilterPresetId,
    activePlaceholderViewId,
    backendColumnFilters,
    customFilters,
    currentFormId,
    effectiveColumnSortRules,
    effectiveGlobalFilters,
    excludeSortOrder99,
    excludeTestCustomerPart,
    localDayStartTimestamp,
    prodTypeScope,
    shouldUseServerSidePreview,
  ]);

  const fixedPresetPreviewQueries = useMemo(
    () =>
      FIXED_FILTER_PRESET_IDS_BY_FORM[currentFormId].map((presetId) => {
        const filters = getFixedFilterPresetFilters(presetId, currentFormId);
        const sort = getDefaultSortRulesForCurrentFilters(currentFormId, filters, presetId)
          .map((rule) => `${rule.key}:${rule.direction}`)
          .join(",");
        const enabled =
          hasActiveGlobalFilters(filters) ||
          Boolean(sort) ||
          excludeTestCustomerPart ||
          excludeSortOrder99 ||
          Boolean(prodTypeScope);
        if (!enabled) {
          return { enabled: false as const };
        }
        return {
          enabled: true as const,
          prodType: prodTypeScope,
          excludeTestCustomerPart,
          excludeSortOrder99,
          status: filters.status !== ALL_FILTER_VALUE ? filters.status : undefined,
          ragicUnfinishedStatus:
            filters.ragicUnfinishedStatus !== ALL_FILTER_VALUE
              ? filters.ragicUnfinishedStatus
              : undefined,
          machineCode:
            filters.machineCode !== ALL_FILTER_VALUE ? filters.machineCode : undefined,
          filterMachineCode:
            filters.filterMachineCode !== ALL_FILTER_VALUE
              ? filters.filterMachineCode
              : undefined,
          siteRunning: filters.siteRunning,
          startSchedule: filters.startSchedule,
          sort: sort || undefined,
        };
      }),
    [currentFormId, excludeSortOrder99, excludeTestCustomerPart, prodTypeScope]
  );

  const bootstrapKeyword = useMemo(() => {
    const globalKeyword = globalFilters.globalKeyword.trim();
    if (globalKeyword) {
      return globalKeyword;
    }

    const workOrderKeyword = globalFilters.workOrderKeyword.trim();
    if (workOrderKeyword) {
      return workOrderKeyword;
    }

    const customerPartKeyword = globalFilters.customerPartKeyword.trim();
    if (customerPartKeyword) {
      return customerPartKeyword;
    }

    return "";
  }, [
    globalFilters.customerPartKeyword,
    globalFilters.globalKeyword,
    globalFilters.workOrderKeyword,
  ]);

  return {
    isGlobalFilterActive,
    hasOnlyServerPreviewSortRules,
    shouldUseServerSidePreview,
    shouldUseFullHydrationForList,
    serverPreviewQuery,
    fixedPresetPreviewQueries,
    bootstrapKeyword,
  };
}

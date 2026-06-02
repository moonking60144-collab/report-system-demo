import { useMemo } from "react";
import { ALL_FILTER_VALUE } from "../../constants";
import type {
  ColumnSortRule,
  FixedFilterPresetId,
  GlobalFilters,
  SidebarPlaceholderView,
} from "../../types";
import { getDefaultSortRulesForCurrentFilters, hasActiveGlobalFilters } from "../../utils";

interface UseWorkReportListQueryControllerArgs {
  activePlaceholderViewId: SidebarPlaceholderView["id"] | null;
  activeFixedFilterPresetId: FixedFilterPresetId | null;
  currentFormId: "104" | "105";
  globalFilters: GlobalFilters;
  columnSortRules: ColumnSortRule[];
  hasActiveColumnMenuFilters: boolean;
  isColumnAnalysisOpen: boolean;
  hasActiveColumnSortRules: boolean;
}

export function useWorkReportListQueryController({
  activePlaceholderViewId,
  activeFixedFilterPresetId,
  currentFormId,
  globalFilters,
  columnSortRules,
  hasActiveColumnMenuFilters,
  isColumnAnalysisOpen,
  hasActiveColumnSortRules,
}: UseWorkReportListQueryControllerArgs) {
  const isGlobalFilterActive = useMemo(
    () => hasActiveGlobalFilters(globalFilters),
    [globalFilters]
  );

  const hasOnlyServerPreviewSortRules = useMemo(
    () =>
      columnSortRules.length === 0 ||
      columnSortRules.every(
        (rule) =>
          rule.key === "machineCode" ||
          rule.key === "sortOrder" ||
          rule.key === "lastUpdatedAt" ||
          rule.key === "plannedStartDate"
      ),
    [columnSortRules]
  );

  const shouldUseServerSidePreview = useMemo(() => {
    if (hasActiveColumnMenuFilters || isColumnAnalysisOpen) {
      return false;
    }
    if (!hasOnlyServerPreviewSortRules) {
      return false;
    }

    const hasSupportedFilters =
      globalFilters.globalKeyword.trim() !== "" ||
      globalFilters.workOrderKeyword.trim() !== "" ||
      globalFilters.customerPartKeyword.trim() !== "" ||
      globalFilters.filterMachineCode !== ALL_FILTER_VALUE ||
      globalFilters.status !== ALL_FILTER_VALUE ||
      globalFilters.ragicUnfinishedStatus !== ALL_FILTER_VALUE ||
      globalFilters.machineCode !== ALL_FILTER_VALUE ||
      globalFilters.siteRunning !== "all" ||
      globalFilters.startSchedule !== "all";
    const hasSupportedSorts =
      columnSortRules.length > 0 || activePlaceholderViewId === "last-updated";
    const hasSupportedQuickView = activePlaceholderViewId === "starred";
    return hasSupportedFilters || hasSupportedSorts || hasSupportedQuickView;
  }, [
    activePlaceholderViewId,
    columnSortRules.length,
    globalFilters.customerPartKeyword,
    globalFilters.filterMachineCode,
    globalFilters.globalKeyword,
    globalFilters.machineCode,
    globalFilters.ragicUnfinishedStatus,
    globalFilters.siteRunning,
    globalFilters.startSchedule,
    globalFilters.status,
    globalFilters.workOrderKeyword,
    hasActiveColumnMenuFilters,
    hasOnlyServerPreviewSortRules,
    isColumnAnalysisOpen,
  ]);

  const shouldUseFullHydrationForList =
    (isGlobalFilterActive && !shouldUseServerSidePreview) ||
    hasActiveColumnMenuFilters ||
    (hasActiveColumnSortRules && !hasOnlyServerPreviewSortRules) ||
    isColumnAnalysisOpen;

  const serverPreviewQuery = useMemo(() => {
    if (!shouldUseServerSidePreview) {
      return { enabled: false as const };
    }

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(todayStart);
    todayEnd.setDate(todayEnd.getDate() + 1);
    const sort = columnSortRules
      .filter(
        (rule) =>
          rule.key === "machineCode" ||
          rule.key === "sortOrder" ||
          rule.key === "lastUpdatedAt" ||
          rule.key === "plannedStartDate"
      )
      .map((rule) => `${rule.key}:${rule.direction}`)
      .join(",");

    const defaultPresetSortRules =
      columnSortRules.length === 0
        ? getDefaultSortRulesForCurrentFilters(
            currentFormId,
            globalFilters,
            activeFixedFilterPresetId
          )
        : [];
    const defaultPresetSort =
      defaultPresetSortRules.length > 0
        ? defaultPresetSortRules.map((rule) => `${rule.key}:${rule.direction}`).join(",")
        : undefined;

    return {
      enabled: true as const,
      keyword: globalFilters.globalKeyword.trim() || undefined,
      workOrderKeyword: globalFilters.workOrderKeyword.trim() || undefined,
      customerPartKeyword: globalFilters.customerPartKeyword.trim() || undefined,
      status: globalFilters.status !== ALL_FILTER_VALUE ? globalFilters.status : undefined,
      ragicUnfinishedStatus:
        globalFilters.ragicUnfinishedStatus !== ALL_FILTER_VALUE
          ? globalFilters.ragicUnfinishedStatus
          : undefined,
      machineCode:
        globalFilters.machineCode !== ALL_FILTER_VALUE ? globalFilters.machineCode : undefined,
      filterMachineCode:
        globalFilters.filterMachineCode !== ALL_FILTER_VALUE
          ? globalFilters.filterMachineCode
          : undefined,
      siteRunning: globalFilters.siteRunning,
      startSchedule: globalFilters.startSchedule,
      updatedDateFrom:
        activePlaceholderViewId === "starred" ? todayStart.toISOString() : undefined,
      updatedDateTo: activePlaceholderViewId === "starred" ? todayEnd.toISOString() : undefined,
      sort:
        sort ||
        defaultPresetSort ||
        (activePlaceholderViewId === "last-updated" ? "lastUpdatedAt:desc" : undefined),
    };
  }, [
    activeFixedFilterPresetId,
    activePlaceholderViewId,
    columnSortRules,
    currentFormId,
    globalFilters,
    shouldUseServerSidePreview,
  ]);

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
    bootstrapKeyword,
  };
}

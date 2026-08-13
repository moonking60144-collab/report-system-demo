import { useEffect, useMemo, useState } from "react";
import { ALL_FILTER_VALUE } from "../../constants";
import type {
  ColumnSortRule,
  FixedFilterPresetId,
  GlobalFilters,
  SidebarPlaceholderView,
} from "../../types";
import {
  buildUpdatedDateRangeQuery,
  getDefaultSortRulesForCurrentFilters,
  hasActiveGlobalFilters,
} from "../../utils";

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
      globalFilters.startSchedule !== "all" ||
      globalFilters.updatedDateFrom !== "" ||
      globalFilters.updatedDateTo !== "";
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
    globalFilters.updatedDateFrom,
    globalFilters.updatedDateTo,
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

    const todayStart = new Date(localDayStartTimestamp);
    const todayEnd = new Date(localDayStartTimestamp);
    todayEnd.setHours(23, 59, 59, 999);
    const updatedDateRange = buildUpdatedDateRangeQuery(globalFilters);
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
        activePlaceholderViewId === "starred"
          ? todayStart.toISOString()
          : updatedDateRange.updatedDateFrom,
      updatedDateTo:
        activePlaceholderViewId === "starred"
          ? todayEnd.toISOString()
          : updatedDateRange.updatedDateTo,
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
    localDayStartTimestamp,
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

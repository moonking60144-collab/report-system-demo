import { useCallback, useMemo } from "react";
import type {
  WorkReportFrontendEventAction,
  WorkReportFrontendEventCategory,
} from "../../debug/workReportDeveloperContract";
import {
  ALL_FILTER_VALUE,
  DEFAULT_GLOBAL_FILTERS,
  WORK_REPORT_LANDING_PAGE_CONFIGS,
} from "../../constants";
import type {
  ColumnSortRule,
  FixedFilterPresetId,
  GlobalFilters,
  NoticeState,
  SidebarMachinePreset,
  SidebarPlaceholderView,
  WorkReportLandingPageKey,
  WorkReportLocalPreferences,
} from "../../types";
import {
  cloneGlobalFilters,
  getDefaultSortBootstrapKey,
  getDefaultSortRulesForFixedPreset,
  getFixedFilterPresetFilters,
  getInitialGlobalFilters,
  hasExplicitGlobalFilterParamsInUrl,
  normalizeFilters,
  writeWorkReportLocalPreferences,
} from "../../utils";

interface ActiveFilterChip {
  key: string;
  label: string;
  removable?: boolean;
  removeActionKey?: string;
}

interface UseWorkReportListInteractionControllerArgs {
  currentFormId: "104" | "105";
  activeLandingPageKey: WorkReportLandingPageKey;
  activePlaceholderViewId: SidebarPlaceholderView["id"] | null;
  activeFixedFilterPresetId: FixedFilterPresetId | null;
  activeUnfinishedMachineShortcut: SidebarMachinePreset | null;
  globalFilters: GlobalFilters;
  globalFilterDraft: GlobalFilters;
  columnSortRules: ColumnSortRule[];
  pageScopedFiltersRef: React.MutableRefObject<
    Partial<
      Record<
        WorkReportLandingPageKey,
        {
          draft: GlobalFilters;
          applied: GlobalFilters;
          columnSortRules: ColumnSortRule[];
          activePlaceholderViewId: SidebarPlaceholderView["id"] | null;
        }
      >
    >
  >;
  localPreferences: WorkReportLocalPreferences;
  defaultPresetSortBootstrapKey: string | null;
  dismissedDefaultSortBootstrapKeysRef: React.MutableRefObject<Set<string>>;
  bootstrappedDefaultSortKeysRef: React.MutableRefObject<Set<string>>;
  syncQuickViewQuery: (viewId: SidebarPlaceholderView["id"] | null) => void;
  resetColumnFilters: () => void;
  setColumnSortRules: React.Dispatch<React.SetStateAction<ColumnSortRule[]>>;
  setGlobalFilterDraft: React.Dispatch<React.SetStateAction<GlobalFilters>>;
  setGlobalFilters: React.Dispatch<React.SetStateAction<GlobalFilters>>;
  setPage: React.Dispatch<React.SetStateAction<number>>;
  setNotice: React.Dispatch<React.SetStateAction<NoticeState | null>>;
  setActivePlaceholderViewId: React.Dispatch<
    React.SetStateAction<SidebarPlaceholderView["id"] | null>
  >;
  setActiveLandingPageKey: React.Dispatch<React.SetStateAction<WorkReportLandingPageKey>>;
  setActiveTopView: React.Dispatch<
    React.SetStateAction<"report" | "local-settings" | "technical-info">
  >;
  setMobileSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>;
  translateStatusDisplay: (status: string) => string;
  logListEvent: (
    category: WorkReportFrontendEventCategory,
    action: WorkReportFrontendEventAction,
    summary: string,
    meta?: Record<string, string | number | boolean | null | undefined | string[]>,
    level?: "info" | "warn" | "error"
  ) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

export function useWorkReportListInteractionController({
  currentFormId,
  activeLandingPageKey,
  activePlaceholderViewId,
  activeFixedFilterPresetId,
  activeUnfinishedMachineShortcut,
  globalFilters,
  globalFilterDraft,
  columnSortRules,
  pageScopedFiltersRef,
  localPreferences,
  defaultPresetSortBootstrapKey,
  dismissedDefaultSortBootstrapKeysRef,
  bootstrappedDefaultSortKeysRef,
  syncQuickViewQuery,
  resetColumnFilters,
  setColumnSortRules,
  setGlobalFilterDraft,
  setGlobalFilters,
  setPage,
  setNotice,
  setActivePlaceholderViewId,
  setActiveLandingPageKey,
  setActiveTopView,
  setMobileSidebarOpen,
  translateStatusDisplay,
  logListEvent,
  t,
}: UseWorkReportListInteractionControllerArgs) {
  const activeFilterSummaryLabel = useMemo(() => {
    if (activeUnfinishedMachineShortcut) {
      return t("workReport:sidebar.machineOpenLabel", {
        machineCode: activeUnfinishedMachineShortcut.machineCode,
      });
    }

    if (activePlaceholderViewId === "starred") {
      return t("workReport:sidebar.placeholders.starred.label");
    }

    if (activePlaceholderViewId === "last-updated") {
      return t("workReport:sidebar.placeholders.lastUpdated.label");
    }

    switch (activeFixedFilterPresetId) {
      case "unfinished-runnable":
        return t("workReport:sidebar.presets.unfinishedRunnable.label");
      case "unfinished-orders":
        return t("workReport:sidebar.presets.unfinishedOrders.label");
      case "finished-orders":
        return t("workReport:sidebar.presets.finishedOrders.label");
      case "all-data":
      default:
        return t("workReport:sidebar.presets.allData.label");
    }
  }, [activeFixedFilterPresetId, activePlaceholderViewId, activeUnfinishedMachineShortcut, t]);

  const applyFiltersAndResetView = useCallback(
    (nextFilters: GlobalFilters, options: { sortRules?: ColumnSortRule[] } = {}): void => {
      const normalizedFilters = cloneGlobalFilters(nextFilters);
      const normalizedFiltersForDraft = cloneGlobalFilters(nextFilters);
      setActivePlaceholderViewId(null);
      syncQuickViewQuery(null);
      resetColumnFilters();
      setColumnSortRules(options.sortRules ?? []);
      setGlobalFilterDraft(normalizedFiltersForDraft);
      setGlobalFilters(normalizedFilters);
      setPage(1);
    },
    [
      resetColumnFilters,
      setColumnSortRules,
      setGlobalFilterDraft,
      setGlobalFilters,
      setPage,
      setActivePlaceholderViewId,
      syncQuickViewQuery,
    ]
  );

  const applyFixedFilterPreset = useCallback(
    (presetId: FixedFilterPresetId): void => {
      const nextFilters = getFixedFilterPresetFilters(presetId, currentFormId);
      const nextSortRules = getDefaultSortRulesForFixedPreset(currentFormId, presetId);
      const nextBootstrapKey = getDefaultSortBootstrapKey(currentFormId, nextFilters, presetId);
      if (nextBootstrapKey) {
        dismissedDefaultSortBootstrapKeysRef.current.delete(nextBootstrapKey);
        bootstrappedDefaultSortKeysRef.current.delete(nextBootstrapKey);
      }
      applyFiltersAndResetView(nextFilters, { sortRules: nextSortRules });
      logListEvent("ui", "fixed-filter-applied", `套用固定篩選：${presetId}`, {
        presetId,
        changedFields: [
          "status",
          "ragicUnfinishedStatus",
          "machineCode",
          "filterMachineCode",
          "startSchedule",
        ],
      });
    },
    [
      applyFiltersAndResetView,
      bootstrappedDefaultSortKeysRef,
      currentFormId,
      dismissedDefaultSortBootstrapKeysRef,
      logListEvent,
    ]
  );

  const applyUnfinishedMachineShortcut = useCallback(
    (preset: SidebarMachinePreset): void => {
      const nextBootstrapKey = getDefaultSortBootstrapKey(currentFormId, preset.filters, null);
      if (nextBootstrapKey) {
        dismissedDefaultSortBootstrapKeysRef.current.delete(nextBootstrapKey);
        bootstrappedDefaultSortKeysRef.current.delete(nextBootstrapKey);
      }
      applyFiltersAndResetView(preset.filters, { sortRules: preset.sortRules });
      logListEvent("ui", "machine-shortcut-applied", `套用未結案機台：${preset.machineCode}`, {
        machineCode: preset.machineCode,
        changedFields: ["filterMachineCode", "ragicUnfinishedStatus", "startSchedule"],
      });
    },
    [
      applyFiltersAndResetView,
      bootstrappedDefaultSortKeysRef,
      currentFormId,
      dismissedDefaultSortBootstrapKeysRef,
      logListEvent,
    ]
  );

  const applyImmediateFilterState = useCallback(
    (
      nextFilters: GlobalFilters,
      options: { sortRules?: ColumnSortRule[]; clearPlaceholderView?: boolean } = {}
    ): void => {
      const normalized = cloneGlobalFilters(nextFilters);
      setGlobalFilterDraft(normalized);
      setGlobalFilters(normalized);
      setPage(1);
      if (options.sortRules) {
        setColumnSortRules(options.sortRules);
      }
      if (options.clearPlaceholderView) {
        setActivePlaceholderViewId(null);
        syncQuickViewQuery(null);
      }
    },
    [
      setColumnSortRules,
      setGlobalFilterDraft,
      setGlobalFilters,
      setPage,
      setActivePlaceholderViewId,
      syncQuickViewQuery,
    ]
  );

  const applyQuickViewCommonReset = useCallback((): void => {
    setActivePlaceholderViewId(null);
    syncQuickViewQuery(null);
    const clearedGlobalFilters = cloneGlobalFilters(DEFAULT_GLOBAL_FILTERS);
    setGlobalFilterDraft(clearedGlobalFilters);
    setGlobalFilters(clearedGlobalFilters);
    resetColumnFilters();
    setColumnSortRules([]);
  }, [
    resetColumnFilters,
    setActivePlaceholderViewId,
    setColumnSortRules,
    setGlobalFilterDraft,
    setGlobalFilters,
    syncQuickViewQuery,
  ]);

  const applySidebarStarredView = useCallback(
    (options: { showNotice: boolean; syncQuery: boolean }): void => {
      const { showNotice, syncQuery } = options;
      setActivePlaceholderViewId("starred");
      if (syncQuery) {
        syncQuickViewQuery("starred");
      }
      setPage(1);
      if (showNotice) {
        setNotice({
          type: "success",
          message: t("workReport:messages.sidebarQuickViewStarredApplied"),
        });
      }
    },
    [setActivePlaceholderViewId, setNotice, setPage, syncQuickViewQuery, t]
  );

  const applySidebarLastUpdatedView = useCallback(
    (options: { showNotice: boolean; syncQuery: boolean }): void => {
      const { showNotice, syncQuery } = options;
      setColumnSortRules((prev) => {
        const next = prev.filter((rule) => rule.key !== "lastUpdatedAt");
        next.unshift({
          key: "lastUpdatedAt",
          direction: "desc",
          type: "date",
        });
        return next;
      });
      setActivePlaceholderViewId("last-updated");
      if (syncQuery) {
        syncQuickViewQuery("last-updated");
      }
      if (showNotice) {
        setNotice({
          type: "success",
          message: t("workReport:messages.sidebarQuickViewLastUpdatedApplied"),
        });
      }
    },
    [setActivePlaceholderViewId, setColumnSortRules, setNotice, syncQuickViewQuery, t]
  );

  const applySidebarPlaceholderView = useCallback(
    async (
      viewId: SidebarPlaceholderView["id"],
      options: { showNotice?: boolean; syncQuery?: boolean } = {}
    ): Promise<void> => {
      const mergedOptions = {
        showNotice: options.showNotice ?? true,
        syncQuery: options.syncQuery ?? true,
      };

      applyQuickViewCommonReset();

      if (viewId === "starred") {
        applySidebarStarredView(mergedOptions);
        return;
      }

      applySidebarLastUpdatedView(mergedOptions);
    },
    [applyQuickViewCommonReset, applySidebarLastUpdatedView, applySidebarStarredView]
  );

  const handleSidebarPlaceholderViewClick = useCallback(
    async (viewId: SidebarPlaceholderView["id"]): Promise<void> => {
      logListEvent("ui", "quick-view-applied", `套用快捷視圖：${viewId}`);
      await applySidebarPlaceholderView(viewId, { showNotice: true, syncQuery: true });
    },
    [applySidebarPlaceholderView, logListEvent]
  );

  const handleRemoveActiveFilterChip = useCallback(
    (actionKey: string): void => {
      if (!actionKey.startsWith("sort:")) {
        logListEvent("ui", "filter-chip-removed", `移除條件：${actionKey}`, {
          actionKey,
        });
      }
      if (
        actionKey === "active-machine-shortcut" ||
        actionKey === "active-placeholder-starred" ||
        actionKey === "active-placeholder-last-updated" ||
        actionKey === "active-fixed-preset"
      ) {
        applyQuickViewCommonReset();
        return;
      }

      switch (actionKey) {
        case "filter-status":
          applyImmediateFilterState(
            { ...globalFilters, status: ALL_FILTER_VALUE },
            { clearPlaceholderView: true }
          );
          return;
        case "filter-machine-code":
          applyImmediateFilterState(
            { ...globalFilters, filterMachineCode: ALL_FILTER_VALUE },
            { clearPlaceholderView: true }
          );
          return;
        case "filter-main-machine-code":
          applyImmediateFilterState(
            { ...globalFilters, machineCode: ALL_FILTER_VALUE },
            { clearPlaceholderView: true }
          );
          return;
        case "filter-site-running":
          applyImmediateFilterState(
            { ...globalFilters, siteRunning: "all" },
            { clearPlaceholderView: true }
          );
          return;
        case "filter-start-schedule":
          applyImmediateFilterState(
            { ...globalFilters, startSchedule: "all" },
            { clearPlaceholderView: true }
          );
          return;
        case "filter-work-order-keyword":
          applyImmediateFilterState(
            { ...globalFilters, workOrderKeyword: "" },
            { clearPlaceholderView: true }
          );
          return;
        case "filter-customer-part-keyword":
          applyImmediateFilterState(
            { ...globalFilters, customerPartKeyword: "" },
            { clearPlaceholderView: true }
          );
          return;
        case "filter-global-keyword":
          applyImmediateFilterState(
            { ...globalFilters, globalKeyword: "" },
            { clearPlaceholderView: true }
          );
          return;
        default:
          break;
      }

      if (actionKey.startsWith("sort:")) {
        const sortIndex = Number(actionKey.slice("sort:".length));
        if (!Number.isInteger(sortIndex) || sortIndex < 0) {
          return;
        }
        const nextSortRules = columnSortRules.filter((_, index) => index !== sortIndex);
        if (nextSortRules.length === 0 && defaultPresetSortBootstrapKey) {
          dismissedDefaultSortBootstrapKeysRef.current.add(defaultPresetSortBootstrapKey);
          bootstrappedDefaultSortKeysRef.current.delete(defaultPresetSortBootstrapKey);
        }
        logListEvent("ui", "sort-chip-removed", `移除排序條件：第 ${sortIndex + 1} 順位`, {
          actionKey,
          result: nextSortRules.length === 0 ? "cleared-all" : "partial",
        });
        applyImmediateFilterState(globalFilters, {
          sortRules: nextSortRules,
          clearPlaceholderView: true,
        });
      }
    },
    [
      applyImmediateFilterState,
      applyQuickViewCommonReset,
      bootstrappedDefaultSortKeysRef,
      columnSortRules,
      defaultPresetSortBootstrapKey,
      dismissedDefaultSortBootstrapKeysRef,
      globalFilters,
      logListEvent,
    ]
  );

  const activeFilterChips = useMemo<ActiveFilterChip[]>(() => {
    const chips: ActiveFilterChip[] = [];

    if (activeUnfinishedMachineShortcut) {
      chips.push({
        key: "active-machine-shortcut",
        label: `快捷｜${t("workReport:sidebar.machineOpenLabel", {
          machineCode: activeUnfinishedMachineShortcut.machineCode,
        })}`,
        removable: true,
        removeActionKey: "active-machine-shortcut",
      });
    } else if (activePlaceholderViewId === "starred") {
      chips.push({
        key: "active-placeholder-starred",
        label: `快捷｜${t("workReport:sidebar.placeholders.starred.label")}`,
        removable: true,
        removeActionKey: "active-placeholder-starred",
      });
    } else if (activePlaceholderViewId === "last-updated") {
      chips.push({
        key: "active-placeholder-last-updated",
        label: `快捷｜${t("workReport:sidebar.placeholders.lastUpdated.label")}`,
        removable: true,
        removeActionKey: "active-placeholder-last-updated",
      });
    } else if (activeFixedFilterPresetId) {
      chips.push({
        key: "active-fixed-preset",
        label: `固定｜${activeFilterSummaryLabel || t("workReport:sidebar.presets.allData.label")}`,
        removable: true,
        removeActionKey: "active-fixed-preset",
      });
    }

    if (globalFilters.status !== ALL_FILTER_VALUE) {
      chips.push({
        key: "filter-status",
        label: `工令狀態｜${translateStatusDisplay(globalFilters.status)}`,
        removable: true,
        removeActionKey: "filter-status",
      });
    }

    if (globalFilters.filterMachineCode !== ALL_FILTER_VALUE) {
      chips.push({
        key: "filter-machine-code",
        label: `機台｜${globalFilters.filterMachineCode}`,
        removable: true,
        removeActionKey: "filter-machine-code",
      });
    }

    if (globalFilters.machineCode !== ALL_FILTER_VALUE) {
      chips.push({
        key: "filter-main-machine-code",
        label: `主機台｜${globalFilters.machineCode}`,
        removable: true,
        removeActionKey: "filter-main-machine-code",
      });
    }

    if (globalFilters.siteRunning !== "all") {
      chips.push({
        key: "filter-site-running",
        label: `本站｜${globalFilters.siteRunning === "yes" ? t("common:yesNo.yes") : t("common:yesNo.no")}`,
        removable: true,
        removeActionKey: "filter-site-running",
      });
    }

    if (globalFilters.startSchedule !== "all") {
      chips.push({
        key: "filter-start-schedule",
        label: `開始排程｜${globalFilters.startSchedule === "yes" ? t("common:yesNo.yes") : t("common:yesNo.no")}`,
        removable: true,
        removeActionKey: "filter-start-schedule",
      });
    }

    if (globalFilters.workOrderKeyword.trim()) {
      chips.push({
        key: "filter-work-order-keyword",
        label: `工令單號｜${globalFilters.workOrderKeyword.trim()}`,
        removable: true,
        removeActionKey: "filter-work-order-keyword",
      });
    }

    if (globalFilters.customerPartKeyword.trim()) {
      chips.push({
        key: "filter-customer-part-keyword",
        label: `客戶料號｜${globalFilters.customerPartKeyword.trim()}`,
        removable: true,
        removeActionKey: "filter-customer-part-keyword",
      });
    }

    if (globalFilters.globalKeyword.trim()) {
      chips.push({
        key: "filter-global-keyword",
        label: `全域搜尋｜${globalFilters.globalKeyword.trim()}`,
        removable: true,
        removeActionKey: "filter-global-keyword",
      });
    }

    const sortKeyLabelMap: Record<string, string> = {
      machineCode: "機台",
      sortOrder: "排序",
      lastUpdatedAt: "最後修改",
      plannedStartDate: "指定開始日",
    };
    columnSortRules.forEach((rule, index) => {
      chips.push({
        key: `sort-${rule.key}-${index}`,
        label: `排序｜${sortKeyLabelMap[rule.key] ?? rule.key} 第${index + 1}順位 ${
          rule.direction === "asc" ? "↑" : "↓"
        }`,
        removable: true,
        removeActionKey: `sort:${index}`,
      });
    });

    if (chips.length === 0) {
      chips.push({
        key: "filter-all-data",
        label: `固定｜${t("workReport:sidebar.presets.allData.label")}`,
      });
    }

    return chips;
  }, [
    activeFilterSummaryLabel,
    activeFixedFilterPresetId,
    activePlaceholderViewId,
    activeUnfinishedMachineShortcut,
    columnSortRules,
    globalFilters,
    t,
    translateStatusDisplay,
  ]);

  const handleApplyFilters = useCallback((): void => {
    const normalized = normalizeFilters(globalFilterDraft);
    setActivePlaceholderViewId(null);
    syncQuickViewQuery(null);
    setGlobalFilterDraft(normalized);
    setPage(1);
    setGlobalFilters(normalized);
    logListEvent("ui", "filters-applied", "套用篩選條件", {
      changedFields: Object.entries(normalized)
        .filter(
          ([, value]) => String(value ?? "").trim() !== "" && value !== ALL_FILTER_VALUE && value !== "all"
        )
        .map(([key]) => key),
    });
  }, [
    globalFilterDraft,
    logListEvent,
    setActivePlaceholderViewId,
    setGlobalFilterDraft,
    setGlobalFilters,
    setPage,
    syncQuickViewQuery,
  ]);

  const handleClearFilters = useCallback((): void => {
    setActivePlaceholderViewId(null);
    syncQuickViewQuery(null);
    setGlobalFilterDraft(DEFAULT_GLOBAL_FILTERS);
    setGlobalFilters(DEFAULT_GLOBAL_FILTERS);
    resetColumnFilters();
    setPage(1);
    logListEvent("ui", "filters-cleared", "清除篩選條件");
  }, [
    logListEvent,
    resetColumnFilters,
    setActivePlaceholderViewId,
    setGlobalFilterDraft,
    setGlobalFilters,
    setPage,
    syncQuickViewQuery,
  ]);

  const handleSaveLocalSettings = useCallback(() => {
    writeWorkReportLocalPreferences(localPreferences);
    const nextInitialFilters = getInitialGlobalFilters(localPreferences.defaultLandingPageKey);
    setGlobalFilterDraft(nextInitialFilters);
    setGlobalFilters(nextInitialFilters);
    setPage(1);
    setNotice({ type: "success", message: t("workReport:messages.localSettingsSaved") });
    setActiveLandingPageKey(localPreferences.defaultLandingPageKey);
    setActiveTopView("report");
    logListEvent("ui", "local-settings-saved", "本機設定已儲存", {
      defaultLandingPageKey: localPreferences.defaultLandingPageKey,
    });
  }, [
    localPreferences,
    logListEvent,
    setActiveLandingPageKey,
    setActiveTopView,
    setGlobalFilterDraft,
    setGlobalFilters,
    setNotice,
    setPage,
    t,
  ]);

  const handleOpenLandingPage = useCallback(
    (nextLandingPageKey: WorkReportLandingPageKey): void => {
      const nextLandingPageConfig = WORK_REPORT_LANDING_PAGE_CONFIGS[nextLandingPageKey];
      const hasScopedFilters = Boolean(pageScopedFiltersRef.current[nextLandingPageKey]);
      const shouldResetPresetOnSelect =
        Boolean(nextLandingPageConfig.resetPresetIdOnSelect) &&
        !hasScopedFilters &&
        !hasExplicitGlobalFilterParamsInUrl();

      if (shouldResetPresetOnSelect && nextLandingPageConfig.resetPresetIdOnSelect) {
        const nextFilters = getFixedFilterPresetFilters(
          nextLandingPageConfig.resetPresetIdOnSelect,
          nextLandingPageConfig.formId
        );
        pageScopedFiltersRef.current[nextLandingPageKey] = {
          draft: cloneGlobalFilters(nextFilters),
          applied: cloneGlobalFilters(nextFilters),
          columnSortRules: getDefaultSortRulesForFixedPreset(
            nextLandingPageConfig.formId,
            nextLandingPageConfig.resetPresetIdOnSelect
          ),
          activePlaceholderViewId: null,
        };

        if (activeLandingPageKey === nextLandingPageKey) {
          setGlobalFilterDraft(cloneGlobalFilters(nextFilters));
          setGlobalFilters(cloneGlobalFilters(nextFilters));
          setPage(1);
        }
      }

      setActiveLandingPageKey(nextLandingPageKey);
      setActiveTopView("report");
      setActivePlaceholderViewId(null);
      syncQuickViewQuery(null);
      logListEvent("navigation", "landing-page-opened", `切換頁面：${nextLandingPageKey}`, {
        landingPageKey: nextLandingPageKey,
      });
    },
    [
      activeLandingPageKey,
      logListEvent,
      pageScopedFiltersRef,
      setActiveLandingPageKey,
      setActivePlaceholderViewId,
      setActiveTopView,
      setGlobalFilterDraft,
      setGlobalFilters,
      setPage,
      syncQuickViewQuery,
    ]
  );

  const openTechnicalInfoView = useCallback(() => {
    setActiveTopView("technical-info");
    logListEvent("navigation", "top-view-opened", "切換到技術資訊", {
      topView: "technical-info",
    });
  }, [logListEvent, setActiveTopView]);

  const openLocalSettingsView = useCallback(() => {
    setActiveTopView("local-settings");
    logListEvent("navigation", "top-view-opened", "切換到本機設定", {
      topView: "local-settings",
    });
  }, [logListEvent, setActiveTopView]);

  const openMobileFilters = useCallback(() => {
    setMobileSidebarOpen(true);
    logListEvent("ui", "mobile-fixed-filters-opened", "開啟手機版固定篩選");
  }, [logListEvent, setMobileSidebarOpen]);

  return {
    applyFixedFilterPreset,
    applyUnfinishedMachineShortcut,
    handleSidebarPlaceholderViewClick,
    handleRemoveActiveFilterChip,
    activeFilterChips,
    handleApplyFilters,
    handleClearFilters,
    handleSaveLocalSettings,
    handleOpenLandingPage,
    openTechnicalInfoView,
    openLocalSettingsView,
    openMobileFilters,
    applySidebarPlaceholderView,
  };
}

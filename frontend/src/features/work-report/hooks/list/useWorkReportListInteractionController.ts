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
  ColumnKey,
  ColumnSortRule,
  FixedFilterPresetId,
  GlobalFilters,
  NoticeState,
  SidebarMachinePreset,
  SidebarPlaceholderView,
  WorkReportLandingPageKey,
  WorkReportLocalPreferences,
  WorkReportFilterGroup,
} from "../../types";
import {
  applyFixedFilterPresetToGlobalFilters,
  applyMachineShortcutToGlobalFilters,
  cloneGlobalFilters,
  getDefaultSortBootstrapKey,
  getDefaultSortRulesForFixedPreset,
  getFixedFilterPresetFilters,
  getInitialGlobalFilters,
  hasExplicitGlobalFilterParamsInUrl,
  isValidUpdatedDateRange,
  normalizeGlobalFiltersForForm,
  normalizeWorkReportFilterGroup,
  EMPTY_WORK_REPORT_FILTER_GROUP,
  writeWorkReportLocalPreferences,
} from "../../utils";

interface ActiveFilterChip {
  key: string;
  label: string;
  removable?: boolean;
  removeActionKey?: string;
}

interface UseWorkReportListInteractionControllerArgs {
  currentFormId: "901" | "902";
  activeLandingPageKey: WorkReportLandingPageKey;
  activePlaceholderViewId: SidebarPlaceholderView["id"] | null;
  globalFilters: GlobalFilters;
  globalFilterDraft: GlobalFilters;
  customFilterDraft: WorkReportFilterGroup;
  columnSortRules: ColumnSortRule[];
  pageScopedFiltersRef: React.MutableRefObject<
    Partial<
      Record<
        WorkReportLandingPageKey,
        {
          draft: GlobalFilters;
          applied: GlobalFilters;
          columnSortRules: ColumnSortRule[];
          customFilterDraft: WorkReportFilterGroup;
          customFilters: WorkReportFilterGroup;
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
  clearColumnFilter: (columnKey: ColumnKey) => void;
  setColumnSortRules: React.Dispatch<React.SetStateAction<ColumnSortRule[]>>;
  setGlobalFilterDraft: React.Dispatch<React.SetStateAction<GlobalFilters>>;
  setGlobalFilters: React.Dispatch<React.SetStateAction<GlobalFilters>>;
  setCustomFilterDraft: React.Dispatch<React.SetStateAction<WorkReportFilterGroup>>;
  setCustomFilters: React.Dispatch<React.SetStateAction<WorkReportFilterGroup>>;
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
  globalFilters,
  globalFilterDraft,
  customFilterDraft,
  columnSortRules,
  pageScopedFiltersRef,
  localPreferences,
  defaultPresetSortBootstrapKey,
  dismissedDefaultSortBootstrapKeysRef,
  bootstrappedDefaultSortKeysRef,
  syncQuickViewQuery,
  resetColumnFilters,
  clearColumnFilter,
  setColumnSortRules,
  setGlobalFilterDraft,
  setGlobalFilters,
  setCustomFilterDraft,
  setCustomFilters,
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
  const applyFiltersAndResetView = useCallback(
    (nextFilters: GlobalFilters, options: { sortRules?: ColumnSortRule[] } = {}): void => {
      const normalizedFilters = cloneGlobalFilters(nextFilters);
      const normalizedFiltersForDraft = cloneGlobalFilters(nextFilters);
      setActivePlaceholderViewId(null);
      syncQuickViewQuery(null);
      setCustomFilterDraft(EMPTY_WORK_REPORT_FILTER_GROUP);
      setCustomFilters(EMPTY_WORK_REPORT_FILTER_GROUP);
      setColumnSortRules(options.sortRules ?? []);
      setGlobalFilterDraft(normalizedFiltersForDraft);
      setGlobalFilters(normalizedFilters);
      setPage(1);
    },
    [
      setColumnSortRules,
      setCustomFilterDraft,
      setCustomFilters,
      setGlobalFilterDraft,
      setGlobalFilters,
      setPage,
      setActivePlaceholderViewId,
      syncQuickViewQuery,
    ]
  );

  const applyFixedFilterPreset = useCallback(
    (presetId: FixedFilterPresetId): void => {
      const nextFilters = applyFixedFilterPresetToGlobalFilters(
        presetId,
        currentFormId
      );
      const nextSortRules = getDefaultSortRulesForFixedPreset(currentFormId, presetId);
      const nextBootstrapKey = getDefaultSortBootstrapKey(currentFormId, nextFilters, presetId);
      if (nextBootstrapKey) {
        dismissedDefaultSortBootstrapKeysRef.current.delete(nextBootstrapKey);
        bootstrappedDefaultSortKeysRef.current.delete(nextBootstrapKey);
      }
      resetColumnFilters();
      applyFiltersAndResetView(nextFilters, { sortRules: nextSortRules });
      logListEvent("ui", "fixed-filter-applied", `套用固定篩選：${presetId}`, {
        presetId,
        changedFields: [
          "globalKeyword",
          "workOrderKeyword",
          "customerPartKeyword",
          "machineCode",
          "filterMachineCode",
          "status",
          "ragicUnfinishedStatus",
          "siteRunning",
          "startSchedule",
          "updatedDateFrom",
          "updatedDateTo",
        ],
      });
    },
    [
      applyFiltersAndResetView,
      bootstrappedDefaultSortKeysRef,
      currentFormId,
      dismissedDefaultSortBootstrapKeysRef,
      logListEvent,
      resetColumnFilters,
    ]
  );

  const applyUnfinishedMachineShortcut = useCallback(
    (preset: SidebarMachinePreset): void => {
      const nextFilters = applyMachineShortcutToGlobalFilters(
        preset.filters,
        currentFormId
      );
      const nextBootstrapKey = getDefaultSortBootstrapKey(currentFormId, nextFilters, null);
      if (nextBootstrapKey) {
        dismissedDefaultSortBootstrapKeysRef.current.delete(nextBootstrapKey);
        bootstrappedDefaultSortKeysRef.current.delete(nextBootstrapKey);
      }
      resetColumnFilters();
      applyFiltersAndResetView(nextFilters, { sortRules: preset.sortRules });
      logListEvent("ui", "machine-shortcut-applied", `套用未結案機台：${preset.machineCode}`, {
        machineCode: preset.machineCode,
        changedFields: [
          "globalKeyword",
          "workOrderKeyword",
          "customerPartKeyword",
          "machineCode",
          "filterMachineCode",
          "status",
          "ragicUnfinishedStatus",
          "siteRunning",
          "startSchedule",
          "updatedDateFrom",
          "updatedDateTo",
        ],
      });
    },
    [
      applyFiltersAndResetView,
      bootstrappedDefaultSortKeysRef,
      currentFormId,
      dismissedDefaultSortBootstrapKeysRef,
      logListEvent,
      resetColumnFilters,
    ]
  );

  const applyImmediateFilterState = useCallback(
    (
      nextFilters: GlobalFilters,
      options: {
        sortRules?: ColumnSortRule[];
        clearPlaceholderView?: boolean;
        draftPatch?: Partial<GlobalFilters>;
        preserveDraft?: boolean;
      } = {}
    ): void => {
      const normalized = cloneGlobalFilters(nextFilters);
      if (options.draftPatch || options.preserveDraft) {
        setGlobalFilterDraft((previous) =>
          cloneGlobalFilters({ ...previous, ...options.draftPatch })
        );
      } else {
        setGlobalFilterDraft(normalized);
      }
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
    setCustomFilterDraft(EMPTY_WORK_REPORT_FILTER_GROUP);
    setCustomFilters(EMPTY_WORK_REPORT_FILTER_GROUP);
    setColumnSortRules([]);
  }, [
    setCustomFilterDraft,
    setCustomFilters,
    setActivePlaceholderViewId,
    setColumnSortRules,
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
            { clearPlaceholderView: true, draftPatch: { status: ALL_FILTER_VALUE } }
          );
          return;
        case "filter-ragic-unfinished-status":
          applyImmediateFilterState(
            { ...globalFilters, ragicUnfinishedStatus: ALL_FILTER_VALUE },
            {
              clearPlaceholderView: true,
              draftPatch: { ragicUnfinishedStatus: ALL_FILTER_VALUE },
            }
          );
          return;
        case "filter-machine-code":
          applyImmediateFilterState(
            { ...globalFilters, filterMachineCode: ALL_FILTER_VALUE },
            { clearPlaceholderView: true, draftPatch: { filterMachineCode: ALL_FILTER_VALUE } }
          );
          return;
        case "filter-main-machine-code":
          applyImmediateFilterState(
            { ...globalFilters, machineCode: ALL_FILTER_VALUE },
            { clearPlaceholderView: true, draftPatch: { machineCode: ALL_FILTER_VALUE } }
          );
          return;
        case "filter-site-running":
          applyImmediateFilterState(
            { ...globalFilters, siteRunning: "all" },
            { clearPlaceholderView: true, draftPatch: { siteRunning: "all" } }
          );
          return;
        case "filter-start-schedule":
          applyImmediateFilterState(
            { ...globalFilters, startSchedule: "all" },
            { clearPlaceholderView: true, draftPatch: { startSchedule: "all" } }
          );
          return;
        case "filter-work-order-keyword":
          applyImmediateFilterState(
            { ...globalFilters, workOrderKeyword: "" },
            { clearPlaceholderView: true, draftPatch: { workOrderKeyword: "" } }
          );
          return;
        case "filter-customer-part-keyword":
          applyImmediateFilterState(
            { ...globalFilters, customerPartKeyword: "" },
            { clearPlaceholderView: true, draftPatch: { customerPartKeyword: "" } }
          );
          return;
        case "filter-global-keyword":
          applyImmediateFilterState(
            { ...globalFilters, globalKeyword: "" },
            { clearPlaceholderView: true, draftPatch: { globalKeyword: "" } }
          );
          return;
        case "filter-updated-date-from":
          applyImmediateFilterState(
            { ...globalFilters, updatedDateFrom: "" },
            { clearPlaceholderView: true, draftPatch: { updatedDateFrom: "" } }
          );
          return;
        case "filter-updated-date-to":
          applyImmediateFilterState(
            { ...globalFilters, updatedDateTo: "" },
            { clearPlaceholderView: true, draftPatch: { updatedDateTo: "" } }
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
          preserveDraft: true,
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

    if (activePlaceholderViewId === "starred") {
      chips.push({
        key: "active-placeholder-starred",
        label: `${t("workReport:filters.updatedDateRange")}｜${t(
          "workReport:sidebar.placeholders.starred.shortLabel"
        )}`,
        removable: true,
        removeActionKey: "active-placeholder-starred",
      });
    }

    if (globalFilters.status !== ALL_FILTER_VALUE) {
      chips.push({
        key: "filter-status",
        label: `${t("workReport:filters.workOrderStatus")}｜${translateStatusDisplay(
          globalFilters.status
        )}`,
        removable: true,
        removeActionKey: "filter-status",
      });
    }

    if (globalFilters.ragicUnfinishedStatus !== ALL_FILTER_VALUE) {
      chips.push({
        key: "filter-ragic-unfinished-status",
        label: `${t("workReport:filters.unfinishedJudgment")}｜${globalFilters.ragicUnfinishedStatus}`,
        removable: true,
        removeActionKey: "filter-ragic-unfinished-status",
      });
    }

    if (globalFilters.filterMachineCode !== ALL_FILTER_VALUE) {
      chips.push({
        key: "filter-machine-code",
        label: `${t("workReport:filters.machine")}｜${globalFilters.filterMachineCode}`,
        removable: true,
        removeActionKey: "filter-machine-code",
      });
    }

    if (globalFilters.machineCode !== ALL_FILTER_VALUE) {
      chips.push({
        key: "filter-main-machine-code",
        label: `${t("workReport:filters.machine")}｜${globalFilters.machineCode}`,
        removable: true,
        removeActionKey: "filter-main-machine-code",
      });
    }

    if (globalFilters.siteRunning !== "all") {
      chips.push({
        key: "filter-site-running",
        label: `${t("workReport:filters.siteRunning")}｜${
          globalFilters.siteRunning === "yes" ? t("common:yesNo.yes") : t("common:yesNo.no")
        }`,
        removable: true,
        removeActionKey: "filter-site-running",
      });
    }

    if (globalFilters.startSchedule !== "all") {
      chips.push({
        key: "filter-start-schedule",
        label: `${t("workReport:filters.startSchedule")}｜${
          globalFilters.startSchedule === "yes" ? t("common:yesNo.yes") : t("common:yesNo.no")
        }`,
        removable: true,
        removeActionKey: "filter-start-schedule",
      });
    }

    if (globalFilters.workOrderKeyword.trim()) {
      chips.push({
        key: "filter-work-order-keyword",
        label: `${t("workReport:filters.workOrderNo")}｜${globalFilters.workOrderKeyword.trim()}`,
        removable: true,
        removeActionKey: "filter-work-order-keyword",
      });
    }

    if (globalFilters.customerPartKeyword.trim()) {
      chips.push({
        key: "filter-customer-part-keyword",
        label: `${t("workReport:filters.customerPartNo")}｜${globalFilters.customerPartKeyword.trim()}`,
        removable: true,
        removeActionKey: "filter-customer-part-keyword",
      });
    }

    if (globalFilters.globalKeyword.trim()) {
      chips.push({
        key: "filter-global-keyword",
        label: `${t("workReport:filters.globalSearch")}｜${globalFilters.globalKeyword.trim()}`,
        removable: true,
        removeActionKey: "filter-global-keyword",
      });
    }

    if (globalFilters.updatedDateFrom) {
      chips.push({
        key: "filter-updated-date-from",
        label: `${t("workReport:filters.updatedDateFrom")}｜${globalFilters.updatedDateFrom}`,
        removable: true,
        removeActionKey: "filter-updated-date-from",
      });
    }

    if (globalFilters.updatedDateTo) {
      chips.push({
        key: "filter-updated-date-to",
        label: `${t("workReport:filters.updatedDateTo")}｜${globalFilters.updatedDateTo}`,
        removable: true,
        removeActionKey: "filter-updated-date-to",
      });
    }

    return chips;
  }, [
    activePlaceholderViewId,
    globalFilters,
    t,
    translateStatusDisplay,
  ]);

  const handleApplyFilters = useCallback((draft?: {
    globalFilters: GlobalFilters;
    filterGroup: WorkReportFilterGroup;
    sortRules: ColumnSortRule[];
    resetColumns: boolean;
    clearMachineColumn: boolean;
  }): boolean => {
    const normalized = normalizeGlobalFiltersForForm(draft?.globalFilters ?? globalFilterDraft, currentFormId);
    if (!isValidUpdatedDateRange(normalized)) {
      setNotice({
        type: "error",
        message: t("workReport:filters.invalidUpdatedDateRange"),
      });
      return false;
    }
    const normalizedCustomFilters = normalizeWorkReportFilterGroup(draft?.filterGroup ?? customFilterDraft);
    const selectedMachine =
      currentFormId === "902" ? normalized.filterMachineCode : normalized.machineCode;
    if (
      selectedMachine !== ALL_FILTER_VALUE ||
      normalizedCustomFilters.conditions.some((condition) => condition.field === "machineCode")
    ) {
      clearColumnFilter(currentFormId === "902" ? "filterMachineCode" : "machineCode");
    }
    const nextGlobalFilters =
      normalizedCustomFilters.conditions.length > 0
        ? {
            ...DEFAULT_GLOBAL_FILTERS,
            globalKeyword: normalized.globalKeyword,
            ragicUnfinishedStatus: normalized.ragicUnfinishedStatus,
          }
        : normalized;
    if (draft?.resetColumns) resetColumnFilters();
    else if (draft?.clearMachineColumn) clearColumnFilter(currentFormId === "902" ? "filterMachineCode" : "machineCode");
    if (draft) {
      setColumnSortRules(draft.sortRules);
      if (draft.sortRules.length === 0 && defaultPresetSortBootstrapKey) {
        dismissedDefaultSortBootstrapKeysRef.current.add(defaultPresetSortBootstrapKey);
        bootstrappedDefaultSortKeysRef.current.delete(defaultPresetSortBootstrapKey);
      }
    }
    setActivePlaceholderViewId(null);
    syncQuickViewQuery(null);
    setCustomFilterDraft(normalizedCustomFilters);
    setCustomFilters(normalizedCustomFilters);
    setGlobalFilterDraft(nextGlobalFilters);
    setPage(1);
    setGlobalFilters(nextGlobalFilters);
    logListEvent("ui", "filters-applied", "套用篩選條件", {
      changedFields: [
        ...Object.entries(nextGlobalFilters)
          .filter(
            ([, value]) => String(value ?? "").trim() !== "" && value !== ALL_FILTER_VALUE && value !== "all"
          )
          .map(([key]) => key),
        ...normalizedCustomFilters.conditions.map((condition) => condition.field),
      ],
    });
    return true;
  }, [
    resetColumnFilters, setColumnSortRules, defaultPresetSortBootstrapKey, dismissedDefaultSortBootstrapKeysRef, bootstrappedDefaultSortKeysRef,
    globalFilterDraft,
    customFilterDraft,
    clearColumnFilter,
    currentFormId,
    logListEvent,
    setActivePlaceholderViewId,
    setGlobalFilterDraft,
    setGlobalFilters,
    setCustomFilterDraft,
    setCustomFilters,
    setNotice,
    setPage,
    syncQuickViewQuery,
    t,
  ]);

  const handleClearFilters = useCallback((): void => {
    setActivePlaceholderViewId(null);
    syncQuickViewQuery(null);
    setGlobalFilterDraft(DEFAULT_GLOBAL_FILTERS);
    setGlobalFilters(DEFAULT_GLOBAL_FILTERS);
    setCustomFilterDraft(EMPTY_WORK_REPORT_FILTER_GROUP);
    setCustomFilters(EMPTY_WORK_REPORT_FILTER_GROUP);
    resetColumnFilters();
    setPage(1);
    logListEvent("ui", "filters-cleared", "清除篩選條件");
  }, [
    logListEvent,
    resetColumnFilters,
    setActivePlaceholderViewId,
    setGlobalFilterDraft,
    setGlobalFilters,
    setCustomFilterDraft,
    setCustomFilters,
    setPage,
    syncQuickViewQuery,
  ]);

  const handleApplySavedFilter = useCallback(
    (filterGroup: WorkReportFilterGroup, sortRules: ColumnSortRule[]): void => {
      const normalized = normalizeWorkReportFilterGroup(filterGroup);
      if (normalized.conditions.length === 0) {
        return;
      }
      setActivePlaceholderViewId(null);
      syncQuickViewQuery(null);
      resetColumnFilters();
      setGlobalFilterDraft(DEFAULT_GLOBAL_FILTERS);
      setGlobalFilters(DEFAULT_GLOBAL_FILTERS);
      setCustomFilterDraft(normalized);
      setCustomFilters(normalized);
      setColumnSortRules(sortRules.map((rule) => ({ ...rule })));
      setPage(1);
      logListEvent("ui", "filters-applied", "套用已儲存篩選", {
        changedFields: normalized.conditions.map((condition) => condition.field),
      });
    },
    [
      logListEvent,
      resetColumnFilters,
      setActivePlaceholderViewId,
      setColumnSortRules,
      setCustomFilterDraft,
      setCustomFilters,
      setGlobalFilterDraft,
      setGlobalFilters,
      setPage,
      syncQuickViewQuery,
    ]
  );

  const handleSaveLocalSettings = useCallback(() => {
    if (!writeWorkReportLocalPreferences(localPreferences)) {
      setNotice({ type: "error", message: t("workReport:messages.localSettingsSaveFailed") });
      return false;
    }
    const nextInitialFilters = getInitialGlobalFilters(localPreferences.defaultLandingPageKey);
    setGlobalFilterDraft(nextInitialFilters);
    setGlobalFilters(nextInitialFilters);
    setCustomFilterDraft(EMPTY_WORK_REPORT_FILTER_GROUP);
    setCustomFilters(EMPTY_WORK_REPORT_FILTER_GROUP);
    setPage(1);
    setNotice({ type: "success", message: t("workReport:messages.localSettingsSaved") });
    setActiveLandingPageKey(localPreferences.defaultLandingPageKey);
    setActiveTopView("report");
    logListEvent("ui", "local-settings-saved", "本機設定已儲存", {
      defaultLandingPageKey: localPreferences.defaultLandingPageKey,
    });
    return true;
  }, [
    localPreferences,
    logListEvent,
    setActiveLandingPageKey,
    setActiveTopView,
    setGlobalFilterDraft,
    setGlobalFilters,
    setCustomFilterDraft,
    setCustomFilters,
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
          customFilterDraft: EMPTY_WORK_REPORT_FILTER_GROUP,
          customFilters: EMPTY_WORK_REPORT_FILTER_GROUP,
          activePlaceholderViewId: null,
        };

        if (activeLandingPageKey === nextLandingPageKey) {
          setGlobalFilterDraft(cloneGlobalFilters(nextFilters));
          setGlobalFilters(cloneGlobalFilters(nextFilters));
          setCustomFilterDraft(EMPTY_WORK_REPORT_FILTER_GROUP);
          setCustomFilters(EMPTY_WORK_REPORT_FILTER_GROUP);
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
      setCustomFilterDraft,
      setCustomFilters,
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
    handleApplySavedFilter,
    handleSaveLocalSettings,
    handleOpenLandingPage,
    openTechnicalInfoView,
    openLocalSettingsView,
    openMobileFilters,
    applySidebarPlaceholderView,
  };
}

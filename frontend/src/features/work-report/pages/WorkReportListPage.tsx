import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Modal } from "antd";
import "../../../App.css";
import { FixedFilterSidebar } from "../components/FixedFilterSidebar";
import { WorkReportSyncProgressModal } from "../components/WorkReportSyncProgressModal";
import { WorkReportToolbar } from "../components/WorkReportToolbar";
import { WorkReportWorkspaceToolbar } from "../components/WorkReportWorkspaceToolbar";
import { WorkReportFilterDrawer } from "../components/WorkReportFilterDrawer";
import { PendingBatchTasksBadge } from "../components/PendingBatchTasksBadge";
import { WorkReportStatusArea } from "../components/WorkReportStatusArea";
import { WorkReportTableSection } from "../components/WorkReportTableSection";
import { ColumnTextFilterDialog } from "../components/ColumnTextFilterDialog";
import { ColumnAnalysisDrawer } from "../components/ColumnAnalysisDrawer";
import { WorkReportLocalSettingsPanel } from "../components/WorkReportLocalSettingsPanel";
import { WorkReportTaskQueueDrawer } from "../components/WorkReportTaskQueueDrawer";
import { useWorkReportTaskMonitorContext } from "../context/useWorkReportTaskMonitorContext";
import { useWorkReportViewState } from "../hooks/useWorkReportViewState";
import { useColumnMenuState } from "../hooks/useColumnMenuState";
import {
  buildScopedWorkReportRecords,
  runWorkReportRecordPipeline,
  useWorkReportDataPipeline,
} from "../hooks/useWorkReportDataPipeline";
import { useWorkReportColumns } from "../hooks/useWorkReportColumns";
import { useWorkReportListNavigation } from "../hooks/useWorkReportListNavigation";
import { useWorkReportMarkedRow } from "../hooks/useWorkReportMarkedRow";
import {
  useWorkReportListData,
  type PreviewReadMetric,
} from "../hooks/useWorkReportListData";
import { useWorkReportListDataSync } from "../hooks/useWorkReportListDataSync";
import { useWorkReportListEffectsController } from "../hooks/list/useWorkReportListEffectsController";
import { useWorkReportListEventLogger } from "../hooks/list/useWorkReportListEventLogger";
import { useWorkReportListInteractionController } from "../hooks/list/useWorkReportListInteractionController";
import { useWorkReportListLandingController } from "../hooks/list/useWorkReportListLandingController";
import {
  selectEntryFieldMutationAuthoritativeRecords,
  useWorkReportListMutationTaskController,
} from "../hooks/list/useWorkReportListMutationTaskController";
import { useWorkReportListPresetController } from "../hooks/list/useWorkReportListPresetController";
import { useWorkReportListQueryController } from "../hooks/list/useWorkReportListQueryController";
import { useWorkReportListRefreshController } from "../hooks/list/useWorkReportListRefreshController";
import { useWorkReportListStatusController } from "../hooks/list/useWorkReportListStatusController";
import { useWorkReportListTableLayoutController } from "../hooks/list/useWorkReportListTableLayoutController";
import { useWorkReportListViewController } from "../hooks/list/useWorkReportListViewController";
import { useWorkReportListUrlSync } from "../hooks/list/useWorkReportListUrlSync";
import { useWorkReportClientPresence } from "../hooks/useWorkReportClientPresence";
import { useWorkReportSessionExpiryGuard } from "../hooks/useWorkReportSessionExpiryGuard";
import { WORK_REPORT_LANDING_PAGE_CONFIGS } from "../constants";
import type {
  NoticeState,
  SidebarPlaceholderView,
  UiLanguage,
  WorkReportLocalPreferences,
  WorkReportListLocationState,
  WorkReportFilterGroup,
} from "../types";
import {
  buildWorkReportFilterGroupFromGlobalFilters,
  cloneWorkReportFilterGroup,
  countActiveColumnFilters,
  countActiveGlobalFilters,
  EMPTY_WORK_REPORT_FILTER_GROUP,
  getErrorMessage,
  isSameGlobalFilters,
  isSameWorkReportFilterGroup,
  normalizeColumnFilterStateForForm,
  normalizeColumnSortRulesForForm,
  parseColumnSortRulesFromSearch,
  resolveWorkReportListLocationState,
  readWorkReportLocalPreferences,
} from "../utils";
import { translateWorkOrderStatusValue } from "../../../i18n/valueMappers";
import {
  fetchFormOptions,
  fetchWorkReportBlockingScheduleMutationSummary,
  type FormOptionItem,
} from "../../../api/workReport";
import {
  buildWorkReportPrintDocument,
  buildWorkReportPrintLoadingDocument,
  fetchWorkReportPrintRecords,
  isWorkReportPrintBlockedByScheduleMutation,
  isWorkReportPrintRecordCountAllowed,
  WORK_REPORT_PRINT_MAX_RECORDS,
  writeWorkReportPrintWindow,
} from "../workReportPrint";
import { createWorkReportPrintSession } from "../workReportPrintSession";
import {
  readWorkReportDeviceLabel,
  writeWorkReportDeviceLabel,
} from "../../../utils/clientIdentity";
import { preloadWorkReportDetailPage } from "../routes/workReportRouteLoaders";
import { shouldCloseFilterDrawerFromBackgroundClick } from "../filterDrawerInteraction";

export function WorkReportListPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const submitting = false;
  const [initialListLocationState] = useState<WorkReportListLocationState | undefined>(() => {
    const locationState = (location.state as WorkReportListLocationState | null) ?? null;
    return resolveWorkReportListLocationState(locationState, location.search, null);
  });
  const initialListViewState = initialListLocationState?.listViewState;
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [highlightedEntryId, setHighlightedEntryId] = useState<string | null>(null);
  const [activePlaceholderViewId, setActivePlaceholderViewId] = useState<SidebarPlaceholderView["id"] | null>(
    initialListViewState?.activePlaceholderViewId ?? null
  );
  const [localPreferences, setLocalPreferences] = useState<WorkReportLocalPreferences>(() =>
    readWorkReportLocalPreferences()
  );
  const [deviceLabel, setDeviceLabel] = useState(() => readWorkReportDeviceLabel());
  const [taskQueueOpen, setTaskQueueOpen] = useState(false);
  const [printViewChecking, setPrintViewChecking] = useState(false);
  const printViewCheckInFlightRef = useRef(false);
  const {
    fixedFilterSidebarCollapsed,
    setFixedFilterSidebarCollapsed,
    mobileSidebarOpen,
    setMobileSidebarOpen,
    isMobileViewport,
    activeTopView,
    setActiveTopView,
    activeLandingPageKey,
    setActiveLandingPageKey,
  } = useWorkReportListViewController({
    locationSearch: location.search,
    initialListViewState,
    localPreferences,
  });
  const {
    pageSize,
    setPageSize,
    page,
    setPage,
    globalFilterDraft,
    setGlobalFilterDraft,
    globalFilters,
    setGlobalFilters,
  } = useWorkReportViewState(activeLandingPageKey, {
    page: initialListViewState?.page,
    pageSize: initialListViewState?.pageSize,
    globalFilterDraft: initialListViewState?.globalFilterDraft,
    globalFilters: initialListViewState?.globalFilters,
  });
  const pendingPageScrollRef = useRef(false);
  const activeLandingPageConfig = WORK_REPORT_LANDING_PAGE_CONFIGS[activeLandingPageKey];
  const currentFormId = activeLandingPageConfig.formId;
  const { markedRow, toggleMarkedRow, clearMarkedRow } = useWorkReportMarkedRow(currentFormId);
  const [customFilterDraft, setCustomFilterDraft] = useState<WorkReportFilterGroup>(() =>
    cloneWorkReportFilterGroup(
      initialListViewState?.customFilterDraft ??
        initialListViewState?.customFilters ??
        EMPTY_WORK_REPORT_FILTER_GROUP
    )
  );
  const [customFilters, setCustomFilters] = useState<WorkReportFilterGroup>(() =>
    cloneWorkReportFilterGroup(
      initialListViewState?.customFilters ?? EMPTY_WORK_REPORT_FILTER_GROUP
    )
  );
  const bootstrappedDefaultSortKeysRef = useRef<Set<string>>(new Set());
  const dismissedDefaultSortBootstrapKeysRef = useRef<Set<string>>(new Set());
  const { i18n, t } = useTranslation(["workReport", "common"]);
  const uiLanguage: UiLanguage =
    (i18n.resolvedLanguage ?? i18n.language).toLowerCase().startsWith("en") ? "en" : "zh";
  const setUiLanguage = useCallback(
    (nextLanguage: UiLanguage) => {
      void i18n.changeLanguage(nextLanguage === "en" ? "en" : "zh-TW");
    },
    [i18n]
  );
  const {
    createTaskMonitors,
    taskMonitorExpanded,
    toggleTaskMonitorExpanded,
    collapseTaskMonitor,
    clearFinishedTaskMonitors,
    retryEntryFieldConfirmation,
    hasFinishedTaskMonitors,
    taskRunningCount,
    taskFailedCount,
    latestTaskMonitor,
    upsertCreateTaskMonitor,
    registerEntryFieldSettlementConsumer,
  } = useWorkReportTaskMonitorContext();
  const translateStatusDisplay = useCallback(
    (status: string): string => translateWorkOrderStatusValue(status, t),
    [t]
  );
  const {
    columnFilterState,
    columnSortRules,
    setColumnSortRules,
    columnMenuOpenKey,
    columnMenuOpenOwnerId,
    columnMenuSearchState,
    columnAnalysisState,
    columnAnalysisLabel,
    columnTextFilterDialog,
    hasActiveColumnSortRules,
    isColumnAnalysisOpen,
    handleColumnMenuOpenChange,
    markColumnMenuInteract,
    handleColumnMenuSearchChange,
    toggleColumnFilterToken,
    clearColumnFilter,
    applyColumnSortRule,
    clearColumnSortRule,
    clearColumnMenuSettings,
    openColumnAnalysis,
    closeColumnAnalysis,
    openColumnTextFilterDialog,
    handleColumnTextFilterDialogChange,
    closeColumnTextFilterDialog,
    submitColumnTextFilterDialog,
    resetColumnFilters,
  } = useColumnMenuState({
    setPage,
    initialState: {
      columnFilterState: normalizeColumnFilterStateForForm(
        initialListViewState?.columnFilterState ?? {},
        currentFormId
      ),
      columnSortRules: normalizeColumnSortRulesForForm(
        initialListViewState?.columnSortRules ??
          parseColumnSortRulesFromSearch(location.search) ??
          [],
        currentFormId
      ),
    },
  });
  const { syncQuickViewQuery } = useWorkReportListUrlSync({
    activeLandingPageKey,
    activeTopView,
    columnSortRules,
  });
  const effectiveCustomFilterDraft = useMemo(
    () =>
      customFilterDraft.conditions.length > 0
        ? customFilterDraft
        : buildWorkReportFilterGroupFromGlobalFilters(globalFilterDraft, currentFormId),
    [currentFormId, customFilterDraft, globalFilterDraft]
  );
  const effectiveCustomFilters = useMemo(
    () =>
      customFilters.conditions.length > 0
        ? customFilters
        : buildWorkReportFilterGroupFromGlobalFilters(globalFilters, currentFormId),
    [currentFormId, customFilters, globalFilters]
  );
  const [machineOptionsByForm, setMachineOptionsByForm] = useState<
    Partial<Record<"901" | "902", FormOptionItem[]>>
  >({});
  useEffect(() => {
    if (machineOptionsByForm[currentFormId]) return;
    let cancelled = false;
    void fetchFormOptions(currentFormId, ["machineId"])
      .then((options) => {
        if (cancelled) return;
        setMachineOptionsByForm((current) => ({
          ...current,
          [currentFormId]: options.machineId ?? [],
        }));
      })
      .catch(() => {
        if (cancelled) return;
        setMachineOptionsByForm((current) => ({
          ...current,
          [currentFormId]: [],
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [currentFormId, machineOptionsByForm]);
  const currentPageProdTypeCode = activeLandingPageConfig.prodTypeCode;
  const currentPageGroupLabel = t(activeLandingPageConfig.groupLabelI18nKey);
  const hasPendingFilterChanges = useMemo(
    () =>
      !isSameGlobalFilters(globalFilterDraft, globalFilters) ||
      !isSameWorkReportFilterGroup(effectiveCustomFilterDraft, effectiveCustomFilters),
    [effectiveCustomFilterDraft, effectiveCustomFilters, globalFilterDraft, globalFilters]
  );
  const activeColumnFilterCount = useMemo(
    () => countActiveColumnFilters(columnFilterState),
    [columnFilterState]
  );
  const machineColumnFilterKey = currentFormId === "902" ? "filterMachineCode" : "machineCode";
  const machineColumnFilterTokens =
    columnFilterState[machineColumnFilterKey]?.selectedTokens ?? [];
  const {
    columnDisplayMode,
    columnSettingsOpen,
    setColumnSettingsOpen,
    selectableColumns,
    currentTableLayout,
    columnWidthOverrides,
    hiddenColumnKeySet,
    handleColumnDisplayModeChange,
    handleOpenColumnSettings,
    handleToggleColumnVisibility,
    handleShowAllColumns,
    handleResetDefaultColumns,
    handleMoveColumn,
    handleMoveColumnByOffset,
    handleChangeColumnColor,
    handleColumnResizeStart,
  } = useWorkReportListTableLayoutController(currentFormId);
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [filterDrawerDraftStatus, setFilterDrawerDraftStatus] = useState<{
    source: object;
    pending: boolean;
  } | null>(null);
  const handleOpenFiltersFromWorkspace = useCallback(() => {
    if (filterPanelOpen) return;
    setFilterDrawerDraftStatus(null);
    setFilterPanelOpen(true);
  }, [filterPanelOpen]);
  const handleCloseFilterDrawer = useCallback(() => {
    setFilterDrawerDraftStatus(null);
    setFilterPanelOpen(false);
  }, []);
  const handleFilterDrawerBackgroundClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (
        filterPanelOpen &&
        shouldCloseFilterDrawerFromBackgroundClick(event.target)
      ) {
        handleCloseFilterDrawer();
      }
    },
    [filterPanelOpen, handleCloseFilterDrawer]
  );
  const handleToggleFixedFilterSidebar = useCallback(() => {
    setFixedFilterSidebarCollapsed((previous) => !previous);
  }, [setFixedFilterSidebarCollapsed]);
  const handleCloseMobileSidebar = useCallback(() => {
    setMobileSidebarOpen(false);
  }, [setMobileSidebarOpen]);
  const handleGlobalSearchDraftChange = useCallback(
    (globalKeyword: string) => {
      setGlobalFilterDraft((previous) => ({ ...previous, globalKeyword }));
    },
    [setGlobalFilterDraft]
  );
  const handlePreviousPage = useCallback(() => {
    pendingPageScrollRef.current = true;
    setPage((previous) => Math.max(1, previous - 1));
  }, [setPage]);
  const handleNextPage = useCallback(() => {
    pendingPageScrollRef.current = true;
    setPage((previous) => previous + 1);
  }, [setPage]);
  const handlePageSizeChange = useCallback(
    (nextPageSize: number) => {
      pendingPageScrollRef.current = true;
      setPageSize(nextPageSize);
      setPage(1);
    },
    [setPage, setPageSize]
  );
  const handleOpenTaskQueue = useCallback(() => {
    setTaskQueueOpen(true);
  }, []);
  const { logListEvent } = useWorkReportListEventLogger(currentFormId);
  const handlePreviewReadMetric = useCallback(
    (metric: PreviewReadMetric) => {
      logListEvent("api", "list-preview-read", "列表 preview 讀取完成", {
        operationType: "list-preview-read",
        phase: metric.outcome,
        durationMs: Number(metric.durationMs.toFixed(2)),
        meta: {
          mode: metric.mode,
          page: metric.page,
          recordCount: metric.recordCount,
          cacheSource: metric.cacheSource,
          cacheState: metric.cacheState,
        },
      });
    },
    [logListEvent]
  );
  const isStandaloneTopView = activeTopView !== "report";
  const isReportTopView = activeTopView === "report";
  const {
    activeFixedFilterPresetId,
    isSidebarFixedViewActive,
    defaultPresetSortBootstrapKey,
  } = useWorkReportListPresetController({
    activeLandingPageKey,
    activePlaceholderViewId,
    currentFormId,
    globalFilters,
    hasCustomFilters: customFilters.conditions.length > 0,
    columnSortRules,
    setColumnSortRules,
    bootstrappedDefaultSortKeysRef,
    dismissedDefaultSortBootstrapKeysRef,
  });
  const {
    isGlobalFilterActive,
    shouldUseFullHydrationForList,
    serverPreviewQuery,
    fixedPresetPreviewQueries,
    bootstrapKeyword,
  } = useWorkReportListQueryController({
    activePlaceholderViewId,
    activeFixedFilterPresetId,
    currentFormId,
    pageProdTypeCode: currentPageProdTypeCode,
    globalFilters,
    columnSortRules,
    isColumnAnalysisOpen,
    hasActiveColumnSortRules,
    columnFilterState,
    customFilters,
    analysisColumnKey: columnAnalysisState.columnKey,
    excludeTestCustomerPart: localPreferences.hideTestCustomerPartRecords,
    excludeSortOrder99: localPreferences.hideSortOrder99Records,
  });

  const {
    loading,
    error,
    records,
    allRecords,
    hasMore,
    previewTotalCount,
    previewReadMeta,
    previewRevalidating,
    previewRevalidationError,
    backgroundFetching,
    previewTransitionPending,
    displayedPreviewPage,
    displayedPreviewPageSize,
    hydration,
    loadReports,
    hydrateAllRecords,
    mergeListRecord,
    patchListRecord,
    invalidatePreviewCache,
    resetListDataState,
    resetHydrationState,
  } = useWorkReportListData({
    currentFormId,
    page,
    pageSize,
    shouldUseFullHydrationForList,
    serverPreviewQuery,
    previewPrefetchQueries: fixedPresetPreviewQueries,
    bootstrapKeyword,
    t,
    setNotice,
    onPreviewReadMetric: handlePreviewReadMetric,
  });
  const effectiveListLoading = loading || previewTransitionPending;
  const listBackgroundLoading = effectiveListLoading || previewRevalidating || backgroundFetching;
  const hasRenderableListContent =
    previewReadMeta !== null || hydration.hasHydratedAllRecords;
  const listInitialLoading = !hasRenderableListContent && !error;
  const previewPresentationRevalidating =
    !shouldUseFullHydrationForList &&
    hasRenderableListContent &&
    (effectiveListLoading || previewRevalidating || backgroundFetching);
  const {
    handleUpdateStartSchedule,
    handleUpdateMainMachine,
    handleUpdateUrgent,
    handleUpdateSortOrder,
    handleUpdatePlannedEndDate,
    entryFieldMutationSyncingEntryIdsByOperation,
    entryFieldMutationBlockedEntryIds,
  } =
    useWorkReportListMutationTaskController({
      currentFormId,
      records,
      authoritativeRecords: selectEntryFieldMutationAuthoritativeRecords({
        previewRecords: records,
        allRecords,
        hasHydratedAllRecords: hydration.hasHydratedAllRecords,
      }),
      createTaskMonitors,
      registerEntryFieldSettlementConsumer,
      upsertCreateTaskMonitor,
      mergeListRecord,
      patchListRecord,
      setNotice,
      t,
    });
  const {
    hasHydratedAllRecords,
    isHydratingAllRecords,
    backendSnapshotAt,
  } = hydration;
  const effectiveBackendSnapshotAt = shouldUseFullHydrationForList
    ? backendSnapshotAt
    : previewReadMeta?.snapshotAt ?? null;

  const { pageScopedFiltersRef } = useWorkReportListLandingController({
    activeLandingPageKey,
    activePlaceholderViewId,
    localPreferences,
    globalFilterDraft,
    globalFilters,
    customFilterDraft,
    customFilters,
    columnSortRules,
    setGlobalFilterDraft,
    setGlobalFilters,
    setCustomFilterDraft,
    setCustomFilters,
    setPage,
    resetListDataState,
    resetColumnFilters,
    setColumnSortRules,
    setActivePlaceholderViewId,
  });

  useWorkReportListDataSync({
    shouldUseFullHydrationForList,
    hasHydratedAllRecords,
    loadReports,
    resetHydrationState,
    hydrateAllRecords,
    currentFormId,
    allRecords,
  });
  const {
    visibleRecords,
    effectiveColumnSortRules,
    displayedPage,
    displayedPageSize,
    hasMoreForPager,
    currentPageReportCount,
    matchedRecordCount,
    pageSizeOptions,
    unfinishedMachineShortcuts,
    activeUnfinishedMachineShortcut,
    machineFilterOptions,
    statusFilterOptions,
    siteRunningFilterOptions,
    openColumnFacetOptionsFiltered,
    analysisTargetColumnType,
    columnAnalysisSummary,
  } = useWorkReportDataPipeline({
    enabled: isReportTopView,
    activeLandingPageKey,
    currentFormId,
    activeFixedFilterPresetId,
    allRecords,
    records,
    previewTotalCount,
    filterOptionsSnapshotAt: effectiveBackendSnapshotAt,
    filterOptionsCacheSource: previewReadMeta?.cacheSource ?? null,
    displayedPreviewPage,
    displayedPreviewPageSize,
    hideTestCustomerPartRecords: localPreferences.hideTestCustomerPartRecords,
    hideSortOrder99Records: localPreferences.hideSortOrder99Records,
    pageProdTypeCode: currentPageProdTypeCode,
    shouldUseFullHydrationForList,
    hasHydratedAllRecords,
    isGlobalFilterActive,
    globalFilters,
    customFilters,
    columnFilterState,
    columnSortRules,
    isSidebarFixedViewActive,
    page,
    pageSize,
    hasMore,
    setPage,
    columnMenuOpenKey,
    columnMenuSearchState,
    columnAnalysisState,
    uiLanguage,
    translateStatusDisplay,
  });
  const {
    applyFixedFilterPreset,
    applyUnfinishedMachineShortcut,
    handleSidebarPlaceholderViewClick,
    activeFilterChips,
    handleApplyFilters,
    handleSaveLocalSettings,
    handleOpenLandingPage,
    openLocalSettingsView,
    openMobileFilters,
    applySidebarPlaceholderView,
  } = useWorkReportListInteractionController({
    currentFormId,
    activeLandingPageKey,
    activePlaceholderViewId,
    globalFilters,
    globalFilterDraft,
    customFilterDraft: effectiveCustomFilterDraft,
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
  });
  const filterPanelSupplementalChips = useMemo(() => {
    const representedByBuilder = new Set([
      "filter-status",
      "filter-machine-code",
      "filter-main-machine-code",
      "filter-site-running",
      "filter-start-schedule",
      "filter-work-order-keyword",
      "filter-customer-part-keyword",
      "filter-updated-date-from",
      "filter-updated-date-to",
    ]);
    return activeFilterChips.filter((chip) => !representedByBuilder.has(chip.key));
  }, [activeFilterChips]);
  const filterDrawerAppliedState = useMemo(
    () => ({
      globalFilters,
      filterGroup: effectiveCustomFilters,
      sortRules: columnSortRules,
      columnFilterState,
      activePlaceholderViewId,
      usesCustomFilterGroup: customFilters.conditions.length > 0,
    }),
    [
      activePlaceholderViewId,
      columnFilterState,
      columnSortRules,
      customFilters.conditions.length,
      effectiveCustomFilters,
      globalFilters,
    ]
  );
  const activeFilterCount =
    countActiveGlobalFilters(globalFilters) +
    customFilters.conditions.length +
    activeColumnFilterCount +
    (activePlaceholderViewId === "starred" ? 1 : 0);
  useWorkReportListEffectsController({
    highlightedEntryId,
    setHighlightedEntryId,
    notice,
    setNotice,
    t,
    applySidebarPlaceholderView,
    initialQuickViewRestored: Boolean(initialListViewState?.activePlaceholderViewId),
  });
  useLayoutEffect(() => {
    if (
      !pendingPageScrollRef.current ||
      effectiveListLoading ||
      displayedPage !== page ||
      displayedPageSize !== pageSize ||
      visibleRecords.length === 0
    ) return;

    const scrollRoot = document.querySelector<HTMLElement>(".ragic-list-main");
    const table = scrollRoot?.querySelector<HTMLElement>(".work-report-table-stage");
    const toolbar = scrollRoot?.querySelector<HTMLElement>(".work-report-workspace-toolbar");
    const firstRow = table?.querySelector<HTMLElement>(".ant-table-tbody .ant-table-row");
    const stickyHeader = table?.querySelector<HTMLElement>(".ant-table-sticky-holder");
    if (!scrollRoot || !table || !toolbar || !firstRow || !stickyHeader) return;

    if (
      scrollRoot.scrollTop > 1 &&
      firstRow.getBoundingClientRect().bottom <= stickyHeader.getBoundingClientRect().bottom + 1
    ) {
      scrollRoot.scrollTop +=
        table.getBoundingClientRect().top -
        scrollRoot.getBoundingClientRect().top -
        toolbar.getBoundingClientRect().height;
    }
    pendingPageScrollRef.current = false;
  }, [displayedPage, displayedPageSize, effectiveListLoading, page, pageSize, visibleRecords]);
  const { handleOpenDetail } = useWorkReportListNavigation({
    currentFormId,
    activeLandingPageKey,
    activeTopView,
    activePlaceholderViewId,
    globalFilterDraft,
    globalFilters,
    customFilterDraft,
    customFilters,
    page,
    pageSize,
    columnFilterState,
    columnSortRules,
    loading: effectiveListLoading,
    visibleRecords,
    setHighlightedEntryId,
  });
  const handleOpenDetailRef = useRef(handleOpenDetail);
  handleOpenDetailRef.current = handleOpenDetail;
  // 保留最新返回列表草稿，但不要讓每次輸入草稿都重建 columns 並重繪整張 Ant Table。
  const handleOpenDetailFromTable = useCallback((entryId: string) => {
    handleOpenDetailRef.current(entryId);
  }, []);
  const handlePreloadDetail = useCallback(() => {
    preloadWorkReportDetailPage();
  }, []);
  const handleOpenDowntimePage = useCallback(() => {
    navigate("/downtime");
  }, [navigate]);

  const handleOpenPrintView = useCallback(async () => {
    if (printViewCheckInFlightRef.current) {
      return;
    }
    printViewCheckInFlightRef.current = true;
    setPrintViewChecking(true);
    const printWindow = window.open("about:blank", "_blank");
    if (!printWindow) {
      Modal.warning({
        title: t("workReport:table.printPopupBlockedTitle"),
        content: t("workReport:table.printPopupBlockedMessage"),
        okText: t("common:actions.ok"),
        centered: true,
      });
      printViewCheckInFlightRef.current = false;
      setPrintViewChecking(false);
      return;
    }
    printWindow.opener = null;
    writeWorkReportPrintWindow(
      printWindow,
      buildWorkReportPrintLoadingDocument(currentFormId, uiLanguage)
    );

    try {
      const blockingScheduleMutationSummary =
        await fetchWorkReportBlockingScheduleMutationSummary(currentFormId);
      if (
        isWorkReportPrintBlockedByScheduleMutation(
          blockingScheduleMutationSummary
        )
      ) {
        printWindow.close();
        Modal.warning({
          title: t("workReport:table.printScheduleMutationPendingTitle"),
          content: t("workReport:table.printScheduleMutationPendingMessage", {
            count: blockingScheduleMutationSummary.count,
          }),
          okText: t("common:actions.ok"),
          centered: true,
        });
        return;
      }

      const fullRecords = await fetchWorkReportPrintRecords(hydrateAllRecords);
      const scopedRecords = buildScopedWorkReportRecords(fullRecords, {
        currentFormId,
        pageProdTypeCode: currentPageProdTypeCode,
        hideTestCustomerPartRecords: localPreferences.hideTestCustomerPartRecords,
        hideSortOrder99Records: localPreferences.hideSortOrder99Records,
      });
      const printRecords = runWorkReportRecordPipeline(scopedRecords, {
        isGlobalFilterActive,
        globalFilters,
        customFilters,
        currentFormId,
        columnFilterState,
        sortRules: effectiveColumnSortRules,
      });
      if (printRecords.length === 0) {
        printWindow.close();
        Modal.info({
          title: t("workReport:table.printNoRecordsTitle"),
          content: t("workReport:table.printNoRecordsMessage"),
          okText: t("common:actions.ok"),
          centered: true,
        });
        return;
      }
      if (!isWorkReportPrintRecordCountAllowed(printRecords.length)) {
        printWindow.close();
        Modal.warning({
          title: t("workReport:table.printTooManyRecordsTitle"),
          content: t("workReport:table.printTooManyRecordsMessage", {
            count: printRecords.length,
            limit: WORK_REPORT_PRINT_MAX_RECORDS,
          }),
          okText: t("common:actions.ok"),
          centered: true,
        });
        return;
      }
      if (printWindow.closed) {
        throw new Error(t("workReport:table.printWindowClosedMessage"));
      }
      const printSession = createWorkReportPrintSession(
        printWindow.sessionStorage,
        buildWorkReportPrintDocument({
          formId: currentFormId,
          records: printRecords,
          language: uiLanguage,
        }),
        uiLanguage
      );
      printWindow.location.replace(
        new URL(printSession.path, window.location.origin).toString()
      );
      printWindow.focus();
    } catch (printError) {
      printWindow.close();
      Modal.error({
        title: t("workReport:table.printGenerateFailedTitle"),
        content: t("workReport:table.printGenerateFailedMessage", {
          error: getErrorMessage(printError),
        }),
        okText: t("common:actions.confirm"),
        centered: true,
      });
    } finally {
      printViewCheckInFlightRef.current = false;
      setPrintViewChecking(false);
    }
  }, [
    columnFilterState,
    currentFormId,
    customFilters,
    currentPageProdTypeCode,
    effectiveColumnSortRules,
    globalFilters,
    hydrateAllRecords,
    isGlobalFilterActive,
    localPreferences.hideSortOrder99Records,
    localPreferences.hideTestCustomerPartRecords,
    t,
    uiLanguage,
  ]);
  const handleOpenPrintViewClick = useCallback(() => {
    void handleOpenPrintView();
  }, [handleOpenPrintView]);

  const { columns } = useWorkReportColumns({
    enabled: isReportTopView,
    currentFormId,
    columnDisplayMode,
    columnWidthOverrides,
    columnOrder: currentTableLayout.columnOrder,
    hiddenColumnKeys: hiddenColumnKeySet,
    columnColors: currentTableLayout.columnColors,
    onColumnResizeStart: handleColumnResizeStart,
    disableFixedColumns: isMobileViewport,
    uiLanguage,
    onOpenDetail: handleOpenDetailFromTable,
    onUpdateStartSchedule: handleUpdateStartSchedule,
    onUpdateMainMachine: handleUpdateMainMachine,
    onUpdateUrgent: handleUpdateUrgent,
    onUpdateSortOrder: handleUpdateSortOrder,
    onUpdatePlannedEndDate: handleUpdatePlannedEndDate,
    entryFieldMutationSyncingEntryIdsByOperation,
    entryFieldMutationBlockedEntryIds,
    machineOptions: machineOptionsByForm[currentFormId] ?? [],
    globalSearchKeyword: globalFilters.globalKeyword,
    menuState: {
      columnFilterState,
      columnSortRules,
      columnMenuOpenKey,
      columnMenuOpenOwnerId,
      openColumnFacetOptionsFiltered,
      columnMenuSearchState,
    },
    menuActions: {
      clearColumnFilter,
      applyColumnSortRule,
      clearColumnSortRule,
      openColumnAnalysis,
      handleColumnMenuSearchChange,
      markColumnMenuInteract,
      openColumnTextFilterDialog,
      toggleColumnFilterToken,
      clearColumnMenuSettings,
      handleColumnMenuOpenChange,
    },
  });

  const {
    sseNoticeReloadToken,
    isSyncingFromRagic,
    refreshSyncTask,
    refreshSyncErrorMessage,
    refreshSyncModalOpen,
    realtimeConnected,
    realtimeDisconnectedSince,
    handleRefresh,
    handleCloseRefreshSyncModal,
    handleSystemNoticeForceRefresh,
    tableSoftBusy,
    tableSoftBusyLabel,
  } = useWorkReportListRefreshController({
    currentFormId,
    shouldUseFullHydrationForList,
    isStandaloneTopView,
    loading,
    isHydratingAllRecords,
    page,
    setPage,
    loadReports,
    invalidatePreviewCache,
    hydrateAllRecords,
    setNotice,
    t,
    logListEvent,
  });

  const effectiveTableSoftBusy = tableSoftBusy || previewTransitionPending;
  const filterControlDisabled = effectiveListLoading || submitting || isHydratingAllRecords;
  const sidebarFilterControlDisabled = submitting || isHydratingAllRecords;

  const { systemStatusNotice } = useWorkReportListStatusController({
    activeTopView,
    notice,
    t,
    shouldUseFullHydrationForList,
    hasHydratedAllRecords,
    backendSnapshotAt: effectiveBackendSnapshotAt,
    truncated: hydration.truncated,
    truncatedCount: hydration.truncatedCount,
    realtimeConnected,
    realtimeDisconnectedSince,
    previewRevalidating: previewPresentationRevalidating,
    previewRevalidationError: shouldUseFullHydrationForList
      ? null
      : previewRevalidationError,
    isSyncingFromRagic,
    loading: listInitialLoading,
    error,
  });
  const { expireSession } = useWorkReportSessionExpiryGuard({
    enabled: true,
    currentPath: location.pathname + location.search,
  });
  const { maintenanceMessage, blocked, blockedReason } = useWorkReportClientPresence({
    currentPath: location.pathname + location.search,
    currentFormId,
    currentTopView: activeTopView,
    currentLandingPageKey: activeLandingPageKey,
    realtimeConnected,
    onForceSessionExpired: expireSession,
  });
  const statusHydration = useMemo(
    () => ({
      shouldUseFullHydrationForList,
      hasHydratedAllRecords,
      backendSnapshotAt: effectiveBackendSnapshotAt,
      truncated: hydration.truncated,
      truncatedCount: hydration.truncatedCount,
      realtimeConnected,
      realtimeDisconnectedSince,
      previewRevalidating: previewPresentationRevalidating,
      previewRevalidationError: shouldUseFullHydrationForList
        ? null
        : previewRevalidationError,
    }),
    [
      effectiveBackendSnapshotAt,
      hasHydratedAllRecords,
      hydration.truncated,
      hydration.truncatedCount,
      realtimeConnected,
      realtimeDisconnectedSince,
      previewPresentationRevalidating,
      previewRevalidationError,
      shouldUseFullHydrationForList,
    ]
  );
  const statusSummary = useMemo(
    () => ({
      sortedFilteredRecordsLength: matchedRecordCount,
      visibleRecordsLength: visibleRecords.length,
      currentPageReportCount,
    }),
    [currentPageReportCount, matchedRecordCount, visibleRecords.length]
  );
  const statusTaskMonitor = useMemo(
    () => ({
      createTaskMonitors,
      taskMonitorExpanded,
      hasFinishedTaskMonitors,
      taskRunningCount,
      taskFailedCount,
      latestTaskMonitor,
      onToggleTaskMonitorExpanded: toggleTaskMonitorExpanded,
      onCollapseTaskMonitor: collapseTaskMonitor,
      onClearFinishedTaskMonitors: clearFinishedTaskMonitors,
      onRetryEntryFieldConfirmation: retryEntryFieldConfirmation,
    }),
    [
      clearFinishedTaskMonitors,
      retryEntryFieldConfirmation,
      collapseTaskMonitor,
      createTaskMonitors,
      hasFinishedTaskMonitors,
      latestTaskMonitor,
      taskFailedCount,
      taskMonitorExpanded,
      taskRunningCount,
      toggleTaskMonitorExpanded,
    ]
  );

  return (
    <main className={`page ${isReportTopView ? "work-report-viewport" : ""}`}>
      <div
        className={`ragic-list-shell ${fixedFilterSidebarCollapsed ? "is-sidebar-collapsed" : ""} ${
          isStandaloneTopView ? "is-settings-view" : ""
        }`}
        onClickCapture={handleFilterDrawerBackgroundClick}
      >
        {maintenanceMessage ? (
          <section className="detail-system-status-wrap" role="status" aria-live="polite">
            <div className="detail-system-status detail-system-status--warn">
              <span className="detail-system-status-content">
                <span>{maintenanceMessage}</span>
              </span>
            </div>
          </section>
        ) : null}
        {blocked ? (
          <div
            role="alert"
            aria-live="assertive"
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 3000,
              background: "rgba(15, 23, 42, 0.72)",
              backdropFilter: "blur(2px)",
              display: "grid",
              placeItems: "center",
              padding: "1.5rem",
            }}
          >
            <div
              style={{
                width: "min(560px, 100%)",
                padding: "1.4rem 1.5rem",
                borderRadius: "16px",
                border: "1px solid rgba(248, 113, 113, 0.5)",
                background: "#1f1111",
                boxShadow: "0 18px 40px rgba(0,0,0,0.35)",
                color: "#fecaca",
              }}
            >
              <div style={{ fontSize: "1.05rem", fontWeight: 700, marginBottom: "0.55rem" }}>
                此裝置已被管理端停用
              </div>
              <div style={{ lineHeight: 1.65, fontSize: "0.96rem" }}>
                {blockedReason || "此裝置已被管理端暫時停用"}
              </div>
            </div>
          </div>
        ) : null}
        <WorkReportSyncProgressModal
          open={refreshSyncModalOpen}
          task={refreshSyncTask}
          errorMessage={refreshSyncErrorMessage}
          onClose={handleCloseRefreshSyncModal}
        />
        {!isStandaloneTopView && (
          <FixedFilterSidebar
            collapsed={fixedFilterSidebarCollapsed}
            mobileMode={isMobileViewport}
            mobileOpen={mobileSidebarOpen}
            currentFormId={currentFormId}
            filterControlDisabled={sidebarFilterControlDisabled}
            activeFixedFilterPresetId={activeFixedFilterPresetId}
            activePlaceholderViewId={activePlaceholderViewId}
            activeUnfinishedMachineShortcut={activeUnfinishedMachineShortcut}
            unfinishedMachineShortcuts={unfinishedMachineShortcuts}
            onToggleCollapsed={handleToggleFixedFilterSidebar}
            onCloseMobile={handleCloseMobileSidebar}
            onApplyFixedFilterPreset={applyFixedFilterPreset}
            onPlaceholderViewClick={handleSidebarPlaceholderViewClick}
            onApplyUnfinishedMachineShortcut={applyUnfinishedMachineShortcut}
          />
        )}

        <section className="ragic-list-main">
          <WorkReportToolbar
            uiLanguage={uiLanguage}
            setUiLanguage={setUiLanguage}
            activeTopView={activeTopView}
            activeLandingPageKey={activeLandingPageKey}
            currentPageGroupLabel={currentPageGroupLabel}
            currentPageContextLabel={`${currentFormId} / ${currentPageProdTypeCode}`}
            onOpenLandingPage={handleOpenLandingPage}
            onOpenDowntimePage={handleOpenDowntimePage}
            onOpenLocalSettingsView={openLocalSettingsView}
            showMobileFilterButton={activeTopView === "report" && isMobileViewport}
            onOpenMobileFilters={openMobileFilters}
            columnSettingsOpen={columnSettingsOpen}
            setColumnSettingsOpen={setColumnSettingsOpen}
            selectableColumns={selectableColumns}
            columnOrder={currentTableLayout.columnOrder}
            hiddenColumnKeys={hiddenColumnKeySet}
            columnColors={currentTableLayout.columnColors}
            onToggleColumnVisibility={handleToggleColumnVisibility}
            onMoveColumn={handleMoveColumn}
            onMoveColumnByOffset={handleMoveColumnByOffset}
            onChangeColumnColor={handleChangeColumnColor}
            onShowAllColumns={handleShowAllColumns}
            onResetDefaultColumns={handleResetDefaultColumns}
            onSystemNoticeForceRefresh={handleSystemNoticeForceRefresh}
            systemNoticeForceReloadToken={sseNoticeReloadToken}
            systemStatusNotice={systemStatusNotice}
            systemStatusRefreshing={hasRenderableListContent && listBackgroundLoading}
          />
          {activeTopView === "local-settings" ? (
            <WorkReportLocalSettingsPanel
              value={localPreferences}
              deviceLabel={deviceLabel}
              onChange={setLocalPreferences}
              onDeviceLabelChange={setDeviceLabel}
              onSave={() => {
                if (handleSaveLocalSettings()) {
                  writeWorkReportDeviceLabel(deviceLabel);
                }
              }}
              onBackToReport={() => setActiveTopView("report")}
            />
          ) : activeTopView === "technical-info" ? (
            // 開發者模式已搬到獨立路由 /dev；舊 URL（?topView=technical-info）重定向過去
            <Navigate to="/dev" replace />
          ) : (
            <>
              <div className="work-report-list-workspace">
                <WorkReportWorkspaceToolbar
                currentPageGroupLabel={currentPageGroupLabel}
                currentPageContextLabel={`${currentFormId} / ${currentPageProdTypeCode}`}
                matchedCount={matchedRecordCount}
                markedRow={markedRow}
                onClearMarkedRow={clearMarkedRow}
                searchValue={globalFilterDraft.globalKeyword}
                onSearchValueChange={handleGlobalSearchDraftChange}
                onSearchSubmit={() => handleApplyFilters()}
                page={displayedPage}
                hasMoreForPager={hasMoreForPager}
                onPrevPage={handlePreviousPage}
                onNextPage={handleNextPage}
                activeFilterCount={activeFilterCount}
                hasPendingFilterChanges={
                  hasPendingFilterChanges ||
                  Boolean(
                    filterPanelOpen &&
                    filterDrawerDraftStatus?.source === filterDrawerAppliedState &&
                    filterDrawerDraftStatus.pending
                  )
                }
                filterPanelOpen={filterPanelOpen}
                onOpenFilters={handleOpenFiltersFromWorkspace}
                columnDisplayMode={columnDisplayMode}
                onChangeColumnDisplayMode={handleColumnDisplayModeChange}
                columnSettingsOpen={columnSettingsOpen}
                onOpenColumnSettings={handleOpenColumnSettings}
                onOpenTaskQueue={handleOpenTaskQueue}
                onOpenPrintView={handleOpenPrintViewClick}
                printViewChecking={printViewChecking}
                pageSize={pageSize}
                pageSizeOptions={pageSizeOptions}
                onChangePageSize={handlePageSizeChange}
                controlsDisabled={filterControlDisabled}
                isSyncingFromRagic={isSyncingFromRagic}
                onRefresh={handleRefresh}
                stickyEnabled
              />
                {filterPanelOpen ? (
                  <WorkReportFilterDrawer
                    key={activeLandingPageKey}
                    currentFormId={currentFormId}
                    activeLandingPageKey={activeLandingPageKey}
                    appliedState={filterDrawerAppliedState}
                    onClose={handleCloseFilterDrawer}
                    onPendingChange={(pending) => {
                      setFilterDrawerDraftStatus({
                        source: filterDrawerAppliedState,
                        pending,
                      });
                    }}
                    machineFilterOptions={machineFilterOptions}
                    statusFilterOptions={statusFilterOptions}
                    siteRunningFilterOptions={siteRunningFilterOptions}
                    filterControlDisabled={filterControlDisabled}
                    activeFilterChips={filterPanelSupplementalChips}
                    columnFilterCount={activeColumnFilterCount}
                    machineColumnFilterTokens={machineColumnFilterTokens}
                    onApply={handleApplyFilters}
                  />
                ) : null}
                <PendingBatchTasksBadge />
                <WorkReportStatusArea
                uiLanguage={uiLanguage}
                hydration={statusHydration}
                summary={statusSummary}
                isSyncingFromRagic={isSyncingFromRagic}
                notice={notice}
                suppressSuccessHumanNote={activeTopView === "report"}
                suppressInlineNotice={activeTopView === "report"}
                taskMonitor={statusTaskMonitor}
                loading={listInitialLoading}
                error={error}
                hasRenderableContent={hasRenderableListContent}
                />

                <WorkReportTableSection
                  columns={columns}
                  columnDisplayMode={columnDisplayMode}
                  visibleRecords={visibleRecords}
                  backgroundLoading={listBackgroundLoading}
                  error={error}
                  hasRenderableContent={hasRenderableListContent}
                  softBusy={effectiveTableSoftBusy}
                  softBusyLabel={tableSoftBusyLabel}
                  highlightedEntryId={highlightedEntryId}
                  markedRow={markedRow}
                  onToggleMarkedRow={toggleMarkedRow}
                  showScrollHintButton={localPreferences.showListScrollHintButton}
                  onOpenDetail={handleOpenDetailFromTable}
                  onPreloadDetail={handlePreloadDetail}
                  onRetry={() => {
                    void loadReports(false, { mode: "foreground" });
                  }}
                />
              </div>
            </>
          )}

        </section>
      {isReportTopView && (
        <>
          <ColumnTextFilterDialog
            uiLanguage={uiLanguage}
            state={columnTextFilterDialog}
            onCancel={closeColumnTextFilterDialog}
            onConfirm={submitColumnTextFilterDialog}
            onChangeDraft={handleColumnTextFilterDialogChange}
          />
          <ColumnAnalysisDrawer
            uiLanguage={uiLanguage}
            state={columnAnalysisState}
            label={columnAnalysisLabel}
            targetColumnType={analysisTargetColumnType}
            shouldUseFullHydrationForList={shouldUseFullHydrationForList}
            hasHydratedAllRecords={hasHydratedAllRecords}
            isHydratingAllRecords={isHydratingAllRecords}
            summary={columnAnalysisSummary}
            onClose={closeColumnAnalysis}
          />
          <WorkReportTaskQueueDrawer
            open={taskQueueOpen}
            context="list"
            formId={currentFormId}
            entryId={null}
            onClose={() => setTaskQueueOpen(false)}
          />
        </>
      )}
      </div>
    </main>
  );
}

export default WorkReportListPage;

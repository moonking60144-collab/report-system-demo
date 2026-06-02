import { useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import "../../../App.css";
import { FixedFilterSidebar } from "../components/FixedFilterSidebar";
import { WorkReportSyncProgressModal } from "../components/WorkReportSyncProgressModal";
import { WorkReportToolbar } from "../components/WorkReportToolbar";
import { PendingBatchTasksBadge } from "../components/PendingBatchTasksBadge";
import { WorkReportStatusArea } from "../components/WorkReportStatusArea";
import { WorkReportTechnicalInfoPanel } from "../../dev/components/WorkReportTechnicalInfoPanel";
import { WorkReportTableSection } from "../components/WorkReportTableSection";
import { ColumnTextFilterDialog } from "../components/ColumnTextFilterDialog";
import { ColumnAnalysisDrawer } from "../components/ColumnAnalysisDrawer";
import { WorkReportLocalSettingsPanel } from "../components/WorkReportLocalSettingsPanel";
import { useWorkReportTaskMonitorContext } from "../context/useWorkReportTaskMonitorContext";
import { useWorkReportViewState } from "../hooks/useWorkReportViewState";
import { useColumnMenuState } from "../hooks/useColumnMenuState";
import { useWorkReportDataPipeline } from "../hooks/useWorkReportDataPipeline";
import { useWorkReportColumns } from "../hooks/useWorkReportColumns";
import { getSelectableWorkReportColumns } from "../hooks/workReportColumnDefinitions";
import { useWorkReportListNavigation } from "../hooks/useWorkReportListNavigation";
import { useWorkReportListData } from "../hooks/useWorkReportListData";
import { useWorkReportListDataSync } from "../hooks/useWorkReportListDataSync";
import { useWorkReportListEffectsController } from "../hooks/list/useWorkReportListEffectsController";
import { useWorkReportListEventLogger } from "../hooks/list/useWorkReportListEventLogger";
import { useWorkReportListInteractionController } from "../hooks/list/useWorkReportListInteractionController";
import { useWorkReportListLandingController } from "../hooks/list/useWorkReportListLandingController";
import { useWorkReportListPresetController } from "../hooks/list/useWorkReportListPresetController";
import { useWorkReportListQueryController } from "../hooks/list/useWorkReportListQueryController";
import { useWorkReportListRefreshController } from "../hooks/list/useWorkReportListRefreshController";
import { useWorkReportListStatusController } from "../hooks/list/useWorkReportListStatusController";
import { useWorkReportListViewController } from "../hooks/list/useWorkReportListViewController";
import { useWorkReportListUrlSync } from "../hooks/list/useWorkReportListUrlSync";
import { useWorkReportClientPresence } from "../hooks/useWorkReportClientPresence";
import { useWorkReportSessionExpiryGuard } from "../hooks/useWorkReportSessionExpiryGuard";
import { WORK_REPORT_LANDING_PAGE_CONFIGS } from "../constants";
import type {
  ColumnWidthOverrides,
  ColumnKey,
  NoticeState,
  SidebarPlaceholderView,
  UiLanguage,
  WorkReportLocalPreferences,
  WorkReportListLocationState,
} from "../types";
import {
  parseColumnSortRulesFromSearch,
  resolveWorkReportListLocationState,
  readColumnDisplayMode,
  readColumnWidthOverrides,
  readHiddenColumns,
  readWorkReportLocalPreferences,
  writeColumnWidthOverrides,
  writeColumnDisplayMode,
  writeHiddenColumns,
} from "../utils";
import { translateWorkOrderStatusValue } from "../../../i18n/valueMappers";

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
  const [columnDisplayMode, setColumnDisplayMode] = useState(() => readColumnDisplayMode());
  const [activePlaceholderViewId, setActivePlaceholderViewId] = useState<SidebarPlaceholderView["id"] | null>(
    initialListViewState?.activePlaceholderViewId ?? null
  );
  const [localPreferences, setLocalPreferences] = useState<WorkReportLocalPreferences>(() =>
    readWorkReportLocalPreferences()
  );
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
    hasFinishedTaskMonitors,
    taskRunningCount,
    taskFailedCount,
    latestTaskMonitor,
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
    columnMenuSearchState,
    columnAnalysisState,
    columnAnalysisLabel,
    columnTextFilterDialog,
    hasActiveColumnMenuFilters,
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
      columnFilterState: initialListViewState?.columnFilterState,
      columnSortRules:
        initialListViewState?.columnSortRules ?? parseColumnSortRulesFromSearch(location.search),
    },
  });
  const { syncQuickViewQuery } = useWorkReportListUrlSync({
    activeLandingPageKey,
    activeTopView,
    columnSortRules,
  });
  const activeLandingPageConfig = WORK_REPORT_LANDING_PAGE_CONFIGS[activeLandingPageKey];
  const currentFormId = activeLandingPageConfig.formId;
  const currentPageProdTypeCode = activeLandingPageConfig.prodTypeCode;
  const currentPageGroupLabel = t(activeLandingPageConfig.groupLabelI18nKey);
  const currentColumnLayoutKey = `${currentFormId}:${columnDisplayMode}`;
  const [columnWidthOverridesByKey, setColumnWidthOverridesByKey] = useState<
    Record<string, ColumnWidthOverrides>
  >(() => ({
    [currentColumnLayoutKey]: readColumnWidthOverrides(currentFormId, columnDisplayMode),
  }));
  const [columnSettingsOpen, setColumnSettingsOpen] = useState(false);
  const [hiddenColumnKeysByKey, setHiddenColumnKeysByKey] = useState<Record<string, ColumnKey[]>>(
    () => ({
      [currentColumnLayoutKey]: readHiddenColumns(currentFormId, columnDisplayMode),
    })
  );
  const columnWidthOverrides =
    columnWidthOverridesByKey[currentColumnLayoutKey] ??
    readColumnWidthOverrides(currentFormId, columnDisplayMode);
  const hiddenColumnKeysList =
    hiddenColumnKeysByKey[currentColumnLayoutKey] ??
    readHiddenColumns(currentFormId, columnDisplayMode);
  const hiddenColumnKeySet = useMemo(() => new Set(hiddenColumnKeysList), [hiddenColumnKeysList]);
  const resizeFrameRef = useRef<number | null>(null);
  const selectableColumns = useMemo(
    () => getSelectableWorkReportColumns(currentFormId, columnDisplayMode),
    [columnDisplayMode, currentFormId]
  );
  const handleToggleColumnVisibility = useCallback(
    (columnKey: ColumnKey) => {
      setHiddenColumnKeysByKey((previous) => {
        const current =
          previous[currentColumnLayoutKey] ??
          readHiddenColumns(currentFormId, columnDisplayMode);
        const next = current.includes(columnKey)
          ? current.filter((key) => key !== columnKey)
          : [...current, columnKey];
        writeHiddenColumns(currentFormId, columnDisplayMode, next);
        return {
          ...previous,
          [currentColumnLayoutKey]: next,
        };
      });
    },
    [columnDisplayMode, currentColumnLayoutKey, currentFormId]
  );
  const handleShowAllColumns = useCallback(() => {
    setHiddenColumnKeysByKey((previous) => ({
      ...previous,
      [currentColumnLayoutKey]: [],
    }));
    writeHiddenColumns(currentFormId, columnDisplayMode, []);
  }, [columnDisplayMode, currentColumnLayoutKey, currentFormId]);
  const handleResetDefaultColumns = useCallback(() => {
    setHiddenColumnKeysByKey((previous) => ({
      ...previous,
      [currentColumnLayoutKey]: [],
    }));
    writeHiddenColumns(currentFormId, columnDisplayMode, []);
  }, [columnDisplayMode, currentColumnLayoutKey, currentFormId]);
  const handleColumnResizeStart = useCallback(
    (
      columnKey: string,
      currentWidth: number,
      event: ReactPointerEvent<HTMLSpanElement>
    ) => {
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startWidth = Math.max(48, currentWidth);
      const minWidth = Math.max(48, Math.min(96, startWidth));
      const maxWidth = 420;
      let latestWidth = startWidth;
      let draftOverrides: ColumnWidthOverrides | null = null;
      document.body.classList.add("work-report-column-resizing");

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const deltaX = moveEvent.clientX - startX;
        const nextWidth = Math.min(
          maxWidth,
          Math.max(minWidth, Math.round(startWidth + deltaX))
        );
        latestWidth = nextWidth;
        if (resizeFrameRef.current !== null) {
          return;
        }
        resizeFrameRef.current = window.requestAnimationFrame(() => {
          resizeFrameRef.current = null;
          setColumnWidthOverridesByKey((previous) => {
            const current =
              previous[currentColumnLayoutKey] ??
              readColumnWidthOverrides(currentFormId, columnDisplayMode);
            if (current[columnKey] === latestWidth) {
              draftOverrides = current;
              return previous;
            }
            const next = {
              ...current,
              [columnKey]: latestWidth,
            };
            draftOverrides = next;
            return {
              ...previous,
              [currentColumnLayoutKey]: next,
            };
          });
        });
      };

      const handlePointerUp = () => {
        if (resizeFrameRef.current !== null) {
          window.cancelAnimationFrame(resizeFrameRef.current);
          resizeFrameRef.current = null;
        }
        document.body.classList.remove("work-report-column-resizing");
        const persistedOverrides = draftOverrides ?? {
          ...columnWidthOverrides,
          [columnKey]: latestWidth,
        };
        writeColumnWidthOverrides(
          currentFormId,
          columnDisplayMode,
          persistedOverrides
        );
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
    },
    [columnDisplayMode, columnWidthOverrides, currentColumnLayoutKey, currentFormId]
  );
  const { logListEvent } = useWorkReportListEventLogger(currentFormId);
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
    columnSortRules,
    setColumnSortRules,
    bootstrappedDefaultSortKeysRef,
    dismissedDefaultSortBootstrapKeysRef,
  });
  const {
    isGlobalFilterActive,
    shouldUseFullHydrationForList,
    serverPreviewQuery,
    bootstrapKeyword,
  } = useWorkReportListQueryController({
    activePlaceholderViewId,
    activeFixedFilterPresetId,
    currentFormId,
    globalFilters,
    columnSortRules,
    hasActiveColumnMenuFilters,
    isColumnAnalysisOpen,
    hasActiveColumnSortRules,
  });

  const {
    loading,
    error,
    records,
    allRecords,
    hasMore,
    previewTotalCount,
    hydration,
    loadReports,
    hydrateAllRecords,
    resetListDataState,
    resetHydrationState,
  } = useWorkReportListData({
    currentFormId,
    page,
    pageSize,
    shouldUseFullHydrationForList,
    serverPreviewQuery,
    bootstrapKeyword,
    t,
    setNotice,
  });
  const {
    hasHydratedAllRecords,
    isHydratingAllRecords,
    hydrationSource,
    backendCacheState,
    backendSnapshotAt,
    backendExpiresAt,
    fullDataHydratedAt,
    hydratedCount,
  } = hydration;

  const { pageScopedFiltersRef } = useWorkReportListLandingController({
    activeLandingPageKey,
    activePlaceholderViewId,
    localPreferences,
    globalFilterDraft,
    globalFilters,
    columnSortRules,
    setGlobalFilterDraft,
    setGlobalFilters,
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
    pageFrom,
    pageTo,
    hasMoreForPager,
    currentPageReportCount,
    matchedRecordCount,
    pageSizeOptions,
    unfinishedMachineShortcuts,
    activeUnfinishedMachineShortcut,
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
    hideTestCustomerPartRecords: localPreferences.hideTestCustomerPartRecords,
    pageProdTypeCode: currentPageProdTypeCode,
    shouldUseFullHydrationForList,
    hasHydratedAllRecords,
    isGlobalFilterActive,
    globalFilters,
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
  } = useWorkReportListInteractionController({
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
  });
  useWorkReportListEffectsController({
    highlightedEntryId,
    setHighlightedEntryId,
    notice,
    setNotice,
    t,
    applySidebarPlaceholderView,
    initialQuickViewRestored: Boolean(initialListViewState?.activePlaceholderViewId),
  });
  const { handleOpenDetail } = useWorkReportListNavigation({
    currentFormId,
    activeLandingPageKey,
    activeTopView,
    activePlaceholderViewId,
    globalFilterDraft,
    globalFilters,
    page,
    pageSize,
    columnFilterState,
    columnSortRules,
    loading,
    visibleRecords,
    setHighlightedEntryId,
  });
  const handleOpenDowntimePage = useCallback(() => {
    navigate("/downtime");
  }, [navigate]);

  const { columns } = useWorkReportColumns({
    enabled: isReportTopView,
    currentFormId,
    columnDisplayMode,
    columnWidthOverrides,
    hiddenColumnKeys: hiddenColumnKeySet,
    onColumnResizeStart: handleColumnResizeStart,
    disableFixedColumns: isMobileViewport,
    uiLanguage,
    onOpenDetail: handleOpenDetail,
    globalSearchKeyword: globalFilters.globalKeyword,
    menuState: {
      columnFilterState,
      columnSortRules,
      columnMenuOpenKey,
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
    hydrateAllRecords,
    setNotice,
    t,
    logListEvent,
  });

  const filterControlDisabled = loading || submitting || isHydratingAllRecords;

  const { systemStatusNotice } = useWorkReportListStatusController({
    activeTopView,
    notice,
    t,
    isHydratingAllRecords,
    hydratedCount,
    shouldUseFullHydrationForList,
    hasHydratedAllRecords,
    hydrationSource,
    backendCacheState,
    backendSnapshotAt,
    truncated: hydration.truncated,
    truncatedCount: hydration.truncatedCount,
    realtimeConnected,
    realtimeDisconnectedSince,
    isSyncingFromRagic,
    loading,
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
      isHydratingAllRecords,
      hydratedCount,
      shouldUseFullHydrationForList,
      hasHydratedAllRecords,
      hydrationSource,
      backendCacheState,
      backendSnapshotAt,
      backendExpiresAt,
      fullDataHydratedAt,
      truncated: hydration.truncated,
      truncatedCount: hydration.truncatedCount,
      realtimeConnected,
      realtimeDisconnectedSince,
    }),
    [
      backendCacheState,
      backendExpiresAt,
      backendSnapshotAt,
      fullDataHydratedAt,
      hasHydratedAllRecords,
      hydratedCount,
      hydration.truncated,
      hydration.truncatedCount,
      hydrationSource,
      isHydratingAllRecords,
      realtimeConnected,
      realtimeDisconnectedSince,
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
    }),
    [
      clearFinishedTaskMonitors,
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
    <main className="page">
      <div
        className={`ragic-list-shell ${fixedFilterSidebarCollapsed ? "is-sidebar-collapsed" : ""} ${
          isStandaloneTopView ? "is-settings-view" : ""
        }`}
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
            filterControlDisabled={filterControlDisabled}
            activeFixedFilterPresetId={activeFixedFilterPresetId}
            activePlaceholderViewId={activePlaceholderViewId}
            activeUnfinishedMachineShortcut={activeUnfinishedMachineShortcut}
            unfinishedMachineShortcuts={unfinishedMachineShortcuts}
            onToggleCollapsed={() => setFixedFilterSidebarCollapsed((prev) => !prev)}
            onCloseMobile={() => setMobileSidebarOpen(false)}
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
            onOpenLandingPage={handleOpenLandingPage}
            onOpenDowntimePage={handleOpenDowntimePage}
            onOpenTechnicalInfoView={openTechnicalInfoView}
            onOpenLocalSettingsView={openLocalSettingsView}
            showMobileFilterButton={activeTopView === "report" && isMobileViewport}
            onOpenMobileFilters={openMobileFilters}
            globalFilterDraft={globalFilterDraft}
            setGlobalFilterDraft={setGlobalFilterDraft}
            statusFilterOptions={statusFilterOptions}
            siteRunningFilterOptions={siteRunningFilterOptions}
            pageSizeOptions={pageSizeOptions}
            columnDisplayMode={columnDisplayMode}
            setColumnDisplayMode={(mode) => {
              setColumnSettingsOpen(false);
              setColumnDisplayMode(mode);
              writeColumnDisplayMode(mode);
            }}
            columnSettingsOpen={columnSettingsOpen}
            setColumnSettingsOpen={setColumnSettingsOpen}
            selectableColumns={selectableColumns}
            hiddenColumnKeys={hiddenColumnKeySet}
            onToggleColumnVisibility={handleToggleColumnVisibility}
            onShowAllColumns={handleShowAllColumns}
            onResetDefaultColumns={handleResetDefaultColumns}
            pageSize={pageSize}
            setPageSize={setPageSize}
            setPage={setPage}
            filterControlDisabled={filterControlDisabled}
            loading={loading}
            submitting={submitting}
            isHydratingAllRecords={isHydratingAllRecords}
            isSyncingFromRagic={isSyncingFromRagic}
            activeFilterChips={activeFilterChips}
            onRemoveActiveFilterChip={handleRemoveActiveFilterChip}
            onApplyFilters={handleApplyFilters}
            onClearFilters={handleClearFilters}
            onRefresh={handleRefresh}
            onSystemNoticeForceRefresh={handleSystemNoticeForceRefresh}
            systemNoticeForceReloadToken={sseNoticeReloadToken}
            systemStatusNotice={systemStatusNotice}
          />
          {activeTopView === "local-settings" ? (
            <WorkReportLocalSettingsPanel
              value={localPreferences}
              onChange={setLocalPreferences}
              onSave={handleSaveLocalSettings}
              onBackToReport={() => setActiveTopView("report")}
            />
          ) : activeTopView === "technical-info" ? (
            <WorkReportTechnicalInfoPanel />
          ) : (
            <>
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
                loading={loading}
                error={error}
              />

              {!loading && !error && (
                <WorkReportTableSection
                  columns={columns}
                  columnDisplayMode={columnDisplayMode}
                  visibleRecords={visibleRecords}
                  pageFrom={pageFrom}
                  pageTo={pageTo}
                  page={page}
                  loading={loading}
                  submitting={submitting}
                  isHydratingAllRecords={isHydratingAllRecords}
                  hasMoreForPager={hasMoreForPager}
                  softBusy={tableSoftBusy}
                  softBusyLabel={tableSoftBusyLabel}
                  highlightedEntryId={highlightedEntryId}
                  onPrevPage={() => setPage((prev) => Math.max(1, prev - 1))}
                  onNextPage={() => setPage((prev) => prev + 1)}
                  onOpenDetail={handleOpenDetail}
                />
              )}
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
        </>
      )}
      </div>
    </main>
  );
}

export default WorkReportListPage;

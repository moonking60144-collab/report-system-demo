import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Modal } from "antd";
import "../../../App.css";
import { FixedFilterSidebar } from "../components/FixedFilterSidebar";
import { WorkReportSyncProgressModal } from "../components/WorkReportSyncProgressModal";
import { WorkReportToolbar } from "../components/WorkReportToolbar";
import { WorkReportWorkspaceToolbar } from "../components/WorkReportWorkspaceToolbar";
import { WorkReportFilterPanel } from "../components/WorkReportFilterPanel";
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
  ColumnDisplayMode,
  ColumnKey,
  NoticeState,
  SidebarPlaceholderView,
  UiLanguage,
  WorkReportColumnColor,
  WorkReportFormId,
  WorkReportLocalPreferences,
  WorkReportListLocationState,
  WorkReportTableLayoutPreferences,
} from "../types";
import {
  createDefaultWorkReportTableLayout,
  countActiveColumnFilters,
  countActiveGlobalFilters,
  getErrorMessage,
  isSameGlobalFilters,
  parseColumnSortRulesFromSearch,
  readWorkReportTableLayout,
  reconcileWorkReportTableLayout,
  resetWorkReportTableLayout,
  resolveWorkReportListLocationState,
  readColumnDisplayMode,
  readWorkReportLocalPreferences,
  writeColumnDisplayMode,
  writeWorkReportTableLayout,
} from "../utils";
import { translateWorkOrderStatusValue } from "../../../i18n/valueMappers";
import {
  fetchWorkReportQueueTasks,
  fetchWorkReportEntry,
  updateWorkOrderSortOrderAccepted,
  type WorkReportRecord,
} from "../../../api/workReport";
import {
  buildWorkReportPrintDocument,
  buildWorkReportPrintLoadingDocument,
  fetchActiveSortOrderTasks,
  fetchWorkReportPrintRecords,
  isWorkReportPrintRecordCountAllowed,
  WORK_REPORT_PRINT_MAX_RECORDS,
  writeWorkReportPrintWindow,
} from "../workReportPrint";
import {
  bindRetryableSortOrderMutationTask,
  deleteRetryableSortOrderMutationByTaskId,
  getOrCreateRetryableSortOrderMutation,
  getRetryableSortOrderMutationByTaskId,
  listRetryableSortOrderMutations,
  resolveSortOrderTaskRecordPatch,
} from "../sortOrderTaskRetryStore";
import {
  readWorkReportDeviceLabel,
  writeWorkReportDeviceLabel,
} from "../../../utils/clientIdentity";
import { resolveTaskMutationLifecycleState } from "../mutationLifecycle";
import {
  createWorkReportOptimisticMutation,
  reconcileWorkReportOptimisticMutation,
} from "../workReportOptimisticMutation";
import { WORK_REPORT_OPTIMISTIC_MUTATIONS_ENABLED } from "../optimisticMutationFeatureFlags";

function parseRollbackSortOrder(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

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
    upsertCreateTaskMonitor,
  } = useWorkReportTaskMonitorContext();
  const processedEntryUpdateTaskIdsRef = useRef<Set<string>>(new Set());
  const processedFailedEntryUpdateTaskIdsRef = useRef<Set<string>>(new Set());
  const restoredSortOrderTaskIdsRef = useRef<Set<string>>(new Set());
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
  const hasPendingFilterChanges = useMemo(
    () => !isSameGlobalFilters(globalFilterDraft, globalFilters),
    [globalFilterDraft, globalFilters]
  );
  const activeColumnFilterCount = useMemo(
    () => countActiveColumnFilters(columnFilterState),
    [columnFilterState]
  );
  const currentColumnLayoutKey = `${currentFormId}:${columnDisplayMode}`;
  const selectableColumns = useMemo(
    () => getSelectableWorkReportColumns(currentFormId, columnDisplayMode),
    [columnDisplayMode, currentFormId]
  );
  const selectableColumnKeys = useMemo(
    () => selectableColumns.map((column) => column.key),
    [selectableColumns]
  );
  const [columnSettingsOpen, setColumnSettingsOpen] = useState(false);
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [workspaceStickyHeight, setWorkspaceStickyHeight] = useState(0);
  const [tableLayoutsByKey, setTableLayoutsByKey] = useState<
    Record<string, WorkReportTableLayoutPreferences>
  >(() => ({
    [currentColumnLayoutKey]: readWorkReportTableLayout(
      currentFormId,
      columnDisplayMode,
      selectableColumnKeys
    ),
  }));
  const tableLayoutsByKeyRef = useRef(tableLayoutsByKey);
  const currentTableLayout =
    tableLayoutsByKey[currentColumnLayoutKey] ??
    readWorkReportTableLayout(
      currentFormId,
      columnDisplayMode,
      selectableColumnKeys
    );
  const columnWidthOverrides = currentTableLayout.columnWidths;
  const hiddenColumnKeySet = useMemo(
    () => new Set(currentTableLayout.hiddenColumnKeys),
    [currentTableLayout.hiddenColumnKeys]
  );
  const resizeFrameRef = useRef<number | null>(null);

  const applyCurrentTableLayoutState = useCallback(
    (layout: WorkReportTableLayoutPreferences) => {
      const nextLayouts = {
        ...tableLayoutsByKeyRef.current,
        [currentColumnLayoutKey]: layout,
      };
      tableLayoutsByKeyRef.current = nextLayouts;
      setTableLayoutsByKey(nextLayouts);
    },
    [currentColumnLayoutKey]
  );

  const handleWorkspaceToolbarHeightChange = useCallback((height: number) => {
    setWorkspaceStickyHeight((previous) => (previous === height ? previous : height));
  }, []);

  const handleOpenFiltersFromWorkspace = useCallback(() => {
    if (filterPanelOpen) {
      setFilterPanelOpen(false);
      return;
    }
    setFilterPanelOpen(true);
    window.requestAnimationFrame(() => {
      const filterPanel = document.getElementById("work-report-filter-panel");
      if (!filterPanel) {
        return;
      }
      window.scrollTo({
        top:
          filterPanel.getBoundingClientRect().top +
          window.scrollY -
          workspaceStickyHeight,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
    });
  }, [filterPanelOpen, workspaceStickyHeight]);
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
    setPage((previous) => Math.max(1, previous - 1));
  }, [setPage]);
  const handleNextPage = useCallback(() => {
    setPage((previous) => previous + 1);
  }, [setPage]);
  const handlePageSizeChange = useCallback(
    (nextPageSize: number) => {
      setPageSize(nextPageSize);
      setPage(1);
    },
    [setPage, setPageSize]
  );
  const handleColumnDisplayModeChange = useCallback((mode: ColumnDisplayMode) => {
    setColumnSettingsOpen(false);
    setColumnDisplayMode(mode);
    writeColumnDisplayMode(mode);
  }, []);
  const handleOpenColumnSettings = useCallback(() => {
    setColumnSettingsOpen(true);
  }, []);
  const handleOpenTaskQueue = useCallback(() => {
    setTaskQueueOpen(true);
  }, []);

  const updateCurrentTableLayout = useCallback(
    (
      updater: (
        current: WorkReportTableLayoutPreferences
      ) => WorkReportTableLayoutPreferences
    ) => {
      const current =
        tableLayoutsByKeyRef.current[currentColumnLayoutKey] ??
        readWorkReportTableLayout(
          currentFormId,
          columnDisplayMode,
          selectableColumnKeys
        );
      const next = reconcileWorkReportTableLayout(
        updater(current),
        selectableColumnKeys
      );
      applyCurrentTableLayoutState(next);
      writeWorkReportTableLayout(
        currentFormId,
        columnDisplayMode,
        next,
        selectableColumnKeys
      );
    },
    [
      applyCurrentTableLayoutState,
      columnDisplayMode,
      currentColumnLayoutKey,
      currentFormId,
      selectableColumnKeys,
    ]
  );

  const handleToggleColumnVisibility = useCallback(
    (columnKey: ColumnKey) => {
      updateCurrentTableLayout((current) => {
        const hiddenColumnKeys = current.hiddenColumnKeys.includes(columnKey)
          ? current.hiddenColumnKeys.filter((key) => key !== columnKey)
          : [...current.hiddenColumnKeys, columnKey];
        return { ...current, hiddenColumnKeys };
      });
    },
    [updateCurrentTableLayout]
  );
  const handleShowAllColumns = useCallback(() => {
    updateCurrentTableLayout((current) => ({
      ...current,
      hiddenColumnKeys: [],
    }));
  }, [updateCurrentTableLayout]);
  const handleResetDefaultColumns = useCallback(() => {
    resetWorkReportTableLayout(currentFormId, columnDisplayMode);
    applyCurrentTableLayoutState(
      createDefaultWorkReportTableLayout(selectableColumnKeys)
    );
  }, [
    applyCurrentTableLayoutState,
    columnDisplayMode,
    currentFormId,
    selectableColumnKeys,
  ]);
  const handleMoveColumn = useCallback(
    (columnKey: ColumnKey, targetColumnKey: ColumnKey) => {
      updateCurrentTableLayout((current) => {
        const withoutSource = current.columnOrder.filter(
          (key) => key !== columnKey
        );
        const targetIndex = withoutSource.indexOf(targetColumnKey);
        if (targetIndex < 0) {
          return current;
        }
        withoutSource.splice(targetIndex, 0, columnKey);
        return { ...current, columnOrder: withoutSource };
      });
    },
    [updateCurrentTableLayout]
  );
  const handleMoveColumnByOffset = useCallback(
    (columnKey: ColumnKey, offset: -1 | 1) => {
      updateCurrentTableLayout((current) => {
        const currentIndex = current.columnOrder.indexOf(columnKey);
        const targetIndex = currentIndex + offset;
        if (
          currentIndex < 0 ||
          targetIndex < 0 ||
          targetIndex >= current.columnOrder.length
        ) {
          return current;
        }
        const columnOrder = [...current.columnOrder];
        [columnOrder[currentIndex], columnOrder[targetIndex]] = [
          columnOrder[targetIndex],
          columnOrder[currentIndex],
        ];
        return { ...current, columnOrder };
      });
    },
    [updateCurrentTableLayout]
  );
  const handleChangeColumnColor = useCallback(
    (columnKey: ColumnKey, color: WorkReportColumnColor) => {
      updateCurrentTableLayout((current) => {
        const columnColors = { ...current.columnColors };
        if (color === "none") {
          delete columnColors[columnKey];
        } else {
          columnColors[columnKey] = color;
        }
        return { ...current, columnColors };
      });
    },
    [updateCurrentTableLayout]
  );
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
          const current =
            tableLayoutsByKeyRef.current[currentColumnLayoutKey] ??
            readWorkReportTableLayout(
              currentFormId,
              columnDisplayMode,
              selectableColumnKeys
            );
          if (current.columnWidths[columnKey] === latestWidth) {
            return;
          }
          applyCurrentTableLayoutState(
            reconcileWorkReportTableLayout(
              {
                ...current,
                columnWidths: {
                  ...current.columnWidths,
                  [columnKey]: latestWidth,
                },
              },
              selectableColumnKeys
            )
          );
        });
      };

      const handlePointerUp = () => {
        if (resizeFrameRef.current !== null) {
          window.cancelAnimationFrame(resizeFrameRef.current);
          resizeFrameRef.current = null;
        }
        document.body.classList.remove("work-report-column-resizing");
        const current =
          tableLayoutsByKeyRef.current[currentColumnLayoutKey] ??
          currentTableLayout;
        const persistedLayout = reconcileWorkReportTableLayout(
          {
            ...current,
            columnWidths: {
              ...current.columnWidths,
              [columnKey]: latestWidth,
            },
          },
          selectableColumnKeys
        );
        applyCurrentTableLayoutState(persistedLayout);
        writeWorkReportTableLayout(
          currentFormId,
          columnDisplayMode,
          persistedLayout,
          selectableColumnKeys
        );
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
    },
    [
      applyCurrentTableLayoutState,
      columnDisplayMode,
      currentColumnLayoutKey,
      currentFormId,
      currentTableLayout,
      selectableColumnKeys,
    ]
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
    previewTransitionPending,
    displayedPreviewPage,
    displayedPreviewPageSize,
    hydration,
    loadReports,
    hydrateAllRecords,
    mergeListRecord,
    patchListRecord,
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
  const effectiveListLoading = loading || previewTransitionPending;
  useEffect(() => {
    if (!WORK_REPORT_OPTIMISTIC_MUTATIONS_ENABLED) {
      return;
    }
    for (const task of createTaskMonitors) {
      const mutation = task.optimisticMutation;
      if (
        task.formId !== currentFormId ||
        !mutation ||
        mutation.patch.kind !== "update-entry" ||
        (mutation.lifecycle.optimisticState !== "applied" &&
          mutation.lifecycle.optimisticState !== "confirmed" &&
          mutation.lifecycle.optimisticState !== "frozen")
      ) {
        continue;
      }
      patchListRecord(currentFormId, task.entryId, mutation.patch.patch);
    }
  }, [createTaskMonitors, currentFormId, patchListRecord]);
  useEffect(() => {
    for (const retryRecord of listRetryableSortOrderMutations(currentFormId)) {
      const pendingPatch = resolveSortOrderTaskRecordPatch(retryRecord, "pending");
      if (WORK_REPORT_OPTIMISTIC_MUTATIONS_ENABLED && pendingPatch) {
        patchListRecord(pendingPatch.formId, pendingPatch.entryId, {
          sortOrder: pendingPatch.sortOrder,
        });
      }
      if (
        !retryRecord.taskId ||
        restoredSortOrderTaskIdsRef.current.has(retryRecord.taskId)
      ) {
        continue;
      }
      restoredSortOrderTaskIdsRef.current.add(retryRecord.taskId);
      if (createTaskMonitors.some((task) => task.taskId === retryRecord.taskId)) {
        continue;
      }
      upsertCreateTaskMonitor({
        taskId: retryRecord.taskId,
        kind: "update",
        formId: retryRecord.formId,
        entryId: retryRecord.entryId,
        workOrderNo: String(retryRecord.workOrderNo ?? retryRecord.entryId),
        status: "pending",
        lifecycleState: "accepted",
        acceptedAt: retryRecord.createdAt,
        confirmedAt: null,
        message: t("workReport:table.sortOrderQueued"),
        updatedAt: retryRecord.createdAt,
        ...(retryRecord.lifecycle
          ? {
              optimisticMutation: {
                lifecycle: retryRecord.lifecycle,
                patch: {
                  kind: "update-entry" as const,
                  patch: { sortOrder: retryRecord.sortOrder },
                },
              },
            }
          : {}),
      });
    }
  }, [createTaskMonitors, currentFormId, patchListRecord, records, t, upsertCreateTaskMonitor]);
  useEffect(() => {
    for (const task of createTaskMonitors) {
      if (
        task.kind !== "update" ||
        task.rowId ||
        (task.formId !== "104" && task.formId !== "105")
      ) {
        continue;
      }
      if (task.status === "failed" || task.stale === true) {
        if (processedFailedEntryUpdateTaskIdsRef.current.has(task.taskId)) {
          continue;
        }
        const targetFormId: WorkReportFormId = task.formId;
        const targetEntryId = task.entryId;
        const optimisticMutation = task.optimisticMutation;
        const isVerificationPending =
          task.stale === true ||
          optimisticMutation?.lifecycle.optimisticState === "frozen";
        if (!isVerificationPending) {
          const retryRecord = getRetryableSortOrderMutationByTaskId(task.taskId);
          const rollbackPatch = resolveSortOrderTaskRecordPatch(retryRecord, "failed");
          if (rollbackPatch) {
            patchListRecord(rollbackPatch.formId, rollbackPatch.entryId, {
              sortOrder: rollbackPatch.sortOrder,
            });
          } else if (
            optimisticMutation?.lifecycle.optimisticState === "rolled-back" &&
            optimisticMutation.patch.kind === "update-entry" &&
            optimisticMutation.lifecycle.previousSnapshot &&
            typeof optimisticMutation.lifecycle.previousSnapshot === "object" &&
            !Array.isArray(optimisticMutation.lifecycle.previousSnapshot)
          ) {
            patchListRecord(
              targetFormId,
              targetEntryId,
              optimisticMutation.lifecycle.previousSnapshot as Partial<WorkReportRecord>
            );
          }
        }
        processedFailedEntryUpdateTaskIdsRef.current.add(task.taskId);
        if (!isVerificationPending) {
          deleteRetryableSortOrderMutationByTaskId(task.taskId);
        }
        void fetchWorkReportEntry(targetFormId, targetEntryId, true, {
          strictRefresh: true,
        })
          .then((freshRecord) => {
            mergeListRecord(targetFormId, freshRecord);
          })
          .catch((refreshError) => {
            setNotice({
              type: "error",
              message: t("workReport:table.sortOrderRefreshFailed", {
                error: getErrorMessage(refreshError),
              }),
            });
          });
        continue;
      }
      if (
        task.status !== "success" ||
        processedEntryUpdateTaskIdsRef.current.has(task.taskId)
      ) {
        continue;
      }
      processedEntryUpdateTaskIdsRef.current.add(task.taskId);
      const targetFormId: WorkReportFormId = task.formId;
      const retryRecord = getRetryableSortOrderMutationByTaskId(task.taskId);
      const successPatch = resolveSortOrderTaskRecordPatch(retryRecord, "success");
      if (successPatch) {
        patchListRecord(successPatch.formId, successPatch.entryId, {
          sortOrder: successPatch.sortOrder,
        });
      } else {
        void fetchWorkReportEntry(targetFormId, task.entryId, true, {
          strictRefresh: true,
        })
          .then((freshRecord) => {
            mergeListRecord(targetFormId, freshRecord);
          })
          .catch((refreshError) => {
            setNotice({
              type: "error",
              message: t("workReport:table.sortOrderRefreshFailed", {
                error: getErrorMessage(refreshError),
              }),
            });
          });
      }
      deleteRetryableSortOrderMutationByTaskId(task.taskId);
    }
  }, [
    createTaskMonitors,
    mergeListRecord,
    patchListRecord,
    t,
  ]);
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
    effectiveColumnSortRules,
    displayedPage,
    pageFrom,
    pageTo,
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
    displayedPreviewPage,
    displayedPreviewPageSize,
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
    openLocalSettingsView,
    openMobileFilters,
    applySidebarPlaceholderView,
  } = useWorkReportListInteractionController({
    currentFormId,
    activeLandingPageKey,
    activePlaceholderViewId,
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
  const activeFilterCount =
    countActiveGlobalFilters(globalFilters) +
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
      const activeSortOrderTasks = await fetchActiveSortOrderTasks(
        currentFormId,
        fetchWorkReportQueueTasks
      );
      if (activeSortOrderTasks.length > 0) {
        printWindow.close();
        Modal.warning({
          title: t("workReport:table.printSortOrderPendingTitle"),
          content: t("workReport:table.printSortOrderPendingMessage", {
            count: activeSortOrderTasks.length,
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
      });
      const printRecords = runWorkReportRecordPipeline(scopedRecords, {
        isGlobalFilterActive,
        globalFilters,
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
      writeWorkReportPrintWindow(
        printWindow,
        buildWorkReportPrintDocument({
          formId: currentFormId,
          records: printRecords,
          language: uiLanguage,
        })
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
    currentPageProdTypeCode,
    effectiveColumnSortRules,
    globalFilters,
    hydrateAllRecords,
    isGlobalFilterActive,
    localPreferences.hideTestCustomerPartRecords,
    t,
    uiLanguage,
  ]);
  const handleOpenPrintViewClick = useCallback(() => {
    void handleOpenPrintView();
  }, [handleOpenPrintView]);

  const handleUpdateSortOrder = useCallback(
    async (record: WorkReportRecord, sortOrder: number) => {
      const retryRecord = getOrCreateRetryableSortOrderMutation({
        formId: currentFormId,
        entryId: String(record.id),
        sortOrder,
        previousSortOrder: parseRollbackSortOrder(record.sortOrder),
        workOrderNo: record.workOrderNo,
        expectedEntryLastUpdatedAt: record.lastUpdatedAt ?? undefined,
      });
      const accepted = await updateWorkOrderSortOrderAccepted(
        retryRecord.formId,
        retryRecord.entryId,
        retryRecord.sortOrder,
        {
          clientMutationId: retryRecord.clientMutationId,
          workOrderNo: retryRecord.workOrderNo,
          expectedEntryLastUpdatedAt: retryRecord.expectedEntryLastUpdatedAt,
        }
      );
      bindRetryableSortOrderMutationTask(
        retryRecord.clientMutationId,
        accepted.taskId,
        accepted.acceptedAt ?? accepted.createdAt
      );
      if (accepted.status === "failed") {
        deleteRetryableSortOrderMutationByTaskId(accepted.taskId);
      } else if (WORK_REPORT_OPTIMISTIC_MUTATIONS_ENABLED) {
        patchListRecord(currentFormId, String(record.id), {
          sortOrder,
        });
      }
      const updatedAt = new Date().toISOString();
      const lifecycleState = accepted.lifecycleState ??
        resolveTaskMutationLifecycleState({ status: accepted.status });
      const optimisticMutation = WORK_REPORT_OPTIMISTIC_MUTATIONS_ENABLED
        ? reconcileWorkReportOptimisticMutation(
            createWorkReportOptimisticMutation({
              taskId: accepted.taskId,
              mutationId: retryRecord.clientMutationId,
              operation: "work-report-sort-order",
              target: {
                domain: "work-report",
                formId: retryRecord.formId,
                entryId: retryRecord.entryId,
              },
              acceptedAt: accepted.acceptedAt ?? accepted.createdAt,
              reconcilePolicy: "replace-target",
              failurePolicy: "rollback",
              previousSnapshot: retryRecord.previousSortOrder ?? null,
              patch: {
                kind: "update-entry",
                patch: { sortOrder: retryRecord.sortOrder },
              },
            }),
            {
              lifecycleState,
              confirmedAt: accepted.confirmedAt,
            }
          )
        : undefined;
      upsertCreateTaskMonitor({
        taskId: accepted.taskId,
        kind: "update",
        formId: retryRecord.formId,
        entryId: retryRecord.entryId,
        workOrderNo: String(record.workOrderNo ?? record.id),
        status: accepted.status,
        lifecycleState,
        acceptedAt: accepted.acceptedAt ?? accepted.createdAt,
        confirmedAt: accepted.confirmedAt ?? null,
        message:
          accepted.status === "success"
            ? t("workReport:table.sortOrderUpdated")
            : accepted.status === "failed"
              ? t("workReport:table.sortOrderUpdateFailed")
              : t("workReport:table.sortOrderQueued"),
        updatedAt,
        ...(optimisticMutation ? { optimisticMutation } : {}),
      });
      setNotice({
        type: accepted.status === "failed" ? "error" : "info",
        message:
          accepted.status === "success"
            ? t("workReport:table.sortOrderUpdated")
            : accepted.status === "failed"
              ? t("workReport:table.sortOrderUpdateFailed")
              : t("workReport:table.sortOrderQueued"),
      });
    },
    [currentFormId, patchListRecord, t, upsertCreateTaskMonitor]
  );

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
    onUpdateSortOrder: handleUpdateSortOrder,
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

  const effectiveTableSoftBusy = tableSoftBusy || previewTransitionPending;
  const effectiveTableSoftBusyLabel = tableSoftBusyLabel ?? (
    previewTransitionPending ? t("workReport:status.tableBusy.loading") : null
  );
  const filterControlDisabled = effectiveListLoading || submitting || isHydratingAllRecords;

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
          />
          {activeTopView === "local-settings" ? (
            <WorkReportLocalSettingsPanel
              value={localPreferences}
              deviceLabel={deviceLabel}
              onChange={setLocalPreferences}
              onDeviceLabelChange={setDeviceLabel}
              onSave={() => {
                writeWorkReportDeviceLabel(deviceLabel);
                handleSaveLocalSettings();
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
                searchValue={globalFilterDraft.globalKeyword}
                onSearchValueChange={handleGlobalSearchDraftChange}
                onSearchSubmit={handleApplyFilters}
                page={displayedPage}
                hasMoreForPager={hasMoreForPager}
                onPrevPage={handlePreviousPage}
                onNextPage={handleNextPage}
                activeFilterCount={activeFilterCount}
                hasPendingFilterChanges={hasPendingFilterChanges}
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
                stickyEnabled={!isMobileViewport}
                onHeightChange={handleWorkspaceToolbarHeightChange}
              />
                {filterPanelOpen ? (
                  <WorkReportFilterPanel
                    currentFormId={currentFormId}
                    globalFilterDraft={globalFilterDraft}
                    setGlobalFilterDraft={setGlobalFilterDraft}
                    machineFilterOptions={machineFilterOptions}
                    statusFilterOptions={statusFilterOptions}
                    siteRunningFilterOptions={siteRunningFilterOptions}
                    filterControlDisabled={filterControlDisabled}
                    activeFilterChips={activeFilterChips}
                    columnFilterCount={activeColumnFilterCount}
                    hasPendingChanges={hasPendingFilterChanges}
                    onRemoveActiveFilterChip={handleRemoveActiveFilterChip}
                    onApplyFilters={handleApplyFilters}
                    onClearFilters={handleClearFilters}
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
                loading={effectiveListLoading}
                error={error}
                />

                {!error && (!effectiveListLoading || visibleRecords.length > 0) && (
                  <WorkReportTableSection
                  columns={columns}
                  columnDisplayMode={columnDisplayMode}
                  visibleRecords={visibleRecords}
                  pageFrom={pageFrom}
                  pageTo={pageTo}
                  page={displayedPage}
                  loading={effectiveListLoading}
                  submitting={submitting}
                  isHydratingAllRecords={isHydratingAllRecords}
                  hasMoreForPager={hasMoreForPager}
                  softBusy={effectiveTableSoftBusy}
                  softBusyLabel={effectiveTableSoftBusyLabel}
                  stickyHeaderOffset={Math.max(0, workspaceStickyHeight - 2)}
                  highlightedEntryId={highlightedEntryId}
                  onPrevPage={handlePreviousPage}
                  onNextPage={handleNextPage}
                  onOpenDetail={handleOpenDetailFromTable}
                  />
                )}
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

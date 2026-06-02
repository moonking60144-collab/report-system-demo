import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { fetchWorkReportAnalysis, fetchWorkReportFacets } from "../../../api/workReport";
import type { WorkReportRecord } from "../../../api/workReport";
import {
  ALL_FILTER_VALUE,
  BACKEND_ANALYSIS_COLUMN_KEYS,
  BACKEND_FACET_COLUMN_KEYS,
  COLUMN_TYPE_MAP,
  RAGIC_UNFINISHED_MACHINE_SHORTCUT_ORDER,
  RAGIC_UNFINISHED_MACHINE_SHORTCUT_ORDER_105,
} from "../constants";
import type {
  ColumnAnalysisSummary,
  ColumnAnalysisState,
  ColumnDataType,
  ColumnFacetOption,
  ColumnFilterState,
  ColumnSortRule,
  FixedFilterPresetId,
  GlobalFilters,
  UiLanguage,
  WorkReportLandingPageKey,
} from "../types";
import {
  applyColumnFilters,
  applyGlobalFilters,
  applyPageReportGroupFilter,
  buildBackendColumnFilters,
  buildColumnAnalysisSummary,
  buildColumnFacetOptions,
  buildUnfinishedMachineShortcut,
  compareAlphaNumeric,
  getDefaultSortRulesForCurrentFilters,
  getColumnFacetLabelFromToken,
  isActiveUnfinishedMachineShortcut,
  normalizeText,
  sortRecordsByColumnRules,
} from "../utils";

interface UseWorkReportDataPipelineArgs {
  enabled?: boolean;
  pageProdTypeCode: string;
  currentFormId: "104" | "105";
  activeLandingPageKey: WorkReportLandingPageKey;
  activeFixedFilterPresetId: FixedFilterPresetId | null;
  allRecords: WorkReportRecord[];
  records: WorkReportRecord[];
  previewTotalCount: number;
  hideTestCustomerPartRecords: boolean;
  shouldUseFullHydrationForList: boolean;
  hasHydratedAllRecords: boolean;
  isGlobalFilterActive: boolean;
  globalFilters: GlobalFilters;
  columnFilterState: ColumnFilterState;
  columnSortRules: ColumnSortRule[];
  isSidebarFixedViewActive: boolean;
  page: number;
  pageSize: number;
  hasMore: boolean;
  setPage: Dispatch<SetStateAction<number>>;
  columnMenuOpenKey: string | null;
  columnMenuSearchState: Partial<Record<string, string>>;
  columnAnalysisState: ColumnAnalysisState;
  uiLanguage: UiLanguage;
  translateStatusDisplay: (status: string) => string;
}

function buildRemoteQuerySignature(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

const remoteDataVersionByRecords = new WeakMap<WorkReportRecord[], number>();
let nextRemoteDataVersion = 0;

function getRemoteRecordSetVersion(records: WorkReportRecord[]): number {
  const existing = remoteDataVersionByRecords.get(records);
  if (existing) {
    return existing;
  }
  nextRemoteDataVersion += 1;
  remoteDataVersionByRecords.set(records, nextRemoteDataVersion);
  return nextRemoteDataVersion;
}

function buildRemoteDataVersion(
  records: WorkReportRecord[],
  options: {
    hasHydratedAllRecords: boolean;
    previewTotalCount: number;
  }
): string {
  return JSON.stringify({
    mode: options.hasHydratedAllRecords ? "full" : "preview",
    previewTotalCount: options.previewTotalCount,
    recordsVersion: getRemoteRecordSetVersion(records),
  });
}

const remoteFacetRequestBySignature = new Map<string, Promise<string[]>>();
const remoteAnalysisRequestBySignature = new Map<string, Promise<ColumnAnalysisSummary>>();

async function fetchRemoteFacetTokensDeduped(
  signature: string,
  loader: () => Promise<string[]>
): Promise<string[]> {
  const inFlight = remoteFacetRequestBySignature.get(signature);
  if (inFlight) {
    return inFlight;
  }
  const task = loader().finally(() => {
    if (remoteFacetRequestBySignature.get(signature) === task) {
      remoteFacetRequestBySignature.delete(signature);
    }
  });
  remoteFacetRequestBySignature.set(signature, task);
  return task;
}

async function fetchRemoteAnalysisDeduped(
  signature: string,
  loader: () => Promise<ColumnAnalysisSummary>
): Promise<ColumnAnalysisSummary> {
  const inFlight = remoteAnalysisRequestBySignature.get(signature);
  if (inFlight) {
    return inFlight;
  }
  const task = loader().finally(() => {
    if (remoteAnalysisRequestBySignature.get(signature) === task) {
      remoteAnalysisRequestBySignature.delete(signature);
    }
  });
  remoteAnalysisRequestBySignature.set(signature, task);
  return task;
}

function runRecordPipeline(
  sourceRecords: WorkReportRecord[],
  options: {
    isGlobalFilterActive: boolean;
    globalFilters: GlobalFilters;
    columnFilterState: ColumnFilterState;
    sortRules: ColumnSortRule[];
  }
): WorkReportRecord[] {
  let nextRecords = sourceRecords;

  if (options.isGlobalFilterActive) {
    nextRecords = applyGlobalFilters(nextRecords, options.globalFilters);
  }

  nextRecords = applyColumnFilters(nextRecords, options.columnFilterState, COLUMN_TYPE_MAP);

  if (options.sortRules.length > 0) {
    nextRecords = sortRecordsByColumnRules(nextRecords, options.sortRules);
  }

  return nextRecords;
}

export function useWorkReportDataPipeline({
  enabled = true,
  pageProdTypeCode,
  currentFormId,
  activeLandingPageKey,
  activeFixedFilterPresetId,
  allRecords,
  records,
  previewTotalCount,
  hideTestCustomerPartRecords,
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
}: UseWorkReportDataPipelineArgs) {
  const { t } = useTranslation(["workReport", "common"]);
  const sanitizedAllRecords = useMemo(() => {
    if (!enabled) {
      return [] as WorkReportRecord[];
    }
    if (!hideTestCustomerPartRecords) {
      return allRecords;
    }
    return allRecords.filter((record) => !normalizeText(record.customerPartNo).includes("test"));
  }, [allRecords, enabled, hideTestCustomerPartRecords]);

  const sanitizedPreviewRecords = useMemo(() => {
    if (!enabled) {
      return [] as WorkReportRecord[];
    }
    if (!hideTestCustomerPartRecords) {
      return records;
    }
    return records.filter((record) => !normalizeText(record.customerPartNo).includes("test"));
  }, [enabled, records, hideTestCustomerPartRecords]);

  const groupedAllRecords = useMemo(
    () =>
      currentFormId === "105"
        ? sanitizedAllRecords
        : applyPageReportGroupFilter(sanitizedAllRecords, pageProdTypeCode),
    [currentFormId, sanitizedAllRecords, pageProdTypeCode]
  );
  const groupedPreviewRecords = useMemo(
    () =>
      currentFormId === "105"
        ? sanitizedPreviewRecords
        : applyPageReportGroupFilter(sanitizedPreviewRecords, pageProdTypeCode),
    [currentFormId, sanitizedPreviewRecords, pageProdTypeCode]
  );

  const effectiveColumnSortRules = useMemo(() => {
    if (columnSortRules.length === 0 && !isSidebarFixedViewActive) {
      return [] as ColumnSortRule[];
    }

    const nextRules: ColumnSortRule[] = [...columnSortRules];
    if (nextRules.length === 0) {
      nextRules.push(
        ...getDefaultSortRulesForCurrentFilters(
          currentFormId,
          globalFilters,
          activeFixedFilterPresetId
        )
      );
    }
    const hasExplicitMachineSort = nextRules.some((rule) => rule.key === "machineCode");
    if (isSidebarFixedViewActive && !hasExplicitMachineSort) {
      nextRules.unshift({
        key: "machineCode",
        direction: "asc",
        type: "text",
      });
    }
    return nextRules;
  }, [
    activeFixedFilterPresetId,
    columnSortRules,
    currentFormId,
    globalFilters,
    isSidebarFixedViewActive,
  ]);

  const processedFullRecords = useMemo(() => {
    if (!shouldUseFullHydrationForList) {
      return [] as WorkReportRecord[];
    }
    return runRecordPipeline(groupedAllRecords, {
      isGlobalFilterActive,
      globalFilters,
      columnFilterState,
      sortRules: effectiveColumnSortRules,
    });
  }, [
    shouldUseFullHydrationForList,
    groupedAllRecords,
    isGlobalFilterActive,
    globalFilters,
    columnFilterState,
    effectiveColumnSortRules,
  ]);

  const processedPreviewRecords = useMemo(() => {
    if (!shouldUseFullHydrationForList || hasHydratedAllRecords) {
      return [] as WorkReportRecord[];
    }
    return runRecordPipeline(groupedPreviewRecords, {
      isGlobalFilterActive,
      globalFilters,
      columnFilterState,
      sortRules: effectiveColumnSortRules,
    });
  }, [
    shouldUseFullHydrationForList,
    hasHydratedAllRecords,
    groupedPreviewRecords,
    isGlobalFilterActive,
    globalFilters,
    columnFilterState,
    effectiveColumnSortRules,
  ]);

  const visibleRecords = useMemo(() => {
    if (!shouldUseFullHydrationForList) {
      return groupedPreviewRecords;
    }

    if (!hasHydratedAllRecords) {
      return processedPreviewRecords;
    }

    const offset = (page - 1) * pageSize;
    return processedFullRecords.slice(offset, offset + pageSize);
  }, [
    shouldUseFullHydrationForList,
    hasHydratedAllRecords,
    groupedPreviewRecords,
    processedPreviewRecords,
    processedFullRecords,
    page,
    pageSize,
  ]);

  useEffect(() => {
    if (!shouldUseFullHydrationForList || !hasHydratedAllRecords) {
      return;
    }
    if (!enabled) {
      return;
    }

    const total = processedFullRecords.length;
    const maxPage = Math.max(1, Math.ceil(total / pageSize));
    if (page > maxPage) {
      setPage(maxPage);
    }
  }, [enabled, shouldUseFullHydrationForList, hasHydratedAllRecords, processedFullRecords, page, pageSize, setPage]);

  useEffect(() => {
    if (shouldUseFullHydrationForList) {
      return;
    }
    if (!enabled) {
      return;
    }

    const total = Math.max(0, previewTotalCount);
    const maxPage = Math.max(1, Math.ceil(total / pageSize));
    if (page > maxPage) {
      setPage(maxPage);
    }
  }, [enabled, page, pageSize, previewTotalCount, setPage, shouldUseFullHydrationForList]);

  const pageFrom = visibleRecords.length === 0 ? 0 : (page - 1) * pageSize + 1;
  const pageTo = visibleRecords.length === 0 ? 0 : pageFrom + visibleRecords.length - 1;
  const hasMoreForPager = shouldUseFullHydrationForList
    ? hasHydratedAllRecords
      ? page * pageSize < processedFullRecords.length
      : hasMore
    : hasMore;

  const currentPageReportCount = useMemo(
    () => visibleRecords.reduce((sum, record) => sum + (record.reports?.length ?? 0), 0),
    [visibleRecords]
  );
  const matchedRecordCount = shouldUseFullHydrationForList
    ? processedFullRecords.length
    : previewTotalCount;

  const pageSizeOptions = useMemo(
    () => [
      { value: "25", label: "25", display: "25" },
      { value: "50", label: "50", display: "50" },
      { value: "100", label: "100", display: "100" },
    ],
    []
  );

  const baseSourceRecords = useMemo(
    () => (hasHydratedAllRecords ? groupedAllRecords : groupedPreviewRecords),
    [hasHydratedAllRecords, groupedAllRecords, groupedPreviewRecords]
  );

  const globallyFilteredSourceRecords = useMemo(
    () =>
      isGlobalFilterActive
        ? applyGlobalFilters(baseSourceRecords, globalFilters)
        : baseSourceRecords,
    [baseSourceRecords, globalFilters, isGlobalFilterActive]
  );

  const optionSourceRecords = baseSourceRecords;

  const unfinishedMachineShortcuts = useMemo(() => {
    if (pageProdTypeCode === "HF") {
      return RAGIC_UNFINISHED_MACHINE_SHORTCUT_ORDER_105.map((machineCode) =>
        buildUnfinishedMachineShortcut(machineCode, "105")
      );
    }

    return RAGIC_UNFINISHED_MACHINE_SHORTCUT_ORDER.map((machineCode) =>
      buildUnfinishedMachineShortcut(machineCode, "104")
    );
  }, [pageProdTypeCode]);

  const activeUnfinishedMachineShortcut = useMemo(
    () =>
      unfinishedMachineShortcuts.find((preset) =>
        isActiveUnfinishedMachineShortcut(
          preset,
          globalFilters,
          columnSortRules,
          activeLandingPageKey,
          currentFormId
        )
      ) ?? null,
    [
      activeLandingPageKey,
      columnSortRules,
      currentFormId,
      unfinishedMachineShortcuts,
      globalFilters,
    ]
  );

  const machineFilterOptions = useMemo(() => {
    if (!enabled) {
      return [
        {
          value: ALL_FILTER_VALUE,
          label: t("workReport:filters.allMachines"),
          display: t("workReport:filters.allMachines"),
        },
      ];
    }
    const values = Array.from(
      new Set(optionSourceRecords.map((record) => String(record.machineCode ?? "").trim()).filter(Boolean))
    ).sort(compareAlphaNumeric);

    return [
      {
        value: ALL_FILTER_VALUE,
        label: t("workReport:filters.allMachines"),
        display: t("workReport:filters.allMachines"),
      },
      ...values.map((value) => ({ value, label: value, display: value })),
    ];
  }, [enabled, optionSourceRecords, t]);

  const statusFilterOptions = useMemo(() => {
    if (!enabled) {
      return [
        {
          value: ALL_FILTER_VALUE,
          label: t("workReport:filters.allStatuses"),
          display: t("workReport:filters.allStatuses"),
        },
      ];
    }
    const values = Array.from(
      new Set(optionSourceRecords.map((record) => String(record.status ?? "").trim()).filter(Boolean))
    ).sort((a, b) => a.localeCompare(b, "zh-Hant"));

    return [
      {
        value: ALL_FILTER_VALUE,
        label: t("workReport:filters.allStatuses"),
        display: t("workReport:filters.allStatuses"),
      },
      ...values.map((value) => ({
        value,
        label: translateStatusDisplay(value),
        display: translateStatusDisplay(value),
      })),
    ];
  }, [enabled, optionSourceRecords, t, translateStatusDisplay]);

  const siteRunningFilterOptions = useMemo(
    () => [
      { value: "all", label: t("common:options.all"), display: t("common:options.all") },
      { value: "yes", label: t("common:yesNo.yes"), display: t("common:yesNo.yes") },
      { value: "no", label: t("common:yesNo.no"), display: t("common:yesNo.no") },
    ],
    [t]
  );

  const openColumnMenuType = useMemo<ColumnDataType | null>(() => {
    if (!enabled) {
      return null;
    }
    if (!columnMenuOpenKey) {
      return null;
    }
    return COLUMN_TYPE_MAP[columnMenuOpenKey] ?? "text";
  }, [columnMenuOpenKey, enabled]);
  const isBackendFacetColumn = useMemo(
    () =>
      Boolean(
        columnMenuOpenKey &&
          BACKEND_FACET_COLUMN_KEYS.includes(
            columnMenuOpenKey as (typeof BACKEND_FACET_COLUMN_KEYS)[number]
          )
      ),
    [columnMenuOpenKey]
  );

  const facetedBaseRecordsForOpenColumn = useMemo(() => {
    if (!columnMenuOpenKey || !openColumnMenuType) {
      return [] as WorkReportRecord[];
    }
    if (openColumnMenuType === "text" && !isBackendFacetColumn) {
      return [] as WorkReportRecord[];
    }

    const filtersExcludingCurrent: ColumnFilterState = { ...columnFilterState };
    delete filtersExcludingCurrent[columnMenuOpenKey];

    return applyColumnFilters(globallyFilteredSourceRecords, filtersExcludingCurrent, COLUMN_TYPE_MAP);
  }, [
    columnMenuOpenKey,
    openColumnMenuType,
    columnFilterState,
    globallyFilteredSourceRecords,
    isBackendFacetColumn,
  ]);

  const openColumnFacetOptions = useMemo(() => {
    if (!columnMenuOpenKey || !openColumnMenuType) {
      return [] as ColumnFacetOption[];
    }
    if (openColumnMenuType === "text" && !isBackendFacetColumn) {
      return [] as ColumnFacetOption[];
    }
    return buildColumnFacetOptions(
      facetedBaseRecordsForOpenColumn,
      columnMenuOpenKey,
      openColumnMenuType,
      uiLanguage,
      t
    );
  }, [columnMenuOpenKey, openColumnMenuType, facetedBaseRecordsForOpenColumn, isBackendFacetColumn, uiLanguage, t]);

  const backendColumnFiltersForOpenColumn = useMemo(
    () =>
      buildBackendColumnFilters(columnFilterState, COLUMN_TYPE_MAP, {
        excludeColumnKey: columnMenuOpenKey ?? undefined,
      }),
    [columnFilterState, columnMenuOpenKey]
  );
  const backendColumnFiltersForAnalysis = useMemo(
    () => buildBackendColumnFilters(columnFilterState, COLUMN_TYPE_MAP),
    [columnFilterState]
  );

  const [remoteFacetState, setRemoteFacetState] = useState<{
    signature: string;
    tokens: string[];
  } | null>(null);
  const [remoteAnalysisState, setRemoteAnalysisState] = useState<{
    signature: string;
    summary: ColumnAnalysisSummary;
  } | null>(null);
  const lastRemoteFacetRequestKeyRef = useRef<string | null>(null);
  const lastRemoteAnalysisRequestKeyRef = useRef<string | null>(null);
  const remoteDataVersion = useMemo(
    () =>
      buildRemoteDataVersion(baseSourceRecords, {
        hasHydratedAllRecords,
        previewTotalCount,
      }),
    [baseSourceRecords, hasHydratedAllRecords, previewTotalCount]
  );

  const remoteFacetQuerySignature = useMemo(() => {
    if (!columnMenuOpenKey || !openColumnMenuType) {
      return null;
    }
    if (openColumnMenuType === "text" && !isBackendFacetColumn) {
      return null;
    }
    if (hasHydratedAllRecords) {
      return null;
    }
    if (!isBackendFacetColumn) {
      return null;
    }

    return buildRemoteQuerySignature({
      formId: currentFormId,
      columnKey: columnMenuOpenKey,
      columnType: openColumnMenuType,
      keyword: globalFilters.globalKeyword.trim(),
      workOrderKeyword: globalFilters.workOrderKeyword.trim(),
      customerPartKeyword: globalFilters.customerPartKeyword.trim(),
      status: globalFilters.status,
      ragicUnfinishedStatus: globalFilters.ragicUnfinishedStatus,
      machineCode: globalFilters.machineCode,
      filterMachineCode: globalFilters.filterMachineCode,
      siteRunning: globalFilters.siteRunning,
      startSchedule: globalFilters.startSchedule,
    });
  }, [
    columnMenuOpenKey,
    openColumnMenuType,
    hasHydratedAllRecords,
    isBackendFacetColumn,
    currentFormId,
    globalFilters.customerPartKeyword,
    globalFilters.filterMachineCode,
    globalFilters.globalKeyword,
    globalFilters.machineCode,
    globalFilters.ragicUnfinishedStatus,
    globalFilters.siteRunning,
    globalFilters.startSchedule,
    globalFilters.status,
    globalFilters.workOrderKeyword,
  ]);
  const shouldUseRemoteFacetOptions = remoteFacetQuerySignature !== null;

  const remoteFacetOptions = useMemo(() => {
    if (
      !remoteFacetQuerySignature ||
      !remoteFacetState ||
      remoteFacetState.signature !== remoteFacetQuerySignature ||
      !openColumnMenuType
    ) {
      return null;
    }
    return remoteFacetState.tokens.map((token) => ({
      token,
      label: getColumnFacetLabelFromToken(token, openColumnMenuType, uiLanguage, t),
    }));
  }, [openColumnMenuType, remoteFacetQuerySignature, remoteFacetState, t, uiLanguage]);

  useEffect(() => {
    if (!remoteFacetQuerySignature || !columnMenuOpenKey || !openColumnMenuType) {
      lastRemoteFacetRequestKeyRef.current = null;
      return;
    }
    if (!enabled) {
      return;
    }
    const remoteFacetRequestKey = `${remoteFacetQuerySignature}:${remoteDataVersion}`;
    if (lastRemoteFacetRequestKeyRef.current === remoteFacetRequestKey) {
      return;
    }
    lastRemoteFacetRequestKeyRef.current = remoteFacetRequestKey;

    let cancelled = false;
    const run = async () => {
      try {
        const tokens = await fetchRemoteFacetTokensDeduped(remoteFacetQuerySignature, async () => {
          const facetMap = await fetchWorkReportFacets(currentFormId, [columnMenuOpenKey], {
            keyword: globalFilters.globalKeyword.trim() || undefined,
            workOrderKeyword: globalFilters.workOrderKeyword.trim() || undefined,
            customerPartKeyword: globalFilters.customerPartKeyword.trim() || undefined,
            status:
              globalFilters.status !== ALL_FILTER_VALUE ? globalFilters.status : undefined,
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
            columnFilters: backendColumnFiltersForOpenColumn,
            siteRunning: globalFilters.siteRunning,
            startSchedule: globalFilters.startSchedule,
          });
          const items = facetMap[columnMenuOpenKey] ?? [];
          return items.map((item) => item.token);
        });
        if (cancelled) {
          return;
        }
        setRemoteFacetState({
          signature: remoteFacetQuerySignature,
          tokens,
        });
      } catch {
        if (!cancelled) {
          setRemoteFacetState(null);
        }
        if (lastRemoteFacetRequestKeyRef.current === remoteFacetRequestKey) {
          lastRemoteFacetRequestKeyRef.current = null;
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    remoteFacetQuerySignature,
    remoteDataVersion,
    columnMenuOpenKey,
    openColumnMenuType,
    currentFormId,
    globalFilters.customerPartKeyword,
    globalFilters.filterMachineCode,
    globalFilters.globalKeyword,
    globalFilters.machineCode,
    globalFilters.ragicUnfinishedStatus,
    globalFilters.siteRunning,
    globalFilters.startSchedule,
    globalFilters.status,
    globalFilters.workOrderKeyword,
    backendColumnFiltersForOpenColumn,
  ]);

  const openColumnFacetOptionsFiltered = useMemo(() => {
    if (!columnMenuOpenKey) {
      return [] as ColumnFacetOption[];
    }
    const sourceOptions = shouldUseRemoteFacetOptions
      ? (remoteFacetOptions ?? [])
      : openColumnFacetOptions;
    const keyword = normalizeText(columnMenuSearchState[columnMenuOpenKey] ?? "");
    if (!keyword) {
      return sourceOptions;
    }
    return sourceOptions.filter((option) => normalizeText(option.label).includes(keyword));
  }, [
    columnMenuOpenKey,
    columnMenuSearchState,
    openColumnFacetOptions,
    remoteFacetOptions,
    shouldUseRemoteFacetOptions,
  ]);

  const analysisTargetColumnKey = columnAnalysisState.columnKey;
  const analysisTargetColumnType = analysisTargetColumnKey
    ? (COLUMN_TYPE_MAP[analysisTargetColumnKey] ?? "text")
    : null;
  const isBackendAnalysisColumn = useMemo(
    () =>
      Boolean(
        analysisTargetColumnKey &&
          BACKEND_ANALYSIS_COLUMN_KEYS.includes(
            analysisTargetColumnKey as (typeof BACKEND_ANALYSIS_COLUMN_KEYS)[number]
          )
      ),
    [analysisTargetColumnKey]
  );
  const remoteAnalysisQuerySignature = useMemo(() => {
    if (!analysisTargetColumnKey || !analysisTargetColumnType) {
      return null;
    }
    if (!isBackendAnalysisColumn) {
      return null;
    }
    if (hasHydratedAllRecords) {
      return null;
    }

    return buildRemoteQuerySignature({
      formId: currentFormId,
      columnKey: analysisTargetColumnKey,
      columnType: analysisTargetColumnType,
      keyword: globalFilters.globalKeyword.trim(),
      workOrderKeyword: globalFilters.workOrderKeyword.trim(),
      customerPartKeyword: globalFilters.customerPartKeyword.trim(),
      status: globalFilters.status,
      ragicUnfinishedStatus: globalFilters.ragicUnfinishedStatus,
      machineCode: globalFilters.machineCode,
      filterMachineCode: globalFilters.filterMachineCode,
      siteRunning: globalFilters.siteRunning,
      startSchedule: globalFilters.startSchedule,
    });
  }, [
    analysisTargetColumnKey,
    analysisTargetColumnType,
    isBackendAnalysisColumn,
    hasHydratedAllRecords,
    currentFormId,
    globalFilters.customerPartKeyword,
    globalFilters.filterMachineCode,
    globalFilters.globalKeyword,
    globalFilters.machineCode,
    globalFilters.ragicUnfinishedStatus,
    globalFilters.siteRunning,
    globalFilters.startSchedule,
    globalFilters.status,
    globalFilters.workOrderKeyword,
  ]);
  const shouldUseRemoteAnalysis = remoteAnalysisQuerySignature !== null;
  const remoteAnalysisSummary =
    remoteAnalysisQuerySignature &&
    remoteAnalysisState &&
    remoteAnalysisState.signature === remoteAnalysisQuerySignature
      ? remoteAnalysisState.summary
      : null;

  const analysisDataset = useMemo(() => {
    if (!analysisTargetColumnKey) {
      return [] as WorkReportRecord[];
    }
    if (hasHydratedAllRecords) {
      return processedFullRecords;
    }
    if (shouldUseFullHydrationForList) {
      return processedPreviewRecords;
    }
    return [] as WorkReportRecord[];
  }, [
    analysisTargetColumnKey,
    hasHydratedAllRecords,
    shouldUseFullHydrationForList,
    processedFullRecords,
    processedPreviewRecords,
  ]);

  const columnAnalysisSummary = useMemo(() => {
    if (!analysisTargetColumnKey || !analysisTargetColumnType) {
      return null;
    }
    if (remoteAnalysisSummary) {
      return remoteAnalysisSummary;
    }
    if (shouldUseRemoteAnalysis) {
      return null;
    }
    return buildColumnAnalysisSummary(
      analysisDataset,
      analysisTargetColumnKey,
      analysisTargetColumnType,
      uiLanguage,
      t
    );
  }, [
    analysisTargetColumnKey,
    analysisTargetColumnType,
    analysisDataset,
    remoteAnalysisSummary,
    shouldUseRemoteAnalysis,
    uiLanguage,
    t,
  ]);

  useEffect(() => {
    if (
      !remoteAnalysisQuerySignature ||
      !analysisTargetColumnKey ||
      !analysisTargetColumnType
    ) {
      lastRemoteAnalysisRequestKeyRef.current = null;
      return;
    }
    if (!enabled) {
      return;
    }
    const remoteAnalysisRequestKey = `${remoteAnalysisQuerySignature}:${remoteDataVersion}`;
    if (lastRemoteAnalysisRequestKeyRef.current === remoteAnalysisRequestKey) {
      return;
    }
    lastRemoteAnalysisRequestKeyRef.current = remoteAnalysisRequestKey;

    let cancelled = false;
    const run = async () => {
      try {
        const summary = await fetchRemoteAnalysisDeduped(
          remoteAnalysisQuerySignature,
          () =>
            fetchWorkReportAnalysis(
              currentFormId,
              analysisTargetColumnKey,
              analysisTargetColumnType,
              {
                keyword: globalFilters.globalKeyword.trim() || undefined,
                workOrderKeyword: globalFilters.workOrderKeyword.trim() || undefined,
                customerPartKeyword: globalFilters.customerPartKeyword.trim() || undefined,
                status:
                  globalFilters.status !== ALL_FILTER_VALUE ? globalFilters.status : undefined,
                ragicUnfinishedStatus:
                  globalFilters.ragicUnfinishedStatus !== ALL_FILTER_VALUE
                    ? globalFilters.ragicUnfinishedStatus
                    : undefined,
                machineCode:
                  globalFilters.machineCode !== ALL_FILTER_VALUE
                    ? globalFilters.machineCode
                    : undefined,
                filterMachineCode:
                  globalFilters.filterMachineCode !== ALL_FILTER_VALUE
                    ? globalFilters.filterMachineCode
                    : undefined,
                columnFilters: backendColumnFiltersForAnalysis,
                siteRunning: globalFilters.siteRunning,
                startSchedule: globalFilters.startSchedule,
              }
            )
        );
        if (!cancelled) {
          setRemoteAnalysisState({
            signature: remoteAnalysisQuerySignature,
            summary,
          });
        }
      } catch {
        if (!cancelled) {
          setRemoteAnalysisState(null);
        }
        if (lastRemoteAnalysisRequestKeyRef.current === remoteAnalysisRequestKey) {
          lastRemoteAnalysisRequestKeyRef.current = null;
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [
    remoteAnalysisQuerySignature,
    remoteDataVersion,
    analysisTargetColumnKey,
    analysisTargetColumnType,
    currentFormId,
    enabled,
    globalFilters.customerPartKeyword,
    globalFilters.filterMachineCode,
    globalFilters.globalKeyword,
    globalFilters.machineCode,
    globalFilters.ragicUnfinishedStatus,
    globalFilters.siteRunning,
    globalFilters.startSchedule,
    globalFilters.status,
    globalFilters.workOrderKeyword,
    backendColumnFiltersForAnalysis,
    hasHydratedAllRecords,
  ]);

  return {
    groupedAllRecords,
    groupedPreviewRecords,
    effectiveColumnSortRules,
    processedFullRecords,
    processedPreviewRecords,
    visibleRecords,
    pageFrom,
    pageTo,
    hasMoreForPager,
    currentPageReportCount,
    matchedRecordCount,
    pageSizeOptions,
    optionSourceRecords,
    unfinishedMachineShortcuts,
    activeUnfinishedMachineShortcut,
    machineFilterOptions,
    statusFilterOptions,
    siteRunningFilterOptions,
    openColumnMenuType,
    openColumnFacetOptionsFiltered,
    analysisTargetColumnType,
    columnAnalysisSummary,
  };
}

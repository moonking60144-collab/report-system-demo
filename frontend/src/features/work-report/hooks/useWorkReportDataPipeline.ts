import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { fetchWorkReportAnalysis, fetchWorkReportFacets } from "../../../api/workReport";
import type {
  WorkReportFacetCount,
  WorkReportReadMeta,
  WorkReportRecord,
} from "../../../api/workReport";
import {
  ALL_FILTER_VALUE,
  BACKEND_ANALYSIS_COLUMN_KEYS,
  BACKEND_FACET_COLUMN_KEYS,
  COLUMN_BLANK_TOKEN,
  COLUMN_TYPE_MAP,
  RAGIC_UNFINISHED_MACHINE_SHORTCUT_ORDER,
  RAGIC_UNFINISHED_MACHINE_SHORTCUT_ORDER_902,
  WORK_REPORT_STATUS_FILTER_VALUES,
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
  WorkReportFilterGroup,
  WorkReportFormId,
  WorkReportLandingPageKey,
} from "../types";
import {
  applyColumnFilters,
  applyGlobalFilters,
  applyWorkReportFilterGroup,
  applyPageReportGroupFilter,
  buildBackendColumnFilters,
  buildColumnAnalysisSummary,
  buildColumnFacetOptions,
  buildUpdatedDateRangeQuery,
  buildUnfinishedMachineShortcut,
  compareAlphaNumeric,
  getDefaultSortRulesForCurrentFilters,
  getColumnFacetLabelFromToken,
  isActiveUnfinishedMachineShortcut,
  normalizeColumnFilterStateForForm,
  normalizeColumnSortRulesForForm,
  normalizeGlobalFiltersForForm,
  normalizeText,
  sortRecordsByColumnRules,
  shouldExcludeSortOrder99Record,
} from "../utils";

interface UseWorkReportDataPipelineArgs {
  enabled?: boolean;
  pageProdTypeCode: string;
  currentFormId: "901" | "902";
  activeLandingPageKey: WorkReportLandingPageKey;
  activeFixedFilterPresetId: FixedFilterPresetId | null;
  allRecords: WorkReportRecord[];
  records: WorkReportRecord[];
  previewTotalCount: number;
  filterOptionsSnapshotAt: string | null;
  filterOptionsCacheSource: WorkReportReadMeta["cacheSource"] | null;
  displayedPreviewPage: number;
  displayedPreviewPageSize: number;
  hideTestCustomerPartRecords: boolean;
  hideSortOrder99Records: boolean;
  shouldUseFullHydrationForList: boolean;
  hasHydratedAllRecords: boolean;
  isGlobalFilterActive: boolean;
  globalFilters: GlobalFilters;
  customFilters: WorkReportFilterGroup;
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

export function buildRemoteQuerySignature(payload: Record<string, unknown>): string {
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
const globalFilterFacetRequestByKey = new Map<
  string,
  Promise<Record<string, WorkReportFacetCount[]>>
>();
const GLOBAL_FILTER_FACET_RETRY_DELAYS_MS = [1_000, 3_000] as const;

async function fetchGlobalFilterFacetsDeduped(
  key: string,
  loader: () => Promise<Record<string, WorkReportFacetCount[]>>
): Promise<Record<string, WorkReportFacetCount[]>> {
  const inFlight = globalFilterFacetRequestByKey.get(key);
  if (inFlight) {
    return inFlight;
  }
  const task = loader().finally(() => {
    if (globalFilterFacetRequestByKey.get(key) === task) {
      globalFilterFacetRequestByKey.delete(key);
    }
  });
  globalFilterFacetRequestByKey.set(key, task);
  return task;
}

export function startGlobalFilterFacetLoad(
  loader: () => Promise<Record<string, WorkReportFacetCount[]>>,
  onSuccess: (facetMap: Record<string, WorkReportFacetCount[]>) => void,
  retryDelaysMs: readonly number[] = GLOBAL_FILTER_FACET_RETRY_DELAYS_MS
): () => void {
  let cancelled = false;
  let retryIndex = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const run = async () => {
    try {
      const facetMap = await loader();
      if (!cancelled) {
        onSuccess(facetMap);
      }
    } catch {
      if (cancelled || retryIndex >= retryDelaysMs.length) {
        return;
      }
      const delayMs = retryDelaysMs[retryIndex];
      retryIndex += 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void run();
      }, delayMs);
    }
  };

  void run();
  return () => {
    cancelled = true;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
    }
  };
}

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

function normalizeFilterOptionValue(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized && normalized !== COLUMN_BLANK_TOKEN && normalized !== ALL_FILTER_VALUE
    ? normalized
    : null;
}

export function buildWorkReportStatusFilterValues(
  facetTokens: readonly string[],
  records: readonly WorkReportRecord[]
): string[] {
  const canonicalValues = [...WORK_REPORT_STATUS_FILTER_VALUES];
  const canonicalSet = new Set<string>(canonicalValues);
  const observedValues = Array.from(
    new Set(
      [...facetTokens, ...records.map((record) => record.status)]
        .map(normalizeFilterOptionValue)
        .filter((value): value is string => value !== null)
    )
  )
    .filter((value) => !canonicalSet.has(value))
    .sort((left, right) => left.localeCompare(right, "zh-Hant"));
  return [...canonicalValues, ...observedValues];
}

export function buildWorkReportMachineFilterValues(
  formId: WorkReportFormId,
  configuredMachines: readonly string[],
  facetTokens: readonly string[],
  records: readonly WorkReportRecord[]
): string[] {
  return Array.from(
    new Set(
      [
        ...configuredMachines,
        ...facetTokens,
        ...records.map((record) =>
          formId === "902" ? record.filterMachineCode : record.machineCode
        ),
      ]
        .map(normalizeFilterOptionValue)
        .filter((value): value is string => value !== null)
    )
  ).sort(compareAlphaNumeric);
}

export function buildScopedWorkReportRecords(
  sourceRecords: WorkReportRecord[],
  options: {
    enabled?: boolean;
    currentFormId: WorkReportFormId;
    pageProdTypeCode: string;
    hideTestCustomerPartRecords: boolean;
    hideSortOrder99Records: boolean;
  }
): WorkReportRecord[] {
  if (options.enabled === false) {
    return [];
  }
  const testFilteredRecords = options.hideTestCustomerPartRecords
    ? sourceRecords.filter(
        (record) => !normalizeText(record.customerPartNo).includes("test")
      )
    : sourceRecords;
  const sanitizedRecords = options.hideSortOrder99Records
    ? testFilteredRecords.filter(
        (record) =>
          !shouldExcludeSortOrder99Record(
            record,
            options.currentFormId,
            options.hideSortOrder99Records
          )
      )
    : testFilteredRecords;
  return options.currentFormId === "902"
    ? sanitizedRecords
    : applyPageReportGroupFilter(sanitizedRecords, options.pageProdTypeCode);
}

export function runWorkReportRecordPipeline(
  sourceRecords: WorkReportRecord[],
  options: {
    isGlobalFilterActive: boolean;
    globalFilters: GlobalFilters;
    customFilters?: WorkReportFilterGroup;
    currentFormId?: WorkReportFormId;
    columnFilterState: ColumnFilterState;
    sortRules: ColumnSortRule[];
  }
): WorkReportRecord[] {
  let nextRecords = sourceRecords;

  if (options.isGlobalFilterActive) {
    nextRecords = applyGlobalFilters(nextRecords, options.globalFilters);
  }

  nextRecords = applyWorkReportFilterGroup(
    nextRecords,
    options.customFilters,
    options.currentFormId
  );

  nextRecords = applyColumnFilters(nextRecords, options.columnFilterState, COLUMN_TYPE_MAP);

  if (options.sortRules.length > 0) {
    nextRecords = sortRecordsByColumnRules(nextRecords, options.sortRules);
  }

  return nextRecords;
}

export function selectVisibleWorkReportRecords(options: {
  shouldUseFullHydrationForList: boolean;
  hasHydratedAllRecords: boolean;
  processedPreviewRecords: WorkReportRecord[];
  processedFullRecords: WorkReportRecord[];
  page: number;
  pageSize: number;
}): WorkReportRecord[] {
  if (!options.shouldUseFullHydrationForList || !options.hasHydratedAllRecords) {
    return options.processedPreviewRecords;
  }

  const offset = (options.page - 1) * options.pageSize;
  return options.processedFullRecords.slice(offset, offset + options.pageSize);
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
  filterOptionsSnapshotAt,
  filterOptionsCacheSource,
  displayedPreviewPage,
  displayedPreviewPageSize,
  hideTestCustomerPartRecords,
  hideSortOrder99Records,
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
}: UseWorkReportDataPipelineArgs) {
  const { t } = useTranslation(["workReport", "common"]);
  const effectiveGlobalFilters = useMemo(
    () => normalizeGlobalFiltersForForm(globalFilters, currentFormId),
    [currentFormId, globalFilters]
  );
  const prodTypeScope = currentFormId === "901" ? pageProdTypeCode : undefined;
  const groupedAllRecords = useMemo(
    () =>
      buildScopedWorkReportRecords(allRecords, {
        enabled,
        currentFormId,
        pageProdTypeCode,
        hideTestCustomerPartRecords,
        hideSortOrder99Records,
      }),
    [
      allRecords,
      currentFormId,
      enabled,
      hideSortOrder99Records,
      hideTestCustomerPartRecords,
      pageProdTypeCode,
    ]
  );
  const groupedPreviewRecords = useMemo(
    () =>
      buildScopedWorkReportRecords(records, {
        enabled,
        currentFormId,
        pageProdTypeCode,
        hideTestCustomerPartRecords,
        hideSortOrder99Records,
      }),
    [
      currentFormId,
      enabled,
      hideSortOrder99Records,
      hideTestCustomerPartRecords,
      pageProdTypeCode,
      records,
    ]
  );
  const normalizedColumnSortRules = useMemo(
    () => normalizeColumnSortRulesForForm(columnSortRules, currentFormId),
    [columnSortRules, currentFormId]
  );
  const effectiveColumnFilterState = useMemo(
    () => normalizeColumnFilterStateForForm(columnFilterState, currentFormId),
    [columnFilterState, currentFormId]
  );

  const effectiveColumnSortRules = useMemo(() => {
    if (normalizedColumnSortRules.length === 0 && !isSidebarFixedViewActive) {
      return [] as ColumnSortRule[];
    }

    const nextRules: ColumnSortRule[] = [...normalizedColumnSortRules];
    if (nextRules.length === 0) {
      nextRules.push(
        ...getDefaultSortRulesForCurrentFilters(
          currentFormId,
          effectiveGlobalFilters,
          activeFixedFilterPresetId
        )
      );
    }
    const machineSortKey = currentFormId === "902" ? "filterMachineCode" : "machineCode";
    const hasExplicitMachineSort = nextRules.some((rule) => rule.key === machineSortKey);
    if (isSidebarFixedViewActive && !hasExplicitMachineSort) {
      nextRules.unshift({
        key: machineSortKey,
        direction: "asc",
        type: "text",
      });
    }
    return nextRules;
  }, [
    activeFixedFilterPresetId,
    currentFormId,
    effectiveGlobalFilters,
    isSidebarFixedViewActive,
    normalizedColumnSortRules,
  ]);

  const processedFullRecords = useMemo(() => {
    if (!shouldUseFullHydrationForList) {
      return [] as WorkReportRecord[];
    }
    return runWorkReportRecordPipeline(groupedAllRecords, {
      isGlobalFilterActive,
      globalFilters: effectiveGlobalFilters,
      customFilters,
      currentFormId,
      columnFilterState: effectiveColumnFilterState,
      sortRules: effectiveColumnSortRules,
    });
  }, [
    shouldUseFullHydrationForList,
    groupedAllRecords,
    isGlobalFilterActive,
    effectiveGlobalFilters,
    customFilters,
    currentFormId,
    effectiveColumnFilterState,
    effectiveColumnSortRules,
  ]);

  const processedPreviewRecords = useMemo(() => {
    if (shouldUseFullHydrationForList && hasHydratedAllRecords) {
      return [] as WorkReportRecord[];
    }
    return runWorkReportRecordPipeline(groupedPreviewRecords, {
      isGlobalFilterActive,
      globalFilters: effectiveGlobalFilters,
      customFilters,
      currentFormId,
      columnFilterState: effectiveColumnFilterState,
      sortRules: effectiveColumnSortRules,
    });
  }, [
    shouldUseFullHydrationForList,
    hasHydratedAllRecords,
    groupedPreviewRecords,
    isGlobalFilterActive,
    effectiveGlobalFilters,
    customFilters,
    currentFormId,
    effectiveColumnFilterState,
    effectiveColumnSortRules,
  ]);

  const visibleRecords = useMemo(
    () =>
      selectVisibleWorkReportRecords({
        shouldUseFullHydrationForList,
        hasHydratedAllRecords,
        processedPreviewRecords,
        processedFullRecords,
        page,
        pageSize,
      }),
    [
      hasHydratedAllRecords,
      page,
      pageSize,
      processedFullRecords,
      processedPreviewRecords,
      shouldUseFullHydrationForList,
    ]
  );

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

  const displayedPage = shouldUseFullHydrationForList && hasHydratedAllRecords
    ? page
    : displayedPreviewPage;
  const displayedPageSize = shouldUseFullHydrationForList && hasHydratedAllRecords
    ? pageSize
    : displayedPreviewPageSize;
  const pageFrom = visibleRecords.length === 0
    ? 0
    : (displayedPage - 1) * displayedPageSize + 1;
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
    () => {
      const globallyFiltered = isGlobalFilterActive
        ? applyGlobalFilters(baseSourceRecords, effectiveGlobalFilters)
        : baseSourceRecords;
      return applyWorkReportFilterGroup(globallyFiltered, customFilters, currentFormId);
    },
    [baseSourceRecords, currentFormId, customFilters, effectiveGlobalFilters, isGlobalFilterActive]
  );
  const updatedDateRangeQuery = useMemo(
    () => buildUpdatedDateRangeQuery(effectiveGlobalFilters),
    [effectiveGlobalFilters]
  );

  const optionSourceRecords = baseSourceRecords;
  const globalFilterMachineFacetField =
    currentFormId === "902" ? "filterMachineCode" : "machineCode";
  const globalFilterFacetRequestKey = buildRemoteQuerySignature({
    formId: currentFormId,
    snapshot: filterOptionsSnapshotAt ?? `count:${previewTotalCount}`,
    prodType: prodTypeScope,
    excludeTestCustomerPart: hideTestCustomerPartRecords,
    excludeSortOrder99: hideSortOrder99Records,
  });
  const [globalFilterFacetState, setGlobalFilterFacetState] = useState<{
    formId: WorkReportFormId;
    requestKey: string;
    statusTokens: string[];
    machineTokens: string[];
  } | null>(null);

  useEffect(() => {
    if (!enabled || hasHydratedAllRecords || filterOptionsCacheSource !== "sqlite") {
      return;
    }

    return startGlobalFilterFacetLoad(
      () =>
        fetchGlobalFilterFacetsDeduped(
          globalFilterFacetRequestKey,
          () =>
            fetchWorkReportFacets(
              currentFormId,
              ["status", globalFilterMachineFacetField],
              {
                prodType: prodTypeScope,
                excludeTestCustomerPart: hideTestCustomerPartRecords,
                excludeSortOrder99: hideSortOrder99Records,
              }
            )
        ),
      (facetMap) => {
        setGlobalFilterFacetState({
          formId: currentFormId,
          requestKey: globalFilterFacetRequestKey,
          statusTokens: (facetMap.status ?? []).map((item) => item.token),
          machineTokens: (facetMap[globalFilterMachineFacetField] ?? []).map(
            (item) => item.token
          ),
        });
      }
    );
  }, [
    currentFormId,
    enabled,
    filterOptionsCacheSource,
    globalFilterFacetRequestKey,
    globalFilterMachineFacetField,
    hasHydratedAllRecords,
    hideSortOrder99Records,
    hideTestCustomerPartRecords,
    prodTypeScope,
  ]);

  const currentGlobalFilterFacetState =
    filterOptionsCacheSource === "sqlite" &&
    globalFilterFacetState?.formId === currentFormId &&
    globalFilterFacetState.requestKey === globalFilterFacetRequestKey
      ? globalFilterFacetState
      : null;

  const unfinishedMachineShortcuts = useMemo(() => {
    if (pageProdTypeCode === "PB") {
      return RAGIC_UNFINISHED_MACHINE_SHORTCUT_ORDER_902.map((machineCode) =>
        buildUnfinishedMachineShortcut(machineCode, "902")
      );
    }

    return RAGIC_UNFINISHED_MACHINE_SHORTCUT_ORDER.map((machineCode) =>
      buildUnfinishedMachineShortcut(machineCode, "901")
    );
  }, [pageProdTypeCode]);

  const activeUnfinishedMachineShortcut = useMemo(
    () =>
      unfinishedMachineShortcuts.find((preset) =>
        isActiveUnfinishedMachineShortcut(
          preset,
          effectiveGlobalFilters,
          normalizedColumnSortRules,
          activeLandingPageKey,
          currentFormId
        )
      ) ?? null,
    [
      activeLandingPageKey,
      currentFormId,
      unfinishedMachineShortcuts,
      effectiveGlobalFilters,
      normalizedColumnSortRules,
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
    const configuredMachines =
      currentFormId === "902"
        ? RAGIC_UNFINISHED_MACHINE_SHORTCUT_ORDER_902
        : RAGIC_UNFINISHED_MACHINE_SHORTCUT_ORDER;
    const values = buildWorkReportMachineFilterValues(
      currentFormId,
      configuredMachines,
      currentGlobalFilterFacetState?.machineTokens ?? [],
      optionSourceRecords
    );

    return [
      {
        value: ALL_FILTER_VALUE,
        label: t("workReport:filters.allMachines"),
        display: t("workReport:filters.allMachines"),
      },
      ...values.map((value) => ({ value, label: value, display: value })),
    ];
  }, [currentFormId, currentGlobalFilterFacetState, enabled, optionSourceRecords, t]);

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
    const values = buildWorkReportStatusFilterValues(
      currentGlobalFilterFacetState?.statusTokens ?? [],
      optionSourceRecords
    );

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
  }, [
    currentGlobalFilterFacetState,
    enabled,
    optionSourceRecords,
    t,
    translateStatusDisplay,
  ]);

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

    const filtersExcludingCurrent: ColumnFilterState = { ...effectiveColumnFilterState };
    delete filtersExcludingCurrent[columnMenuOpenKey];

    return applyColumnFilters(globallyFilteredSourceRecords, filtersExcludingCurrent, COLUMN_TYPE_MAP);
  }, [
    columnMenuOpenKey,
    openColumnMenuType,
    effectiveColumnFilterState,
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
      buildBackendColumnFilters(effectiveColumnFilterState, COLUMN_TYPE_MAP, {
        excludeColumnKey: columnMenuOpenKey ?? undefined,
      }),
    [effectiveColumnFilterState, columnMenuOpenKey]
  );
  const backendColumnFiltersForAnalysis = useMemo(
    () => buildBackendColumnFilters(effectiveColumnFilterState, COLUMN_TYPE_MAP),
    [effectiveColumnFilterState]
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
      keyword: effectiveGlobalFilters.globalKeyword.trim(),
      workOrderKeyword: effectiveGlobalFilters.workOrderKeyword.trim(),
      customerPartKeyword: effectiveGlobalFilters.customerPartKeyword.trim(),
      prodType: prodTypeScope,
      status: effectiveGlobalFilters.status,
      ragicUnfinishedStatus: effectiveGlobalFilters.ragicUnfinishedStatus,
      machineCode: effectiveGlobalFilters.machineCode,
      filterMachineCode: effectiveGlobalFilters.filterMachineCode,
      siteRunning: effectiveGlobalFilters.siteRunning,
      startSchedule: effectiveGlobalFilters.startSchedule,
      updatedDateFrom: updatedDateRangeQuery.updatedDateFrom,
      updatedDateTo: updatedDateRangeQuery.updatedDateTo,
      columnFilters: backendColumnFiltersForOpenColumn,
      filterGroup: customFilters,
      excludeTestCustomerPart: hideTestCustomerPartRecords,
      excludeSortOrder99: hideSortOrder99Records,
    });
  }, [
    columnMenuOpenKey,
    openColumnMenuType,
    hasHydratedAllRecords,
    isBackendFacetColumn,
    currentFormId,
    effectiveGlobalFilters,
    updatedDateRangeQuery.updatedDateFrom,
    updatedDateRangeQuery.updatedDateTo,
    backendColumnFiltersForOpenColumn,
    customFilters,
    hideSortOrder99Records,
    hideTestCustomerPartRecords,
    prodTypeScope,
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
            keyword: effectiveGlobalFilters.globalKeyword.trim() || undefined,
            workOrderKeyword: effectiveGlobalFilters.workOrderKeyword.trim() || undefined,
            customerPartKeyword: effectiveGlobalFilters.customerPartKeyword.trim() || undefined,
            prodType: prodTypeScope,
            excludeTestCustomerPart: hideTestCustomerPartRecords,
            excludeSortOrder99: hideSortOrder99Records,
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
            columnFilters: backendColumnFiltersForOpenColumn,
            filterGroup: customFilters,
            siteRunning: effectiveGlobalFilters.siteRunning,
            startSchedule: effectiveGlobalFilters.startSchedule,
            updatedDateFrom: updatedDateRangeQuery.updatedDateFrom,
            updatedDateTo: updatedDateRangeQuery.updatedDateTo,
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
    effectiveGlobalFilters,
    updatedDateRangeQuery.updatedDateFrom,
    updatedDateRangeQuery.updatedDateTo,
    backendColumnFiltersForOpenColumn,
    customFilters,
    hideSortOrder99Records,
    hideTestCustomerPartRecords,
    prodTypeScope,
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
      keyword: effectiveGlobalFilters.globalKeyword.trim(),
      workOrderKeyword: effectiveGlobalFilters.workOrderKeyword.trim(),
      customerPartKeyword: effectiveGlobalFilters.customerPartKeyword.trim(),
      prodType: prodTypeScope,
      status: effectiveGlobalFilters.status,
      ragicUnfinishedStatus: effectiveGlobalFilters.ragicUnfinishedStatus,
      machineCode: effectiveGlobalFilters.machineCode,
      filterMachineCode: effectiveGlobalFilters.filterMachineCode,
      siteRunning: effectiveGlobalFilters.siteRunning,
      startSchedule: effectiveGlobalFilters.startSchedule,
      updatedDateFrom: updatedDateRangeQuery.updatedDateFrom,
      updatedDateTo: updatedDateRangeQuery.updatedDateTo,
      columnFilters: backendColumnFiltersForAnalysis,
      filterGroup: customFilters,
      excludeTestCustomerPart: hideTestCustomerPartRecords,
      excludeSortOrder99: hideSortOrder99Records,
    });
  }, [
    analysisTargetColumnKey,
    analysisTargetColumnType,
    isBackendAnalysisColumn,
    hasHydratedAllRecords,
    currentFormId,
    effectiveGlobalFilters,
    updatedDateRangeQuery.updatedDateFrom,
    updatedDateRangeQuery.updatedDateTo,
    backendColumnFiltersForAnalysis,
    customFilters,
    hideSortOrder99Records,
    hideTestCustomerPartRecords,
    prodTypeScope,
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
                keyword: effectiveGlobalFilters.globalKeyword.trim() || undefined,
                workOrderKeyword: effectiveGlobalFilters.workOrderKeyword.trim() || undefined,
                customerPartKeyword:
                  effectiveGlobalFilters.customerPartKeyword.trim() || undefined,
                prodType: prodTypeScope,
                excludeTestCustomerPart: hideTestCustomerPartRecords,
                excludeSortOrder99: hideSortOrder99Records,
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
                columnFilters: backendColumnFiltersForAnalysis,
                filterGroup: customFilters,
                siteRunning: effectiveGlobalFilters.siteRunning,
                startSchedule: effectiveGlobalFilters.startSchedule,
                updatedDateFrom: updatedDateRangeQuery.updatedDateFrom,
                updatedDateTo: updatedDateRangeQuery.updatedDateTo,
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
    effectiveGlobalFilters,
    updatedDateRangeQuery.updatedDateFrom,
    updatedDateRangeQuery.updatedDateTo,
    backendColumnFiltersForAnalysis,
    customFilters,
    hasHydratedAllRecords,
    hideSortOrder99Records,
    hideTestCustomerPartRecords,
    prodTypeScope,
  ]);

  return {
    groupedAllRecords,
    groupedPreviewRecords,
    effectiveColumnSortRules,
    processedFullRecords,
    processedPreviewRecords,
    visibleRecords,
    displayedPage,
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

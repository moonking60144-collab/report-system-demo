import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  fetchWorkReports,
  fetchWorkReportsFull,
  type WorkReportReadMeta,
  type WorkReportRecord,
  type WorkReportResponse,
} from "../../../api/workReport";
import type {
  BackendColumnFilterState,
  BackendCacheState,
  HydrationSource,
  NoticeState,
  WorkReportFilterGroup,
  WorkReportFormId,
} from "../types";
import {
  dedupeRecordsById,
  getApiErrorCode,
  getErrorMessage,
  normalizeRecord,
  readHydrationCache,
  writeHydrationCache,
} from "../utils";
import { useWorkReportReadCacheStore } from "../context/workReportReadCacheStore";
import type { PreviewPageCacheEntry } from "../cache/workReportPreviewCache";
import { WorkReportEntrySettlementRevisionBarrier } from "../entrySettlementRevisionBarrier";

export { PreviewPageCache } from "../cache/workReportPreviewCache";
export type { PreviewPageCacheEntry } from "../cache/workReportPreviewCache";
export { WorkReportEntrySettlementRevisionBarrier as HydrationEntrySettlementBarrier } from "../entrySettlementRevisionBarrier";

export function shouldReuseHydratedFullRecords(input: {
  forceRefresh: boolean;
  reloadFromBackend: boolean;
  hasHydratedAllRecords: boolean;
  recordCount: number;
}): boolean {
  return (
    !input.forceRefresh &&
    !input.reloadFromBackend &&
    input.hasHydratedAllRecords &&
    input.recordCount > 0
  );
}

export function shouldPropagateHydrationFallbackFailure(reloadFromBackend: boolean): boolean {
  return reloadFromBackend;
}

export class HydrationRequestCoordinator<T> {
  private activePromise: Promise<T> | null = null;
  private pendingReload: { generation: number; execute: () => Promise<T> } | null = null;
  private generation = 0;

  isActive(): boolean {
    return this.activePromise !== null;
  }

  reset(): void {
    this.generation += 1;
    this.activePromise = null;
    this.pendingReload = null;
  }

  run(reloadFromBackend: boolean, execute: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    if (!this.activePromise) {
      return this.start(generation, execute);
    }
    if (!reloadFromBackend) {
      return this.activePromise;
    }
    this.pendingReload = { generation, execute };
    return this.waitForReload(generation);
  }

  private async waitForReload(generation: number): Promise<T> {
    let latestResult: T | undefined;
    let hasLatestResult = false;

    for (;;) {
      if (generation !== this.generation) {
        if (hasLatestResult) {
          return latestResult as T;
        }
        throw new Error("Hydration request was reset before reload started");
      }
      const activePromise = this.activePromise;
      if (activePromise) {
        try {
          latestResult = await activePromise;
          hasLatestResult = true;
        } catch (error) {
          if (
            generation !== this.generation ||
            this.pendingReload?.generation !== generation
          ) {
            throw error;
          }
        }
        continue;
      }

      const pendingReload = this.pendingReload;
      if (pendingReload?.generation === generation) {
        this.pendingReload = null;
        return this.start(generation, pendingReload.execute);
      }
      if (hasLatestResult) {
        return latestResult as T;
      }
      throw new Error("Hydration reload lost its active request");
    }
  }

  private start(generation: number, execute: () => Promise<T>): Promise<T> {
    const trackedPromise = Promise.resolve()
      .then(execute)
      .finally(() => {
        if (generation === this.generation && this.activePromise === trackedPromise) {
          this.activePromise = null;
        }
      });
    this.activePromise = trackedPromise;
    return trackedPromise;
  }
}

interface UseWorkReportListDataArgs {
  currentFormId: WorkReportFormId;
  page: number;
  pageSize: number;
  shouldUseFullHydrationForList: boolean;
  serverPreviewQuery: PreviewServerQuery;
  previewPrefetchQueries?: PreviewServerQuery[];
  bootstrapKeyword: string;
  t: (key: string, options?: Record<string, unknown>) => string;
  setNotice: Dispatch<SetStateAction<NoticeState | null>>;
  onPreviewReadMetric?: (metric: PreviewReadMetric) => void;
}

export interface PreviewReadMetric {
  mode: "foreground" | "background" | "prefetch";
  outcome: "cache-hit" | "completed" | "failed" | "cancelled";
  durationMs: number;
  page: number;
  recordCount: number;
  cacheSource: WorkReportReadMeta["cacheSource"] | null;
  cacheState: WorkReportReadMeta["cacheState"] | null;
}

interface PreviewServerQuery {
  enabled: boolean;
  keyword?: string;
  workOrderKeyword?: string;
  customerPartKeyword?: string;
  prodType?: string;
  excludeTestCustomerPart?: boolean;
  excludeSortOrder99?: boolean;
  status?: string;
  ragicUnfinishedStatus?: string;
  machineCode?: string;
  filterMachineCode?: string;
  siteRunning?: "all" | "yes" | "no";
  startSchedule?: "all" | "yes" | "no";
  updatedDateFrom?: string;
  updatedDateTo?: string;
  columnFilters?: BackendColumnFilterState;
  filterGroup?: WorkReportFilterGroup;
  sort?: string;
}

export function resolveCachedPreviewRevalidationFailure(
  cachedPreview: PreviewPageCacheEntry,
  error: unknown
): { records: WorkReportRecord[]; readMeta: WorkReportReadMeta; error: string } {
  return {
    records: cachedPreview.records,
    readMeta: {
      ...cachedPreview.readMeta,
      cacheState: "stale",
    },
    error: getErrorMessage(error),
  };
}

export type PreviewLoadFailureResolution =
  | {
      kind: "retain";
      preview: PreviewPageCacheEntry;
      failure: ReturnType<typeof resolveCachedPreviewRevalidationFailure>;
    }
  | { kind: "initial-error"; error: string }
  | { kind: "background-error"; error: string };

export function resolvePreviewLoadFailure(input: {
  isBackground: boolean;
  cachedPreview: PreviewPageCacheEntry | null;
  retainedPreview: PreviewPageCacheEntry | null;
  error: unknown;
}): PreviewLoadFailureResolution {
  const preview = input.cachedPreview ?? input.retainedPreview;
  if (preview) {
    return {
      kind: "retain",
      preview,
      failure: resolveCachedPreviewRevalidationFailure(preview, input.error),
    };
  }
  return input.isBackground
    ? { kind: "background-error", error: getErrorMessage(input.error) }
    : { kind: "initial-error", error: getErrorMessage(input.error) };
}

export interface BackgroundFetchState {
  previewRequestId: number | null;
  hydrationRequestId: number | null;
}

export type BackgroundFetchAction =
  | { type: "start"; scope: "preview" | "hydration"; requestId: number }
  | { type: "finish"; scope: "preview" | "hydration"; requestId: number }
  | { type: "clear"; scope: "preview" | "hydration" }
  | { type: "reset" };

export const INITIAL_BACKGROUND_FETCH_STATE: BackgroundFetchState = {
  previewRequestId: null,
  hydrationRequestId: null,
};

export function reduceBackgroundFetchState(
  state: BackgroundFetchState,
  action: BackgroundFetchAction
): BackgroundFetchState {
  if (action.type === "reset") {
    return INITIAL_BACKGROUND_FETCH_STATE;
  }

  const key = action.scope === "preview"
    ? "previewRequestId"
    : "hydrationRequestId";
  if (action.type === "start") {
    return {
      ...state,
      [key]: action.requestId,
    };
  }
  if (action.type === "finish" && state[key] !== action.requestId) {
    return state;
  }
  if (state[key] === null) {
    return state;
  }
  return {
    ...state,
    [key]: null,
  };
}

interface ForegroundPreviewRequest {
  key: string;
  requestId: number;
  controller: AbortController;
}

export class ForegroundPreviewRequestCoordinator {
  private current: ForegroundPreviewRequest | null = null;

  start(key: string, requestId: number): AbortController {
    if (this.current && this.current.key !== key) {
      this.current.controller.abort();
    }
    const controller =
      this.current?.key === key ? this.current.controller : new AbortController();
    this.current = { key, requestId, controller };
    return controller;
  }

  finish(requestId: number): void {
    if (this.current?.requestId === requestId) {
      this.current = null;
    }
  }

  reset(): void {
    this.current?.controller.abort();
    this.current = null;
  }
}

const PREVIEW_PREFETCH_BATCH_SIZE = 2;
const READ_MODEL_RETRY_DELAYS_MS = [300, 700, 1_500] as const;

export async function retryReadModelUnavailable<T>(
  execute: () => Promise<T>,
  options: {
    retryDelaysMs?: readonly number[];
    shouldContinue?: () => boolean;
    wait?: (delayMs: number) => Promise<void>;
  } = {}
): Promise<T> {
  const retryDelaysMs = options.retryDelaysMs ?? READ_MODEL_RETRY_DELAYS_MS;
  const shouldContinue = options.shouldContinue ?? (() => true);
  const wait = options.wait ?? ((delayMs) => new Promise<void>((resolve) => {
    window.setTimeout(resolve, delayMs);
  }));

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await execute();
    } catch (error) {
      if (
        getApiErrorCode(error) !== "SQLITE_READ_MODEL_UNAVAILABLE" ||
        attempt >= retryDelaysMs.length ||
        !shouldContinue()
      ) {
        throw error;
      }
      await wait(retryDelaysMs[attempt]);
      if (!shouldContinue()) {
        throw error;
      }
    }
  }
}

export function buildPreviewRequestKey(input: {
  currentFormId: WorkReportFormId;
  page: number;
  pageSize: number;
  shouldUseFullHydrationForList: boolean;
  bootstrapKeyword: string;
  serverPreviewQuery: PreviewServerQuery;
}): string {
  return JSON.stringify(input);
}

interface HydratedFormCacheEntry {
  allRecords: WorkReportRecord[];
  hydration: HydrationState;
}

interface LoadedPreviewContext {
  key: string;
  page: number;
  pageSize: number;
}

interface HydrationState {
  hasHydratedAllRecords: boolean;
  isHydratingAllRecords: boolean;
  hydrationSource: HydrationSource;
  backendCacheState: BackendCacheState;
  backendSnapshotAt: string | null;
  backendExpiresAt: string | null;
  fullDataHydratedAt: number | null;
  hydratedCount: number;
  truncated: boolean;
  truncatedCount: number;
}

type HydrationAction =
  | { type: "reset" }
  | { type: "start"; clearCount: boolean }
  | {
      type: "success";
      hydratedCount: number;
      hydrationSource: HydrationSource;
      backendCacheState: BackendCacheState;
      backendSnapshotAt: string | null;
      backendExpiresAt: string | null;
      hydratedAt: number;
      truncated: boolean;
      truncatedCount: number;
    }
  | { type: "local-cache-success"; hydratedCount: number; hydratedAt: number }
  | { type: "finish" };

const INITIAL_HYDRATION_STATE: HydrationState = {
  hasHydratedAllRecords: false,
  isHydratingAllRecords: false,
  hydrationSource: null,
  backendCacheState: null,
  backendSnapshotAt: null,
  backendExpiresAt: null,
  fullDataHydratedAt: null,
  hydratedCount: 0,
  truncated: false,
  truncatedCount: 0,
};

function hydrationReducer(state: HydrationState, action: HydrationAction): HydrationState {
  switch (action.type) {
    case "reset":
      return INITIAL_HYDRATION_STATE;
    case "start":
      return {
        ...state,
        isHydratingAllRecords: true,
        hydrationSource: "network",
        backendCacheState: null,
        hydratedCount: action.clearCount ? 0 : state.hydratedCount,
      };
    case "success":
      return {
        ...state,
        hasHydratedAllRecords: true,
        isHydratingAllRecords: false,
        hydratedCount: action.hydratedCount,
        hydrationSource: action.hydrationSource,
        backendCacheState: action.backendCacheState,
        backendSnapshotAt: action.backendSnapshotAt,
        backendExpiresAt: action.backendExpiresAt,
        fullDataHydratedAt: action.hydratedAt,
        truncated: action.truncated,
        truncatedCount: action.truncatedCount,
      };
    case "local-cache-success":
      return {
        ...state,
        hasHydratedAllRecords: true,
        isHydratingAllRecords: false,
        hydratedCount: action.hydratedCount,
        hydrationSource: "cache",
        backendCacheState: "stale",
        backendSnapshotAt: null,
        backendExpiresAt: null,
        fullDataHydratedAt: action.hydratedAt,
        truncated: false,
        truncatedCount: 0,
      };
    case "finish":
      return {
        ...state,
        isHydratingAllRecords: false,
      };
    default:
      return state;
  }
}

export function useWorkReportListData({
  currentFormId,
  page,
  pageSize,
  shouldUseFullHydrationForList,
  serverPreviewQuery,
  previewPrefetchQueries = [],
  bootstrapKeyword,
  t,
  setNotice,
  onPreviewReadMetric,
}: UseWorkReportListDataArgs) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [records, setRecords] = useState<WorkReportRecord[]>([]);
  const [allRecords, setAllRecords] = useState<WorkReportRecord[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [previewTotalCount, setPreviewTotalCount] = useState(0);
  const [previewReadMeta, setPreviewReadMeta] = useState<WorkReportReadMeta | null>(null);
  const [previewRevalidating, setPreviewRevalidating] = useState(false);
  const [previewRevalidationError, setPreviewRevalidationError] = useState<string | null>(null);
  const [backgroundFetchState, dispatchBackgroundFetch] = useReducer(
    reduceBackgroundFetchState,
    INITIAL_BACKGROUND_FETCH_STATE
  );
  const backgroundFetching =
    backgroundFetchState.previewRequestId !== null ||
    backgroundFetchState.hydrationRequestId !== null;
  const [loadedPreviewContext, setLoadedPreviewContext] = useState<LoadedPreviewContext | null>(null);
  const [previewCacheEpoch, incrementPreviewCacheEpoch] = useReducer((value: number) => value + 1, 0);
  const [previewSettlementReloadEpoch, requestPreviewSettlementReload] = useReducer(
    (value: number) => value + 1,
    0
  );
  const [hydration, dispatchHydration] = useReducer(hydrationReducer, INITIAL_HYDRATION_STATE);
  const { previewPageCacheRef, previewFetchInFlightRef } = useWorkReportReadCacheStore();
  const currentFormIdRef = useRef(currentFormId);
  currentFormIdRef.current = currentFormId;
  const hydratedFormCacheRef = useRef<Partial<Record<WorkReportFormId, HydratedFormCacheEntry>>>({});
  const previewRequestIdRef = useRef(0);
  const hydrateRequestIdRef = useRef(0);
  const previewRequestActiveRef = useRef(false);
  const foregroundPreviewRequestActiveRef = useRef(false);
  const completedFreshPreviewRef = useRef<{ key: string; revision: number; startedAt: number } | null>(null);
  const foregroundPreviewRequestCoordinatorRef = useRef<ForegroundPreviewRequestCoordinator | null>(null);
  const hydrateRequestActiveRef = useRef(false);
  const hydrationRequestCoordinatorRef = useRef<HydrationRequestCoordinator<
    WorkReportRecord[]
  > | null>(null);
  const hydrationEntrySettlementBarrierRef = useRef<
    WorkReportEntrySettlementRevisionBarrier<WorkReportRecord> | null
  >(null);
  const pendingPreviewSettlementReloadFormIdRef = useRef<WorkReportFormId | null>(null);
  if (!hydrationRequestCoordinatorRef.current) {
    hydrationRequestCoordinatorRef.current = new HydrationRequestCoordinator<WorkReportRecord[]>();
  }
  if (!foregroundPreviewRequestCoordinatorRef.current) {
    foregroundPreviewRequestCoordinatorRef.current = new ForegroundPreviewRequestCoordinator();
  }
  if (!hydrationEntrySettlementBarrierRef.current) {
    hydrationEntrySettlementBarrierRef.current =
      new WorkReportEntrySettlementRevisionBarrier<WorkReportRecord>();
  }
  const invalidatePreviewCache = useCallback((formId?: WorkReportFormId): void => {
    const targetFormId = formId ?? currentFormIdRef.current;
    previewPageCacheRef.current?.invalidateForm(targetFormId);
    if (currentFormIdRef.current === targetFormId) {
      incrementPreviewCacheEpoch();
    }
  }, [previewPageCacheRef]);
  const currentPreviewRequestKey = buildPreviewRequestKey({
    currentFormId,
    page,
    pageSize,
    shouldUseFullHydrationForList,
    bootstrapKeyword,
    serverPreviewQuery,
  });
  const currentCachedPreview = shouldUseFullHydrationForList
    ? null
    : previewPageCacheRef.current.peek(currentPreviewRequestKey);
  const hasLoadedCurrentPreview = loadedPreviewContext?.key === currentPreviewRequestKey;
  const displayedPreviewRecords = hasLoadedCurrentPreview
    ? records
    : currentCachedPreview?.records ?? records;
  const displayedPreviewHasMore = hasLoadedCurrentPreview
    ? hasMore
    : currentCachedPreview?.hasMore ?? hasMore;
  const displayedPreviewTotalCount = hasLoadedCurrentPreview
    ? previewTotalCount
    : currentCachedPreview?.totalCount ?? previewTotalCount;
  const displayedPreviewReadMeta = hasLoadedCurrentPreview
    ? previewReadMeta
    : currentCachedPreview?.readMeta ?? previewReadMeta;
  const previewTransitionPending = Boolean(
    !shouldUseFullHydrationForList &&
      displayedPreviewRecords.length > 0 &&
      loadedPreviewContext &&
      loadedPreviewContext.key !== currentPreviewRequestKey &&
      !currentCachedPreview
  );
  const displayedPreviewPage = hasLoadedCurrentPreview
    ? loadedPreviewContext.page
    : currentCachedPreview?.page ?? loadedPreviewContext?.page ?? page;
  const displayedPreviewPageSize = hasLoadedCurrentPreview
    ? loadedPreviewContext.pageSize
    : currentCachedPreview?.pageSize ?? loadedPreviewContext?.pageSize ?? pageSize;
  const renderablePreviewSnapshotRef = useRef<PreviewPageCacheEntry | null>(null);
  if (
    !shouldUseFullHydrationForList &&
    displayedPreviewReadMeta &&
    (hasLoadedCurrentPreview || currentCachedPreview)
  ) {
    renderablePreviewSnapshotRef.current = {
      key: currentPreviewRequestKey,
      formId: currentFormId,
      page: displayedPreviewPage,
      pageSize: displayedPreviewPageSize,
      records: displayedPreviewRecords,
      hasMore: displayedPreviewHasMore,
      totalCount: displayedPreviewTotalCount,
      readMeta: displayedPreviewReadMeta,
      cachedAt: Date.now(),
    };
  } else if (renderablePreviewSnapshotRef.current?.key !== currentPreviewRequestKey) {
    renderablePreviewSnapshotRef.current = null;
  }

  const resetAsyncRequestState = useCallback(() => {
    previewRequestIdRef.current += 1;
    hydrateRequestIdRef.current += 1;
    previewRequestActiveRef.current = false;
    foregroundPreviewRequestActiveRef.current = false;
    foregroundPreviewRequestCoordinatorRef.current?.reset();
    hydrateRequestActiveRef.current = false;
    hydrationRequestCoordinatorRef.current?.reset();
    dispatchBackgroundFetch({ type: "reset" });
  }, []);

  useEffect(() => {
    if (!hydration.hasHydratedAllRecords) {
      return;
    }

    hydratedFormCacheRef.current[currentFormId] = {
      allRecords,
      hydration,
    };
  }, [allRecords, currentFormId, hydration]);

  useEffect(() => {
    return () => {
      foregroundPreviewRequestCoordinatorRef.current?.reset();
    };
  }, []);

  const fetchPreviewPage = useCallback(
    async (
      targetPage: number,
      forceRefresh: boolean,
      previewQuery: PreviewServerQuery,
      requestKey: string,
      signal?: AbortSignal,
      onRequestStarted?: () => void
    ): Promise<WorkReportResponse> => {
      const offset = (targetPage - 1) * pageSize;
      const keywordForPage =
        shouldUseFullHydrationForList && !hydration.hasHydratedAllRecords ? bootstrapKeyword : "";
      const requestRevision = previewPageCacheRef.current!.revision(currentFormId);
      const existingRequest = previewFetchInFlightRef.current.get(requestKey);
      if (
        !forceRefresh &&
        existingRequest?.revision === requestRevision &&
        !existingRequest.signal?.aborted
      ) {
        return existingRequest.promise;
      }
      onRequestStarted?.();
      const request = fetchWorkReports(
        currentFormId,
        pageSize,
        offset,
        keywordForPage,
        forceRefresh,
        previewQuery.enabled
          ? {
              keyword: previewQuery.keyword,
              workOrderKeyword: previewQuery.workOrderKeyword,
              customerPartKeyword: previewQuery.customerPartKeyword,
              prodType: previewQuery.prodType,
              excludeTestCustomerPart: previewQuery.excludeTestCustomerPart,
              excludeSortOrder99: previewQuery.excludeSortOrder99,
              status: previewQuery.status,
              ragicUnfinishedStatus: previewQuery.ragicUnfinishedStatus,
              machineCode: previewQuery.machineCode,
              filterMachineCode: previewQuery.filterMachineCode,
              siteRunning: previewQuery.siteRunning,
              startSchedule: previewQuery.startSchedule,
              updatedDateFrom: previewQuery.updatedDateFrom,
              updatedDateTo: previewQuery.updatedDateTo,
              columnFilters: previewQuery.columnFilters,
              filterGroup: previewQuery.filterGroup,
              sort: previewQuery.sort,
              signal,
            }
          : { signal }
      );
      if (forceRefresh) {
        return request;
      }
      previewFetchInFlightRef.current.set(requestKey, {
        revision: requestRevision,
        promise: request,
        signal,
      });
      try {
        return await request;
      } finally {
        if (previewFetchInFlightRef.current.get(requestKey)?.promise === request) {
          previewFetchInFlightRef.current.delete(requestKey);
        }
      }
    },
    [
      bootstrapKeyword,
      currentFormId,
      hydration.hasHydratedAllRecords,
      pageSize,
      previewFetchInFlightRef,
      previewPageCacheRef,
      shouldUseFullHydrationForList,
    ]
  );

  const loadReports = useCallback(
    async (
      forceRefresh = false,
      options: {
        throwOnError?: boolean;
        mode?: "foreground" | "background";
        invalidateCache?: boolean;
        requiredReadStartedAfter?: number;
      } = {}
    ): Promise<void> => {
      const isBackground = options.mode === "background";
      const metricMode: PreviewReadMetric["mode"] = isBackground
        ? "background"
        : "foreground";
      const metricStartedAt = performance.now();
      const completed = completedFreshPreviewRef.current;
      if (
        isBackground && !forceRefresh && !shouldUseFullHydrationForList &&
        options.requiredReadStartedAfter !== undefined && completed &&
        completed.key === currentPreviewRequestKey &&
        completed.revision === previewPageCacheRef.current!.revision(currentFormId) &&
        completed.startedAt > options.requiredReadStartedAfter
      ) {
        return;
      }
      if (isBackground && foregroundPreviewRequestActiveRef.current) {
        return;
      }
      const retainedPreview =
        renderablePreviewSnapshotRef.current?.key === currentPreviewRequestKey
          ? renderablePreviewSnapshotRef.current
          : null;
      const previewCache = previewPageCacheRef.current!;
      if (options.invalidateCache) {
        invalidatePreviewCache(currentFormId);
      }
      const cachedPreview =
        !forceRefresh && !shouldUseFullHydrationForList
          ? previewCache.get(currentPreviewRequestKey)
          : null;
      const requestRevision = previewCache.revision(currentFormId);
      const entrySettlementRevision =
        hydrationEntrySettlementBarrierRef.current!.captureRevision();
      const requestId = previewRequestIdRef.current + 1;
      completedFreshPreviewRef.current = null;
      const requestContext: LoadedPreviewContext = {
        key: currentPreviewRequestKey,
        page,
        pageSize,
      };
      previewRequestIdRef.current = requestId;
      previewRequestActiveRef.current = true;
      dispatchBackgroundFetch(
        isBackground
          ? { type: "start", scope: "preview", requestId }
          : { type: "clear", scope: "preview" }
      );
      let foregroundController: AbortController | null = null;
      if (!isBackground) {
        foregroundController = foregroundPreviewRequestCoordinatorRef.current!.start(
          currentPreviewRequestKey,
          requestId
        );
        foregroundPreviewRequestActiveRef.current = true;
        setLoading(!cachedPreview);
        setError(null);
        setPreviewRevalidating(Boolean(cachedPreview));
        setPreviewRevalidationError(null);
      }
      if (cachedPreview) {
        setRecords(cachedPreview.records);
        setLoadedPreviewContext(requestContext);
        setHasMore(cachedPreview.hasMore);
        setPreviewTotalCount(cachedPreview.totalCount);
        setPreviewReadMeta(cachedPreview.readMeta);
        onPreviewReadMetric?.({
          mode: metricMode,
          outcome: "cache-hit",
          durationMs: performance.now() - metricStartedAt,
          page,
          recordCount: cachedPreview.records.length,
          cacheSource: cachedPreview.readMeta.cacheSource,
          cacheState: cachedPreview.readMeta.cacheState,
        });
      }

      try {
        let networkStartedAt: number | null = null;
        const executePreviewRequest = () => {
          networkStartedAt = null;
          return fetchPreviewPage(
            page,
            forceRefresh,
            serverPreviewQuery,
            currentPreviewRequestKey,
            foregroundController?.signal,
            () => { networkStartedAt = performance.now(); }
          );
        };
        const response = !forceRefresh && !isBackground
          ? await retryReadModelUnavailable(executePreviewRequest, {
              shouldContinue: () =>
                previewRequestIdRef.current === requestId &&
                previewCache.revision(currentFormId) === requestRevision,
            })
          : await executePreviewRequest();

        if (
          previewRequestIdRef.current !== requestId ||
          previewCache.revision(currentFormId) !== requestRevision
        ) {
          onPreviewReadMetric?.({
            mode: metricMode,
            outcome: "cancelled",
            durationMs: performance.now() - metricStartedAt,
            page,
            recordCount: 0,
            cacheSource: response.meta.cacheSource,
            cacheState: response.meta.cacheState,
          });
          return;
        }

        const normalizedRecords = hydrationEntrySettlementBarrierRef.current!.mergeRecords(
          currentFormId,
          entrySettlementRevision,
          dedupeRecordsById(
            response.data.map((record) => normalizeRecord(record, false))
          ),
          { includeMissingSettlements: false }
        );
        const totalCount = response.meta.totalCount ?? response.meta.count;
        if (!shouldUseFullHydrationForList) {
          previewCache.set({
            key: currentPreviewRequestKey,
            formId: currentFormId,
            page,
            pageSize,
            records: normalizedRecords,
            hasMore: response.meta.hasMore,
            totalCount,
            readMeta: {
              cacheSource: response.meta.cacheSource,
              cacheState: response.meta.cacheState,
              snapshotAt: response.meta.snapshotAt,
            },
            cachedAt: Date.now(),
          });
        }
        setRecords(normalizedRecords);
        setLoadedPreviewContext(requestContext);
        setHasMore(response.meta.hasMore);
        setPreviewTotalCount(totalCount);
        setPreviewReadMeta({
          cacheSource: response.meta.cacheSource,
          cacheState: response.meta.cacheState,
          snapshotAt: response.meta.snapshotAt,
        });
        setPreviewRevalidationError(null);
        setError(null);
        // 只有真正啟動且成功套用的 fresh SQLite 讀取，才能涵蓋較早收到的 SSE。
        completedFreshPreviewRef.current =
          networkStartedAt !== null && response.meta.cacheSource === "sqlite" && response.meta.cacheState === "fresh"
            ? { key: currentPreviewRequestKey, revision: requestRevision, startedAt: networkStartedAt }
            : null;
        onPreviewReadMetric?.({
          mode: metricMode,
          outcome: "completed",
          durationMs: performance.now() - metricStartedAt,
          page,
          recordCount: normalizedRecords.length,
          cacheSource: response.meta.cacheSource,
          cacheState: response.meta.cacheState,
        });
      } catch (err) {
        if (previewRequestIdRef.current !== requestId) {
          onPreviewReadMetric?.({
            mode: metricMode,
            outcome: "cancelled",
            durationMs: performance.now() - metricStartedAt,
            page,
            recordCount: 0,
            cacheSource: null,
            cacheState: null,
          });
          return;
        }
        const failureResolution = resolvePreviewLoadFailure({
          isBackground,
          cachedPreview,
          retainedPreview,
          error: err,
        });
        if (failureResolution.kind === "retain") {
          setRecords(failureResolution.failure.records);
          setLoadedPreviewContext({
            key: failureResolution.preview.key,
            page: failureResolution.preview.page,
            pageSize: failureResolution.preview.pageSize,
          });
          setHasMore(failureResolution.preview.hasMore);
          setPreviewTotalCount(failureResolution.preview.totalCount);
          setPreviewReadMeta(failureResolution.failure.readMeta);
          setPreviewRevalidationError(failureResolution.failure.error);
          setError(null);
        } else if (failureResolution.kind === "initial-error") {
          setError(failureResolution.error);
          setRecords([]);
          setLoadedPreviewContext(null);
          setHasMore(false);
          setPreviewTotalCount(0);
          setPreviewReadMeta(null);
        } else {
          setPreviewRevalidationError(failureResolution.error);
        }
        onPreviewReadMetric?.({
          mode: metricMode,
          outcome: "failed",
          durationMs: performance.now() - metricStartedAt,
          page,
          recordCount: cachedPreview?.records.length ?? retainedPreview?.records.length ?? 0,
          cacheSource:
            cachedPreview?.readMeta.cacheSource ?? retainedPreview?.readMeta.cacheSource ?? null,
          cacheState:
            cachedPreview?.readMeta.cacheState ?? retainedPreview?.readMeta.cacheState ?? null,
        });
        if (options.throwOnError) {
          throw err;
        }
      } finally {
        if (previewRequestIdRef.current === requestId) {
          previewRequestActiveRef.current = false;
        }
        if (previewRequestIdRef.current === requestId && !isBackground) {
          foregroundPreviewRequestActiveRef.current = false;
          foregroundPreviewRequestCoordinatorRef.current?.finish(requestId);
          setLoading(false);
          setPreviewRevalidating(false);
        }
        if (isBackground) {
          dispatchBackgroundFetch({
            type: "finish",
            scope: "preview",
            requestId,
          });
        }
      }
    },
    [
      currentPreviewRequestKey,
      currentFormId,
      fetchPreviewPage,
      invalidatePreviewCache,
      page,
      pageSize,
      serverPreviewQuery,
      shouldUseFullHydrationForList,
      onPreviewReadMetric,
      previewPageCacheRef,
    ]
  );

  useEffect(() => {
    const targetFormId = pendingPreviewSettlementReloadFormIdRef.current;
    if (!targetFormId) {
      return;
    }
    pendingPreviewSettlementReloadFormIdRef.current = null;
    if (targetFormId !== currentFormId || shouldUseFullHydrationForList) {
      return;
    }
    void loadReports(false, { mode: "foreground" }).catch(() => {
      // NOTE: loadReports 已自行處理錯誤提示。
    });
  }, [
    currentFormId,
    loadReports,
    previewSettlementReloadEpoch,
    shouldUseFullHydrationForList,
  ]);

  useEffect(() => {
    if (
      shouldUseFullHydrationForList ||
      loadedPreviewContext?.key !== currentPreviewRequestKey
    ) {
      return;
    }

    const previewCache = previewPageCacheRef.current!;
    const candidates: Array<{
      key: string;
      page: number;
      query: PreviewServerQuery;
    }> = [];
    if (hasMore) {
      const nextPage = page + 1;
      candidates.push({
        key: buildPreviewRequestKey({
          currentFormId,
          page: nextPage,
          pageSize,
          shouldUseFullHydrationForList,
          bootstrapKeyword,
          serverPreviewQuery,
        }),
        page: nextPage,
        query: serverPreviewQuery,
      });
    }
    for (const query of previewPrefetchQueries) {
      const key = buildPreviewRequestKey({
        currentFormId,
        page: 1,
        pageSize,
        shouldUseFullHydrationForList,
        bootstrapKeyword: "",
        serverPreviewQuery: query,
      });
      if (
        key === currentPreviewRequestKey ||
        previewCache.peek(key)
      ) {
        continue;
      }
      candidates.push({ key, page: 1, query });
    }
    if (candidates.length === 0) {
      return;
    }

    let cancelled = false;
    const runPrefetch = async () => {
      const batch = candidates.slice(0, PREVIEW_PREFETCH_BATCH_SIZE);
      let batchSucceeded = true;
      for (const candidate of batch) {
        if (cancelled) {
          return;
        }
        const requestRevision = previewCache.revision(currentFormId);
        const existingRequest = previewFetchInFlightRef.current.get(candidate.key);
        if (previewCache.peek(candidate.key) || existingRequest?.revision === requestRevision) {
          continue;
        }
        try {
          const metricStartedAt = performance.now();
          const response = await fetchPreviewPage(
            candidate.page,
            false,
            candidate.query,
            candidate.key
          );
          if (previewCache.revision(currentFormId) !== requestRevision) {
            continue;
          }
          previewCache.set({
            key: candidate.key,
            formId: currentFormId,
            page: candidate.page,
            pageSize,
            records: dedupeRecordsById(
              response.data.map((record) => normalizeRecord(record, false))
            ),
            hasMore: response.meta.hasMore,
            totalCount: response.meta.totalCount ?? response.meta.count,
            readMeta: {
              cacheSource: response.meta.cacheSource,
              cacheState: response.meta.cacheState,
              snapshotAt: response.meta.snapshotAt,
            },
            cachedAt: Date.now(),
          });
          onPreviewReadMetric?.({
            mode: "prefetch",
            outcome: "completed",
            durationMs: performance.now() - metricStartedAt,
            page: candidate.page,
            recordCount: response.data.length,
            cacheSource: response.meta.cacheSource,
            cacheState: response.meta.cacheState,
          });
        } catch {
          batchSucceeded = false;
          // 預載失敗不影響目前頁面，下一次 idle window 會再嘗試。
        }
      }
      if (!cancelled && batchSucceeded && candidates.length > batch.length) {
        incrementPreviewCacheEpoch();
      }
    };

    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    if (idleWindow.requestIdleCallback && idleWindow.cancelIdleCallback) {
      const idleHandle = idleWindow.requestIdleCallback(() => {
        void runPrefetch();
      }, { timeout: 800 });
      return () => {
        cancelled = true;
        idleWindow.cancelIdleCallback?.(idleHandle);
      };
    }
    const timeoutHandle = window.setTimeout(() => {
      void runPrefetch();
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutHandle);
    };
  }, [
    bootstrapKeyword,
    currentFormId,
    currentPreviewRequestKey,
    fetchPreviewPage,
    hasMore,
    loadedPreviewContext?.key,
    page,
    pageSize,
    onPreviewReadMetric,
    previewCacheEpoch,
    previewFetchInFlightRef,
    previewPageCacheRef,
    previewPrefetchQueries,
    serverPreviewQuery,
    shouldUseFullHydrationForList,
  ]);

  const hydrateAllRecords = useCallback(
    async (
      forceRefresh = false,
      options: {
        mode?: "foreground" | "background";
        reloadFromBackend?: boolean;
      } = {}
    ): Promise<WorkReportRecord[]> => {
      const isBackground = options.mode === "background";
      const reloadFromBackend = options.reloadFromBackend === true;
      const requestCoordinator = hydrationRequestCoordinatorRef.current!;

      if (
        !requestCoordinator.isActive() &&
        shouldReuseHydratedFullRecords({
          forceRefresh,
          reloadFromBackend,
          hasHydratedAllRecords: hydration.hasHydratedAllRecords,
          recordCount: allRecords.length,
        })
      ) {
        return allRecords;
      }

      return requestCoordinator.run(reloadFromBackend, async () => {
        const requestId = hydrateRequestIdRef.current + 1;
        const entrySettlementRevision =
          hydrationEntrySettlementBarrierRef.current!.captureRevision();
        hydrateRequestIdRef.current = requestId;
        hydrateRequestActiveRef.current = true;

        if (isBackground) {
          dispatchBackgroundFetch({
            type: "start",
            scope: "hydration",
            requestId,
          });
        } else {
          dispatchBackgroundFetch({ type: "clear", scope: "hydration" });
          dispatchHydration({
            type: "start",
            clearCount: !hydration.hasHydratedAllRecords,
          });
        }

        try {
          const response = await fetchWorkReportsFull(currentFormId, forceRefresh);
          const merged = hydrationEntrySettlementBarrierRef.current!.mergeRecords(
            currentFormId,
            entrySettlementRevision,
            dedupeRecordsById(
              response.data.map((record) => normalizeRecord(record, false))
            )
          );
          const hydratedAt = Date.now();

          if (hydrateRequestIdRef.current !== requestId) {
            return allRecords;
          }

          setAllRecords(merged);
          dispatchHydration({
            type: "success",
            hydratedCount: merged.length,
            hydrationSource:
              response.meta.cacheSource === "ragic-live"
                ? "network"
                : response.meta.cacheSource === "sqlite"
                  ? "sqlite"
                  : "cache",
            backendCacheState: response.meta.cacheState,
            backendSnapshotAt: response.meta.snapshotAt,
            backendExpiresAt: response.meta.expiresAt,
            hydratedAt,
            truncated: response.meta.truncated,
            truncatedCount: response.meta.truncatedCount ?? 0,
          });
          if (response.meta.truncated) {
            setNotice({
              type: "error",
              message: t("workReport:status.human.truncatedDetail", {
                truncatedCount: response.meta.truncatedCount ?? 0,
              }),
            });
          }
          return merged;
        } catch (err) {
          if (hydrateRequestIdRef.current !== requestId) {
            return allRecords;
          }
          if (!forceRefresh) {
            const cached = readHydrationCache(currentFormId);
            if (cached) {
              const mergedCached =
                hydrationEntrySettlementBarrierRef.current!.mergeRecords(
                  currentFormId,
                  entrySettlementRevision,
                  cached
                );
              const hydratedAt = Date.now();
              const fallbackMessage = t(
                "workReport:messages.failedReadBackendCacheFallbackLocal",
                {
                  error: getErrorMessage(err),
                }
              );
              setAllRecords(mergedCached);
              dispatchHydration({
                type: "local-cache-success",
                hydratedCount: mergedCached.length,
                hydratedAt,
              });
              setNotice({
                type: "error",
                message: fallbackMessage,
              });
              if (shouldPropagateHydrationFallbackFailure(reloadFromBackend)) {
                throw new Error(fallbackMessage, { cause: err });
              }
              return mergedCached;
            }
          }
          setNotice({
            type: "error",
            message: t("workReport:messages.failedLoadFullDataset", { error: getErrorMessage(err) }),
          });
          throw err;
        } finally {
          if (hydrateRequestIdRef.current === requestId) {
            hydrateRequestActiveRef.current = false;
          }
          if (hydrateRequestIdRef.current === requestId) {
            dispatchHydration({ type: "finish" });
          }
          if (isBackground) {
            dispatchBackgroundFetch({
              type: "finish",
              scope: "hydration",
              requestId,
            });
          }
        }
      });
    },
    [
      allRecords,
      currentFormId,
      hydration.hasHydratedAllRecords,
      setNotice,
      t,
    ]
  );

  const resetListDataState = useCallback((nextFormId?: WorkReportFormId): void => {
    previewRequestIdRef.current += 1;
    hydrateRequestIdRef.current += 1;
    previewRequestActiveRef.current = false;
    foregroundPreviewRequestActiveRef.current = false;
    foregroundPreviewRequestCoordinatorRef.current?.reset();
    hydrateRequestActiveRef.current = false;
    hydrationRequestCoordinatorRef.current?.reset();
    const cachedHydratedState = nextFormId
      ? hydratedFormCacheRef.current[nextFormId]
      : undefined;

    setLoading(false);
    setError(null);
    setRecords([]);
    setLoadedPreviewContext(null);
    setAllRecords(cachedHydratedState?.allRecords ?? []);
    setHasMore(false);
    setPreviewTotalCount(0);
    setPreviewReadMeta(null);
    setPreviewRevalidating(false);
    setPreviewRevalidationError(null);
    dispatchBackgroundFetch({ type: "reset" });
    if (cachedHydratedState) {
      dispatchHydration({
        type: "success",
        hydratedCount: cachedHydratedState.hydration.hydratedCount,
        hydrationSource: cachedHydratedState.hydration.hydrationSource,
        backendCacheState: cachedHydratedState.hydration.backendCacheState,
        backendSnapshotAt: cachedHydratedState.hydration.backendSnapshotAt,
        backendExpiresAt: cachedHydratedState.hydration.backendExpiresAt,
        hydratedAt: cachedHydratedState.hydration.fullDataHydratedAt ?? Date.now(),
        truncated: cachedHydratedState.hydration.truncated,
        truncatedCount: cachedHydratedState.hydration.truncatedCount,
      });
      return;
    }
    dispatchHydration({ type: "reset" });
  }, []);

  const resetHydrationState = useCallback((): void => {
    hydrateRequestIdRef.current += 1;
    hydrateRequestActiveRef.current = false;
    hydrationRequestCoordinatorRef.current?.reset();
    dispatchBackgroundFetch({ type: "clear", scope: "hydration" });
    dispatchHydration({ type: "reset" });
  }, []);

  const recoverStaleLoadingState = useCallback(() => {
    if (!loading) {
      return;
    }
    if (previewRequestActiveRef.current || hydrateRequestActiveRef.current) {
      return;
    }
    if (shouldUseFullHydrationForList && !hydration.hasHydratedAllRecords) {
      void hydrateAllRecords(false).catch(() => {
        // NOTE: hydrateAllRecords 已自行處理錯誤提示
      });
      return;
    }
    void loadReports(false).catch(() => {
      // NOTE: loadReports 已自行處理錯誤提示
    });
  }, [
    hydrateAllRecords,
    hydration.hasHydratedAllRecords,
    loadReports,
    loading,
    shouldUseFullHydrationForList,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handlePageShow = () => {
      resetAsyncRequestState();
      recoverStaleLoadingState();
    };

    window.addEventListener("pageshow", handlePageShow);
    return () => {
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, [recoverStaleLoadingState, resetAsyncRequestState]);

  useEffect(() => {
    if (!loading) {
      return;
    }
    const timer = window.setTimeout(() => {
      recoverStaleLoadingState();
    }, 800);
    return () => {
      window.clearTimeout(timer);
    };
  }, [loading, recoverStaleLoadingState]);

  const mergeListRecord = useCallback((
    formId: WorkReportFormId,
    incomingRecord: WorkReportRecord,
    expectedPatch?: Partial<WorkReportRecord>
  ): void => {
    hydrationEntrySettlementBarrierRef.current!.record(
      formId,
      incomingRecord,
      expectedPatch
    );
    const entryId = String(incomingRecord.id);
    const merge = (currentRecords: WorkReportRecord[]): WorkReportRecord[] => {
      let replaced = false;
      const nextRecords = currentRecords.map((record) => {
        if (String(record.id) !== entryId) {
          return record;
        }
        replaced = true;
        return normalizeRecord(
          {
            ...record,
            ...incomingRecord,
          },
          Boolean(record.reportsLoaded)
        );
      });
      return replaced ? nextRecords : currentRecords;
    };
    previewPageCacheRef.current?.updateFormRecords(formId, merge);
    invalidatePreviewCache(formId);

    if (currentFormIdRef.current !== formId) {
      const cachedState = hydratedFormCacheRef.current[formId];
      if (!cachedState) {
        return;
      }
      const nextCachedRecords = merge(cachedState.allRecords);
      if (nextCachedRecords === cachedState.allRecords) {
        return;
      }
      hydratedFormCacheRef.current[formId] = {
        ...cachedState,
        allRecords: nextCachedRecords,
      };
      writeHydrationCache(formId, nextCachedRecords);
      return;
    }

    setRecords(merge);
    setAllRecords(merge);
    pendingPreviewSettlementReloadFormIdRef.current = formId;
    requestPreviewSettlementReload();
  }, [invalidatePreviewCache, previewPageCacheRef]);

  const patchListRecord = useCallback((
    formId: WorkReportFormId,
    entryId: string,
    patch: Partial<WorkReportRecord>
  ): void => {
    const normalizedEntryId = String(entryId);
    const patchEntries = Object.entries(patch);
    const merge = (currentRecords: WorkReportRecord[]): WorkReportRecord[] => {
      let changed = false;
      const nextRecords = currentRecords.map((record) => {
        if (String(record.id) !== normalizedEntryId) {
          return record;
        }
        if (patchEntries.every(([key, value]) => Object.is(record[key], value))) {
          return record;
        }
        changed = true;
        return normalizeRecord(
          {
            ...record,
            ...patch,
          },
          Boolean(record.reportsLoaded)
        );
      });
      return changed ? nextRecords : currentRecords;
    };
    previewPageCacheRef.current?.updateFormRecords(formId, merge);
    invalidatePreviewCache(formId);

    if (currentFormIdRef.current !== formId) {
      const cachedState = hydratedFormCacheRef.current[formId];
      if (!cachedState) {
        return;
      }
      const nextCachedRecords = merge(cachedState.allRecords);
      if (nextCachedRecords === cachedState.allRecords) {
        return;
      }
      hydratedFormCacheRef.current[formId] = {
        ...cachedState,
        allRecords: nextCachedRecords,
      };
      writeHydrationCache(formId, nextCachedRecords);
      return;
    }

    setRecords(merge);
    setAllRecords(merge);
  }, [invalidatePreviewCache, previewPageCacheRef]);

  return {
    loading,
    error,
    records: displayedPreviewRecords,
    allRecords,
    hasMore: displayedPreviewHasMore,
    previewTotalCount: displayedPreviewTotalCount,
    previewReadMeta: displayedPreviewReadMeta,
    previewRevalidating,
    previewRevalidationError,
    backgroundFetching,
    previewTransitionPending,
    displayedPreviewPage,
    displayedPreviewPageSize,
    hydration,
    setError,
    loadReports,
    hydrateAllRecords,
    mergeListRecord,
    patchListRecord,
    invalidatePreviewCache,
    resetListDataState,
    resetHydrationState,
  };
}

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { fetchWorkReports, fetchWorkReportsFull, type WorkReportRecord } from "../../../api/workReport";
import type {
  BackendCacheState,
  HydrationSource,
  NoticeState,
  WorkReportFormId,
} from "../types";
import {
  dedupeRecordsById,
  getErrorMessage,
  normalizeRecord,
  readHydrationCache,
  writeHydrationCache,
} from "../utils";

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
  serverPreviewQuery: {
    enabled: boolean;
    keyword?: string;
    workOrderKeyword?: string;
    customerPartKeyword?: string;
    status?: string;
    ragicUnfinishedStatus?: string;
    machineCode?: string;
    filterMachineCode?: string;
    siteRunning?: "all" | "yes" | "no";
    startSchedule?: "all" | "yes" | "no";
    updatedDateFrom?: string;
    updatedDateTo?: string;
    sort?: string;
  };
  bootstrapKeyword: string;
  t: (key: string, options?: Record<string, unknown>) => string;
  setNotice: Dispatch<SetStateAction<NoticeState | null>>;
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
  bootstrapKeyword,
  t,
  setNotice,
}: UseWorkReportListDataArgs) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [records, setRecords] = useState<WorkReportRecord[]>([]);
  const [allRecords, setAllRecords] = useState<WorkReportRecord[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [previewTotalCount, setPreviewTotalCount] = useState(0);
  const [loadedPreviewContext, setLoadedPreviewContext] = useState<LoadedPreviewContext | null>(null);
  const [hydration, dispatchHydration] = useReducer(hydrationReducer, INITIAL_HYDRATION_STATE);
  const currentFormIdRef = useRef(currentFormId);
  currentFormIdRef.current = currentFormId;
  const hydratedFormCacheRef = useRef<Partial<Record<WorkReportFormId, HydratedFormCacheEntry>>>({});
  const previewRequestIdRef = useRef(0);
  const hydrateRequestIdRef = useRef(0);
  const previewRequestActiveRef = useRef(false);
  const foregroundPreviewRequestActiveRef = useRef(false);
  const hydrateRequestActiveRef = useRef(false);
  const hydrationRequestCoordinatorRef = useRef<HydrationRequestCoordinator<
    WorkReportRecord[]
  > | null>(null);
  if (!hydrationRequestCoordinatorRef.current) {
    hydrationRequestCoordinatorRef.current = new HydrationRequestCoordinator<WorkReportRecord[]>();
  }
  const currentPreviewRequestKey = JSON.stringify({
    currentFormId,
    page,
    pageSize,
    shouldUseFullHydrationForList,
    bootstrapKeyword,
    serverPreviewQuery,
  });
  const previewTransitionPending = Boolean(
    !shouldUseFullHydrationForList &&
      records.length > 0 &&
      loadedPreviewContext &&
      loadedPreviewContext.key !== currentPreviewRequestKey
  );
  const displayedPreviewPage = loadedPreviewContext?.page ?? page;
  const displayedPreviewPageSize = loadedPreviewContext?.pageSize ?? pageSize;

  const resetAsyncRequestState = useCallback(() => {
    previewRequestIdRef.current += 1;
    hydrateRequestIdRef.current += 1;
    previewRequestActiveRef.current = false;
    foregroundPreviewRequestActiveRef.current = false;
    hydrateRequestActiveRef.current = false;
    hydrationRequestCoordinatorRef.current?.reset();
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

  const loadReports = useCallback(
    async (
      forceRefresh = false,
      options: { throwOnError?: boolean; mode?: "foreground" | "background" } = {}
    ): Promise<void> => {
      const isBackground = options.mode === "background";
      if (isBackground && foregroundPreviewRequestActiveRef.current) {
        return;
      }
      const requestId = previewRequestIdRef.current + 1;
      const requestContext: LoadedPreviewContext = {
        key: currentPreviewRequestKey,
        page,
        pageSize,
      };
      previewRequestIdRef.current = requestId;
      previewRequestActiveRef.current = true;
      if (!isBackground) {
        foregroundPreviewRequestActiveRef.current = true;
        setLoading(true);
      }
      if (!isBackground) {
        setError(null);
      }

      try {
        const offset = (page - 1) * pageSize;
        const keywordForPage =
          shouldUseFullHydrationForList && !hydration.hasHydratedAllRecords ? bootstrapKeyword : "";
        const response = await fetchWorkReports(
          currentFormId,
          pageSize,
          offset,
          keywordForPage,
          forceRefresh,
          serverPreviewQuery.enabled
            ? {
                keyword: serverPreviewQuery.keyword,
                workOrderKeyword: serverPreviewQuery.workOrderKeyword,
                customerPartKeyword: serverPreviewQuery.customerPartKeyword,
                status: serverPreviewQuery.status,
                ragicUnfinishedStatus: serverPreviewQuery.ragicUnfinishedStatus,
                machineCode: serverPreviewQuery.machineCode,
                filterMachineCode: serverPreviewQuery.filterMachineCode,
                siteRunning: serverPreviewQuery.siteRunning,
                startSchedule: serverPreviewQuery.startSchedule,
                updatedDateFrom: serverPreviewQuery.updatedDateFrom,
                updatedDateTo: serverPreviewQuery.updatedDateTo,
                sort: serverPreviewQuery.sort,
              }
            : {}
        );

        if (previewRequestIdRef.current !== requestId) {
          return;
        }

        setRecords(dedupeRecordsById(response.data.map((record) => normalizeRecord(record, false))));
        setLoadedPreviewContext(requestContext);
        setHasMore(response.meta.hasMore);
        setPreviewTotalCount(response.meta.totalCount ?? response.meta.count);
        setError(null);
      } catch (err) {
        if (previewRequestIdRef.current !== requestId) {
          return;
        }
        if (!isBackground) {
          setError(getErrorMessage(err));
          setRecords([]);
          setLoadedPreviewContext(null);
          setHasMore(false);
          setPreviewTotalCount(0);
        }
        if (options.throwOnError) {
          throw err;
        }
      } finally {
        if (previewRequestIdRef.current === requestId) {
          previewRequestActiveRef.current = false;
        }
        if (previewRequestIdRef.current === requestId && !isBackground) {
          foregroundPreviewRequestActiveRef.current = false;
          setLoading(false);
        }
      }
    },
    [
      bootstrapKeyword,
      currentPreviewRequestKey,
      currentFormId,
      hydration.hasHydratedAllRecords,
      page,
      pageSize,
      serverPreviewQuery.enabled,
      serverPreviewQuery.keyword,
      serverPreviewQuery.workOrderKeyword,
      serverPreviewQuery.customerPartKeyword,
      serverPreviewQuery.machineCode,
      serverPreviewQuery.filterMachineCode,
      serverPreviewQuery.ragicUnfinishedStatus,
      serverPreviewQuery.siteRunning,
      serverPreviewQuery.sort,
      serverPreviewQuery.startSchedule,
      serverPreviewQuery.updatedDateFrom,
      serverPreviewQuery.updatedDateTo,
      serverPreviewQuery.status,
      shouldUseFullHydrationForList,
    ]
  );

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
        hydrateRequestIdRef.current = requestId;
        hydrateRequestActiveRef.current = true;

        if (!isBackground) {
          dispatchHydration({
            type: "start",
            clearCount: !hydration.hasHydratedAllRecords,
          });
        }

        try {
          const response = await fetchWorkReportsFull(currentFormId, forceRefresh);
          const merged = dedupeRecordsById(
            response.data.map((record) => normalizeRecord(record, false))
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
          writeHydrationCache(currentFormId, merged);
          return merged;
        } catch (err) {
          if (hydrateRequestIdRef.current !== requestId) {
            return allRecords;
          }
          if (!forceRefresh) {
            const cached = readHydrationCache(currentFormId);
            if (cached) {
              const hydratedAt = Date.now();
              const fallbackMessage = t(
                "workReport:messages.failedReadBackendCacheFallbackLocal",
                {
                  error: getErrorMessage(err),
                }
              );
              setAllRecords(cached);
              dispatchHydration({
                type: "local-cache-success",
                hydratedCount: cached.length,
                hydratedAt,
              });
              setNotice({
                type: "error",
                message: fallbackMessage,
              });
              if (shouldPropagateHydrationFallbackFailure(reloadFromBackend)) {
                throw new Error(fallbackMessage, { cause: err });
              }
              return cached;
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

  const mergeListRecord = useCallback((formId: WorkReportFormId, incomingRecord: WorkReportRecord): void => {
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
  }, []);

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
  }, []);

  return {
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
    setError,
    loadReports,
    hydrateAllRecords,
    mergeListRecord,
    patchListRecord,
    resetListDataState,
    resetHydrationState,
  };
}

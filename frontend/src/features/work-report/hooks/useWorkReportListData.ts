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
  const [hydration, dispatchHydration] = useReducer(hydrationReducer, INITIAL_HYDRATION_STATE);
  const hydratedFormCacheRef = useRef<Partial<Record<WorkReportFormId, HydratedFormCacheEntry>>>({});
  const previewRequestIdRef = useRef(0);
  const hydrateRequestIdRef = useRef(0);
  const previewRequestActiveRef = useRef(false);
  const hydrateRequestActiveRef = useRef(false);

  const resetAsyncRequestState = useCallback(() => {
    previewRequestIdRef.current += 1;
    hydrateRequestIdRef.current += 1;
    previewRequestActiveRef.current = false;
    hydrateRequestActiveRef.current = false;
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
      options: { throwOnError?: boolean } = {}
    ): Promise<void> => {
      const requestId = previewRequestIdRef.current + 1;
      previewRequestIdRef.current = requestId;
      previewRequestActiveRef.current = true;
      setLoading(true);
      setError(null);

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
        setHasMore(response.meta.hasMore);
        setPreviewTotalCount(response.meta.totalCount ?? response.meta.count);
      } catch (err) {
        if (previewRequestIdRef.current !== requestId) {
          return;
        }
        setError(getErrorMessage(err));
        setRecords([]);
        setHasMore(false);
        setPreviewTotalCount(0);
        if (options.throwOnError) {
          throw err;
        }
      } finally {
        if (previewRequestIdRef.current === requestId) {
          previewRequestActiveRef.current = false;
        }
        if (previewRequestIdRef.current === requestId) {
          setLoading(false);
        }
      }
    },
    [
      bootstrapKeyword,
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
    async (forceRefresh = false): Promise<WorkReportRecord[]> => {
      if (hydration.isHydratingAllRecords) {
        return allRecords;
      }

      if (!forceRefresh && hydration.hasHydratedAllRecords && allRecords.length > 0) {
        return allRecords;
      }

      const requestId = hydrateRequestIdRef.current + 1;
      hydrateRequestIdRef.current = requestId;
      hydrateRequestActiveRef.current = true;

      dispatchHydration({
        type: "start",
        clearCount: !hydration.hasHydratedAllRecords,
      });

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
            setAllRecords(cached);
            dispatchHydration({
              type: "local-cache-success",
              hydratedCount: cached.length,
              hydratedAt,
            });
            setNotice({
              type: "error",
              message: t("workReport:messages.failedReadBackendCacheFallbackLocal", {
                error: getErrorMessage(err),
              }),
            });
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
    },
    [
      allRecords,
      currentFormId,
      hydration.hasHydratedAllRecords,
      hydration.isHydratingAllRecords,
      setNotice,
      t,
    ]
  );

  const resetListDataState = useCallback((nextFormId?: WorkReportFormId): void => {
    previewRequestIdRef.current += 1;
    hydrateRequestIdRef.current += 1;
    previewRequestActiveRef.current = false;
    hydrateRequestActiveRef.current = false;
    const cachedHydratedState = nextFormId
      ? hydratedFormCacheRef.current[nextFormId]
      : undefined;

    setLoading(false);
    setError(null);
    setRecords([]);
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

  return {
    loading,
    error,
    records,
    allRecords,
    hasMore,
    previewTotalCount,
    hydration,
    setError,
    loadReports,
    hydrateAllRecords,
    resetListDataState,
    resetHydrationState,
  };
}

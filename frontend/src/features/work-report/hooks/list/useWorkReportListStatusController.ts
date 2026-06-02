import { useMemo } from "react";
import type { BackendCacheState, HydrationSource, NoticeState } from "../../types";
import { deriveWorkReportHumanStatus } from "../../statusHumanStatus";
import { formatStatusDateTime } from "../../utils";

interface UseWorkReportListStatusControllerArgs {
  activeTopView: "report" | "local-settings" | "technical-info";
  notice: NoticeState | null;
  t: (key: string, options?: Record<string, unknown>) => string;
  isHydratingAllRecords: boolean;
  hydratedCount: number;
  shouldUseFullHydrationForList: boolean;
  hasHydratedAllRecords: boolean;
  hydrationSource: HydrationSource;
  backendCacheState: BackendCacheState;
  backendSnapshotAt: string | null;
  truncated: boolean;
  truncatedCount: number;
  realtimeConnected: boolean;
  realtimeDisconnectedSince: number | null;
  isSyncingFromRagic: boolean;
  loading: boolean;
  error: string | null;
}

export function useWorkReportListStatusController({
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
  truncated,
  truncatedCount,
  realtimeConnected,
  realtimeDisconnectedSince,
  isSyncingFromRagic,
  loading,
  error,
}: UseWorkReportListStatusControllerArgs) {
  const derivedHumanStatus = useMemo(
    () =>
      deriveWorkReportHumanStatus({
        t,
        hydration: {
          isHydratingAllRecords,
          hydratedCount,
          shouldUseFullHydrationForList,
          hasHydratedAllRecords,
          hydrationSource,
          backendCacheState,
          backendSnapshotAt,
          truncated,
          truncatedCount,
          realtimeConnected,
          realtimeDisconnectedSince,
        },
        isSyncingFromRagic,
        loading,
        error,
        summarySnapshotText:
          shouldUseFullHydrationForList && hasHydratedAllRecords && backendSnapshotAt
            ? formatStatusDateTime(backendSnapshotAt)
            : "--",
      }),
    [
      t,
      isHydratingAllRecords,
      hydratedCount,
      shouldUseFullHydrationForList,
      hasHydratedAllRecords,
      hydrationSource,
      backendCacheState,
      backendSnapshotAt,
      truncated,
      truncatedCount,
      realtimeConnected,
      realtimeDisconnectedSince,
      isSyncingFromRagic,
      loading,
      error,
    ]
  );

  const systemStatusNotice = useMemo<NoticeState | null>(() => {
    if (activeTopView !== "report") {
      return null;
    }
    if (notice) {
      return notice;
    }
    return {
      type: derivedHumanStatus.tone,
      message: derivedHumanStatus.detail,
      displayAsHumanStatus: true,
    };
  }, [activeTopView, derivedHumanStatus, notice]);

  return {
    systemStatusNotice,
  };
}

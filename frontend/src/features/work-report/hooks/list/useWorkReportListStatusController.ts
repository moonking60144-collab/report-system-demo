import { useMemo } from "react";
import type { NoticeState } from "../../types";
import { deriveWorkReportHumanStatus } from "../../statusHumanStatus";
import { formatStatusDateTime } from "../../utils";

interface UseWorkReportListStatusControllerArgs {
  activeTopView: "report" | "local-settings" | "technical-info";
  notice: NoticeState | null;
  t: (key: string, options?: Record<string, unknown>) => string;
  shouldUseFullHydrationForList: boolean;
  hasHydratedAllRecords: boolean;
  backendSnapshotAt: string | null;
  truncated: boolean;
  truncatedCount: number;
  realtimeConnected: boolean;
  realtimeDisconnectedSince: number | null;
  previewRevalidating: boolean;
  previewRevalidationError: string | null;
  isSyncingFromRagic: boolean;
  loading: boolean;
  error: string | null;
}

export function useWorkReportListStatusController({
  activeTopView,
  notice,
  t,
  shouldUseFullHydrationForList,
  hasHydratedAllRecords,
  backendSnapshotAt,
  truncated,
  truncatedCount,
  realtimeConnected,
  realtimeDisconnectedSince,
  previewRevalidating,
  previewRevalidationError,
  isSyncingFromRagic,
  loading,
  error,
}: UseWorkReportListStatusControllerArgs) {
  const derivedHumanStatus = useMemo(
    () =>
      deriveWorkReportHumanStatus({
        t,
        hydration: {
          shouldUseFullHydrationForList,
          hasHydratedAllRecords,
          backendSnapshotAt,
          truncated,
          truncatedCount,
          realtimeConnected,
          realtimeDisconnectedSince,
          previewRevalidating,
          previewRevalidationError,
        },
        isSyncingFromRagic,
        loading,
        error,
        summarySnapshotText:
          backendSnapshotAt
            ? formatStatusDateTime(backendSnapshotAt)
            : "--",
      }),
    [
      t,
      shouldUseFullHydrationForList,
      hasHydratedAllRecords,
      backendSnapshotAt,
      truncated,
      truncatedCount,
      realtimeConnected,
      realtimeDisconnectedSince,
      previewRevalidating,
      previewRevalidationError,
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

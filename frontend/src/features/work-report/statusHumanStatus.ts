import type { HydrationSource, NoticeState } from "./types";
import { formatStatusDateTime } from "./utils";

interface WorkReportStatusHydrationSnapshot {
  isHydratingAllRecords: boolean;
  hydratedCount: number;
  shouldUseFullHydrationForList: boolean;
  hasHydratedAllRecords: boolean;
  hydrationSource: HydrationSource;
  backendCacheState: "fresh" | "stale" | "building" | null;
  backendSnapshotAt: string | null;
  truncated: boolean;
  truncatedCount: number;
  realtimeConnected: boolean;
  realtimeDisconnectedSince: number | null;
}

export interface DerivedWorkReportHumanStatus {
  tone: NoticeState["type"];
  title: string;
  detail: string;
}

interface DeriveWorkReportHumanStatusOptions {
  t: (key: string, options?: Record<string, unknown>) => string;
  hydration: WorkReportStatusHydrationSnapshot;
  isSyncingFromRagic: boolean;
  loading: boolean;
  error: string | null;
  summarySnapshotText: string;
}

export function deriveWorkReportHumanStatus({
  t,
  hydration,
  isSyncingFromRagic,
  loading,
  error,
  summarySnapshotText,
}: DeriveWorkReportHumanStatusOptions): DerivedWorkReportHumanStatus {
  const backendSnapshotAtText = formatStatusDateTime(hydration.backendSnapshotAt);

  if (error) {
    return {
      tone: "error",
      title: t("workReport:status.human.errorTitle"),
      detail: error,
    };
  }
  if (loading && !hydration.hasHydratedAllRecords) {
    return {
      tone: "loading",
      title: t("workReport:status.human.loadingTitle"),
      detail: t("workReport:status.human.loadingDetail"),
    };
  }
  if (isSyncingFromRagic) {
    return {
      tone: "info",
      title: t("workReport:status.human.syncingTitle"),
      detail: t("workReport:status.human.syncingDetail"),
    };
  }
  if (!hydration.realtimeConnected && hydration.realtimeDisconnectedSince) {
    return {
      tone: "warn",
      title: t("workReport:status.human.realtimeDisconnectedTitle"),
      detail: t("workReport:status.human.realtimeDisconnectedDetail", {
        since: formatStatusDateTime(hydration.realtimeDisconnectedSince),
      }),
    };
  }
  if (hydration.isHydratingAllRecords) {
    return {
      tone: "info",
      title: t("workReport:status.human.hydratingTitle"),
      detail: t("workReport:status.human.hydratingDetail", {
        count: hydration.hydratedCount,
      }),
    };
  }
  if (hydration.shouldUseFullHydrationForList && hydration.hasHydratedAllRecords && hydration.truncated) {
    return {
      tone: "error",
      title: t("workReport:status.human.truncatedTitle"),
      detail: t("workReport:status.human.truncatedDetail", {
        truncatedCount: hydration.truncatedCount,
      }),
    };
  }
  if (
    hydration.shouldUseFullHydrationForList &&
    hydration.hasHydratedAllRecords &&
    hydration.hydrationSource !== "network" &&
    hydration.backendCacheState === "building"
  ) {
    return {
      tone: "warn",
      title: t("workReport:status.human.buildingTitle"),
      detail: t("workReport:status.human.buildingDetail", {
        snapshot: backendSnapshotAtText,
      }),
    };
  }
  if (
    hydration.shouldUseFullHydrationForList &&
    hydration.hasHydratedAllRecords &&
    hydration.hydrationSource !== "network" &&
    hydration.backendCacheState === "stale"
  ) {
    return {
      tone: "warn",
      title: t("workReport:status.human.staleTitle"),
      detail: t("workReport:status.human.staleDetail", {
        snapshot: backendSnapshotAtText,
      }),
    };
  }
  return {
    tone: "success",
    title: t("workReport:status.human.readyTitle"),
    detail:
      summarySnapshotText !== "--"
        ? t("workReport:status.human.readyDetail", { snapshot: summarySnapshotText })
        : t("workReport:status.human.readyDetailNoSnapshot"),
  };
}

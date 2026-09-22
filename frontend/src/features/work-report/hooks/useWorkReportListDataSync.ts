import { useEffect } from "react";
import type { WorkReportRecord } from "../../../api/workReport";
import type { WorkReportFormId } from "../types";
import { clearScheduledHydrationCacheWrite, scheduleHydrationCacheWrite } from "../utils";

interface UseWorkReportListDataSyncArgs {
  shouldUseFullHydrationForList: boolean;
  hasHydratedAllRecords: boolean;
  loadReports: (forceRefresh?: boolean) => Promise<void>;
  resetHydrationState: () => void;
  hydrateAllRecords: (forceRefresh?: boolean) => Promise<WorkReportRecord[]>;
  currentFormId: WorkReportFormId;
  allRecords: WorkReportRecord[];
}

export function useWorkReportListDataSync({
  shouldUseFullHydrationForList,
  hasHydratedAllRecords,
  loadReports,
  resetHydrationState,
  hydrateAllRecords,
  currentFormId,
  allRecords,
}: UseWorkReportListDataSyncArgs): void {
  useEffect(() => {
    if (shouldUseFullHydrationForList && hasHydratedAllRecords) {
      return;
    }
    void loadReports();
  }, [shouldUseFullHydrationForList, hasHydratedAllRecords, loadReports]);

  useEffect(() => {
    if (!shouldUseFullHydrationForList) {
      resetHydrationState();
      return;
    }

    if (hasHydratedAllRecords) {
      return;
    }

    void hydrateAllRecords(false).catch(() => {
      // NOTE: 錯誤已於 hydrateAllRecords 顯示。
    });
  }, [
    hasHydratedAllRecords,
    hydrateAllRecords,
    resetHydrationState,
    shouldUseFullHydrationForList,
  ]);

  useEffect(() => {
    if (!shouldUseFullHydrationForList || !hasHydratedAllRecords) {
      return;
    }
    scheduleHydrationCacheWrite({ formId: currentFormId, records: allRecords });
    return () => {
      clearScheduledHydrationCacheWrite(currentFormId);
    };
  }, [shouldUseFullHydrationForList, hasHydratedAllRecords, currentFormId, allRecords]);
}

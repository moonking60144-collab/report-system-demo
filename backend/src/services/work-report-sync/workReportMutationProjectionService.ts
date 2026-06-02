import { shouldUseSqliteReadForForm } from "../../config/env";
import { workReportReadService } from "../work-report/workReportReadService";
import { buildRefreshEntryOptions } from "../work-report/shared/refreshEntryOptions";
import { workReportSqliteRepository } from "../../storage/sqlite/workReportSqliteRepository";
import { recentMutationProjectionWindow } from "./recentMutationProjectionWindow";
import { WorkReportMutationProjectionService } from "./workReportMutationProjectionServiceFactory";

export const workReportMutationProjectionService = new WorkReportMutationProjectionService({
  shouldProject(formId) {
    return shouldUseSqliteReadForForm(formId);
  },
  getSyncState: workReportSqliteRepository.getSyncState.bind(workReportSqliteRepository),
  enqueueProjectionEvent:
    workReportSqliteRepository.enqueueProjectionEvent.bind(workReportSqliteRepository),
  // Mutation projection 是寫入後的背景投影。走 background lane 不阻塞使用者 lane；
  // 失敗也可接受（SQLite 會保留舊 snapshot，下個使用者讀取若帶 refresh=true 會再打 Ragic）。
  refreshEntry(formId, entryId) {
    return workReportReadService.getReportByEntryId(
      formId,
      entryId,
      buildRefreshEntryOptions("background")
    );
  },
  upsertEntrySnapshot:
    workReportSqliteRepository.upsertEntrySnapshot.bind(workReportSqliteRepository),
  deleteEntrySnapshot:
    workReportSqliteRepository.deleteEntrySnapshot.bind(workReportSqliteRepository),
  markProjectionEventProcessed:
    workReportSqliteRepository.markProjectionEventProcessed.bind(workReportSqliteRepository),
  cleanupProcessedProjectionEvents:
    workReportSqliteRepository.cleanupProcessedProjectionEvents.bind(workReportSqliteRepository),
  touchSyncStateSnapshot:
    workReportSqliteRepository.touchSyncStateSnapshot.bind(workReportSqliteRepository),
  markRecentlyProjectedEntry(formId, entryId, reason, snapshotAt) {
    recentMutationProjectionWindow.mark({
      formId,
      entryId,
      reason,
      projectedAt: snapshotAt,
    });
  },
});

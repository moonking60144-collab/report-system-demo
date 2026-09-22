import { resolveWorkReportDataPath, shouldUseSqliteReadForForm } from "../../config/env";
import { workReportReadService } from "../work-report/workReportReadService";
import { buildRefreshEntryOptions } from "../work-report/shared/refreshEntryOptions";
import { workReportSqliteRepository } from "../../storage/sqlite/workReportSqliteRepository";
import { recentMutationProjectionWindow } from "./recentMutationProjectionWindow";
import { WorkReportMutationProjectionService } from "./workReportMutationProjectionServiceFactory";
import { getFormConfig } from "../../config/forms";
import { ragicClient } from "../../ragic/client";
import { buildBackgroundReadOptions } from "../work-report/shared/refreshEntryOptions";
import { getFirstFieldValue } from "../work-report/shared/subtableUtils";
import { parseNumericValue } from "../work-report/shared/valueUtils";
import { UpstreamError } from "../../utils/httpError";

export const workReportMutationProjectionService = new WorkReportMutationProjectionService({
  shouldProject(formId) {
    return shouldUseSqliteReadForForm(formId);
  },
  getSyncState: workReportSqliteRepository.getSyncState.bind(workReportSqliteRepository),
  enqueueProjectionEvent:
    workReportSqliteRepository.enqueueProjectionEvent.bind(workReportSqliteRepository),
  // Mutation projection 是寫入後的背景投影。走 background lane 不阻塞使用者 lane；
  // 失敗也可接受（SQLite 會保留舊 snapshot，下個使用者讀取若帶 refresh=true 會再打 Ragic）。
  async refreshEntry(formId, entryId, observedEntry) {
    if (observedEntry) {
      const observedEntryId = String(
        observedEntry._ragicId ?? observedEntry._ragic_id ?? entryId
      ).trim();
      if (observedEntryId !== entryId) {
        throw new Error(
          `confirmed projection entry mismatch: expected ${entryId}, observed ${observedEntryId}`
        );
      }
    }
    // The command observation can predate another writer entering the projection queue.
    return workReportReadService.getReportByEntryId(
      formId,
      entryId,
      buildRefreshEntryOptions("background")
    );
  },
  async patchSortOrderSnapshot(formId, entryId, _sortOrder, snapshotAt) {
    const config = getFormConfig(formId);
    const observation = await ragicClient.observeEntry(resolveWorkReportDataPath(formId, config.ragicPath), entryId,
      { ...buildBackgroundReadOptions("background"), maxRetries: 0 });
    if (observation.kind !== "found") throw new UpstreamError("工令已不存在，等待完整投影確認", "RAGIC_READ_INVALID_RESPONSE");
    const fieldId = config.writeConfig.mainWriteFields?.sortOrder;
    if (!fieldId) throw new UpstreamError("尚未設定工令排序欄位", "RAGIC_READ_INVALID_RESPONSE");
    const currentSortOrder = parseNumericValue(getFirstFieldValue(observation.record, [fieldId, config.mainFields.sortOrder]));
    if (currentSortOrder === null) throw new UpstreamError("無法確認目前工令排序", "RAGIC_READ_INVALID_RESPONSE");
    return workReportSqliteRepository.patchEntrySortOrderSnapshot(formId, entryId, currentSortOrder, snapshotAt);
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

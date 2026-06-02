import { env, shouldUseSqliteReadForForm } from "../config/env";
import {
  publishWorkReportFormUpdated,
  publishWorkReportUpdated,
} from "../events/realtimeEventBus";
import { workReportSqliteRepository } from "../storage/sqlite/workReportSqliteRepository";
import { workReportReadService } from "./work-report/workReportReadService";
import { buildRefreshEntryOptions } from "./work-report/shared/refreshEntryOptions";
import { workReportMutationProjectionService } from "./work-report-sync/workReportMutationProjectionService";
import { recentMutationProjectionWindow } from "./work-report-sync/recentMutationProjectionWindow";
import {
  RagicCallbackRefreshService,
  type RagicCallbackRefreshServiceDeps,
} from "./ragicCallbackRefreshServiceFactory";

const ragicCallbackRefreshServiceDeps: RagicCallbackRefreshServiceDeps = {
  delayMs: env.RAGIC_CALLBACK_DELAY_MS,
  dedupeWindowMs: Math.max(2_000, env.RAGIC_CALLBACK_DELAY_MS + 2_000),
  shouldUseSqliteReadForForm,
  getSyncState: workReportSqliteRepository.getSyncState.bind(workReportSqliteRepository),
  projectEntryAfterMutation:
    workReportMutationProjectionService.projectEntryAfterMutation.bind(
      workReportMutationProjectionService
    ),
  refreshEntry: (formId, entryId) =>
    workReportReadService.getReportByEntryId(
      formId,
      entryId,
      buildRefreshEntryOptions("background")
    ),
  upsertEntrySnapshot: workReportSqliteRepository.upsertEntrySnapshot.bind(workReportSqliteRepository),
  touchSyncStateSnapshot:
    workReportSqliteRepository.touchSyncStateSnapshot.bind(workReportSqliteRepository),
  deleteEntrySnapshot: workReportSqliteRepository.deleteEntrySnapshot.bind(workReportSqliteRepository),
  publishWorkReportUpdated,
  publishWorkReportFormUpdated,
  getRecentMutationProjection(formId, entryId, windowMs) {
    return recentMutationProjectionWindow.getRecent(formId, entryId, windowMs);
  },
};

export const ragicCallbackRefreshService = new RagicCallbackRefreshService(
  ragicCallbackRefreshServiceDeps
);

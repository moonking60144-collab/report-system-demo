import { createReportTaskService } from "../services/createReportTaskService";
import { ragicCallbackRefreshService } from "../services/ragicCallbackRefreshService";
import { workReportEditingPresenceService } from "../services/workReportEditingPresenceService";
import { workReportReadService } from "../services/work-report/workReportReadService";
import { workReportBatchDeleteTaskService } from "../services/work-report/workReportBatchDeleteTaskService";
import { workReportBatchCreateTaskService } from "../services/work-report/workReportBatchCreateTaskService";
import { workReportTaskRegistryService } from "../services/work-report/workReportTaskRegistryService";
import { workReportMutationProjectionService } from "../services/work-report-sync/workReportMutationProjectionService";
import type {
  ProjectionApplyResult,
  ProjectionReason,
} from "../services/work-report-sync/workReportMutationProjectionServiceFactory";
import { workReportSyncService } from "../services/work-report-sync/workReportSyncService";
import { workReportService } from "../services/workReportService";
import { createWorkReportRouter } from "./workReportRouterFactory";
import { publishWorkReportFormUpdated, publishWorkReportUpdated } from "../events/realtimeEventBus";
import type { ReportWritePayload } from "../types/workReport";
import type { CreateReportBatchSharedState } from "../services/work-report/mutation/runCreateReportFlow";
import { runBackgroundTask } from "../infra/backgroundTaskRunner";
import { runWorkReportEntryMutationExclusive } from "../services/work-report/workReportEntryMutationQueue";
import { readWorkReportRowSnapshot } from "../services/audit/recordAuditSnapshotResolver";

function shouldPublishAfterBackgroundProjection(result: ProjectionApplyResult): boolean {
  return result === "applied" || result === "deleted";
}

async function enqueueProjectionAfterBatchMutation(
  formId: string,
  entryId: string,
  reason: ProjectionReason
): Promise<void> {
  let projectionSeq = 0;
  try {
    projectionSeq = await workReportMutationProjectionService.enqueueEntryAfterMutation(
      formId,
      entryId,
      reason
    );
  } catch (error) {
    console.warn("[sqlite-entry-projection-enqueue-failed]", {
      formId,
      entryId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  if (projectionSeq <= 0) {
    publishWorkReportUpdated(formId, entryId);
    publishWorkReportFormUpdated(formId);
    return;
  }

  runBackgroundTask(
    "work-report-batch-mutation-projection",
    async () => {
      const result = await workReportMutationProjectionService.applyQueuedProjectionAfterMutation(
        formId,
        entryId,
        reason,
        projectionSeq
      );
      if (shouldPublishAfterBackgroundProjection(result)) {
        publishWorkReportUpdated(formId, entryId);
        publishWorkReportFormUpdated(formId);
      }
    },
    (error) => {
      console.warn("[sqlite-entry-projection-apply-failed]", {
        formId,
        entryId,
        reason,
        projectionSeq,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  );
}

async function finalizeBatchCreateAndPublish(
  formId: string,
  entryId: string,
  createdCount: number,
  createdRowIds: string[]
): Promise<void> {
  if (createdCount <= 0) {
    return;
  }
  await workReportService.finalizeBatchCreate(formId, entryId, createdRowIds);
  await enqueueProjectionAfterBatchMutation(formId, entryId, "create");
}

const workReportRouter = createWorkReportRouter({
  runEntryMutationExclusive: runWorkReportEntryMutationExclusive,
  requestSync: workReportSyncService.requestSync.bind(workReportSyncService),
  listTasks: workReportTaskRegistryService.listTasks.bind(workReportTaskRegistryService),
  getTaskRecord: workReportTaskRegistryService.getTask.bind(workReportTaskRegistryService),
  getSyncStatus: workReportSyncService.getStatus.bind(workReportSyncService),
  getReports: workReportReadService.getReports.bind(workReportReadService),
  getFullReports: workReportReadService.getFullReports.bind(workReportReadService),
  getReportFacets: workReportReadService.getReportFacets.bind(workReportReadService),
  getReportAnalysis: workReportReadService.getReportAnalysis.bind(workReportReadService),
  getFormOptions: workReportReadService.getFormOptions.bind(workReportReadService),
  getRawPreview: workReportReadService.getRawPreview.bind(workReportReadService),
  getReportByEntryId: workReportReadService.getReportByEntryId.bind(workReportReadService),
  createReport: workReportService.createReport.bind(workReportService),
  assertCreateEntryAcceptsReports: workReportService.assertCreateEntryAcceptsReports.bind(workReportService),
  enqueueCreateTask: createReportTaskService.enqueue.bind(createReportTaskService),
  getCreateTask: createReportTaskService.getTask.bind(createReportTaskService),
  requestBatchCreate: async (input) =>
    (() => {
      const batchSharedState: CreateReportBatchSharedState = {
        latestRows: [],
        workOrderNo: String(input.workOrderNo ?? "").trim() || undefined,
      };
      return workReportBatchCreateTaskService.requestBatchCreate({
        ...input,
        beforeRun: async (context) => {
          await workReportService.assertEntryEditableBySession({
            formId: input.formId,
            entryId: input.entryId,
            editSessionId: input.editSessionId,
          });
          await workReportService.assertEntryLockVersion({
            formId: input.formId,
            entryId: input.entryId,
            editSessionId: input.editSessionId,
            editLockVersion: input.editLockVersion,
          });
          context.setStatusMessage("正在確認最新工令狀態");
          await workReportService.assertBatchCreateEntryAcceptsReports(
            input.formId,
            input.entryId
          );
        },
        createRow: async (payload) =>
          workReportService.createReport(input.formId, input.entryId, payload as ReportWritePayload, {
            mode: { kind: "batch", shared: batchSharedState },
            skipEntryPreflight: true,
          }),
        finalizeAfterCreate: async ({ createdCount, createdRowIds }) => {
          await finalizeBatchCreateAndPublish(
            input.formId,
            input.entryId,
            createdCount,
            createdRowIds
          );
        },
      });
    })(),
  requestBatchCreateFinalizeRetry: async (input) =>
    workReportBatchCreateTaskService.requestBatchCreateFinalizeRetry({
      formId: input.formId,
      entryId: input.entryId,
      taskId: input.taskId,
      actorClientId: input.actorClientId,
      actorTabId: input.actorTabId,
      actorIp: input.actorIp,
      actorLabel: input.actorLabel,
      finalizeAfterCreate: async ({ createdCount, createdRowIds }) => {
        await finalizeBatchCreateAndPublish(
          input.formId,
          input.entryId,
          createdCount,
          createdRowIds
        );
      },
    }),
  requestBatchDelete: async ({ onRowDeleted, ...input }) => {
    const taskResponse = await workReportBatchDeleteTaskService.requestBatchDelete({
      ...input,
      beforeRun: async () => {
        await workReportService.assertEntryLockVersion({
          formId: input.formId,
          entryId: input.entryId,
          ...(input.taskType === "delete-report" && input.rowIds.length === 1
            ? { rowId: input.rowIds[0] }
            : {}),
          editSessionId: input.editSessionId,
          editLockVersion: input.editLockVersion,
        });
        await workReportService.assertEntryNotModified(
          input.formId,
          input.entryId,
          input.expectedEntryLastUpdatedAt
        );
      },
      beforeDeleteRow: async (rowId) =>
        readWorkReportRowSnapshot(input.formId, input.entryId, rowId),
      deleteRow: async (rowId) => {
        await workReportService.assertEntryEditableBySession({
          formId: input.formId,
          entryId: input.entryId,
          rowId,
          editSessionId: input.editSessionId,
        });
        const result = await workReportService.hardDeleteReport(
          input.formId,
          input.entryId,
          rowId,
          { skipDeleteRecalculate: true }
        );
        return result;
      },
      ...(onRowDeleted
        ? {
            onRowDeleted: (
              rowId: string,
              taskId: string,
              beforeSnapshot: unknown | null
            ) => onRowDeleted(rowId, taskId, beforeSnapshot),
          }
        : {}),
      finalizeAfterDelete: async ({ deletedCount, deletedRowIds }) => {
        if (deletedCount <= 0) {
          return;
        }
        await workReportService.finalizeBatchDelete(
          input.formId,
          input.entryId,
          deletedRowIds
        );
        await enqueueProjectionAfterBatchMutation(input.formId, input.entryId, "delete");
      },
    });
    return taskResponse;
  },
  updateReport: workReportService.updateReport.bind(workReportService),
  updateMainMachine: workReportService.updateMainMachine.bind(workReportService),
  updateSortOrder: workReportService.updateSortOrder.bind(workReportService),
  manualCloseWorkOrder: workReportService.manualCloseWorkOrder.bind(workReportService),
  deleteReport: workReportService.hardDeleteReport.bind(workReportService),
  assertEntryNotModified: workReportService.assertEntryNotModified.bind(workReportService),
  assertEntryEditableBySession: workReportService.assertEntryEditableBySession.bind(workReportService),
  assertEntryLockVersion: workReportService.assertEntryLockVersion.bind(workReportService),
  upsertEditingPresence:
    async (input) => workReportEditingPresenceService.upsertPresence(input),
  getEditingPresenceSnapshot:
    async (input) => workReportEditingPresenceService.getSnapshot(input),
  requestRagicCallbackRefresh: async (input) => {
    const task = ragicCallbackRefreshService.enqueue(input);
    return {
      accepted: true,
      taskId: task.taskId,
      status: task.status,
      createdAt: task.createdAt,
    };
  },
  enqueueSqliteProjectionAfterMutation:
    workReportMutationProjectionService.enqueueEntryAfterMutation.bind(
      workReportMutationProjectionService
    ),
  applyQueuedSqliteProjectionAfterMutation:
    workReportMutationProjectionService.applyQueuedProjectionAfterMutation.bind(
      workReportMutationProjectionService
    ),
  applyQueuedSortOrderSqliteAfterMutation:
    workReportMutationProjectionService.applyQueuedSortOrderAfterMutation.bind(
      workReportMutationProjectionService
    ),
});

export default workReportRouter;

import { isSqliteReadModelVersionCurrent } from "../work-report/readModelState";
import { workReportDebugLog } from "../../observability/workReportDebugLog";
import type { WorkReportRecord } from "../../types/workReport";
import { HttpError } from "../../utils/httpError";

export type ProjectionReason = "create" | "update" | "delete";
export type ProjectionApplyResult = "applied" | "deleted" | "skipped";
export type SortOrderProjectionResult =
  | "applied"
  | "deferred"
  | "failed"
  | "not-required";

export interface MutationProjectionSyncState {
  status: string;
  snapshotAt: string | null;
  readModelVersion?: number | null;
}

interface WorkReportMutationProjectionServiceDeps {
  shouldProject(formId: string): boolean;
  getSyncState(formId: string): Promise<MutationProjectionSyncState | null>;
  enqueueProjectionEvent(
    formId: string,
    entryId: string,
    reason: ProjectionReason
  ): Promise<number>;
  refreshEntry(formId: string, entryId: string): Promise<WorkReportRecord>;
  patchSortOrderSnapshot(
    formId: string,
    entryId: string,
    sortOrder: number,
    snapshotAt: string
  ): Promise<{ rowCount: number }>;
  upsertEntrySnapshot(
    formId: string,
    record: WorkReportRecord,
    snapshotAt: string
  ): Promise<{ rowCount: number }>;
  deleteEntrySnapshot(formId: string, entryId: string): Promise<void>;
  markProjectionEventProcessed(
    formId: string,
    seq: number,
    processedAt: string
  ): Promise<void>;
  cleanupProcessedProjectionEvents(formId: string, upToSeq: number): Promise<void>;
  touchSyncStateSnapshot(
    formId: string,
    snapshotAt: string,
    message: string | null
  ): Promise<void>;
  markRecentlyProjectedEntry?(
    formId: string,
    entryId: string,
    reason: ProjectionReason,
    snapshotAt: string
  ): void;
}

export class WorkReportMutationProjectionService {
  constructor(private readonly deps: WorkReportMutationProjectionServiceDeps) {}

  async enqueueEntryAfterMutation(
    formId: string,
    entryId: string,
    reason: ProjectionReason
  ): Promise<number> {
    if (!this.deps.shouldProject(formId)) {
      return 0;
    }

    const enqueuedSeq = await this.deps.enqueueProjectionEvent(formId, entryId, reason);
    if (enqueuedSeq > 0) {
      workReportDebugLog("projection", "enqueued", {
        formId,
        entryId,
        reason,
        seq: enqueuedSeq,
      });
    }
    return enqueuedSeq;
  }

  async projectEntryAfterMutation(
    formId: string,
    entryId: string,
    reason: ProjectionReason
  ): Promise<void> {
    const enqueuedSeq = await this.enqueueEntryAfterMutation(formId, entryId, reason);
    if (enqueuedSeq <= 0) {
      return;
    }
    await this.applyQueuedProjectionAfterMutation(formId, entryId, reason, enqueuedSeq);
  }

  async projectSortOrderAfterMutation(
    formId: string,
    entryId: string,
    sortOrder: number
  ): Promise<SortOrderProjectionResult> {
    const enqueuedSeq = await this.enqueueEntryAfterMutation(formId, entryId, "update");
    if (enqueuedSeq <= 0) {
      return "not-required";
    }
    return this.applyQueuedSortOrderAfterMutation(
      formId,
      entryId,
      sortOrder,
      enqueuedSeq
    );
  }

  async applyQueuedSortOrderAfterMutation(
    formId: string,
    entryId: string,
    sortOrder: number,
    enqueuedSeq: number
  ): Promise<SortOrderProjectionResult> {
    if (!this.deps.shouldProject(formId) || enqueuedSeq <= 0) {
      return "not-required";
    }
    const syncState = await this.deps.getSyncState(formId);
    if (syncState?.status === "running") {
      workReportDebugLog("projection", "sort-order-skipped-during-sync", {
        formId,
        entryId,
        reason: "update",
        seq: enqueuedSeq,
      });
      return "deferred";
    }
    if (!syncState?.snapshotAt || !isSqliteReadModelVersionCurrent(syncState)) {
      workReportDebugLog("projection", "sort-order-skipped-no-readable-snapshot", {
        formId,
        entryId,
        reason: "update",
        seq: enqueuedSeq,
      });
      return "deferred";
    }
    const snapshotAt = new Date().toISOString();
    const result = await this.deps.patchSortOrderSnapshot(
      formId,
      entryId,
      sortOrder,
      snapshotAt
    );
    if (result.rowCount <= 0) {
      workReportDebugLog("projection", "sort-order-skipped-entry-not-cached", {
        formId,
        entryId,
        reason: "update",
        seq: enqueuedSeq,
      });
      return "deferred";
    }
    await this.deps.markProjectionEventProcessed(formId, enqueuedSeq, snapshotAt);
    await this.deps.cleanupProcessedProjectionEvents(formId, enqueuedSeq);
    await this.deps.touchSyncStateSnapshot(
      formId,
      snapshotAt,
      `entry-projection:update:${entryId}`
    );
    this.deps.markRecentlyProjectedEntry?.(formId, entryId, "update", snapshotAt);
    workReportDebugLog("projection", "sort-order-applied", {
      formId,
      entryId,
      reason: "update",
      sortOrder,
      snapshotAt,
    });
    return "applied";
  }

  async applyQueuedProjectionAfterMutation(
    formId: string,
    entryId: string,
    reason: ProjectionReason,
    enqueuedSeq: number
  ): Promise<ProjectionApplyResult> {
    const syncState = await this.deps.getSyncState(formId);
    if (syncState?.status === "running") {
      workReportDebugLog("projection", "skipped-during-sync", {
        formId,
        entryId,
        reason,
        seq: enqueuedSeq,
      });
      return "skipped";
    }
    if (!syncState?.snapshotAt || !isSqliteReadModelVersionCurrent(syncState)) {
      workReportDebugLog("projection", "skipped-no-readable-snapshot", {
        formId,
        entryId,
        reason,
        seq: enqueuedSeq,
      });
      return "skipped";
    }

    try {
      const record = await this.deps.refreshEntry(formId, entryId);
      const snapshotAt = new Date().toISOString();
      const result = await this.deps.upsertEntrySnapshot(formId, record, snapshotAt);
      await this.deps.markProjectionEventProcessed(formId, enqueuedSeq, snapshotAt);
      await this.deps.cleanupProcessedProjectionEvents(formId, enqueuedSeq);
      await this.deps.touchSyncStateSnapshot(
        formId,
        snapshotAt,
        `entry-projection:${reason}:${entryId}`
      );
      this.deps.markRecentlyProjectedEntry?.(formId, entryId, reason, snapshotAt);

      workReportDebugLog("projection", "applied", {
        formId,
        entryId,
        reason,
        rowCount: result.rowCount,
        snapshotAt,
      });
      return "applied";
    } catch (error) {
      if (error instanceof HttpError && error.code === "REPORT_NOT_FOUND") {
        const snapshotAt = new Date().toISOString();
        await this.deps.deleteEntrySnapshot(formId, entryId);
        await this.deps.markProjectionEventProcessed(formId, enqueuedSeq, snapshotAt);
        await this.deps.cleanupProcessedProjectionEvents(formId, enqueuedSeq);
        await this.deps.touchSyncStateSnapshot(
          formId,
          snapshotAt,
          `entry-projection:${reason}:${entryId}:deleted`
        );
        this.deps.markRecentlyProjectedEntry?.(formId, entryId, reason, snapshotAt);
        workReportDebugLog(
          "projection",
          "deleted-report-not-found",
          {
            formId,
            entryId,
            reason,
            code: error.code,
            message: error.message,
          },
          "warn"
        );
        return "deleted";
      }

      throw error;
    }
  }
}

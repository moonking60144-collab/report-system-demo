import type { parseAnalysisQuery, parseReportsQuery, RagicCallbackEventType } from "./workReportRequest";
import type {
  WorkReportQueueTaskRecord,
  WorkReportQueueTaskOperationKind,
  WorkReportQueueTaskStatus,
  WorkReportQueueTaskType,
} from "../services/work-report/workReportTaskRegistryService";
import type { RagicReadPriority } from "../infra/ragicRequestScheduler";
import type {
  ProjectionApplyResult,
  ProjectionReason,
  SortOrderProjectionResult,
} from "../services/work-report-sync/workReportMutationProjectionServiceFactory";
import type { RagicRecord } from "../ragic/client";
import type { MutationLifecycleState } from "../types/mutationLifecycle";
import type {
  WorkReportCommandEntryObservation,
  WorkReportCommandTimingResult
} from "../services/work-report/mutation/workReportWorkOrderCommandService";
import type { WorkReportMutationTimings } from "../types/workReportMutationTiming";
import type { WorkReportConfirmedEntryFieldObservation } from "../types/workReportConfirmedEntry";
import type { CreateReportTaskWorkerContext } from "../services/createReportTaskService";
import type {
  ReportAnalysisQueryResult,
  ReportEntryQueryResult,
  ReportFacetQueryResult,
  ReportFullQueryResult,
  ReportQueryResult,
} from "../types/workReport";

interface SyncTaskResponse {
  taskId?: string;
  status?: string;
  createdAt?: string;
  lifecycleState?: MutationLifecycleState;
  acceptedAt?: string | null;
  confirmedAt?: string | null;
  result?: {
    rowId?: string;
  };
}

interface AcceptedMutationTaskResponse extends SyncTaskResponse {
  taskId: string;
  status: WorkReportQueueTaskStatus;
  createdAt: string;
}

interface CreateTaskLookupResult {
  formId: string;
  taskId?: string;
  status?: string;
  createdAt?: string;
  lifecycleState?: MutationLifecycleState;
  acceptedAt?: string | null;
  confirmedAt?: string | null;
  slotAcquiredAt?: string | null;
  writeStartedAt?: string | null;
  timings?: WorkReportMutationTimings;
  writeIndeterminate?: boolean | null;
  result?: {
    rowId?: string;
    confirmedEntry?: WorkReportConfirmedEntryFieldObservation;
  };
}

export interface WorkReportRouterDeps {
  runEntryMutationExclusive<T>(
    formId: string,
    entryId: string,
    worker: () => Promise<T>,
    options?: { signal?: AbortSignal }
  ): Promise<T>;
  requestSync(formId: string, options: {
    triggeredBy: string;
    waitForCompletion: boolean;
    queueIfRunning?: boolean;
    actorClientId?: string;
    actorTabId?: string;
    actorIp?: string;
    actorLabel?: string;
  }): Promise<{
    accepted: boolean;
  } & SyncTaskResponse>;
  listTasks(options: {
    formId: string;
    entryId?: string;
    status?: WorkReportQueueTaskStatus;
    taskType?: WorkReportQueueTaskType;
    taskTypes?: WorkReportQueueTaskType[];
    actorClientId?: string;
    limit?: number;
  }): WorkReportQueueTaskRecord[];
  getBlockingScheduleMutationSummary(formId: string): {
    hasBlockingScheduleMutation: boolean;
    count: number;
  };
  getUnresolvedScheduleMutationTaskIds(formId: string, entryId: string): string[];
  acknowledgeScheduleMutationObservation(formId: string, entryId: string, taskIds: readonly string[]): number;
  getTaskRecord(taskId: string): WorkReportQueueTaskRecord | null;
  getSyncStatus(formId: string): Promise<unknown>;
  getReports(
    formId: string,
    query: ReturnType<typeof parseReportsQuery>
  ): Promise<ReportQueryResult>;
  getFullReports(formId: string, options: { refresh: boolean }): Promise<ReportFullQueryResult>;
  getReportFacets(
    formId: string,
    fields: string[],
    query: ReturnType<typeof parseReportsQuery>
  ): Promise<ReportFacetQueryResult>;
  getReportAnalysis(
    formId: string,
    query: ReturnType<typeof parseReportsQuery> & ReturnType<typeof parseAnalysisQuery>
  ): Promise<ReportAnalysisQueryResult>;
  getFormOptions(formId: string, fields?: string[]): Promise<Record<string, unknown>>;
  getRawPreview(formId: string, limit: number): Promise<unknown[]>;
  getReportByEntryId(
    formId: string,
    entryId: string,
    options: {
      refresh: boolean;
      allowSqliteFallbackOnRefresh?: boolean;
      ragicReadMaxRetries?: number;
      persistRefreshToSqlite?: boolean;
    }
  ): Promise<ReportEntryQueryResult>;
  createReport(
    formId: string,
    entryId: string,
    payload: Record<string, unknown>,
    options?: {
      expectedEntryLastUpdatedAt?: string;
      editSessionId?: string;
      editLockVersion?: number;
      onTiming?: (timing: WorkReportCommandTimingResult) => void;
      clientMutationId?: string;
      createIdempotencyKey?: string;
      clientMutationFingerprint?: string;
      skipEntryPreflight?: boolean;
      loadPreconditionEntrySnapshot?: () => Promise<RagicRecord>;
    }
  ): Promise<{ rowId: string }>;
  assertCreateEntryAcceptsReports(formId: string, entryId: string): Promise<RagicRecord>;
  enqueueCreateTask(input: {
    taskType: "create-report" | "update-report";
    formId: string;
    entryId: string;
    workOrderNo?: string;
    queueKey: string;
    clientMutationId?: string;
    operationFingerprint: string;
    operationKind?: WorkReportQueueTaskOperationKind;
    actorClientId?: string;
    actorTabId?: string;
    actorIp?: string;
    actorLabel?: string;
    worker: (context?: CreateReportTaskWorkerContext) => Promise<unknown>;
  }): AcceptedMutationTaskResponse;
  sleep?(ms: number): Promise<void>;
  getCreateTask(taskId: string): CreateTaskLookupResult | null;
  requestBatchDelete(input: {
    taskType?: Extract<WorkReportQueueTaskType, "delete-report" | "delete-report-batch">;
    formId: string;
    entryId: string;
    workOrderNo?: string;
    rowIds: string[];
    expectedRowSnapshotHashes?: Record<string, string>;
    expectedEntryLastUpdatedAt?: string;
    editSessionId?: string;
    editLockVersion?: number;
    actorClientId?: string;
    actorTabId?: string;
    actorIp?: string;
    actorLabel?: string;
    /** 每列真的 Ragic 刪掉後觸發；用來寫 audit 等 side effect */
    onRowDeleted?: (
      rowId: string,
      taskId: string,
      beforeSnapshot: unknown | null
    ) => void | Promise<void>;
  }): Promise<AcceptedMutationTaskResponse & {
    requestedCount?: number;
  }>;
  requestBatchCreate(input: {
    formId: string;
    entryId: string;
    workOrderNo?: string;
    rows: Array<{ payload: Record<string, unknown>; clientRowKey?: string }>;
    expectedEntryLastUpdatedAt?: string;
    editSessionId?: string;
    editLockVersion?: number;
    actorClientId?: string;
    actorTabId?: string;
    actorIp?: string;
    actorLabel?: string;
  }): Promise<AcceptedMutationTaskResponse & {
    requestedCount?: number;
  }>;
  requestBatchCreateFinalizeRetry(input: {
    formId: string;
    entryId: string;
    taskId: string;
    actorClientId?: string;
    actorTabId?: string;
    actorIp?: string;
    actorLabel?: string;
  }): Promise<AcceptedMutationTaskResponse & {
    requestedCount?: number;
  }>;
  updateReport(
    formId: string,
    entryId: string,
    rowId: string,
    payload: Record<string, unknown>,
    options?: {
      expectedEntryLastUpdatedAt?: string;
      expectedRowSnapshotHash?: string;
      editSessionId?: string;
      editLockVersion?: number;
    }
  ): Promise<{ rowId: string; beforeSnapshot: Record<string, unknown> }>;
  updateMainMachine(
    formId: string,
    entryId: string,
    machineCode: string,
    options?: {
      expectedMachineCode?: string | null;
      expectedEntryLastUpdatedAt?: string;
      editSessionId?: string;
      editLockVersion?: number;
      onTiming?: (timing: WorkReportCommandTimingResult) => void;
      onConfirmedEntry?: (observation: WorkReportCommandEntryObservation) => void;
    }
  ): Promise<{
    machineCode: string;
    previousMachineCode: string | null;
    changed: boolean;
  }>;
  updateSortOrder(
    formId: string,
    entryId: string,
    sortOrder: number,
    options?: {
      expectedSortOrder?: number | null;
      expectedEntryLastUpdatedAt?: string;
      editSessionId?: string;
      editLockVersion?: number;
      onTiming?: (timing: WorkReportCommandTimingResult) => void;
      onConfirmedEntry?: (observation: WorkReportCommandEntryObservation) => void;
    }
  ): Promise<{
    sortOrder: number;
    previousSortOrder: number | null;
    changed: boolean;
  }>;
  updatePlannedEndDate(
    formId: string,
    entryId: string,
    plannedEndDate: string,
    options?: {
      expectedPlannedEndDate?: string | null;
      expectedEntryLastUpdatedAt?: string;
      editSessionId?: string;
      editLockVersion?: number;
      onTiming?: (timing: WorkReportCommandTimingResult) => void;
      onConfirmedEntry?: (observation: WorkReportCommandEntryObservation) => void;
    }
  ): Promise<{
    plannedEndDate: string;
    previousPlannedEndDate: string | null;
    changed: boolean;
  }>;
  updateUrgent(
    formId: string,
    entryId: string,
    urgent: boolean,
    options?: {
      expectedUrgent?: boolean;
      expectedEntryLastUpdatedAt?: string;
      editSessionId?: string;
      editLockVersion?: number;
      onTiming?: (timing: WorkReportCommandTimingResult) => void;
      onConfirmedEntry?: (observation: WorkReportCommandEntryObservation) => void;
    }
  ): Promise<{
    urgent: boolean;
    previousUrgent: boolean;
    changed: boolean;
  }>;
  updateStartSchedule(
    formId: string,
    entryId: string,
    startSchedule: boolean,
    options?: {
      expectedStartSchedule?: boolean;
      expectedEntryLastUpdatedAt?: string;
      editSessionId?: string;
      editLockVersion?: number;
      onTiming?: (timing: WorkReportCommandTimingResult) => void;
      onConfirmedEntry?: (observation: WorkReportCommandEntryObservation) => void;
    }
  ): Promise<{
    startSchedule: boolean;
    previousStartSchedule: boolean;
    changed: boolean;
  }>;
  manualCloseWorkOrder(
    formId: string,
    entryId: string,
    action: "close" | "reopen",
    options?: {
      expectedEntryLastUpdatedAt?: string;
      editSessionId?: string;
      editLockVersion?: number;
      onTiming?: (timing: WorkReportCommandTimingResult) => void;
    }
  ): Promise<{ action: "close" | "reopen"; previousStatus: string | null }>;
  deleteReport(
    formId: string,
    entryId: string,
    rowId: string,
    options?: {
      expectedEntryLastUpdatedAt?: string;
      editSessionId?: string;
      editLockVersion?: number;
    }
  ): Promise<{ rowId: string; beforeSnapshot: Record<string, unknown> }>;
  assertEntryNotModified(
    formId: string,
    entryId: string,
    expectedEntryLastUpdatedAt?: string,
    options?: {
      priority?: RagicReadPriority;
      timeoutMs?: number;
      maxRetries?: number;
      expectedEntrySnapshotHash?: string;
    }
  ): Promise<void>;
  assertEntryEditableBySession(input: {
    formId: string;
    entryId: string;
    rowId?: string;
    editSessionId?: string;
  }): Promise<void>;
  assertEntryLockVersion(input: {
    formId: string;
    entryId: string;
    rowId?: string;
    editSessionId?: string;
    editLockVersion?: number;
  }): Promise<void>;
  upsertEditingPresence(input: {
    formId: string;
    entryId: string;
    rowId?: string;
    sessionId: string;
    active: boolean;
    state?: string;
  }): Promise<{
    hasOtherEditors: boolean;
    otherEditorCount: number;
    observedAt: string;
    canEdit: boolean;
    isCurrentSessionOwner: boolean;
    lockAcquiredAt?: string;
    idleMs?: number;
    lockVersion?: number;
  }>;
  getEditingPresenceSnapshot(input: {
    formId: string;
    entryId: string;
    rowId?: string;
    sessionId?: string;
  }): Promise<{
    hasOtherEditors: boolean;
    otherEditorCount: number;
    observedAt: string;
    canEdit: boolean;
    isCurrentSessionOwner: boolean;
    lockAcquiredAt?: string;
    idleMs?: number;
    lockVersion?: number;
  }>;
  enqueueSqliteProjectionAfterMutation(
    formId: string,
    entryId: string,
    reason: ProjectionReason
  ): Promise<number>;
  applyQueuedSqliteProjectionAfterMutation(
    formId: string,
    entryId: string,
    reason: ProjectionReason,
    enqueuedSeq: number,
    observedEntry?: RagicRecord
  ): Promise<ProjectionApplyResult>;
  applyQueuedSortOrderSqliteAfterMutation(
    formId: string,
    entryId: string,
    sortOrder: number,
    enqueuedSeq: number
  ): Promise<SortOrderProjectionResult>;
  requestRagicCallbackRefresh(input: {
    formId: string;
    entryId: string;
    eventType: RagicCallbackEventType;
    rowId?: string;
    source?: string;
    actorIp?: string;
    actorLabel?: string;
  }): Promise<{
    accepted: boolean;
    taskId: string;
    status: string;
    createdAt: string;
  }>;
}

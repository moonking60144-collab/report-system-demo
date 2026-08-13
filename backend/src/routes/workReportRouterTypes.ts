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
  getTaskRecord(taskId: string): WorkReportQueueTaskRecord | null;
  getSyncStatus(formId: string): Promise<unknown>;
  getReports(
    formId: string,
    query: ReturnType<typeof parseReportsQuery>
  ): Promise<{ data: unknown[]; count: number; totalCount: number; hasMore: boolean }>;
  getFullReports(formId: string, options: { refresh: boolean }): Promise<{ data: unknown[]; meta: unknown }>;
  getReportFacets(
    formId: string,
    fields: string[],
    query: ReturnType<typeof parseReportsQuery>
  ): Promise<Record<string, unknown>>;
  getReportAnalysis(
    formId: string,
    query: ReturnType<typeof parseReportsQuery> & ReturnType<typeof parseAnalysisQuery>
  ): Promise<unknown>;
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
  ): Promise<unknown>;
  createReport(
    formId: string,
    entryId: string,
    payload: Record<string, unknown>,
    options?: {
      expectedEntryLastUpdatedAt?: string;
      editSessionId?: string;
      editLockVersion?: number;
      clientMutationId?: string;
      createIdempotencyKey?: string;
      clientMutationFingerprint?: string;
      skipEntryPreflight?: boolean;
      loadPreconditionEntrySnapshot?: () => Promise<RagicRecord>;
    }
  ): Promise<unknown>;
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
    worker: () => Promise<unknown>;
  }): AcceptedMutationTaskResponse;
  sleep?(ms: number): Promise<void>;
  getCreateTask(taskId: string): CreateTaskLookupResult | null;
  requestBatchDelete(input: {
    taskType?: Extract<WorkReportQueueTaskType, "delete-report" | "delete-report-batch">;
    formId: string;
    entryId: string;
    workOrderNo?: string;
    rowIds: string[];
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
      editSessionId?: string;
      editLockVersion?: number;
    }
  ): Promise<unknown>;
  updateMainMachine(
    formId: string,
    entryId: string,
    machineCode: string,
    options?: {
      expectedEntryLastUpdatedAt?: string;
      editSessionId?: string;
      editLockVersion?: number;
    }
  ): Promise<{ machineCode: string }>;
  updateSortOrder(
    formId: string,
    entryId: string,
    sortOrder: number,
    options?: {
      expectedEntryLastUpdatedAt?: string;
      editSessionId?: string;
      editLockVersion?: number;
    }
  ): Promise<{
    sortOrder: number;
    previousSortOrder: number | null;
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
    }
  ): Promise<{ action: "close" | "reopen" }>;
  deleteReport(
    formId: string,
    entryId: string,
    rowId: string,
    options?: {
      expectedEntryLastUpdatedAt?: string;
      editSessionId?: string;
      editLockVersion?: number;
    }
  ): Promise<unknown>;
  assertEntryNotModified(
    formId: string,
    entryId: string,
    expectedEntryLastUpdatedAt?: string,
    options?: {
      priority?: RagicReadPriority;
      timeoutMs?: number;
      maxRetries?: number;
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
    enqueuedSeq: number
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

import { getOrCreateClientId, getOrCreateTabId } from "../features/work-report/debug/clientIdentity";
import { createApiClient } from "./apiClient";

const api = createApiClient();

function buildTaskActorHeaders(): Record<string, string> {
  return {
    "x-debug-client-id": getOrCreateClientId(),
    "x-debug-tab-id": getOrCreateTabId(),
  };
}

function buildTaskActorHeadersWithContext(options?: {
  workOrderNo?: string | null;
}): Record<string, string> {
  return {
    ...buildTaskActorHeaders(),
    ...(String(options?.workOrderNo ?? "").trim()
      ? {
          "x-debug-work-order-no": String(options?.workOrderNo).trim(),
        }
      : {}),
  };
}

export interface WorkReportItem {
  [key: string]: unknown;
  rowId: string;
  date: string | null;
  reportType?: string | null;
  plannedIdle: string | null;
  processCode: string | null;
  processCodeDisplay: string | null;
  machineId: string | null;
  machineIdDisplay: string | null;
  operatorId: string | null;
  operatorIdDisplay: string | null;
  operatorName: string | null;
  inputOptions: string | null;
  shiftType: string | null;
  startTime: string | null;
  endTime: string | null;
  breakTime: string | null;
  totalWorkTime: number | string | null;
  productionQty: number | string | null;
  cumulativeQty?: number | string | null;
  remark?: string | null;
  setupAdjustType?: string | null;
  setupAdjustMinutes?: number | string | null;
  countSetupTimeFlag?: string | null;
  setupTimeStandardHours?: number | string | null;
  setupLossQtyPerPcs?: number | string | null;
  processLossQtyPerPcs?: number | string | null;
  totalContainerQty?: number | string | null;
  containerUnit?: string | null;
  plannedIdleMinutes?: number | string | null;
  unplannedIdleMinutes?: number | string | null;
  absentOrTrainingMinutes?: number | string | null;
  noMaterialMinutes?: number | string | null;
  waitingQcApprovalMinutes?: number | string | null;
  meetingMinutes?: number | string | null;
  cleaningMinutes?: number | string | null;
  rdSamplingMinutes?: number | string | null;
  supportOtherMachinesMinutes?: number | string | null;
  machineBreakdownMinutes?: number | string | null;
  machineAdjustmentMinutes?: number | string | null;
  othersMinutes?: number | string | null;
  waitingForDiesMinutes?: number | string | null;
  testingDiesMinutes?: number | string | null;
}

export interface WorkReportRecord {
  id: string;
  machineCode?: string | null;
  filterMachineCode?: string | null;
  modificationStatus?: string | null;
  workOrderNo: string | null;
  workOrderType?: string | null;
  processName?: string | null;
  defaultProcessCode?: string | null;
  prodType?: string | null;
  status: string | null;
  ragicUnfinishedStatus?: string | null;
  misCloseStatus?: string | null;
  targetQtyPc?: number | string | null;
  pendingQty?: number | string | null;
  producedQtyStat?: number | string | null;
  estimatedHours?: number | string | null;
  currentMaterial?: string | null;
  primaryMaterial?: string | null;
  defaultMainMaterial?: string | null;
  size?: string | null;
  prevStationRunning?: string | null;
  prevStationStatus?: string | null;
  siteRunning?: string | null;
  prevReportQtyPc?: number | string | null;
  prevReportQtyKg?: number | string | null;
  prevReportContainerQty?: number | string | null;
  prevCompletePc?: number | string | null;
  prevCompleteKg?: number | string | null;
  prevCompleteContainer?: number | string | null;
  plannedEndDate?: string | null;
  plannedStartDate?: string | null;
  prevPlanEndDate?: string | null;
  customerPartNo: string | null;
  erpPartNo: string | null;
  reports?: WorkReportItem[];
  reportsLoaded?: boolean;
  [key: string]: unknown;
}

export interface WorkReportResponse {
  data: WorkReportRecord[];
  meta: {
    formId: string;
    count: number;
    totalCount: number;
    hasMore: boolean;
    limit: number;
    offset: number;
    keyword: string;
    workOrderKeyword?: string;
    customerPartKeyword?: string;
    status?: string;
    ragicUnfinishedStatus?: string;
    machineCode?: string;
    siteRunning?: string;
    startSchedule?: string;
    updatedDateFrom?: string;
    updatedDateTo?: string;
    sort?: string;
    refresh?: boolean;
  };
}

export interface WorkReportFullResponse {
  data: WorkReportRecord[];
  meta: {
    formId: string;
    count: number;
    cacheSource: "file-cache" | "memory-cache" | "sqlite" | "ragic-live";
    cacheState: "fresh" | "stale" | "building";
    snapshotAt: string | null;
    expiresAt: string | null;
    refreshTriggered: boolean;
    truncated: boolean;
    truncatedCount?: number;
  };
}

export interface WorkReportFacetCount {
  token: string;
  count: number;
}

export interface WorkReportAnalysisSummary {
  totalCount: number;
  nonEmptyCount: number;
  blankCount: number;
  distinctCount: number;
  numberStats?: {
    sum: number;
    avg: number;
    min: number;
    max: number;
    count: number;
  };
  dateStats?: {
    earliest: string | null;
    latest: string | null;
    count: number;
  };
  booleanStats?: {
    yes: number;
    no: number;
    blank: number;
  };
  topValues?: Array<{ label: string; count: number }>;
}

interface BackendColumnFilterRule {
  type: "text" | "number" | "date" | "boolean";
  selectedTokens?: string[];
  textQuery?: string;
}

type BackendColumnFilterState = Partial<Record<string, BackendColumnFilterRule>>;

function serializeColumnFilters(
  columnFilters?: BackendColumnFilterState
): string | undefined {
  if (!columnFilters || Object.keys(columnFilters).length === 0) {
    return undefined;
  }
  return JSON.stringify(columnFilters);
}

export interface FormOptionItem {
  value: string;
  label: string;
  display: string;
  operatorGroupKey?: string;
  operatorGroupLabel?: string;
  processGroupKey?: string;
  processGroupLabel?: string;
  machineDefault?: {
    machineCode: string;
    processCategoryCode?: string;
    processCategoryName?: string;
    processCode?: string;
    mainOperatorId?: string;
    mainOperatorName?: string;
    machineSpec?: string;
    machineSpeed?: string;
    status?: string;
    sourceEntryId?: string;
  };
}

export type FormOptionMap = Record<string, FormOptionItem[]>;

export interface ReportMutationResult {
  rowId: string;
}

export interface MainMachineUpdateResult {
  machineCode: string;
}

export interface EditingPresenceSnapshot {
  hasOtherEditors: boolean;
  otherEditorCount: number;
  observedAt: string;
  canEdit: boolean;
  isCurrentSessionOwner: boolean;
  lockAcquiredAt?: string;
  idleMs?: number;
  lockVersion?: number;
}

export type WorkReportSyncTaskStatus = "pending" | "running" | "success" | "failed";

export interface WorkReportSyncTask {
  taskId: string;
  formId: string;
  status: WorkReportSyncTaskStatus;
  accepted: boolean;
  triggeredBy: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  scannedEntries: number;
  syncedEntries: number;
  syncedRows: number;
  snapshotAt?: string;
  message?: string;
  error?: {
    code?: string;
    message: string;
  };
}

export interface WorkReportSyncStateSnapshot {
  formId: string;
  status: "idle" | "running" | "success" | "failed";
  taskId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  snapshotAt: string | null;
  totalEntries: number;
  totalRows: number;
  message: string | null;
  updatedAt: string;
}

export type CreateReportTaskStatus = "pending" | "running" | "success" | "failed";

export interface CreateReportTaskAcceptedResult {
  taskId: string;
  status: CreateReportTaskStatus;
  createdAt: string;
  rowId?: string;
}

export interface CreateReportTaskResult {
  taskId: string;
  taskType?: "create-report" | "update-report";
  formId: string;
  entryId: string;
  queueKey: string;
  status: CreateReportTaskStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: ReportMutationResult;
  error?: {
    code?: string;
    message: string;
  };
}

export type WorkReportQueueTaskType =
  | "create-report"
  | "update-report"
  | "create-report-batch"
  | "delete-report-batch"
  | "sync"
  | "callback-refresh";

export type WorkReportQueueTaskStatus = "pending" | "running" | "success" | "failed";

export interface WorkReportQueueTask {
  taskId: string;
  taskType: WorkReportQueueTaskType;
  status: WorkReportQueueTaskStatus;
  formId: string;
  workOrderNo: string | null;
  entryId: string | null;
  rowId: string | null;
  queueKey: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  message: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  actorClientId: string | null;
  actorTabId: string | null;
  actorIp: string | null;
  actorLabel: string | null;
  /** 系統事件來源（e.g. ragic-callback-16、ragic-form-save）；跟 actorLabel 分流 */
  source: string | null;
  batchCreatedRowIds?: string[] | null;
  batchFinalizeFailed?: boolean | null;
  retriedFromTaskId?: string | null;
}

export interface ReportMutationPayload {
  date: string;
  plannedIdle?: string;
  reportType?: string;
  processCode?: string;
  inputOptions?: string;
  shiftType?: string;
  machineId: string;
  operatorId: string;
  operatorName?: string;
  startTime: string;
  endTime: string;
  breakTime?: string;
  productionQty?: number;
  remark?: string;
  setupAdjustType?: string;
  setupAdjustMinutes?: number;
  countSetupTimeFlag?: string;
  setupTimeStandardHours?: number;
  setupLossQtyPerPcs?: number;
  processLossQtyPerPcs?: number;
  totalContainerQty?: number;
  containerUnit?: string;
  plannedIdleMinutes?: number;
  unplannedIdleMinutes?: number;
  absentOrTrainingMinutes?: number;
  noMaterialMinutes?: number;
  waitingQcApprovalMinutes?: number;
  meetingMinutes?: number;
  cleaningMinutes?: number;
  rdSamplingMinutes?: number;
  supportOtherMachinesMinutes?: number;
  machineBreakdownMinutes?: number;
  machineAdjustmentMinutes?: number;
  othersMinutes?: number;
  waitingForDiesMinutes?: number;
  testingDiesMinutes?: number;
}

export async function fetchWorkReports(
  formId = "104",
  limit = 20,
  offset = 0,
  keyword = "",
  refresh = false,
  options: {
    keyword?: string;
    workOrderKeyword?: string;
    customerPartKeyword?: string;
    status?: string;
    ragicUnfinishedStatus?: string;
    machineCode?: string;
    filterMachineCode?: string;
    siteRunning?: "all" | "yes" | "no";
    startSchedule?: "all" | "yes" | "no";
    updatedDateFrom?: string;
    updatedDateTo?: string;
    sort?: string;
  } = {}
): Promise<WorkReportResponse> {
  const response = await api.get<WorkReportResponse>(`/forms/${formId}/reports`, {
    params: {
      limit,
      offset,
      keyword: options.keyword ?? keyword,
      ...(options.workOrderKeyword ? { workOrderKeyword: options.workOrderKeyword } : {}),
      ...(options.customerPartKeyword ? { customerPartKeyword: options.customerPartKeyword } : {}),
      ...(options.status ? { status: options.status } : {}),
      ...(options.ragicUnfinishedStatus
        ? { ragicUnfinishedStatus: options.ragicUnfinishedStatus }
        : {}),
      ...(options.machineCode ? { machineCode: options.machineCode } : {}),
      ...(options.filterMachineCode ? { filterMachineCode: options.filterMachineCode } : {}),
      ...(options.siteRunning && options.siteRunning !== "all"
        ? { siteRunning: options.siteRunning }
        : {}),
      ...(options.startSchedule && options.startSchedule !== "all"
        ? { startSchedule: options.startSchedule }
        : {}),
      ...(options.updatedDateFrom ? { updatedDateFrom: options.updatedDateFrom } : {}),
      ...(options.updatedDateTo ? { updatedDateTo: options.updatedDateTo } : {}),
      ...(options.sort ? { sort: options.sort } : {}),
      ...(refresh ? { refresh: 1 } : {}),
    },
  });
  return response.data;
}

export async function fetchWorkReportsFull(
  formId = "104",
  refresh = false
): Promise<WorkReportFullResponse> {
  const response = await api.get<WorkReportFullResponse>(`/forms/${formId}/reports/full`, {
    params: refresh ? { refresh: 1 } : undefined,
  });
  return response.data;
}

export async function fetchWorkReportFacets(
  formId = "104",
  fields: string[],
  options: {
    keyword?: string;
    workOrderKeyword?: string;
    customerPartKeyword?: string;
    status?: string;
    ragicUnfinishedStatus?: string;
    machineCode?: string;
    filterMachineCode?: string;
    siteRunning?: "all" | "yes" | "no";
    startSchedule?: "all" | "yes" | "no";
    updatedDateFrom?: string;
    updatedDateTo?: string;
    columnFilters?: BackendColumnFilterState;
    refresh?: boolean;
  } = {}
): Promise<Record<string, WorkReportFacetCount[]>> {
  const response = await api.get<{ data: Record<string, WorkReportFacetCount[]> }>(
    `/forms/${formId}/reports/facets`,
    {
      params: {
        fields: fields.join(","),
        ...(options.keyword ? { keyword: options.keyword } : {}),
        ...(options.workOrderKeyword ? { workOrderKeyword: options.workOrderKeyword } : {}),
        ...(options.customerPartKeyword ? { customerPartKeyword: options.customerPartKeyword } : {}),
        ...(options.status ? { status: options.status } : {}),
        ...(options.ragicUnfinishedStatus
          ? { ragicUnfinishedStatus: options.ragicUnfinishedStatus }
          : {}),
        ...(options.machineCode ? { machineCode: options.machineCode } : {}),
        ...(options.filterMachineCode ? { filterMachineCode: options.filterMachineCode } : {}),
        ...(options.siteRunning && options.siteRunning !== "all"
          ? { siteRunning: options.siteRunning }
          : {}),
        ...(options.startSchedule && options.startSchedule !== "all"
          ? { startSchedule: options.startSchedule }
          : {}),
        ...(options.updatedDateFrom ? { updatedDateFrom: options.updatedDateFrom } : {}),
        ...(options.updatedDateTo ? { updatedDateTo: options.updatedDateTo } : {}),
        ...(serializeColumnFilters(options.columnFilters)
          ? { columnFilters: serializeColumnFilters(options.columnFilters) }
          : {}),
        ...(options.refresh ? { refresh: 1 } : {}),
      },
    }
  );
  return response.data.data;
}

export async function fetchWorkReportAnalysis(
  formId: string,
  field: string,
  columnType: "text" | "number" | "date" | "boolean",
  options: {
    keyword?: string;
    workOrderKeyword?: string;
    customerPartKeyword?: string;
    status?: string;
    ragicUnfinishedStatus?: string;
    machineCode?: string;
    filterMachineCode?: string;
    siteRunning?: "all" | "yes" | "no";
    startSchedule?: "all" | "yes" | "no";
    updatedDateFrom?: string;
    updatedDateTo?: string;
    columnFilters?: BackendColumnFilterState;
    refresh?: boolean;
  } = {}
): Promise<WorkReportAnalysisSummary> {
  const response = await api.get<{ data: WorkReportAnalysisSummary }>(
    `/forms/${formId}/reports/analysis`,
    {
      params: {
        field,
        columnType,
        ...(options.keyword ? { keyword: options.keyword } : {}),
        ...(options.workOrderKeyword ? { workOrderKeyword: options.workOrderKeyword } : {}),
        ...(options.customerPartKeyword ? { customerPartKeyword: options.customerPartKeyword } : {}),
        ...(options.status ? { status: options.status } : {}),
        ...(options.ragicUnfinishedStatus
          ? { ragicUnfinishedStatus: options.ragicUnfinishedStatus }
          : {}),
        ...(options.machineCode ? { machineCode: options.machineCode } : {}),
        ...(options.filterMachineCode ? { filterMachineCode: options.filterMachineCode } : {}),
        ...(options.siteRunning && options.siteRunning !== "all"
          ? { siteRunning: options.siteRunning }
          : {}),
        ...(options.startSchedule && options.startSchedule !== "all"
          ? { startSchedule: options.startSchedule }
          : {}),
        ...(options.updatedDateFrom ? { updatedDateFrom: options.updatedDateFrom } : {}),
        ...(options.updatedDateTo ? { updatedDateTo: options.updatedDateTo } : {}),
        ...(serializeColumnFilters(options.columnFilters)
          ? { columnFilters: serializeColumnFilters(options.columnFilters) }
          : {}),
        ...(options.refresh ? { refresh: 1 } : {}),
      },
    }
  );
  return response.data.data;
}

export async function fetchWorkReportEntry(
  formId: string,
  entryId: string,
  refresh = false
): Promise<WorkReportRecord> {
  const response = await api.get<{ data: WorkReportRecord }>(`/forms/${formId}/reports/${entryId}`, {
    params: refresh ? { refresh: 1 } : undefined,
  });
  return response.data.data;
}

export async function fetchFormOptions(
  formId = "104",
  fields?: string[]
): Promise<FormOptionMap> {
  const response = await api.get<{ data: FormOptionMap }>(`/forms/${formId}/options`, {
    params: fields?.length ? { fields: fields.join(",") } : undefined,
  });
  return response.data.data;
}

export async function updateWorkOrderMainMachine(
  formId: string,
  entryId: string,
  machineCode: string,
  options: {
    expectedEntryLastUpdatedAt?: string;
    editSessionId?: string;
    editLockVersion?: number;
  } = {}
): Promise<MainMachineUpdateResult> {
  const response = await api.put<{ data: MainMachineUpdateResult }>(
    `/forms/${formId}/reports/${entryId}/main-machine`,
    { machineCode },
    {
      headers: options.expectedEntryLastUpdatedAt
        || options.editSessionId
        || options.editLockVersion !== undefined
        ? {
            ...(options.expectedEntryLastUpdatedAt
              ? {
                  "x-entry-last-updated-at": options.expectedEntryLastUpdatedAt,
                }
              : {}),
            ...(options.editSessionId
              ? {
                  "x-edit-session-id": options.editSessionId,
                }
              : {}),
            ...(options.editLockVersion
              ? {
                  "x-edit-lock-version": String(options.editLockVersion),
                }
              : {}),
          }
        : undefined,
    }
  );
  return response.data.data;
}

export async function closeWorkOrder(
  formId: string,
  entryId: string,
  options: {
    expectedEntryLastUpdatedAt?: string;
    editSessionId?: string;
    editLockVersion?: number;
  } = {}
): Promise<void> {
  await api.post(`/forms/${formId}/reports/${entryId}/close`, null, {
    headers:
      options.expectedEntryLastUpdatedAt || options.editSessionId || options.editLockVersion !== undefined
        ? {
            ...(options.expectedEntryLastUpdatedAt
              ? {
                  "x-entry-last-updated-at": options.expectedEntryLastUpdatedAt,
                }
              : {}),
            ...(options.editSessionId
              ? {
                  "x-edit-session-id": options.editSessionId,
                }
              : {}),
            ...(options.editLockVersion
              ? {
                  "x-edit-lock-version": String(options.editLockVersion),
                }
              : {}),
          }
        : undefined,
  });
}

export async function reopenWorkOrder(
  formId: string,
  entryId: string,
  options: {
    expectedEntryLastUpdatedAt?: string;
    editSessionId?: string;
    editLockVersion?: number;
  } = {}
): Promise<void> {
  await api.post(`/forms/${formId}/reports/${entryId}/reopen`, null, {
    headers:
      options.expectedEntryLastUpdatedAt || options.editSessionId || options.editLockVersion !== undefined
        ? {
            ...(options.expectedEntryLastUpdatedAt
              ? {
                  "x-entry-last-updated-at": options.expectedEntryLastUpdatedAt,
                }
              : {}),
            ...(options.editSessionId
              ? {
                  "x-edit-session-id": options.editSessionId,
                }
              : {}),
            ...(options.editLockVersion
              ? {
                  "x-edit-lock-version": String(options.editLockVersion),
                }
              : {}),
          }
        : undefined,
  });
}

export async function createReport(
  formId: string,
  entryId: string,
  payload: ReportMutationPayload
): Promise<ReportMutationResult> {
  const response = await api.post<{ data: ReportMutationResult }>(
    `/forms/${formId}/reports/${entryId}`,
    payload
  );
  return response.data.data;
}

export async function createReportAccepted(
  formId: string,
  entryId: string,
  payload: ReportMutationPayload,
  options: {
    clientMutationId?: string;
    workOrderNo?: string | null;
    expectedEntryLastUpdatedAt?: string;
    editSessionId?: string;
    editLockVersion?: number;
  } = {}
): Promise<CreateReportTaskAcceptedResult> {
  const response = await api.post<{ data: CreateReportTaskAcceptedResult }>(
    `/forms/${formId}/reports/${entryId}`,
    payload,
    {
      params: { async: 1 },
      headers: {
        ...buildTaskActorHeadersWithContext({
          workOrderNo: options.workOrderNo ?? null,
        }),
        ...(options.clientMutationId
          ? {
              "x-client-mutation-id": options.clientMutationId,
            }
          : {}),
        ...(options.expectedEntryLastUpdatedAt
          ? {
              "x-entry-last-updated-at": options.expectedEntryLastUpdatedAt,
            }
          : {}),
        ...(options.editSessionId
          ? {
              "x-edit-session-id": options.editSessionId,
            }
          : {}),
        ...(options.editLockVersion
          ? {
              "x-edit-lock-version": String(options.editLockVersion),
            }
          : {}),
      },
    }
  );
  return response.data.data;
}

export async function fetchCreateReportTask(
  formId: string,
  taskId: string
): Promise<CreateReportTaskResult> {
  const response = await api.get<{ data: CreateReportTaskResult }>(
    `/forms/${formId}/reports/tasks/${taskId}`
  );
  return response.data.data;
}

export async function updateReport(
  formId: string,
  entryId: string,
  rowId: string,
  payload: ReportMutationPayload
): Promise<void> {
  await api.put(`/forms/${formId}/reports/${entryId}/${rowId}`, payload);
}

export async function updateReportAccepted(
  formId: string,
  entryId: string,
  rowId: string,
  payload: ReportMutationPayload,
  options: {
    clientMutationId?: string;
    workOrderNo?: string | null;
    expectedEntryLastUpdatedAt?: string;
    editSessionId?: string;
    editLockVersion?: number;
  } = {}
): Promise<CreateReportTaskAcceptedResult> {
  const response = await api.put<{ data: CreateReportTaskAcceptedResult }>(
    `/forms/${formId}/reports/${entryId}/${rowId}`,
    payload,
    {
      params: { async: 1 },
      headers: {
        ...buildTaskActorHeadersWithContext({
          workOrderNo: options.workOrderNo ?? null,
        }),
        ...(options.clientMutationId
          ? {
              "x-client-mutation-id": options.clientMutationId,
            }
          : {}),
        ...(options.expectedEntryLastUpdatedAt
          ? {
              "x-entry-last-updated-at": options.expectedEntryLastUpdatedAt,
            }
          : {}),
        ...(options.editSessionId
          ? {
              "x-edit-session-id": options.editSessionId,
            }
          : {}),
        ...(options.editLockVersion
          ? {
              "x-edit-lock-version": String(options.editLockVersion),
            }
          : {}),
      },
    }
  );
  return response.data.data;
}

export async function deleteReport(
  formId: string,
  entryId: string,
  rowId: string,
  options: {
    expectedEntryLastUpdatedAt?: string;
    editSessionId?: string;
    editLockVersion?: number;
  } = {}
): Promise<void> {
  await api.delete(`/forms/${formId}/reports/${entryId}/${rowId}`, {
    headers:
      options.expectedEntryLastUpdatedAt || options.editSessionId || options.editLockVersion !== undefined
        ? {
            ...(options.expectedEntryLastUpdatedAt
              ? {
                  "x-entry-last-updated-at": options.expectedEntryLastUpdatedAt,
                }
              : {}),
            ...(options.editSessionId
              ? {
                  "x-edit-session-id": options.editSessionId,
                }
              : {}),
            ...(options.editLockVersion
              ? {
                  "x-edit-lock-version": String(options.editLockVersion),
                }
              : {}),
          }
        : undefined,
  });
}

export interface BatchDeleteTaskAcceptedResult {
  taskId: string;
  status: WorkReportQueueTaskStatus;
  createdAt: string;
  requestedCount?: number;
}

export interface BatchCreateTaskAcceptedResult {
  taskId: string;
  status: WorkReportQueueTaskStatus;
  createdAt: string;
  requestedCount?: number;
}

export interface BatchCreateRowRequest {
  payload: ReportMutationPayload;
  /** 前端產生的 UUID，後端用於 idempotency 映射（可省略，向後相容） */
  clientRowKey?: string;
}

export async function createReportsBatchAccepted(
  formId: string,
  entryId: string,
  rows: BatchCreateRowRequest[],
  options: {
    editSessionId?: string;
    workOrderNo?: string | null;
  } = {}
): Promise<BatchCreateTaskAcceptedResult> {
  const body = {
    rows: rows.map((row) => ({
      payload: row.payload,
      ...(row.clientRowKey ? { clientRowKey: row.clientRowKey } : {}),
    })),
  };
  const response = await api.post<{ data: BatchCreateTaskAcceptedResult }>(
    `/forms/${formId}/reports/${entryId}/batch-create`,
    body,
    {
      headers: {
        ...buildTaskActorHeadersWithContext({
          workOrderNo: options.workOrderNo ?? null,
        }),
        ...(options.editSessionId
          ? {
              "x-edit-session-id": options.editSessionId,
            }
          : {}),
      },
    }
  );
  return response.data.data;
}

export async function retryBatchCreateFinalizeAccepted(
  formId: string,
  entryId: string,
  taskId: string,
  options: {
    workOrderNo?: string | null;
  } = {}
): Promise<BatchCreateTaskAcceptedResult> {
  const response = await api.post<{ data: BatchCreateTaskAcceptedResult }>(
    `/forms/${formId}/reports/${entryId}/batch-create/${taskId}/retry-finalize`,
    null,
    {
      headers: {
        ...buildTaskActorHeadersWithContext({
          workOrderNo: options.workOrderNo ?? null,
        }),
      },
    }
  );
  return response.data.data;
}

export async function deleteReportsBatchAccepted(
  formId: string,
  entryId: string,
  rowIds: string[],
  options: {
    editSessionId?: string;
    workOrderNo?: string | null;
  } = {}
): Promise<BatchDeleteTaskAcceptedResult> {
  const response = await api.post<{ data: BatchDeleteTaskAcceptedResult }>(
    `/forms/${formId}/reports/${entryId}/batch-delete`,
    { rowIds },
    {
      headers: {
        ...buildTaskActorHeadersWithContext({
          workOrderNo: options.workOrderNo ?? null,
        }),
        ...(options.editSessionId
          ? {
              "x-edit-session-id": options.editSessionId,
            }
          : {}),
      },
    }
  );
  return response.data.data;
}

export async function fetchEditingPresence(
  formId: string,
  entryId: string,
  sessionId: string,
  rowId?: string
): Promise<EditingPresenceSnapshot> {
  const response = await api.get<{ data: EditingPresenceSnapshot }>(
    `/forms/${formId}/reports/${entryId}/editing-presence`,
    {
      params: {
        sessionId,
        ...(rowId ? { rowId } : {}),
      },
    }
  );
  return response.data.data;
}

export async function updateEditingPresence(
  formId: string,
  entryId: string,
  payload: {
    sessionId: string;
    active: boolean;
    state?: string;
    rowId?: string;
  }
): Promise<EditingPresenceSnapshot> {
  const response = await api.put<{ data: EditingPresenceSnapshot }>(
    `/forms/${formId}/reports/${entryId}/editing-presence`,
    payload
  );
  return response.data.data;
}

export async function triggerWorkReportSync(
  formId: string,
  options: { async?: boolean; triggeredBy?: string } = {}
): Promise<WorkReportSyncTask> {
  const response = await api.post<{ data: WorkReportSyncTask }>(`/forms/${formId}/sync`, null, {
    params: options.async === false ? undefined : { async: 1 },
    headers: {
      ...buildTaskActorHeaders(),
      ...(options.triggeredBy
        ? {
            "x-sync-triggered-by": options.triggeredBy,
          }
        : {}),
    },
  });
  return response.data.data;
}

export async function fetchWorkReportQueueTasks(
  formId: string,
  options: {
    entryId?: string;
    status?: WorkReportQueueTaskStatus;
    taskType?: WorkReportQueueTaskType;
    taskTypes?: WorkReportQueueTaskType[];
    actorClientId?: string;
    limit?: number;
  } = {}
): Promise<WorkReportQueueTask[]> {
  const response = await api.get<{ data: WorkReportQueueTask[] }>(
    `/forms/${formId}/tasks`,
    {
      params: {
        ...(options.entryId ? { entryId: options.entryId } : {}),
        ...(options.status ? { status: options.status } : {}),
        ...(options.taskType ? { taskType: options.taskType } : {}),
        ...(options.taskTypes && options.taskTypes.length > 0
          ? { taskTypes: options.taskTypes.join(",") }
          : {}),
        ...(options.actorClientId ? { actorClientId: options.actorClientId } : {}),
        ...(typeof options.limit === "number" ? { limit: options.limit } : {}),
      },
    }
  );
  return response.data.data;
}

export async function fetchWorkReportQueueTask(
  formId: string,
  taskId: string
): Promise<WorkReportQueueTask> {
  const response = await api.get<{ data: WorkReportQueueTask }>(
    `/forms/${formId}/tasks/${taskId}`
  );
  return response.data.data;
}

export async function fetchWorkReportSyncStatus(
  formId: string
): Promise<WorkReportSyncTask | WorkReportSyncStateSnapshot | null> {
  const response = await api.get<{
    data: WorkReportSyncTask | WorkReportSyncStateSnapshot | null;
  }>(`/forms/${formId}/sync/status`);
  return response.data.data;
}

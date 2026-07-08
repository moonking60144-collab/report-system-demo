import { getOrCreateClientId, getOrCreateTabId } from "../utils/clientIdentity";
import { createApiClient } from "./apiClient";
import type {
  BackendColumnFilterState,
  BatchCreateRowRequest,
  BatchCreateTaskAcceptedResult,
  BatchDeleteTaskAcceptedResult,
  DeleteReportTaskAcceptedResult,
  CreateReportTaskAcceptedResult,
  CreateReportTaskResult,
  EditingPresenceSnapshot,
  FormOptionMap,
  MainMachineUpdateResult,
  ReportMutationPayload,
  ReportMutationResult,
  WorkReportAnalysisSummary,
  WorkReportFacetCount,
  WorkReportFullResponse,
  WorkReportQueueTask,
  WorkReportQueueTaskStatus,
  WorkReportQueueTaskType,
  WorkReportRecord,
  WorkReportResponse,
  WorkReportSyncStateSnapshot,
  WorkReportSyncTask,
} from "./workReportTypes";

export type {
  BackendColumnFilterRule,
  BackendColumnFilterState,
  BatchCreateRowRequest,
  BatchCreateTaskAcceptedResult,
  BatchDeleteTaskAcceptedResult,
  DeleteReportTaskAcceptedResult,
  CreateReportTaskAcceptedResult,
  CreateReportTaskResult,
  CreateReportTaskStatus,
  EditingPresenceSnapshot,
  FormOptionItem,
  FormOptionMap,
  MainMachineUpdateResult,
  ReportMutationPayload,
  ReportMutationResult,
  WorkReportAnalysisSummary,
  WorkReportFacetCount,
  WorkReportFullResponse,
  WorkReportItem,
  WorkReportQueueTask,
  WorkReportQueueTaskStatus,
  WorkReportQueueTaskType,
  WorkReportRecord,
  WorkReportResponse,
  WorkReportSyncStateSnapshot,
  WorkReportSyncTask,
  WorkReportSyncTaskStatus,
} from "./workReportTypes";

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

function serializeColumnFilters(
  columnFilters?: BackendColumnFilterState
): string | undefined {
  if (!columnFilters || Object.keys(columnFilters).length === 0) {
    return undefined;
  }
  return JSON.stringify(columnFilters);
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
    workOrderNo?: string | null;
  } = {}
): Promise<DeleteReportTaskAcceptedResult> {
  const response = await api.delete<{ data: DeleteReportTaskAcceptedResult }>(
    `/forms/${formId}/reports/${entryId}/${rowId}`,
    {
      headers: {
        ...buildTaskActorHeadersWithContext({
          workOrderNo: options.workOrderNo ?? null,
        }),
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

export async function createReportsBatchAccepted(
  formId: string,
  entryId: string,
  rows: BatchCreateRowRequest[],
  options: {
    expectedEntryLastUpdatedAt?: string;
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
        ...(options.expectedEntryLastUpdatedAt
          ? {
              "x-entry-last-updated-at": options.expectedEntryLastUpdatedAt,
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
    expectedEntryLastUpdatedAt?: string;
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
        ...(options.expectedEntryLastUpdatedAt
          ? {
              "x-entry-last-updated-at": options.expectedEntryLastUpdatedAt,
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

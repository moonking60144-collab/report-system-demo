import { createApiClient } from "./apiClient";
import type { FormOptionMap } from "./workReport";
import { getOrCreateClientId, getOrCreateTabId } from "../utils/clientIdentity";
import {
  parseContentDispositionFilename,
  type ApiDownload,
} from "./downloadResponse";
import type { MutationLifecycleTiming } from "./mutationLifecycleTypes";

const api = createApiClient();

function buildActorHeaders(): Record<string, string> {
  return {
    "x-debug-client-id": getOrCreateClientId(),
    "x-debug-tab-id": getOrCreateTabId(),
  };
}

export interface Form16DowntimeRecord {
  id: string;
  snapshotHash: string | null;
  date: string | null;
  machineId: string | null;
  processCode: string | null;
  operatorId: string | null;
  operatorName: string | null;
  reportType: string | null;
  startTime: string | null;
  endTime: string | null;
  breakTime: string | null;
  plannedIdleMinutes: number | null;
  remark: string | null;
  workOrderNo: string | null;
}

export interface CreateForm16DowntimePayload {
  date: string;
  machineId: string;
  processCode: string;
  operatorId?: string;
  plannedIdleMinutes?: number;
  remark?: string;
  /**
   * Idempotency key。同一次送出流程（含 retry）要重用同一個 UUID，
   * backend 會用它擋掉 retry 風暴造成的重複寫入。
   * queued create 必填；同一次送出流程（含 retry）重用同一個 key。
   */
  clientRowKey?: string;
}

export interface FetchForm16DowntimeRecordsOptions {
  limit?: number;
  offset?: number;
  refresh?: boolean;
}

export interface FetchForm16DowntimeRecordsResult {
  records: Form16DowntimeRecord[];
  meta: {
    count: number;
    totalCount: number;
    limit: number;
    offset: number;
    hasMore: boolean;
    source: string;
    refreshed: boolean;
    refreshTriggered: boolean;
  };
}

export async function fetchForm16DowntimeOptions(): Promise<FormOptionMap> {
  const response = await api.get<{ data: FormOptionMap }>("/downtime/options");
  return response.data.data;
}

export async function fetchForm16DowntimeRecords(
  options: FetchForm16DowntimeRecordsOptions = {}
): Promise<FetchForm16DowntimeRecordsResult> {
  const response = await api.get<{
    data: Form16DowntimeRecord[];
    meta: FetchForm16DowntimeRecordsResult["meta"];
  }>("/downtime/records", {
    params: {
      ...(typeof options.limit === "number" ? { limit: options.limit } : {}),
      ...(typeof options.offset === "number" ? { offset: options.offset } : {}),
      ...(options.refresh ? { refresh: 1 } : {}),
    },
  });
  return {
    records: response.data.data,
    meta: response.data.meta,
  };
}

// 匯出稼動表用的 c1/6 期間統計檔（後端 proxy 抓 Ragic 發佈網址原樣轉發）。
// 後端要去抓外部網址，可能等幾秒，timeout 放長。
export async function exportForm16DowntimeMonthlyCsv(): Promise<ApiDownload> {
  const response = await api.get<Blob>("/downtime/export/monthly-csv", {
    responseType: "blob",
    timeout: 180_000,
    headers: buildActorHeaders(),
  });
  return {
    blob: response.data,
    filename: parseContentDispositionFilename(response.headers["content-disposition"]),
  };
}

// 下載已灌好期間資料的樞紐分析表 xlsx（後端抓同一條發佈 CSV、注入空白範本後回傳）。
// attendanceDays 選填：當月應出勤天數，後端會灌進 3 張機台運轉分析表的 F 欄。
export async function exportForm16AnalysisXlsx(attendanceDays?: number): Promise<ApiDownload> {
  const response = await api.get<Blob>("/downtime/export/analysis-xlsx", {
    responseType: "blob",
    timeout: 180_000,
    params: {
      ...(typeof attendanceDays === "number" ? { attendanceDays } : {}),
    },
    headers: buildActorHeaders(),
  });
  return {
    blob: response.data,
    filename: parseContentDispositionFilename(response.headers["content-disposition"]),
  };
}

export interface EfficiencyReportArtifact {
  id: string;
  snapshotId: string;
  attendanceDays: number | null;
  xlsxSizeBytes: number;
  createdAt: string;
}

export interface EfficiencyReportSnapshot {
  id: string;
  periodMonth: string;
  version: number;
  status: "ready" | "finalized";
  sourceRowCount: number;
  sourceSizeBytes: number;
  createdAt: string;
  finalizedAt: string | null;
  artifacts: EfficiencyReportArtifact[];
}

export interface EfficiencyReportHistoryResult {
  records: EfficiencyReportSnapshot[];
  meta: {
    count: number;
    totalCount: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

export async function fetchEfficiencyReportHistory(
  limit = 20,
  offset = 0
): Promise<EfficiencyReportHistoryResult> {
  const response = await api.get<{
    data: EfficiencyReportSnapshot[];
    meta: EfficiencyReportHistoryResult["meta"];
  }>("/downtime/efficiency-reports", {
    params: { limit, offset },
  });
  return { records: response.data.data, meta: response.data.meta };
}

export async function downloadEfficiencyReportCsv(snapshotId: string): Promise<ApiDownload> {
  const response = await api.get<Blob>(
    `/downtime/efficiency-reports/${encodeURIComponent(snapshotId)}/csv`,
    { responseType: "blob", timeout: 180_000 }
  );
  return {
    blob: response.data,
    filename: parseContentDispositionFilename(response.headers["content-disposition"]),
  };
}

export async function downloadEfficiencyReportXlsx(
  snapshotId: string,
  artifactId: string
): Promise<ApiDownload> {
  const response = await api.get<Blob>(
    `/downtime/efficiency-reports/${encodeURIComponent(snapshotId)}/artifacts/${encodeURIComponent(artifactId)}/xlsx`,
    { responseType: "blob", timeout: 180_000 }
  );
  return {
    blob: response.data,
    filename: parseContentDispositionFilename(response.headers["content-disposition"]),
  };
}

export interface PlannedIdleMachineSummary {
  machineId: string;
  prodType: string;
  totalMinutes: number;
  totalDays: number;
  count: number;
}

export interface PlannedIdleSummary {
  month: string;
  machines: PlannedIdleMachineSummary[];
  source?: string;
  refreshed: boolean;
  refreshTriggered: boolean;
  snapshotAt: string | null;
}

// 每機台當月計畫停機彙總（後端撈當月、加總 (P)計畫停機分）。month 選填 YYYY/MM，不帶為當月。
export async function fetchPlannedIdleSummary(
  month?: string,
  refresh?: boolean
): Promise<PlannedIdleSummary> {
  const response = await api.get<{
    data: PlannedIdleMachineSummary[];
    meta: {
      month: string;
      machineCount: number;
      source?: string;
      refreshed?: boolean;
      refreshTriggered?: boolean;
      snapshotAt?: string | null;
    };
  }>("/downtime/planned-idle-summary", {
    params: {
      ...(month ? { month } : {}),
      ...(refresh ? { refresh: 1 } : {}),
    },
    timeout: 120_000,
  });
  return {
    month: response.data.meta.month,
    machines: response.data.data,
    source: response.data.meta.source,
    refreshed: response.data.meta.refreshed ?? false,
    refreshTriggered: response.data.meta.refreshTriggered ?? false,
    snapshotAt: response.data.meta.snapshotAt ?? null,
  };
}

export interface DowntimeTaskAccepted extends MutationLifecycleTiming {
  taskId: string;
  status: DowntimeTaskStatus;
  createdAt: string;
  entryId?: string;
}

/** @deprecated 保留別名避免 breaking change；新程式碼請用 DowntimeTaskAccepted */
export type CreateForm16DowntimeAccepted = DowntimeTaskAccepted;

export type DowntimeTaskStatus = "pending" | "running" | "success" | "failed";

export type DowntimeTaskType =
  | "create-downtime"
  | "update-downtime"
  | "delete-downtime";

export interface DowntimeQueueTask extends MutationLifecycleTiming {
  taskId: string;
  taskType: DowntimeTaskType;
  status: DowntimeTaskStatus;
  formId: "16";
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
  writeIndeterminate?: boolean | null;
  actorClientId: string | null;
  actorTabId: string | null;
  actorIp: string | null;
  actorLabel: string | null;
  source: string | null;
}

export async function createForm16DowntimeRecord(
  payload: CreateForm16DowntimePayload & { clientRowKey: string }
): Promise<DowntimeTaskAccepted> {
  const response = await api.post<{ data: DowntimeTaskAccepted }>("/downtime/records", payload, {
    headers: buildActorHeaders(),
  });
  return response.data.data;
}

export async function fetchDowntimeTasks(
  options: {
    status?: DowntimeTaskStatus;
    taskType?: DowntimeTaskType;
    actorClientId?: string;
    limit?: number;
  } = {}
): Promise<DowntimeQueueTask[]> {
  const response = await api.get<{ data: DowntimeQueueTask[] }>("/downtime/tasks", {
    params: {
      ...(options.status ? { status: options.status } : {}),
      ...(options.taskType ? { taskType: options.taskType } : {}),
      ...(options.actorClientId ? { actorClientId: options.actorClientId } : {}),
      ...(typeof options.limit === "number" ? { limit: options.limit } : {}),
    },
    headers: buildActorHeaders(),
  });
  return response.data.data;
}

export interface UpdateForm16DowntimePayload {
  date?: string;
  machineId?: string;
  processCode?: string;
  /** 傳空字串代表清空操作者 */
  operatorId?: string;
  plannedIdleMinutes?: number;
  remark?: string;
  expectedSnapshotHash?: string | null;
}

export async function updateForm16DowntimeRecord(
  entryId: string,
  payload: UpdateForm16DowntimePayload,
  options: { async?: boolean; clientMutationId?: string } = {}
): Promise<DowntimeTaskAccepted> {
  const response = await api.patch<{ data: DowntimeTaskAccepted }>(
    `/downtime/records/${entryId}`,
    payload,
    {
      params: options.async ? { async: 1 } : undefined,
      headers: {
        ...buildActorHeaders(),
        ...(options.clientMutationId
          ? { "x-client-mutation-id": options.clientMutationId }
          : {}),
      },
    }
  );
  return response.data.data;
}

export async function deleteForm16DowntimeRecord(
  entryId: string,
  options: {
    expectedSnapshotHash?: string | null;
    async?: boolean;
    clientMutationId?: string;
  } = {}
): Promise<DowntimeTaskAccepted> {
  const response = await api.delete<{ data: DowntimeTaskAccepted }>(
    `/downtime/records/${entryId}`,
    {
      params: options.async ? { async: 1 } : undefined,
      headers: {
        ...buildActorHeaders(),
        ...(options.clientMutationId
          ? { "x-client-mutation-id": options.clientMutationId }
          : {}),
        ...(options.expectedSnapshotHash
          ? { "x-downtime-snapshot-hash": options.expectedSnapshotHash }
          : {}),
      },
    }
  );
  return response.data.data;
}

export async function fetchDowntimeTask(taskId: string): Promise<DowntimeQueueTask> {
  const response = await api.get<{ data: DowntimeQueueTask }>(`/downtime/tasks/${taskId}`);
  return response.data.data;
}

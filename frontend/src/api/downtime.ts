import { createApiClient } from "./apiClient";
import type { FormOptionMap } from "./workReport";
import { getOrCreateClientId, getOrCreateTabId } from "../features/work-report/debug/clientIdentity";

const api = createApiClient();

function buildActorHeaders(): Record<string, string> {
  return {
    "x-debug-client-id": getOrCreateClientId(),
    "x-debug-tab-id": getOrCreateTabId(),
  };
}

export interface Form16DowntimeRecord {
  id: string;
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
   * 不帶也能跑，只是失去保護。
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

export interface DowntimeTaskAccepted {
  taskId: string;
  status: string;
}

/** @deprecated 保留別名避免 breaking change；新程式碼請用 DowntimeTaskAccepted */
export type CreateForm16DowntimeAccepted = DowntimeTaskAccepted;

export interface DowntimeTaskResult {
  taskId: string;
  taskType: string;
  status: "pending" | "running" | "success" | "failed";
  message: string | null;
  rowId: string | null;
}

export async function createForm16DowntimeRecord(
  payload: CreateForm16DowntimePayload
): Promise<DowntimeTaskAccepted> {
  const response = await api.post<{ data: DowntimeTaskAccepted }>("/downtime/records", payload, {
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
}

export async function updateForm16DowntimeRecord(
  entryId: string,
  payload: UpdateForm16DowntimePayload
): Promise<DowntimeTaskAccepted> {
  const response = await api.patch<{ data: DowntimeTaskAccepted }>(
    `/downtime/records/${entryId}`,
    payload,
    { headers: buildActorHeaders() }
  );
  return response.data.data;
}

export async function deleteForm16DowntimeRecord(
  entryId: string
): Promise<DowntimeTaskAccepted> {
  const response = await api.delete<{ data: DowntimeTaskAccepted }>(
    `/downtime/records/${entryId}`,
    { headers: buildActorHeaders() }
  );
  return response.data.data;
}

export async function fetchDowntimeTask(taskId: string): Promise<DowntimeTaskResult> {
  const response = await api.get<{ data: DowntimeTaskResult }>(`/downtime/tasks/${taskId}`);
  return response.data.data;
}

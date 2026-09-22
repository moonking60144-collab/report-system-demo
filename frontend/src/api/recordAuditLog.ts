import { createApiClient } from "./apiClient";
import { readSystemNoticeAdminToken } from "../utils/systemNoticeAdminSession";

const api = createApiClient();

export type RecordAuditScope = "work-report" | "downtime";
export type RecordAuditAction = "update" | "delete";

export interface RecordAuditLogActor {
  clientId: string | null;
  tabId: string | null;
  ip: string | null;
  label: string | null;
}

export interface RecordAuditLogApiEntry {
  id: number;
  scope: RecordAuditScope;
  formId: string;
  entryId: string;
  rowId: string | null;
  action: RecordAuditAction;
  actor: RecordAuditLogActor;
  taskId: string | null;
  beforeSnapshot: unknown | null;
  afterPatch: unknown | null;
  changedFields: string[];
  occurredAt: string;
}

export interface FetchRecordAuditLogResult {
  data: RecordAuditLogApiEntry[];
  meta: {
    count: number;
    limit: number;
    scope: RecordAuditScope;
    formId: string;
    entryId: string | null;
    rowId: string | null;
  };
}

export async function fetchRecordAuditLog(params: {
  scope: RecordAuditScope;
  formId: string;
  entryId?: string;
  rowId?: string;
  limit?: number;
}): Promise<FetchRecordAuditLogResult> {
  const token = readSystemNoticeAdminToken();
  const response = await api.get<FetchRecordAuditLogResult>("/audit/records", {
    params: {
      scope: params.scope,
      formId: params.formId,
      ...(params.entryId ? { entryId: params.entryId } : {}),
      ...(params.rowId ? { rowId: params.rowId } : {}),
      ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
    },
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  });
  return response.data;
}

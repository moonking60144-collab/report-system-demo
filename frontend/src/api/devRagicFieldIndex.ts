import { createApiClient } from "./apiClient";

const api = createApiClient();

export type RagicFieldScope = "main" | "subtable";
export type RagicFieldIndexStatus = "idle" | "refreshing" | "ready" | "error";

export interface RagicFieldIndexEntry {
  id: number;
  formPath: string;
  formName: string;
  scope: RagicFieldScope;
  subtableName: string | null;
  subtableKey: string | null;
  fieldPos: string | null;
  fieldName: string;
  fieldId: string;
  fieldType: string | null;
  fieldNote: string | null;
  refreshedAt: string;
}

export type RagicFieldRefreshPhase = "downloading" | "parsing" | "writing";

export interface RagicFieldRefreshProgress {
  phase: RagicFieldRefreshPhase;
  downloadedBytes: number;
  totalBytes: number | null;
  startedAt: string;
}

export interface RagicFieldIndexState {
  status: RagicFieldIndexStatus;
  refreshedAt: string | null;
  totalForms: number;
  totalFields: number;
  message: string | null;
  updatedAt: string;
  progress: RagicFieldRefreshProgress | null;
}

export interface RagicFieldSearchParams {
  q?: string;
  formPath?: string;
  fieldId?: string;
  limit?: number;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export async function fetchRagicFieldIndexState(
  token: string
): Promise<RagicFieldIndexState> {
  const response = await api.get<{ data: RagicFieldIndexState }>(
    "/dev/ragic-fields/state",
    { headers: authHeaders(token) }
  );
  return response.data.data;
}

export async function searchRagicFieldIndex(
  token: string,
  params: RagicFieldSearchParams,
  options: { signal?: AbortSignal } = {}
): Promise<RagicFieldIndexEntry[]> {
  const response = await api.get<{ data: RagicFieldIndexEntry[] }>(
    "/dev/ragic-fields/search",
    {
      headers: authHeaders(token),
      params,
      signal: options.signal,
    }
  );
  return response.data.data;
}

export async function refreshRagicFieldIndex(token: string): Promise<void> {
  await api.post(
    "/dev/ragic-fields/refresh",
    {},
    { headers: authHeaders(token) }
  );
}

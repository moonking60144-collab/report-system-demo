import { createApiClient } from "./apiClient";
import {
  encodeTaskActorLabelHeader,
  getOrCreateClientId,
  getOrCreateTabId,
  readWorkReportDeviceLabel,
} from "../utils/clientIdentity";

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

/**
 * 分相設計：每個 phase 各自一組對應 counter，避免「downloading 階段卻顯示
 * parsedForms / writtenFields」這種型別上能成立但語意荒謬的狀態。
 * 用 discriminated union (`phase` 是 literal) 讓 TS narrowing 直接拿到對的 counter。
 *
 * 過渡期（部署前後不同步）：前端讀取時用 `'downloadedBytes' in p` 等 type guard
 * 收斂，舊 payload 仍能解析成 downloading-only 視圖，不會 crash。
 */

export interface RagicFieldRefreshProgressBase {
  /** ISO timestamp；前端用這個當 React key 觸發 remount → 進度條重置 */
  startedAt: string;
}

export interface RagicFieldRefreshProgressDownloading
  extends RagicFieldRefreshProgressBase {
  phase: "downloading";
  downloadedBytes: number;
  /** Content-Length 抓不到時 null → 前端走 time-asymptotic 模擬 */
  totalBytes: number | null;
}

export interface RagicFieldRefreshProgressParsing
  extends RagicFieldRefreshProgressBase {
  phase: "parsing";
  parsedForms: number;
  /** parser 在跑到第一個 <form> 才知道總數時可能 null */
  totalForms: number | null;
}

export interface RagicFieldRefreshProgressWriting
  extends RagicFieldRefreshProgressBase {
  phase: "writing";
  writtenFields: number;
  /** repository.replaceAll 在 chunk 開始前已知總筆數 → 一般不為 null */
  totalFields: number | null;
}

export type RagicFieldRefreshProgress =
  | RagicFieldRefreshProgressDownloading
  | RagicFieldRefreshProgressParsing
  | RagicFieldRefreshProgressWriting;

export interface RagicFieldIndexState {
  status: RagicFieldIndexStatus;
  refreshedAt: string | null;
  totalForms: number;
  totalFields: number;
  message: string | null;
  updatedAt: string;
  progress: RagicFieldRefreshProgress | null;
  /** true：當前 in-flight refresh 由 30 分鐘背景排程啟動，非使用者手動觸發 */
  autoRefreshing?: boolean;
}

export interface RagicFieldSearchParams {
  q?: string;
  formPath?: string;
  fieldId?: string;
  limit?: number;
}

function authHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "x-debug-client-id": getOrCreateClientId(),
    "x-debug-tab-id": getOrCreateTabId(),
  };
  const label = readWorkReportDeviceLabel();
  if (label) {
    headers["x-debug-device-label"] = encodeTaskActorLabelHeader(label);
  }
  return headers;
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

export interface RagicFieldSearchResult {
  data: RagicFieldIndexEntry[];
  truncated: boolean;
}

export async function searchRagicFieldIndex(
  token: string,
  params: RagicFieldSearchParams,
  options: { signal?: AbortSignal } = {}
): Promise<RagicFieldSearchResult> {
  const response = await api.get<{
    data: RagicFieldIndexEntry[];
    meta?: { truncated?: boolean };
  }>("/dev/ragic-fields/search", {
    headers: authHeaders(token),
    params,
    signal: options.signal,
  });
  return {
    data: response.data.data,
    truncated: Boolean(response.data.meta?.truncated),
  };
}

export async function refreshRagicFieldIndex(token: string): Promise<void> {
  await api.post(
    "/dev/ragic-fields/refresh",
    {},
    { headers: authHeaders(token) }
  );
}

export interface RagicFieldRefreshAbortResult {
  /** false：當下沒有 in-flight refresh，DELETE 是 no-op（不該跳「已中止」toast）*/
  aborted: boolean;
  reason?: string;
}

export async function abortRagicFieldIndexRefresh(
  token: string
): Promise<RagicFieldRefreshAbortResult> {
  const response = await api.delete<{ data: RagicFieldRefreshAbortResult }>(
    "/dev/ragic-fields/refresh",
    { headers: authHeaders(token) }
  );
  return response.data.data;
}

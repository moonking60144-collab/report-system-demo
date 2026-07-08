import { createApiClient } from "./apiClient";
import {
  getOrCreateClientId,
  getOrCreateTabId,
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
  if (typeof window !== "undefined") {
    const label = window.localStorage.getItem("debug.deviceLabel");
    if (label && label.trim()) {
      headers["x-debug-device-label"] = label.trim();
    }
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

// ── 欄位依賴邊（從 field_note 解析出的關係圖）

export type DependencyDirection = "upstream" | "downstream";

export interface RagicDependencyNode {
  depth: number;
  edgeType: string;
  /** load 邊專屬：是否隨時同步 */
  sync: boolean | null;
  fieldId: string;
  formPath: string | null;
  formName: string | null;
  fieldName: string | null;
  fieldType: string | null;
  /** 從哪個欄位（field_id）連過來 */
  viaFieldId: string;
  /** 目標表單的 Ragic 網址（route 用 env 構造，未解析表單為 null）*/
  ragicUrl?: string | null;
}

export interface RagicEdgeStats {
  byType: Array<{ edgeType: string; count: number }>;
  totalData: number;
  totalSideEffect: number;
  resolvedData: number;
  brokenData: number;
}

export interface RagicSideEffectEdge {
  srcFormPath: string;
  srcFormName: string | null;
  srcFieldId: string;
  srcFieldName: string | null;
  edgeType: string;
  via: string | null;
  target: string | null;
  ragicUrl?: string | null;
}

export async function fetchRagicDependencies(
  token: string,
  fieldId: string,
  direction: DependencyDirection,
  options: { maxDepth?: number; signal?: AbortSignal } = {}
): Promise<RagicDependencyNode[]> {
  const response = await api.get<{ data: RagicDependencyNode[] }>(
    "/dev/ragic-fields/edges/dependencies",
    {
      headers: authHeaders(token),
      params: { fieldId, direction, depth: options.maxDepth ?? 10 },
      signal: options.signal,
    }
  );
  return response.data.data;
}

export async function fetchRagicEdgeStats(
  token: string
): Promise<RagicEdgeStats> {
  const response = await api.get<{ data: RagicEdgeStats }>(
    "/dev/ragic-fields/edges/stats",
    { headers: authHeaders(token) }
  );
  return response.data.data;
}

export async function fetchRagicSideEffects(
  token: string
): Promise<RagicSideEffectEdge[]> {
  const response = await api.get<{ data: RagicSideEffectEdge[] }>(
    "/dev/ragic-fields/edges/side-effects",
    { headers: authHeaders(token) }
  );
  return response.data.data;
}

// ── 實體瀏覽（mainKey 群組 = 正規化後的一張表）

export type RagicFieldRole = "primary" | "derived" | "foreign" | "side_effect";

export interface RagicEntitySummary {
  entityKey: string;
  repName: string | null;
  viewCount: number;
  fieldCount: number;
  refCount: number;
  dangling: boolean;
}

export interface RagicEntityFieldInfo {
  fieldId: string;
  fieldName: string;
  fieldPos: string | null;
  fieldType: string | null;
  role: RagicFieldRole;
  readOnly: boolean;
  unique: boolean;
  required: boolean;
  autoGen: boolean;
  fkTarget: string | null;
  broken: boolean;
}

export interface RagicEntityDetail {
  entityKey: string;
  repName: string | null;
  fields: RagicEntityFieldInfo[];
  views: Array<{ formPath: string; ragicUrl: string }>;
  childTables: Array<{ formPath: string; subtableName: string | null; ragicUrl: string }>;
}

export async function fetchRagicEntities(token: string): Promise<RagicEntitySummary[]> {
  const response = await api.get<{ data: RagicEntitySummary[] }>(
    "/dev/ragic-fields/edges/entities",
    { headers: authHeaders(token) }
  );
  return response.data.data;
}

export async function fetchRagicEntityFields(
  token: string,
  entityKey: string
): Promise<RagicEntityDetail> {
  const response = await api.get<{ data: RagicEntityDetail }>(
    `/dev/ragic-fields/edges/entities/${encodeURIComponent(entityKey)}/fields`,
    { headers: authHeaders(token) }
  );
  return response.data.data;
}

// ── Workflow JS 依賴（ragic_workflow_edge）：field_note 看不到的 getAPIQuery 跨表 / setFieldValue 寫值 / 連外

export interface RagicWorkflowEdgeStats {
  formsWithWorkflow: number;
  queryEdges: number;
  setEdges: number;
  externalEdges: number;
  unresolvedQueryTargets: number;
  topDepended: Array<{
    formPath: string;
    dependedByCount: number;
    resolved: boolean;
    ragicUrl: string | null;
  }>;
}

export interface RagicWorkflowFormDeps {
  formPath: string;
  /** 該表有原文的 scope（pre/post/button 子集），決定顯示哪些「看原始碼」按鈕 */
  sourceScopes: string[];
  downstreamForms: Array<{
    targetFormPath: string;
    resolved: boolean;
    scopes: string[];
    occurCount: number;
    ragicUrl: string | null;
  }>;
  upstreamForms: Array<{
    srcFormPath: string;
    scopes: string[];
    occurCount: number;
    ragicUrl: string | null;
  }>;
  writes: Array<{
    fieldId: string;
    fieldName: string | null;
    formPath: string | null;
    scopes: string[];
    occurCount: number;
    ragicUrl: string | null;
  }>;
  externals: Array<{ via: string; target: string; scopes: string[]; occurCount: number }>;
}

export async function fetchRagicWorkflowStats(
  token: string
): Promise<RagicWorkflowEdgeStats> {
  const response = await api.get<{ data: RagicWorkflowEdgeStats }>(
    "/dev/ragic-fields/workflow/stats",
    { headers: authHeaders(token) }
  );
  return response.data.data;
}

export async function fetchRagicWorkflowFormDeps(
  token: string,
  formPath: string
): Promise<RagicWorkflowFormDeps> {
  const response = await api.get<{ data: RagicWorkflowFormDeps }>(
    "/dev/ragic-fields/workflow/form",
    { headers: authHeaders(token), params: { path: formPath } }
  );
  return response.data.data;
}

export async function fetchRagicWorkflowSource(
  token: string,
  formPath: string,
  scope: string
): Promise<{ js: string; charCount: number } | null> {
  const response = await api.get<{ data: { js: string; charCount: number } | null }>(
    "/dev/ragic-fields/workflow/source",
    { headers: authHeaders(token), params: { path: formPath, scope } }
  );
  return response.data.data;
}

// ── 直讀 Ragic 本地 .nui 重撈 workflow 依賴（全自動，只在 backend 與 Ragic 同台的 server 可用）

export interface WorkflowScanState {
  status: "idle" | "running" | "done" | "error";
  progress: { scannedForms: number; totalForms: number; foundFiles: number } | null;
  message: string | null;
  lastResult: {
    edges: number;
    formsWithWorkflow: number;
    missingFiles: number;
    refreshedAt: string;
  } | null;
  /** false：未設 RAGIC_BUILDER_PATH 或目錄不存在（本機），button 應停用 */
  configured: boolean;
}

export async function triggerWorkflowScan(token: string): Promise<void> {
  await api.post("/dev/ragic-fields/workflow/scan", {}, { headers: authHeaders(token) });
}

export async function fetchWorkflowScanState(token: string): Promise<WorkflowScanState> {
  const response = await api.get<{ data: WorkflowScanState }>(
    "/dev/ragic-fields/workflow/scan-state",
    { headers: authHeaders(token) }
  );
  return response.data.data;
}

// ── group 聚合 ER 鳥瞰圖（正規化規劃用）：form group 超級節點 + 三型跨群聚合邊

export type RagicGroupEdgeType = "fk" | "workflow" | "subtable";

export interface RagicGroupGraphNode {
  group: string;
  formCount: number;
  entityCount: number;
  /** 群內自連邊數（FK/workflow/子表落在同群）；只當凝聚度指標標在節點上，不畫穿圈線 */
  selfEdges: number;
  /** 群成員表單（讓抽象 group 代號追回實際 Ragic 表單）；route 已補 ragicUrl */
  forms: Array<{ formPath: string; formName: string; ragicUrl: string }>;
}

export interface RagicGroupGraphEdge {
  src: string;
  dst: string;
  type: RagicGroupEdgeType;
  count: number;
}

export interface RagicGroupGraph {
  nodes: RagicGroupGraphNode[];
  edges: RagicGroupGraphEdge[];
}

export async function fetchRagicGroupGraph(token: string): Promise<RagicGroupGraph> {
  const response = await api.get<{ data: RagicGroupGraph }>(
    "/dev/ragic-fields/edges/group-graph",
    { headers: authHeaders(token) }
  );
  return response.data.data;
}

// ── 正規化體檢：每表 Link&Load fan-in/out + 主檔/交易檔/葉表分類

export type RagicTableKind = "master" | "transaction" | "leaf";

export interface RagicNormalizationTable {
  formPath: string;
  formName: string;
  /** 被幾張 distinct 表 Link/Load 指向（高＝主檔被引用） */
  fanIn: number;
  /** Link/Load 指向幾張 distinct 表（高＝交易檔引用多主檔） */
  fanOut: number;
  hasSubtable: boolean;
  kind: RagicTableKind;
  /** 合併的多版本數（同 mainKey），1=單一版本 */
  versionCount: number;
  ragicUrl: string;
}

export interface RagicNormalizationCycle {
  members: Array<{ formPath: string; formName: string; ragicUrl: string }>;
}

export interface RagicNormalizationResult {
  tables: RagicNormalizationTable[];
  /** Link&Load 循環依賴（SCC，size>1）：A→B→…→A，運算可能卡死、該優先打斷 */
  cycles: RagicNormalizationCycle[];
}

export async function fetchNormalizationAudit(
  token: string
): Promise<RagicNormalizationResult> {
  const response = await api.get<{ data: RagicNormalizationResult }>(
    "/dev/ragic-fields/edges/normalization",
    { headers: authHeaders(token) }
  );
  return response.data.data;
}

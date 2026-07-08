import { createApiClient } from "./apiClient";
import {
  getOrCreateClientId,
  getOrCreateTabId,
} from "../utils/clientIdentity";
import type {
  RagicDefinitionsState,
  RagicDefinitionForm,
  RagicDefinitionFormula,
  RagicDefinitionFormDetail,
  RagicDefinitionSearchItem,
  RagicFormulaPatchDryRunResult,
  RagicFormulaPatchApplyResult,
  RagicFormulaPatchBatchApplyResult,
  RagicFormulaPatchRollbackLatestResult,
  RagicDefinitionsVersionControlStatus,
  RagicDefinitionsVersionControlCommitResult,
  RagicDefinitionsVersionControlPushResult,
  RagicFormulaSiblingsResult,
  RagicFormulaAiSuggestRequest,
  RagicFormulaAiSuggestResult,
  DevAiChatRequest,
  DevAiChatResult,
  DevAiFeedbackRequest,
  DevAiFeedbackResult,
  DevAiKnowledgeCompileResult,
  DevAiKnowledgeStatusResult,
  DevAiCreateThreadRequest,
  DevAiSendMessageRequest,
  DevAiSendMessageResult,
  DevAiThread,
  DevAiThreadDetail,
} from "@shared-types/ragicDefinitions";

const api = createApiClient();

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

export type {
  RagicDefinitionManifest,
  RagicDefinitionGitStatus,
  RagicDefinitionsState,
  RagicDefinitionForm,
  RagicDefinitionField,
  RagicDefinitionFormula,
  RagicDefinitionWorkflow,
  RagicDefinitionFormDetail,
  RagicDefinitionSearchItem,
  RagicFormulaPatchDryRunResult,
  RagicFormulaPatchApplyResult,
  RagicFormulaPatchBatchTargetResult,
  RagicFormulaPatchBatchApplyResult,
  RagicFormulaPatchRollbackTarget,
  RagicFormulaPatchRollbackLatestResult,
  RagicDefinitionsGitEntry,
  RagicDefinitionsVersionControlStatus,
  RagicDefinitionsVersionControlCommitResult,
  RagicDefinitionsVersionControlPushResult,
  RagicFormulaSiblingTranslation,
  RagicFormulaSiblingInfo,
  RagicFormulaSiblingsResult,
  RagicFormulaAiSuggestRequest,
  RagicFormulaAiSuggestResult,
  DevAiChatRequest,
  DevAiChatResult,
  DevAiFeedbackRequest,
  DevAiFeedbackResult,
  DevAiKnowledgeCompileResult,
  DevAiKnowledgeStatusResult,
  DevAiCreateThreadRequest,
  DevAiSendMessageRequest,
  DevAiSendMessageResult,
  DevAiThread,
  DevAiThreadDetail,
} from "@shared-types/ragicDefinitions";

export interface RagicFormulaPatchDryRunInput {
  formPath: string;
  fieldId: string;
  formulaKind: RagicDefinitionFormula["formulaKind"];
  newFormula: string;
}

export type RagicFormulaAiSuggestInput = RagicFormulaAiSuggestRequest;
export type DevAiChatInput = DevAiChatRequest;
export type DevAiFeedbackInput = DevAiFeedbackRequest;
export type DevAiCreateThreadInput = DevAiCreateThreadRequest;
export type DevAiSendMessageInput = DevAiSendMessageRequest;

export interface RagicDefinitionsReExportResult {
  exported: boolean;
  message: string;
  /** 重新匯入連動觸發的欄位索引刷新狀態（triggered＝已在背景刷新） */
  fieldIndexRefresh?: "triggered" | "already-running" | "unavailable" | "not-needed";
  summary: {
    forms: number;
    fields: number;
    formulas: number;
    workflows: number;
    namespaces: string;
    outDir: string;
  };
  state: RagicDefinitionsState;
  versionStatus: RagicDefinitionsVersionControlStatus;
}

export type RagicDefinitionSearchType = "all" | "field" | "formula";

export interface RagicDefinitionListResult<T> {
  data: T[];
  meta: {
    count: number;
    limit: number;
    truncated: boolean;
    q?: string;
    fieldId?: string;
    formPath?: string;
    type?: RagicDefinitionSearchType;
  };
}

export async function fetchRagicDefinitionsState(
  token: string,
  options: { signal?: AbortSignal } = {}
): Promise<RagicDefinitionsState> {
  const response = await api.get<{ data: RagicDefinitionsState }>(
    "/dev/ragic-definitions/state",
    { headers: authHeaders(token), signal: options.signal }
  );
  return response.data.data;
}

export async function reExportRagicDefinitions(
  token: string
): Promise<RagicDefinitionsReExportResult> {
  const response = await api.post<{ data: RagicDefinitionsReExportResult }>(
    "/dev/ragic-definitions/re-export",
    {},
    { headers: authHeaders(token) }
  );
  return response.data.data;
}

export async function fetchRagicDefinitionForms(
  token: string,
  params: { q?: string; limit?: number } = {},
  options: { signal?: AbortSignal } = {}
): Promise<RagicDefinitionListResult<RagicDefinitionForm>> {
  const response = await api.get<RagicDefinitionListResult<RagicDefinitionForm>>(
    "/dev/ragic-definitions/forms",
    { headers: authHeaders(token), params, signal: options.signal }
  );
  return response.data;
}

export async function searchRagicDefinitions(
  token: string,
  params: {
    q?: string;
    fieldId?: string;
    formPath?: string;
    type?: RagicDefinitionSearchType;
    limit?: number;
  },
  options: { signal?: AbortSignal } = {}
): Promise<RagicDefinitionListResult<RagicDefinitionSearchItem>> {
  const response = await api.get<RagicDefinitionListResult<RagicDefinitionSearchItem>>(
    "/dev/ragic-definitions/search",
    { headers: authHeaders(token), params, signal: options.signal }
  );
  return response.data;
}

export async function fetchRagicDefinitionFormDetail(
  token: string,
  formPath: string,
  options: { signal?: AbortSignal } = {}
): Promise<RagicDefinitionFormDetail> {
  const response = await api.get<{ data: RagicDefinitionFormDetail }>(
    "/dev/ragic-definitions/form",
    { headers: authHeaders(token), params: { path: formPath }, signal: options.signal }
  );
  return response.data.data;
}

export async function dryRunRagicFormulaPatch(
  token: string,
  input: RagicFormulaPatchDryRunInput,
  options: { signal?: AbortSignal } = {}
): Promise<RagicFormulaPatchDryRunResult> {
  const response = await api.post<{ data: RagicFormulaPatchDryRunResult }>(
    "/dev/ragic-definitions/formula/dry-run",
    input,
    { headers: authHeaders(token), signal: options.signal }
  );
  return response.data.data;
}

export async function applyRagicFormulaPatch(
  token: string,
  input: RagicFormulaPatchDryRunInput,
  options: { signal?: AbortSignal } = {}
): Promise<RagicFormulaPatchApplyResult> {
  const response = await api.post<{ data: RagicFormulaPatchApplyResult }>(
    "/dev/ragic-definitions/formula/apply",
    input,
    { headers: authHeaders(token), signal: options.signal }
  );
  return response.data.data;
}

export async function applyRagicFormulaPatchBatch(
  token: string,
  targets: RagicFormulaPatchDryRunInput[],
  options: { signal?: AbortSignal } = {}
): Promise<RagicFormulaPatchBatchApplyResult> {
  const response = await api.post<{ data: RagicFormulaPatchBatchApplyResult }>(
    "/dev/ragic-definitions/formula/apply-batch",
    { targets },
    { headers: authHeaders(token), signal: options.signal }
  );
  return response.data.data;
}

export async function rollbackLatestRagicFormulaPatch(
  token: string
): Promise<RagicFormulaPatchRollbackLatestResult> {
  const response = await api.post<{ data: RagicFormulaPatchRollbackLatestResult }>(
    "/dev/ragic-definitions/formula/rollback-latest",
    {},
    { headers: authHeaders(token) }
  );
  return response.data.data;
}

export async function fetchRagicFormulaSiblings(
  token: string,
  params: {
    formPath: string;
    fieldId: string;
    formulaKind: RagicDefinitionFormula["formulaKind"];
    newFormula?: string;
    includeFreshness?: boolean;
    includeCurrent?: boolean;
  },
  options: { signal?: AbortSignal } = {}
): Promise<RagicFormulaSiblingsResult> {
  const response = await api.get<{ data: RagicFormulaSiblingsResult }>(
    "/dev/ragic-definitions/formula/siblings",
    { headers: authHeaders(token), params, signal: options.signal }
  );
  return response.data.data;
}

export async function suggestRagicFormulaWithAi(
  token: string,
  input: RagicFormulaAiSuggestInput,
  options: { signal?: AbortSignal } = {}
): Promise<RagicFormulaAiSuggestResult> {
  const response = await api.post<{ data: RagicFormulaAiSuggestResult }>(
    "/dev/ragic-definitions/ai/formula/suggest",
    input,
    { headers: authHeaders(token), signal: options.signal }
  );
  return response.data.data;
}

export async function askDevAi(
  token: string,
  input: DevAiChatInput,
  options: { signal?: AbortSignal } = {}
): Promise<DevAiChatResult> {
  const response = await api.post<{ data: DevAiChatResult }>(
    "/dev/ragic-definitions/ai/chat",
    input,
    { headers: authHeaders(token), signal: options.signal }
  );
  return response.data.data;
}

export async function storeDevAiFeedback(
  token: string,
  input: DevAiFeedbackInput,
  options: { signal?: AbortSignal } = {}
): Promise<DevAiFeedbackResult> {
  const response = await api.post<{ data: DevAiFeedbackResult }>(
    "/dev/ragic-definitions/ai/feedback",
    input,
    { headers: authHeaders(token), signal: options.signal }
  );
  return response.data.data;
}

export async function fetchDevAiKnowledgeStatus(
  token: string
): Promise<DevAiKnowledgeStatusResult> {
  const response = await api.get<{ data: DevAiKnowledgeStatusResult }>(
    "/dev/ragic-definitions/ai/knowledge/status",
    { headers: authHeaders(token) }
  );
  return response.data.data;
}

export async function compileDevAiKnowledge(
  token: string
): Promise<DevAiKnowledgeCompileResult> {
  const response = await api.post<{ data: DevAiKnowledgeCompileResult }>(
    "/dev/ragic-definitions/ai/knowledge/compile",
    {},
    { headers: authHeaders(token) }
  );
  return response.data.data;
}

export async function fetchDevAiThreads(token: string): Promise<DevAiThread[]> {
  const response = await api.get<{ data: DevAiThread[] }>("/dev/ai/threads", {
    headers: authHeaders(token),
  });
  return response.data.data;
}

export async function createDevAiThread(
  token: string,
  input: DevAiCreateThreadInput = {}
): Promise<DevAiThread> {
  const response = await api.post<{ data: DevAiThread }>("/dev/ai/threads", input, {
    headers: authHeaders(token),
  });
  return response.data.data;
}

export async function fetchDevAiThreadDetail(
  token: string,
  threadId: string
): Promise<DevAiThreadDetail> {
  const response = await api.get<{ data: DevAiThreadDetail }>(`/dev/ai/threads/${threadId}`, {
    headers: authHeaders(token),
  });
  return response.data.data;
}

export async function sendDevAiThreadMessage(
  token: string,
  threadId: string,
  input: DevAiSendMessageInput,
  options: { signal?: AbortSignal } = {}
): Promise<DevAiSendMessageResult> {
  const response = await api.post<{ data: DevAiSendMessageResult }>(
    `/dev/ai/threads/${threadId}/messages`,
    input,
    { headers: authHeaders(token), signal: options.signal }
  );
  return response.data.data;
}

export async function archiveDevAiThread(
  token: string,
  threadId: string
): Promise<DevAiThread> {
  const response = await api.post<{ data: DevAiThread }>(
    `/dev/ai/threads/${threadId}/archive`,
    {},
    { headers: authHeaders(token) }
  );
  return response.data.data;
}

export async function fetchRagicDefinitionsVersionControlStatus(
  token: string
): Promise<RagicDefinitionsVersionControlStatus> {
  const response = await api.get<{ data: RagicDefinitionsVersionControlStatus }>(
    "/dev/ragic-definitions/version-control/status",
    { headers: authHeaders(token) }
  );
  return response.data.data;
}

export async function commitRagicDefinitionsBaseline(
  token: string,
  message: string,
  options: { formPaths?: string[] } = {}
): Promise<RagicDefinitionsVersionControlCommitResult> {
  const response = await api.post<{ data: RagicDefinitionsVersionControlCommitResult }>(
    "/dev/ragic-definitions/version-control/commit",
    { message, formPaths: options.formPaths },
    { headers: authHeaders(token) }
  );
  return response.data.data;
}

export async function pushRagicDefinitionsBaseline(
  token: string
): Promise<RagicDefinitionsVersionControlPushResult> {
  const response = await api.post<{ data: RagicDefinitionsVersionControlPushResult }>(
    "/dev/ragic-definitions/version-control/push",
    {},
    { headers: authHeaders(token) }
  );
  return response.data.data;
}

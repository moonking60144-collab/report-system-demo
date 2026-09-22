export function shouldApplyDevAiThreadDetailSnapshot(
  requestRevision: number,
  currentRevision: number
): boolean {
  return requestRevision === currentRevision;
}

export function selectDevAiCitedEvidencePayload(
  payload: Record<string, unknown>
): unknown {
  return Array.isArray(payload.citedEvidence)
    ? payload.citedEvidence
    : payload.sources;
}

export function devAiUnavailableMessage(
  readiness: import("@shared-types/ragicDefinitions").DevAiReadiness | null
): string | null {
  if (!readiness) return "正在檢查 AI 設定…";
  if (readiness.chatAvailable) return null;
  if (readiness.reason === "conversation-disabled") {
    return "對話儲存目前停用；請設定 DEV_AI_CONVERSATION_HISTORY_ENABLED=true。";
  }
  if (readiness.reason === "provider-disabled") {
    return "AI provider 目前停用；請設定 DEV_AI_ENABLED=true。";
  }
  return "AI provider 尚未設定 API key。";
}

export function devAiKnowledgeUnavailableMessage(
  readiness: import("@shared-types/ragicDefinitions").DevAiReadiness | null
): string | null {
  if (!readiness || readiness.knowledge.available) return null;
  if (readiness.knowledge.state === "missing") {
    return "本地 knowledge 索引尚未建立，已預設關閉；請先執行 knowledge:prepare。";
  }
  if (readiness.knowledge.state === "stale") {
    return "本地 knowledge 索引已過期，已預設關閉；請重新執行 knowledge:prepare。";
  }
  if (readiness.knowledge.state === "error") {
    return "本地 knowledge 索引目前無法讀取，已預設關閉。";
  }
  return "本地 embedding 模型尚未完成可持久驗證，已預設關閉；請執行 knowledge:prepare。";
}

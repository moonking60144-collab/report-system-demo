import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import {
  AuditOutlined,
  BookOutlined,
  CopyOutlined,
  FileSearchOutlined,
  InboxOutlined,
  PlusOutlined,
  RobotOutlined,
  SendOutlined,
} from "@ant-design/icons";
import {
  archiveDevAiThread,
  createDevAiThread,
  fetchDevAiReadiness,
  fetchDevAiThreadDetail,
  fetchDevAiThreads,
  sendDevAiThreadMessage,
  submitDevAiKnowledgeCandidate,
  type DevAiThread,
  type DevAiThreadDetail,
} from "../../../../api/devRagicDefinitions";
import { extractErrorMessage, isUnauthorized } from "../../../../api/apiErrors";
import type {
  DevAiSendMessageRequest,
  DevAiReadiness,
  DevAiSpeedMode,
  DevAiThreadArtifact,
} from "@shared-types/ragicDefinitions";
import { useDevContext } from "../../layout/devContext";
import {
  devAiContextStatusLabel,
  devAiKnowledgeSourceLabel,
  devAiKnowledgeSourcesFromUnknown,
} from "../../components/RagicDefinitionsAiAssistantUtils";
import {
  devAiUnavailableMessage,
  devAiKnowledgeUnavailableMessage,
  selectDevAiCitedEvidencePayload,
  shouldApplyDevAiThreadDetailSnapshot,
} from "./devAiViewUtils";
import {
  resolveDevAiMessageSubmission,
  type DevAiMessageSubmission,
} from "../../utils/devAiClientMessageId";
import { DevAiMessageContent } from "../../components/DevAiMessageContent";

export function DevAiView() {
  const { token, onAuthFailure } = useDevContext();
  const { threadId } = useParams();
  const navigate = useNavigate();
  const [threads, setThreads] = useState<DevAiThread[]>([]);
  const [detail, setDetail] = useState<DevAiThreadDetail | null>(null);
  const [draft, setDraft] = useState("");
  const [speedMode, setSpeedMode] = useState<DevAiSpeedMode>("fast");
  const [includeKnowledge, setIncludeKnowledge] = useState(true);
  const [includeDefinitions, setIncludeDefinitions] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [readiness, setReadiness] = useState<DevAiReadiness | null>(null);
  const [knowledgeSubmissionByMessage, setKnowledgeSubmissionByMessage] = useState<
    Record<string, "saving" | "saved" | "failed">
  >({});
  const [error, setError] = useState<string | null>(null);
  const detailRevisionRef = useRef(0);
  const sendInFlightRef = useRef(false);
  const messageSubmissionRef = useRef<DevAiMessageSubmission | null>(null);
  const unavailableMessage = devAiUnavailableMessage(readiness);
  const knowledgeUnavailableMessage = devAiKnowledgeUnavailableMessage(readiness);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchDevAiReadiness(token)
      .then(async (nextReadiness) => {
        if (cancelled) return;
        setReadiness(nextReadiness);
        setIncludeKnowledge(nextReadiness.knowledge.available);
        if (!nextReadiness.conversation.enabled) {
          setThreads([]);
          return;
        }
        const nextThreads = await fetchDevAiThreads(token);
        if (!cancelled) setThreads(nextThreads);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(extractErrorMessage(err, "讀取 Dev AI threads 失敗"));
          if (isUnauthorized(err)) onAuthFailure("登入已過期，請重新登入");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onAuthFailure, token]);

  useEffect(() => {
    if (!threadId || !readiness?.conversation.enabled) {
      detailRevisionRef.current += 1;
      setDetail(null);
      return;
    }
    let cancelled = false;
    const requestRevision = detailRevisionRef.current;
    setLoading(true);
    setError(null);
    fetchDevAiThreadDetail(token, threadId)
      .then((next) => {
        if (
          !cancelled &&
          shouldApplyDevAiThreadDetailSnapshot(requestRevision, detailRevisionRef.current)
        ) {
          setDetail(next);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(extractErrorMessage(err, "讀取對話失敗"));
          if (isUnauthorized(err)) onAuthFailure("登入已過期，請重新登入");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onAuthFailure, readiness?.conversation.enabled, threadId, token]);

  const activeThread = useMemo(
    () => detail?.thread ?? threads.find((thread) => thread.id === threadId) ?? null,
    [detail?.thread, threadId, threads]
  );
  const artifactsByMessage = useMemo(() => {
    const map = new Map<string, DevAiThreadArtifact[]>();
    for (const artifact of detail?.artifacts ?? []) {
      map.set(artifact.messageId, [...(map.get(artifact.messageId) ?? []), artifact]);
    }
    return map;
  }, [detail?.artifacts]);

  async function handleNewThread() {
    if (!readiness?.chatAvailable) {
      setError(unavailableMessage ?? "AI 對話目前不可用");
      return;
    }
    setError(null);
    try {
      const created = await createDevAiThread(token, { mode: "auto" });
      setThreads((current) => [created, ...current.filter((thread) => thread.id !== created.id)]);
      detailRevisionRef.current += 1;
      setDetail({ thread: created, messages: [], artifacts: [] });
      navigate(`/dev/ai/threads/${created.id}`);
    } catch (err) {
      setError(extractErrorMessage(err, "新增對話失敗"));
    }
  }

  async function ensureThreadForSend(message: string): Promise<DevAiThread> {
    if (activeThread && threadId) return activeThread;
    const created = await createDevAiThread(token, {
      title: message.slice(0, 42),
      mode: "auto",
    });
    setThreads((current) => [created, ...current.filter((thread) => thread.id !== created.id)]);
    detailRevisionRef.current += 1;
    setDetail({ thread: created, messages: [], artifacts: [] });
    navigate(`/dev/ai/threads/${created.id}`);
    return created;
  }

  async function handleSend() {
    if (!readiness?.chatAvailable) {
      setError(unavailableMessage ?? "AI 對話目前不可用");
      return;
    }
    if (!draft.trim() || sending || sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    const message = draft.trim();
    setSending(true);
    setError(null);
    try {
      const targetThread = await ensureThreadForSend(message);
      const payload: Omit<DevAiSendMessageRequest, "clientMessageId"> = {
        message,
        mode: "auto",
        speedMode,
        includeKnowledge,
        includeDefinitions,
      };
      const submission = resolveDevAiMessageSubmission(
        messageSubmissionRef.current,
        targetThread.id,
        payload
      );
      messageSubmissionRef.current = submission;
      const next = await sendDevAiThreadMessage(token, targetThread.id, {
        ...payload,
        clientMessageId: submission.clientMessageId,
      });
      messageSubmissionRef.current = null;
      detailRevisionRef.current += 1;
      setDetail((current) => ({
        thread: next.thread,
        messages: [...(current?.messages ?? []), next.userMessage, next.assistantMessage],
        artifacts: [...(current?.artifacts ?? []), ...next.artifacts],
        summaryUsed: next.summaryUsed,
      }));
      setThreads((current) => [next.thread, ...current.filter((thread) => thread.id !== next.thread.id)]);
      setDraft("");
    } catch (err) {
      setError(extractErrorMessage(err, "送出失敗"));
    } finally {
      sendInFlightRef.current = false;
      setSending(false);
    }
  }

  async function handleArchive() {
    if (!threadId || !activeThread) return;
    setError(null);
    try {
      await archiveDevAiThread(token, threadId);
      setThreads((current) => current.filter((thread) => thread.id !== threadId));
      detailRevisionRef.current += 1;
      setDetail(null);
      navigate("/dev/ai");
    } catch (err) {
      setError(extractErrorMessage(err, "封存失敗"));
    }
  }

  async function handleSubmitKnowledgeCandidate(
    message: DevAiThreadDetail["messages"][number],
    question: string,
    artifacts: DevAiThreadArtifact[]
  ) {
    if (!activeThread || knowledgeSubmissionByMessage[message.id] === "saving") return;
    setKnowledgeSubmissionByMessage((current) => ({ ...current, [message.id]: "saving" }));
    setError(null);
    try {
      const sourceIds = artifacts
        .flatMap((artifact) =>
          devAiKnowledgeSourcesFromUnknown(
            artifact.payload.citedEvidence ?? artifact.payload.sources
          )
        )
        .map((source) => source.sourceId);
      const formulaArtifact = artifacts.find((artifact) => artifact.type === "formula-suggestion");
      const formulaPayload = objectValue(formulaArtifact?.payload);
      const proposedFormula = stringValue(formulaPayload.proposedFormula);
      await submitDevAiKnowledgeCandidate(token, {
        payload: proposedFormula
          ? {
              kind: "formula-suggestion",
              objective: question,
              proposedFormula,
              explanation: stringValue(formulaPayload.explanation),
              formPath: stringValue(formulaPayload.formPath) || activeThread.context.formPath,
              fieldId: stringValue(formulaPayload.fieldId) || activeThread.context.fieldId,
              position: stringValue(formulaPayload.position) || activeThread.context.position,
              sourceLine:
                positiveIntegerValue(formulaPayload.sourceLine) ?? activeThread.context.sourceLine,
              formulaKind:
                formulaPayload.formulaKind === "defaultFormula" ? "defaultFormula" : "formula",
              sourceIds,
            }
          : {
              kind: "chat-answer",
              question,
              answer: message.content,
              formPath: activeThread.context.formPath,
              fieldId: activeThread.context.fieldId,
              sourceIds,
            },
        domain: proposedFormula ? "definitions" : "ragic",
        sourceKey: `thread:${activeThread.id}:message:${message.id}`,
        sourceThreadId: activeThread.id,
        sourceMessageId: message.id,
      });
      setKnowledgeSubmissionByMessage((current) => ({ ...current, [message.id]: "saved" }));
    } catch (err) {
      setError(extractErrorMessage(err, "送交知識審核失敗"));
      setKnowledgeSubmissionByMessage((current) => ({ ...current, [message.id]: "failed" }));
      if (isUnauthorized(err)) onAuthFailure("登入已過期，請重新登入");
    }
  }

  return (
    <section className="dev-ai-workspace" aria-label="Dev AI workspace">
      <header className="dev-ai-workspace__hero">
        <div className="dev-ai-workspace__brand">
          <span className="dev-ai-workspace__orb" aria-hidden>
            <RobotOutlined />
          </span>
          <div>
            <span>DemoCo Dev AI</span>
            <h1>AI 對話工作台</h1>
            <p>延續左下 bot 的對話脈絡；thread memory 只屬於本對話，不會自動進入 RAG。</p>
          </div>
        </div>
        <div className="dev-ai-workspace__hero-actions">
          <button
            type="button"
            className="dev-mode-btn"
            disabled={!readiness?.chatAvailable}
            onClick={handleNewThread}
          >
            <PlusOutlined />
            新對話
          </button>
          {activeThread ? (
            <button type="button" className="dev-mode-btn" onClick={handleArchive}>
              <InboxOutlined />
              封存
            </button>
          ) : null}
        </div>
      </header>

      <div className="dev-ai-workspace__grid">
        <aside className="dev-ai-workspace__threads" aria-label="對話列表">
          <div className="dev-ai-workspace__section-head">
            <div>
              <strong>我的對話</strong>
              <span>{loading ? "讀取中…" : `${threads.length} 筆 active`}</span>
            </div>
            <button
              type="button"
              className="dev-ai-workspace__icon-btn"
              disabled={!readiness?.chatAvailable}
              onClick={handleNewThread}
              aria-label="新增對話"
            >
              <PlusOutlined />
            </button>
          </div>
          {threads.length ? (
            <div className="dev-ai-workspace__thread-list">
              {threads.map((thread) => (
                <NavLink
                  key={thread.id}
                  to={`/dev/ai/threads/${thread.id}`}
                  className={({ isActive }) =>
                    `dev-ai-workspace__thread${isActive ? " is-active" : ""}`
                  }
                >
                  <span className="dev-ai-workspace__thread-kicker">{thread.mode}</span>
                  <strong>{thread.title}</strong>
                  <span>{thread.lastMessagePreview || "尚無訊息"}</span>
                  <small>{new Date(thread.updatedAt).toLocaleString()}</small>
                </NavLink>
              ))}
            </div>
          ) : (
            <p className="dev-ai-workspace__muted">目前沒有已保存對話。</p>
          )}
        </aside>

        <main className="dev-ai-workspace__panel">
          <ChatHeader
            thread={activeThread}
            loading={loading}
            unavailableMessage={unavailableMessage}
          />
          {knowledgeUnavailableMessage ? (
            <p className="dev-ai-workspace__knowledge-warning">{knowledgeUnavailableMessage}</p>
          ) : null}
          {error ? <p className="dev-mode-error">{error}</p> : null}
          {activeThread?.summary ? (
            <section className="dev-ai-workspace__summary">
              <strong>Thread-local summary</strong>
              <p>{activeThread.summary}</p>
            </section>
          ) : null}
          <div className="dev-ai-workspace__messages" aria-label="對話內容">
            {detail?.messages.length ? (
              detail.messages.map((message, index) => {
                const messageArtifacts = artifactsByMessage.get(message.id) ?? [];
                const question = detail.messages
                  .slice(0, index)
                  .reverse()
                  .find((candidate) => candidate.role === "user")?.content ?? "";
                return (
                  <ConversationMessage
                    key={message.id}
                    message={message}
                    question={question}
                    artifacts={messageArtifacts}
                    knowledgeState={knowledgeSubmissionByMessage[message.id]}
                    onSubmitKnowledgeCandidate={() =>
                      handleSubmitKnowledgeCandidate(message, question, messageArtifacts)
                    }
                  />
                );
              })
            ) : (
              <EmptyConversation
                unavailableMessage={unavailableMessage}
                onPickPrompt={setDraft}
              />
            )}
            {sending ? <ThinkingCard /> : null}
          </div>
          <Composer
            draft={draft}
            speedMode={speedMode}
            includeKnowledge={includeKnowledge}
            includeDefinitions={includeDefinitions}
            sending={sending}
            disabledReason={unavailableMessage}
            knowledgeAvailable={readiness?.knowledge.available ?? false}
            onDraftChange={setDraft}
            onSpeedModeChange={setSpeedMode}
            onIncludeKnowledgeChange={setIncludeKnowledge}
            onIncludeDefinitionsChange={setIncludeDefinitions}
            onSend={handleSend}
          />
        </main>
      </div>
    </section>
  );
}

function ChatHeader({
  thread,
  loading,
  unavailableMessage,
}: {
  thread: DevAiThread | null;
  loading: boolean;
  unavailableMessage: string | null;
}) {
  return (
    <div className="dev-ai-workspace__chat-head">
      <div>
        <span className="dev-ai-workspace__eyebrow">
          {thread ? "Thread" : unavailableMessage ? "Configuration required" : "Ready"}
        </span>
        <strong>{thread?.title ?? (unavailableMessage ? "AI 對話尚未開放" : "開始一段對話")}</strong>
        <p>
          {thread
            ? `${thread.context.formPath ?? "general"} · ${thread.mode}`
            : unavailableMessage ??
              "直接問 DemoCo、Ragic、definitions 或公式；需要改公式時仍只會產草案並 dry-run。"}
        </p>
      </div>
      <div className="dev-ai-workspace__chips" aria-label="AI guardrails">
        <NavLink className="dev-ai-workspace__knowledge-link" to="/dev/knowledge">
          <BookOutlined />
          知識治理
        </NavLink>
        <span>{loading ? "同步中" : "本地 thread"}</span>
        <span>不自動進 RAG</span>
        <span>公式 dry-run only</span>
      </div>
    </div>
  );
}

export function ConversationMessage({
  message,
  question,
  artifacts,
  knowledgeState,
  onSubmitKnowledgeCandidate,
}: {
  message: DevAiThreadDetail["messages"][number];
  question: string;
  artifacts: DevAiThreadArtifact[];
  knowledgeState: "saving" | "saved" | "failed" | undefined;
  onSubmitKnowledgeCandidate: () => Promise<void>;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const chatArtifact = artifacts.find((artifact) => artifact.type === "chat-result");
  const chatPayload = objectValue(chatArtifact?.payload);
  const citedSources = devAiKnowledgeSourcesFromUnknown(
    selectDevAiCitedEvidencePayload(chatPayload)
  );
  const assumptions = stringArrayValue(chatPayload.assumptions);
  const followUps = stringArrayValue(chatPayload.followUps);
  const hasSupportingDetails = citedSources.length > 0 || assumptions.length > 0 || followUps.length > 0;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <article className={`dev-ai-workspace__message is-${message.role}`}>
      <span>{message.role === "assistant" ? "Dev AI" : "你"}</span>
      {message.role === "assistant" ? (
        <DevAiMessageContent content={message.content} format={message.metadata.answerFormat} />
      ) : (
        <p>{message.content}</p>
      )}
      {artifacts
        .filter((artifact) => artifact.type !== "chat-result" && artifact.type !== "knowledge-candidate")
        .map((artifact) => <ArtifactCard key={artifact.id} artifact={artifact} />)}
      {message.role === "assistant" ? (
        <>
          {hasSupportingDetails ? (
            <details className="dev-ai-workspace__supporting-details">
              <summary>查看回答依據</summary>
              {citedSources.length ? (
                <section>
                  <strong>實際引用</strong>
                  <ul>{citedSources.map((source) => <li key={source.sourceId}>{devAiKnowledgeSourceLabel(source)}</li>)}</ul>
                </section>
              ) : null}
              {assumptions.length ? (
                <section><strong>使用提醒</strong><ul>{assumptions.map((item) => <li key={item}>{item}</li>)}</ul></section>
              ) : null}
              {followUps.length ? (
                <section><strong>建議補充</strong><ul>{followUps.map((item) => <li key={item}>{item}</li>)}</ul></section>
              ) : null}
            </details>
          ) : null}
          <div className="dev-ai-workspace__message-actions" aria-label="回答操作">
            <button type="button" title="複製回答" aria-label="複製回答" onClick={() => void handleCopy()}><CopyOutlined /></button>
            {question ? (
              <button
                type="button"
                title="送交知識審核"
                aria-label="送交知識審核"
                disabled={knowledgeState === "saving" || knowledgeState === "saved"}
                onClick={() => void onSubmitKnowledgeCandidate()}
              ><AuditOutlined /></button>
            ) : null}
          </div>
          {copyState === "copied" ? <small className="dev-ai-workspace__action-status is-ok">回答已複製</small> : null}
          {copyState === "failed" ? <small className="dev-ai-workspace__action-status is-error">複製失敗</small> : null}
          {knowledgeState === "saving" ? <small className="dev-ai-workspace__action-status">正在送交知識審核…</small> : null}
          {knowledgeState === "saved" ? <small className="dev-ai-workspace__action-status is-ok">已送交知識審核</small> : null}
          {knowledgeState === "failed" ? <small className="dev-ai-workspace__action-status is-error">送交失敗，可重新送交</small> : null}
        </>
      ) : null}
    </article>
  );
}

function EmptyConversation({
  unavailableMessage,
  onPickPrompt,
}: {
  unavailableMessage: string | null;
  onPickPrompt: (value: string) => void;
}) {
  const promptSamples = [
    "我的 AI 資料流怎麼處理？",
    "這個欄位公式有什麼風險？",
    "幫我整理目前 definitions 脈絡",
  ];

  return (
    <div className="dev-ai-workspace__empty">
      <strong>{unavailableMessage ? "AI 對話尚未開放" : "DemoCo Dev AI 就緒"}</strong>
      <p>
        {unavailableMessage ??
          "把現場流程、Ragic definitions 或公式需求丟進來；回答會先整理內部脈絡，再回到可驗證的來源與 dry-run 結果。"}
      </p>
      {!unavailableMessage ? (
        <div className="dev-ai-workspace__prompt-grid">
          {promptSamples.map((sample) => (
            <button key={sample} type="button" onClick={() => onPickPrompt(sample)}>
              {sample}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ThinkingCard() {
  return (
    <div className="dev-ai-workspace__thinking" role="status" aria-live="polite">
      <span className="dev-ai-workspace__thinking-orbit" aria-hidden>
        <RobotOutlined />
        <i />
        <i />
      </span>
      <div>
        <strong>AI 正在判斷、檢索與整理</strong>
        <p>依速度模式控制 context，必要時查本地 knowledge / definitions，再把結果寫回本 thread。</p>
      </div>
    </div>
  );
}

function Composer({
  draft,
  speedMode,
  includeKnowledge,
  includeDefinitions,
  sending,
  disabledReason,
  knowledgeAvailable,
  onDraftChange,
  onSpeedModeChange,
  onIncludeKnowledgeChange,
  onIncludeDefinitionsChange,
  onSend,
}: {
  draft: string;
  speedMode: DevAiSpeedMode;
  includeKnowledge: boolean;
  includeDefinitions: boolean;
  sending: boolean;
  disabledReason: string | null;
  knowledgeAvailable: boolean;
  onDraftChange: (value: string) => void;
  onSpeedModeChange: (value: DevAiSpeedMode) => void;
  onIncludeKnowledgeChange: (value: boolean) => void;
  onIncludeDefinitionsChange: (value: boolean) => void;
  onSend: () => void;
}) {
  const contextStatus = devAiContextStatusLabel({
    includeKnowledge,
    includeDefinitions,
    speedMode,
  });

  return (
    <section className="dev-ai-workspace__composer" aria-label="送出 Dev AI 訊息">
      <textarea
        value={draft}
        rows={2}
        disabled={Boolean(disabledReason)}
        onChange={(event) => onDraftChange(event.target.value)}
        placeholder="想問什麼？例如：幫我確認這個公式哪裡有風險，或整理 DemoCo / Ragic 流程。"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            onSend();
          }
        }}
      />
      <div className="dev-ai-workspace__composer-bar">
        <details className="dev-ai-workspace__advanced">
          <summary>{contextStatus}</summary>
          <div className="dev-ai-workspace__options">
            <label>
              <input
                type="checkbox"
                checked={includeKnowledge}
                disabled={!knowledgeAvailable}
                onChange={(event) => onIncludeKnowledgeChange(event.target.checked)}
              />
              本地 knowledge
            </label>
            <label>
              <input
                type="checkbox"
                checked={includeDefinitions}
                onChange={(event) => onIncludeDefinitionsChange(event.target.checked)}
              />
              definitions 優先帶入
            </label>
            <select
              value={speedMode}
              onChange={(event) => onSpeedModeChange(event.target.value as DevAiSpeedMode)}
              aria-label="速度模式"
            >
              <option value="fast">Fast</option>
              <option value="balanced">Balanced</option>
              <option value="deep">Deep</option>
            </select>
          </div>
        </details>
        <button
          type="button"
          className={`dev-mode-btn dev-mode-btn--primary dev-ai-workspace__send${
            sending ? " is-loading" : ""
          }`}
          disabled={Boolean(disabledReason) || !draft.trim() || sending}
          onClick={onSend}
        >
          <SendOutlined />
          {sending ? "處理中…" : "送出"}
        </button>
      </div>
    </section>
  );
}


function ArtifactCard({ artifact }: { artifact: DevAiThreadArtifact }) {
  const payload = artifact.payload;
  const proposedFormula = stringValue(payload.proposedFormula);
  const candidateSummary = stringValue(payload.summary);
  const candidateStatus = stringValue(payload.status);
  const dryRun = objectValue(payload.dryRun);
  const allowed = booleanValue(payload.allowed) ?? booleanValue(dryRun.allowed);
  const evidence = selectDevAiCitedEvidencePayload(payload);
  const sources = Array.isArray(evidence) ? evidence.length : null;
  const sourceItems = devAiKnowledgeSourcesFromUnknown(evidence);
  return (
    <div className="dev-ai-workspace__artifact">
      <div>
        <span>
          <FileSearchOutlined />
          {artifactLabel(artifact.type)}
        </span>
        <small>{new Date(artifact.createdAt).toLocaleString()}</small>
      </div>
      {proposedFormula ? <code>{proposedFormula}</code> : null}
      {artifact.type === "knowledge-candidate" ? (
        <>
          {candidateSummary ? <p>{candidateSummary}</p> : null}
          <small>{candidateStatus === "pending" ? "待人工確認，不會自動進 RAG" : candidateStatus}</small>
        </>
      ) : null}
      {typeof allowed === "boolean" ? (
        <strong className={allowed ? "is-ok" : "is-blocked"}>
          {allowed ? "Dry-run 通過" : "Dry-run 已阻擋"}
        </strong>
      ) : null}
      {sources !== null ? <small>{sources} 個來源</small> : null}
      {sourceItems.slice(0, 3).map((source) => (
        <small key={source.sourceId}>{devAiKnowledgeSourceLabel(source)}</small>
      ))}
      {sourceItems.length > 3 ? <small>另有 {sourceItems.length - 3} 個來源</small> : null}
    </div>
  );
}

function artifactLabel(type: DevAiThreadArtifact["type"]): string {
  switch (type) {
    case "formula-suggestion":
      return "公式草案";
    case "dry-run":
      return "Dry-run";
    case "chat-result":
      return "回答來源";
    case "knowledge-candidate":
      return "候選重點";
    default:
      return type;
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

function positiveIntegerValue(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

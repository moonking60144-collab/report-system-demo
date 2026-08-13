import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import {
  FileSearchOutlined,
  InboxOutlined,
  PlusOutlined,
  RobotOutlined,
  SendOutlined,
} from "@ant-design/icons";
import {
  archiveDevAiThread,
  createDevAiThread,
  fetchDevAiThreadDetail,
  fetchDevAiThreads,
  sendDevAiThreadMessage,
  type DevAiThread,
  type DevAiThreadDetail,
} from "../../../../api/devRagicDefinitions";
import { extractErrorMessage, isUnauthorized } from "../../../../api/apiErrors";
import type {
  DevAiSendMessageRequest,
  DevAiSpeedMode,
  DevAiThreadArtifact,
} from "@shared-types/ragicDefinitions";
import { useDevContext } from "../../layout/devContext";
import {
  devAiContextStatusLabel,
  devAiKnowledgeSourceLabel,
  devAiKnowledgeSourcesFromUnknown,
} from "../../components/RagicDefinitionsAiAssistantUtils";
import { shouldApplyDevAiThreadDetailSnapshot } from "./devAiViewUtils";
import {
  resolveDevAiMessageSubmission,
  type DevAiMessageSubmission,
} from "../../utils/devAiClientMessageId";

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
  const [error, setError] = useState<string | null>(null);
  const detailRevisionRef = useRef(0);
  const sendInFlightRef = useRef(false);
  const messageSubmissionRef = useRef<DevAiMessageSubmission | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchDevAiThreads(token)
      .then((next) => {
        if (!cancelled) setThreads(next);
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
    if (!threadId) {
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
  }, [onAuthFailure, threadId, token]);

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

  return (
    <section className="dev-ai-workspace" aria-label="Dev AI workspace">
      <header className="dev-ai-workspace__hero">
        <div className="dev-ai-workspace__brand">
          <span className="dev-ai-workspace__orb" aria-hidden>
            <RobotOutlined />
          </span>
          <div>
            <span>Funda Dev AI</span>
            <h1>AI 對話工作台</h1>
            <p>延續左下 bot 的對話脈絡；thread memory 只屬於本對話，不會自動進入 RAG。</p>
          </div>
        </div>
        <div className="dev-ai-workspace__hero-actions">
          <button type="button" className="dev-mode-btn" onClick={handleNewThread}>
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
            <button type="button" className="dev-ai-workspace__icon-btn" onClick={handleNewThread} aria-label="新增對話">
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
          <ChatHeader thread={activeThread} loading={loading} />
          {error ? <p className="dev-mode-error">{error}</p> : null}
          {activeThread?.summary ? (
            <section className="dev-ai-workspace__summary">
              <strong>Thread-local summary</strong>
              <p>{activeThread.summary}</p>
            </section>
          ) : null}
          <div className="dev-ai-workspace__messages" aria-label="對話內容">
            {detail?.messages.length ? (
              detail.messages.map((message) => (
                <article key={message.id} className={`dev-ai-workspace__message is-${message.role}`}>
                  <span>{message.role === "assistant" ? "Dev AI" : "你"}</span>
                  <p>{message.content}</p>
                  {(artifactsByMessage.get(message.id) ?? []).map((artifact) => (
                    <ArtifactCard key={artifact.id} artifact={artifact} />
                  ))}
                </article>
              ))
            ) : (
              <EmptyConversation onPickPrompt={setDraft} />
            )}
            {sending ? <ThinkingCard /> : null}
          </div>
          <Composer
            draft={draft}
            speedMode={speedMode}
            includeKnowledge={includeKnowledge}
            includeDefinitions={includeDefinitions}
            sending={sending}
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

function ChatHeader({ thread, loading }: { thread: DevAiThread | null; loading: boolean }) {
  return (
    <div className="dev-ai-workspace__chat-head">
      <div>
        <span className="dev-ai-workspace__eyebrow">{thread ? "Thread" : "Ready"}</span>
        <strong>{thread?.title ?? "開始一段對話"}</strong>
        <p>
          {thread
            ? `${thread.context.formPath ?? "general"} · ${thread.mode}`
            : "直接問 Funda、Ragic、definitions 或公式；需要改公式時仍只會產草案並 dry-run。"}
        </p>
      </div>
      <div className="dev-ai-workspace__chips" aria-label="AI guardrails">
        <span>{loading ? "同步中" : "本地 thread"}</span>
        <span>不自動進 RAG</span>
        <span>公式 dry-run only</span>
      </div>
    </div>
  );
}

function EmptyConversation({ onPickPrompt }: { onPickPrompt: (value: string) => void }) {
  const promptSamples = [
    "我的 AI 資料流怎麼處理？",
    "這個欄位公式有什麼風險？",
    "幫我整理目前 definitions 脈絡",
  ];

  return (
    <div className="dev-ai-workspace__empty">
      <strong>Funda Dev AI 就緒</strong>
      <p>把現場流程、Ragic definitions 或公式需求丟進來；回答會先整理內部脈絡，再回到可驗證的來源與 dry-run 結果。</p>
      <div className="dev-ai-workspace__prompt-grid">
        {promptSamples.map((sample) => (
          <button key={sample} type="button" onClick={() => onPickPrompt(sample)}>
            {sample}
          </button>
        ))}
      </div>
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
        onChange={(event) => onDraftChange(event.target.value)}
        placeholder="想問什麼？例如：幫我確認這個公式哪裡有風險，或整理 Funda / Ragic 流程。"
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
          disabled={!draft.trim() || sending}
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
  const sources = Array.isArray(payload.sources) ? payload.sources.length : null;
  const sourceItems = devAiKnowledgeSourcesFromUnknown(payload.sources);
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

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

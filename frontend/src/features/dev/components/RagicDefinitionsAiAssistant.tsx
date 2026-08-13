import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import {
  CloseOutlined,
  CopyOutlined,
  EditOutlined,
  RobotOutlined,
  SendOutlined,
} from "@ant-design/icons";
import {
  compileDevAiKnowledge,
  createDevAiThread,
  fetchDevAiThreadDetail,
  fetchDevAiKnowledgeStatus,
  sendDevAiThreadMessage,
  storeDevAiFeedback,
  type DevAiChatResult,
  type DevAiKnowledgeStatusResult,
  type RagicFormulaAiSuggestResult,
  type RagicFormulaPatchDryRunInput,
  type RagicFormulaPatchDryRunResult,
} from "../../../api/devRagicDefinitions";
import type {
  DevAiMessageIntent,
  DevAiSendMessageRequest,
  DevAiSpeedMode,
  DevAiThread,
  DevAiThreadDetail,
} from "@shared-types/ragicDefinitions";
import { ResultList } from "./RagicDefinitionsVersionPanel";
import {
  clampDevAiLauncherPosition,
  devAiContextStatusLabel,
  devAiKnowledgeSourceLabel,
  getDevAiPanelPosition,
  isAiSuggestionForDraft,
  readDevAiLauncherPosition,
  shouldDefaultIncludeDefinitions,
  writeDevAiLauncherPosition,
  type DevAiLauncherPosition,
} from "./RagicDefinitionsAiAssistantUtils";
import { FORMULA_KIND_LABELS } from "./ragicDefinitionsExplorerUtils";
import { FormulaSyntax } from "./ragicDefinitionsSyntax";
import {
  resolveDevAiMessageSubmission,
  type DevAiMessageSubmission,
} from "../utils/devAiClientMessageId";

interface RagicDefinitionsAiAssistantProps {
  token: string;
  draft: RagicFormulaPatchDryRunInput;
  onDraftChange: Dispatch<SetStateAction<RagicFormulaPatchDryRunInput>>;
  onOpenFormulaEditor: () => void;
  onError: (err: unknown, fallback: string) => string | null;
}

const DEV_AI_LAUNCHER_VIEWPORT_MARGIN_PX = 12;
const DEV_AI_LAUNCHER_DRAG_THRESHOLD_PX = 6;
const DEV_AI_PANEL_GAP_PX = 12;

interface DevAiLauncherDragState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startPosition: DevAiLauncherPosition;
  didDrag: boolean;
}

function positionDevAiPanel(
  launcherPosition: DevAiLauncherPosition,
  launcher: HTMLButtonElement | null,
  panel: HTMLElement | null
) {
  if (!launcher || !panel) return;
  const launcherRect = launcher.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const panelPosition = getDevAiPanelPosition(
    launcherPosition,
    { width: window.innerWidth, height: window.innerHeight },
    { width: launcherRect.width, height: launcherRect.height },
    { width: panelRect.width, height: panelRect.height },
    DEV_AI_LAUNCHER_VIEWPORT_MARGIN_PX,
    DEV_AI_PANEL_GAP_PX
  );
  panel.style.left = `${panelPosition.x}px`;
  panel.style.top = `${panelPosition.y}px`;
  panel.style.right = "auto";
  panel.style.bottom = "auto";
}

export function RagicDefinitionsAiAssistant({
  token,
  draft,
  onDraftChange,
  onOpenFormulaEditor,
  onError,
}: RagicDefinitionsAiAssistantProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"formula" | "chat">("formula");
  const [speedMode, setSpeedMode] = useState<DevAiSpeedMode>("fast");
  const [includeKnowledge, setIncludeKnowledge] = useState(true);
  const [includeDefinitions, setIncludeDefinitions] = useState(() =>
    shouldDefaultIncludeDefinitions(draft.formPath)
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RagicFormulaAiSuggestResult | null>(null);
  const [chatResult, setChatResult] = useState<DevAiChatResult | null>(null);
  const [thread, setThread] = useState<DevAiThread | null>(null);
  const [threadDetail, setThreadDetail] = useState<DevAiThreadDetail | null>(null);
  const [composerText, setComposerText] = useState("");
  const [lastFormulaObjective, setLastFormulaObjective] = useState("");
  const [lastChatQuestion, setLastChatQuestion] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [feedbackState, setFeedbackState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [knowledgeStatus, setKnowledgeStatus] = useState<DevAiKnowledgeStatusResult | null>(null);
  const [knowledgeState, setKnowledgeState] = useState<"idle" | "loading" | "compiling" | "failed">("idle");
  const [launcherPosition, setLauncherPosition] = useState<DevAiLauncherPosition | null>(null);
  const [launcherDragging, setLauncherDragging] = useState(false);
  const includeDefinitionsTouchedRef = useRef(false);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const launcherPositionRef = useRef<DevAiLauncherPosition | null>(null);
  const launcherDragRef = useRef<DevAiLauncherDragState | null>(null);
  const suppressLauncherClickUntilRef = useRef(0);
  const threadSendInFlightRef = useRef(false);
  const messageSubmissionRef = useRef<DevAiMessageSubmission | null>(null);

  const targetFormPath = draft.formPath.trim();
  const targetFieldId = draft.fieldId.trim();
  const targetFormulaKind = draft.formulaKind;
  const targetDraft = useMemo(
    () => ({
      formPath: targetFormPath,
      fieldId: targetFieldId,
      formulaKind: targetFormulaKind,
    }),
    [targetFieldId, targetFormPath, targetFormulaKind]
  );
  const targetReady = Boolean(targetFormPath) && Boolean(targetFieldId);
  const targetSummary = useMemo(() => {
    if (!targetFormPath || !targetFieldId) return "尚未選取公式欄位";
    return `${targetFormPath} · ${targetFieldId}`;
  }, [targetFieldId, targetFormPath]);
  const chatContextSummary = targetFormPath
    ? `${targetFormPath} · 可附帶目前表單`
    : "本地 knowledge · 可選 definitions 檢索";
  const formulaKindLabel = FORMULA_KIND_LABELS[targetFormulaKind];
  const contextStatus = devAiContextStatusLabel({
    formPath: targetFormPath,
    fieldId: targetFieldId,
    includeKnowledge,
    includeDefinitions,
    speedMode,
  });

  const canSendThreadMessage = Boolean(composerText.trim()) && !loading;
  const activeResult = isAiSuggestionForDraft(result, targetDraft) ? result : null;

  useEffect(() => {
    setError(null);
    setCopyState("idle");
    setFeedbackState("idle");
    setResult((current) => (isAiSuggestionForDraft(current, targetDraft) ? current : null));
  }, [targetDraft]);

  useEffect(() => {
    if (includeDefinitionsTouchedRef.current) return;
    setIncludeDefinitions(shouldDefaultIncludeDefinitions(targetFormPath));
  }, [targetFormPath]);

  useEffect(() => {
    const launcher = launcherRef.current;
    if (!launcher) return;

    const rect = launcher.getBoundingClientRect();
    const storedPosition = readDevAiLauncherPosition();
    const nextPosition = clampDevAiLauncherPosition(
      storedPosition ?? { x: rect.left, y: rect.top },
      { width: window.innerWidth, height: window.innerHeight },
      { width: rect.width, height: rect.height },
      DEV_AI_LAUNCHER_VIEWPORT_MARGIN_PX
    );
    launcherPositionRef.current = nextPosition;
    setLauncherPosition(nextPosition);

    function handleResize() {
      const currentPosition = launcherPositionRef.current;
      const currentLauncher = launcherRef.current;
      if (!currentPosition || !currentLauncher) return;
      const currentRect = currentLauncher.getBoundingClientRect();
      const clampedPosition = clampDevAiLauncherPosition(
        currentPosition,
        { width: window.innerWidth, height: window.innerHeight },
        { width: currentRect.width, height: currentRect.height },
        DEV_AI_LAUNCHER_VIEWPORT_MARGIN_PX
      );
      const positionUnchanged =
        clampedPosition.x === currentPosition.x &&
        clampedPosition.y === currentPosition.y;
      positionDevAiPanel(clampedPosition, currentLauncher, panelRef.current);
      if (!positionUnchanged) {
        launcherPositionRef.current = clampedPosition;
        setLauncherPosition(clampedPosition);
        writeDevAiLauncherPosition(clampedPosition);
      }
    }

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useLayoutEffect(() => {
    if (!open || !launcherPosition) return;
    positionDevAiPanel(launcherPosition, launcherRef.current, panelRef.current);
  }, [launcherPosition, open]);

  function handleLauncherPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!event.isPrimary || event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const startPosition = launcherPositionRef.current ?? { x: rect.left, y: rect.top };
    launcherDragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPosition,
      didDrag: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setLauncherDragging(true);
  }

  function handleLauncherPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = launcherDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startClientX;
    const deltaY = event.clientY - drag.startClientY;
    if (!drag.didDrag && Math.hypot(deltaX, deltaY) < DEV_AI_LAUNCHER_DRAG_THRESHOLD_PX) {
      return;
    }
    drag.didDrag = true;
    const rect = event.currentTarget.getBoundingClientRect();
    const nextPosition = clampDevAiLauncherPosition(
      { x: drag.startPosition.x + deltaX, y: drag.startPosition.y + deltaY },
      { width: window.innerWidth, height: window.innerHeight },
      { width: rect.width, height: rect.height },
      DEV_AI_LAUNCHER_VIEWPORT_MARGIN_PX
    );
    launcherPositionRef.current = nextPosition;
    event.currentTarget.style.left = `${nextPosition.x}px`;
    event.currentTarget.style.top = `${nextPosition.y}px`;
    positionDevAiPanel(nextPosition, event.currentTarget, panelRef.current);
  }

  function finishLauncherDrag(event: ReactPointerEvent<HTMLButtonElement>, cancelled = false) {
    const drag = launcherDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    launcherDragRef.current = null;
    setLauncherDragging(false);
    if (cancelled) {
      launcherPositionRef.current = drag.startPosition;
      event.currentTarget.style.left = `${drag.startPosition.x}px`;
      event.currentTarget.style.top = `${drag.startPosition.y}px`;
      setLauncherPosition(drag.startPosition);
      positionDevAiPanel(drag.startPosition, event.currentTarget, panelRef.current);
      return;
    }
    if (!drag.didDrag) return;
    suppressLauncherClickUntilRef.current = window.performance.now() + 400;
    const currentPosition = launcherPositionRef.current;
    if (currentPosition) {
      setLauncherPosition(currentPosition);
      writeDevAiLauncherPosition(currentPosition);
    }
  }

  function handleLauncherClick() {
    if (window.performance.now() < suppressLauncherClickUntilRef.current) return;
    setOpen((current) => !current);
  }

  useEffect(() => {
    if (!open || mode !== "chat") return;
    let cancelled = false;
    setKnowledgeState((current) => (current === "idle" ? "loading" : current));
    fetchDevAiKnowledgeStatus(token)
      .then((next) => {
        if (cancelled) return;
        setKnowledgeStatus(next);
        setKnowledgeState("idle");
      })
      .catch((err) => {
        if (cancelled) return;
        onError(err, "讀取 AI knowledge 狀態失敗");
        setKnowledgeState("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [mode, onError, open, token]);

  async function ensureThread(): Promise<DevAiThread> {
    if (thread) return thread;
    const created = await createDevAiThread(token, {
      mode: "auto",
      context: targetReady
        ? {
            formPath: targetFormPath,
            fieldId: targetFieldId,
            formulaKind: targetFormulaKind,
          }
        : targetFormPath
          ? { formPath: targetFormPath }
          : {},
    });
    setThread(created);
    setThreadDetail({ thread: created, messages: [], artifacts: [] });
    return created;
  }

  async function handleThreadSend() {
    if (!canSendThreadMessage || threadSendInFlightRef.current) return;
    threadSendInFlightRef.current = true;
    const message = composerText.trim();
    setLoading(true);
    setError(null);
    setCopyState("idle");
    setFeedbackState("idle");
    try {
      const targetThread = await ensureThread();
      const payload: Omit<DevAiSendMessageRequest, "clientMessageId"> = {
        message,
        mode: "auto",
        speedMode,
        context: targetReady
          ? {
              formPath: targetFormPath,
              fieldId: targetFieldId,
              formulaKind: targetFormulaKind,
            }
          : targetFormPath
            ? { formPath: targetFormPath }
            : {},
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
      setThread(next.thread);
      setThreadDetail((current) => ({
        thread: next.thread,
        messages: [...(current?.messages ?? []), next.userMessage, next.assistantMessage],
        artifacts: [...(current?.artifacts ?? []), ...next.artifacts],
        summaryUsed: next.summaryUsed,
      }));
      if (next.chat) {
        setMode("chat");
        setChatResult(next.chat);
        setLastChatQuestion(message);
      }
      if (next.formula) {
        setMode("formula");
        setResult(next.formula);
        setLastFormulaObjective(message);
      }
      setComposerText("");
      setOpen(true);
    } catch (err) {
      const messageText = onError(err, "Dev AI 對話送出失敗");
      setError(messageText);
    } finally {
      threadSendInFlightRef.current = false;
      setLoading(false);
    }
  }

  async function handleReloadThread() {
    if (!thread) return;
    setError(null);
    try {
      setThreadDetail(await fetchDevAiThreadDetail(token, thread.id));
    } catch (err) {
      const message = onError(err, "讀取 Dev AI 對話失敗");
      setError(message);
    }
  }

  function handleOpenFullThread() {
    if (!thread) {
      window.location.href = "/dev/ai";
      return;
    }
    window.location.href = `/dev/ai/threads/${thread.id}`;
  }

  async function handleStoreChatExample() {
    if (!chatResult || feedbackState === "saving") return;
    setFeedbackState("saving");
    setError(null);
    try {
      const stored = await storeDevAiFeedback(token, {
        kind: "chat-answer",
        question: lastChatQuestion,
        answer: chatResult.answer,
        sourceIds: chatResult.sources.map((source) => source.sourceId),
      });
      if (stored.compiled?.status) setKnowledgeStatus(stored.compiled.status);
      setFeedbackState("saved");
    } catch (err) {
      const message = onError(err, "收錄 AI 回答失敗");
      setError(message);
      setFeedbackState("failed");
    }
  }

  async function handleStoreFormulaExample() {
    if (!activeResult || feedbackState === "saving") return;
    setFeedbackState("saving");
    setError(null);
    try {
      const stored = await storeDevAiFeedback(token, {
        kind: "formula-suggestion",
        objective: lastFormulaObjective,
        proposedFormula: activeResult.proposedFormula,
        explanation: activeResult.explanation,
        formPath: activeResult.formPath,
        fieldId: activeResult.fieldId,
        formulaKind: activeResult.formulaKind,
        sourceIds: activeResult.referencedFields.map((field) => field.fieldId),
      });
      if (stored.compiled?.status) setKnowledgeStatus(stored.compiled.status);
      setFeedbackState("saved");
    } catch (err) {
      const message = onError(err, "收錄公式範例失敗");
      setError(message);
      setFeedbackState("failed");
    }
  }

  async function handleCopy() {
    const text = mode === "chat" ? chatResult?.answer : result?.proposedFormula;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  function handleUseSuggestion() {
    if (!activeResult) return;
    onDraftChange((current) => ({
      ...current,
      formPath: activeResult.formPath,
      fieldId: activeResult.fieldId,
      formulaKind: activeResult.formulaKind,
      newFormula: activeResult.proposedFormula,
    }));
    onOpenFormulaEditor();
  }

  async function handleRefreshKnowledgeStatus() {
    setKnowledgeState("loading");
    setError(null);
    try {
      setKnowledgeStatus(await fetchDevAiKnowledgeStatus(token));
      setKnowledgeState("idle");
    } catch (err) {
      const message = onError(err, "讀取 AI knowledge 狀態失敗");
      setError(message);
      setKnowledgeState("failed");
    }
  }

  async function handleCompileKnowledge() {
    setKnowledgeState("compiling");
    setError(null);
    try {
      const compiled = await compileDevAiKnowledge(token);
      setKnowledgeStatus(compiled.status);
      setKnowledgeState("idle");
    } catch (err) {
      const message = onError(err, "整理 AI knowledge 失敗");
      setError(message);
      setKnowledgeState("failed");
    }
  }

  const assistant = (
    <aside
      className={`ragic-defs-ai-bot${open ? " is-open" : ""}${loading ? " is-thinking" : ""}`}
      aria-label={mode === "formula" ? "AI 公式助手" : "Funda Dev AI 問答助手"}
    >
      {open ? (
        <section
          ref={panelRef}
          className="ragic-defs-ai-bot__panel"
          role="dialog"
          aria-label="AI 公式助手"
          aria-busy={loading}
        >
          <div className="ragic-defs-ai-bot__chrome">
            <div className="ragic-defs-ai-bot__identity">
              <span className="ragic-defs-ai-bot__orb" aria-hidden>
                <RobotOutlined />
              </span>
              <div>
                <span className="ragic-defs-ai-bot__eyebrow">Funda Dev AI</span>
                <strong>AI 助手</strong>
                <small>直接描述需求，我會判斷要查知識、definitions 或公式。</small>
              </div>
            </div>
            <div className="ragic-defs-ai-bot__window-actions">
              <span className="ragic-defs-ai-bot__guard">
                {mode === "formula" ? "Dry-run only" : speedModeLabel(speedMode)}
              </span>
              <button
                type="button"
                className="ragic-defs-ai-bot__icon-btn"
                aria-label="收合 AI 公式助手"
                onClick={() => setOpen(false)}
              >
                <CloseOutlined />
              </button>
            </div>
          </div>

          <div className={`ragic-defs-ai-bot__target${targetReady ? "" : " is-empty"}`}>
            <span className="ragic-defs-ai-bot__target-label">目前脈絡</span>
            <code>{targetReady ? `${targetSummary} · ${formulaKindLabel}` : chatContextSummary}</code>
            <small>{contextStatus}</small>
          </div>

          <div className="ragic-defs-ai-bot__conversation" aria-label="AI 對話內容">
            {threadDetail?.messages.length ? (
              <AiThreadTimeline
                detail={threadDetail}
                chatResult={mode === "chat" ? chatResult : null}
                formulaResult={mode === "formula" ? activeResult : null}
                copyState={copyState}
                feedbackState={feedbackState}
                onCopy={handleCopy}
                onStoreChatExample={handleStoreChatExample}
                onUseSuggestion={handleUseSuggestion}
                onStoreFormulaExample={handleStoreFormulaExample}
              />
            ) : null}

            {loading ? <AiFormulaThinkingState mode={mode} /> : null}

            {error ? <p className="dev-mode-error ragic-defs-ai-bot__error">{error}</p> : null}

            {!threadDetail?.messages.length && !loading ? (
              <div className="ragic-defs-ai-bot__empty-state">
                <strong>用法</strong>
                <span>
                  {mode === "formula"
                    ? "選公式欄位 → 描述需求 → 取得草案與 dry-run，再決定是否帶入既有編輯器。"
                    : "把 Funda 或 definitions 問題丟進來；若本地 knowledge 不足，AI 會明確說缺哪些資料。"}
                </span>
              </div>
            ) : null}
          </div>

          <div className="ragic-defs-ai-bot__compose ragic-defs-ai-bot__compose--thread">
            <label className="ragic-defs-ai-bot__field ragic-defs-ai-bot__field--prompt">
              <textarea
                rows={3}
                value={composerText}
                onChange={(event) => setComposerText(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    void handleThreadSend();
                  }
                }}
                placeholder="問問題或描述要改的公式，例如：這個公式如果 C6 空白就不要計算。"
              />
            </label>
            <button
              type="button"
              className={`dev-mode-btn dev-mode-btn--primary ragic-defs-ai-bot__submit${
                loading ? " is-loading" : ""
              }`}
              disabled={!canSendThreadMessage}
              onClick={handleThreadSend}
            >
              <span className="ragic-defs-ai-bot__submit-icon" aria-hidden>
                <SendOutlined />
              </span>
              {loading ? "AI 正在判斷、檢索與處理…" : "送給 Dev AI"}
            </button>
            <details className="ragic-defs-ai-bot__advanced-panel">
              <summary>
                <span>進階設定</span>
                <small>
                  {contextStatus}
                </small>
              </summary>
              <div className="ragic-defs-ai-bot__chat-grid">
                <label className="ragic-defs-ai-bot__field">
                  <span>速度</span>
                  <select
                    value={speedMode}
                    onChange={(event) => setSpeedMode(event.target.value as DevAiSpeedMode)}
                  >
                    <option value="fast">Fast：少脈絡、低延遲</option>
                    <option value="balanced">Balanced：一般脈絡</option>
                    <option value="deep">Deep：更多脈絡、較慢</option>
                  </select>
                </label>
                <div className="ragic-defs-ai-bot__thread-actions" aria-label="對話操作">
                  <button type="button" className="dev-mode-btn" onClick={handleOpenFullThread}>
                    開完整頁
                  </button>
                  <button type="button" className="dev-mode-btn" disabled={!thread} onClick={handleReloadThread}>
                    重新讀取
                  </button>
                </div>
              </div>
              <div className="ragic-defs-ai-bot__options" aria-label="AI chat context 選項">
                <label>
                  <input
                    type="checkbox"
                    checked={includeKnowledge}
                    onChange={(event) => setIncludeKnowledge(event.target.checked)}
                  />
                  本地 knowledge
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={includeDefinitions}
                    onChange={(event) => {
                      includeDefinitionsTouchedRef.current = true;
                      setIncludeDefinitions(event.target.checked);
                    }}
                  />
                  definitions 優先帶入
                </label>
              </div>
              <div className="ragic-defs-ai-bot__safety" aria-label="AI 公式助手限制">
                <span>不直接套用</span>
                <span>不寫 .nui</span>
                <span>{speedModeLabel(speedMode)} mode</span>
              </div>
              {mode === "chat" ? (
                <AiKnowledgeStatusCard
                  status={knowledgeStatus}
                  state={knowledgeState}
                  onRefresh={handleRefreshKnowledgeStatus}
                  onCompile={handleCompileKnowledge}
                />
              ) : null}
            </details>
          </div>
        </section>
      ) : null}

      <button
        type="button"
        ref={launcherRef}
        className={`ragic-defs-ai-bot__launcher${launcherDragging ? " is-dragging" : ""}`}
        style={
          launcherPosition
            ? { left: launcherPosition.x, top: launcherPosition.y, right: "auto", bottom: "auto" }
            : undefined
        }
        aria-expanded={open}
        aria-label={open ? "收合 Funda Dev AI" : "開啟 Funda Dev AI"}
        title="Funda Dev AI · 可拖曳位置"
        onPointerDown={handleLauncherPointerDown}
        onPointerMove={handleLauncherPointerMove}
        onPointerUp={finishLauncherDrag}
        onPointerCancel={(event) => finishLauncherDrag(event, true)}
        onClick={handleLauncherClick}
      >
        <RobotOutlined />
        <span>AI</span>
      </button>
    </aside>
  );
  return createPortal(assistant, document.body);
}

function AiFormulaThinkingState({ mode }: { mode: "formula" | "chat" }) {
  return (
    <div className="ragic-defs-ai-bot__thinking" role="status" aria-live="polite">
      <div className="ragic-defs-ai-bot__thinking-orbit" aria-hidden>
        <RobotOutlined />
        <i />
        <i />
        <i />
      </div>
      <div className="ragic-defs-ai-bot__thinking-copy">
        <strong>{mode === "formula" ? "AI 正在處理這個公式" : "AI 正在檢索本地脈絡"}</strong>
        <span>思考中...</span>
      </div>
      <ol className="ragic-defs-ai-bot__thinking-steps" aria-label="處理階段">
        {mode === "formula" ? (
          <>
            <li>讀取目前表單與欄位脈絡</li>
            <li>產生公式草案</li>
            <li>執行 dry-run 安全檢查</li>
          </>
        ) : (
          <>
            <li>檢索本地 knowledge</li>
            <li>整理 definitions context</li>
            <li>產生可追來源回答</li>
          </>
        )}
      </ol>
    </div>
  );
}

function AiKnowledgeStatusCard({
  status,
  state,
  onRefresh,
  onCompile,
}: {
  status: DevAiKnowledgeStatusResult | null;
  state: "idle" | "loading" | "compiling" | "failed";
  onRefresh: () => void;
  onCompile: () => void;
}) {
  const busy = state === "loading" || state === "compiling";
  const approved = status?.approvedExamples.total ?? 0;
  const compiledFiles = status?.compiled.files.length ?? 0;
  const compiledEntries =
    status?.compiled.files.reduce((sum, file) => sum + file.entries, 0) ?? 0;
  const needsCompile = status?.compiled.needsCompile ?? false;
  const label = state === "compiling"
    ? "正在整理 clean knowledge…"
    : state === "loading"
      ? "讀取 knowledge 狀態…"
      : needsCompile
        ? "有新 approved 範例待整理"
        : "RAG 使用 clean knowledge";

  return (
    <section
      className={`ragic-defs-ai-bot__knowledge${needsCompile ? " needs-compile" : ""}`}
      aria-label="Dev AI knowledge 狀態"
    >
      <div className="ragic-defs-ai-bot__knowledge-head">
        <div>
          <span>Knowledge compiler</span>
          <strong>{label}</strong>
        </div>
        <span className="ragic-defs-ai-bot__knowledge-pill">
          {compiledFiles} files
        </span>
      </div>
      <p>
        Approved ledger {approved} 筆；compiled markdown {compiledEntries} 筆。RAG
        不直接吃原始對話，只吃整理後的 knowledge。
      </p>
      {status ? (
        <small>
          最後整理：{status.compiled.lastCompiledAt ?? "尚未整理"} · malformed：
          {status.approvedExamples.malformed}
        </small>
      ) : (
        <small>尚未讀取狀態。</small>
      )}
      <div className="ragic-defs-ai-bot__knowledge-actions">
        <button type="button" className="dev-mode-btn" disabled={busy} onClick={onRefresh}>
          刷新狀態
        </button>
        <button
          type="button"
          className="dev-mode-btn dev-mode-btn--primary"
          disabled={busy || !status?.enabled}
          onClick={onCompile}
        >
          整理 knowledge
        </button>
      </div>
    </section>
  );
}

function AiThreadTimeline({
  detail,
  chatResult,
  formulaResult,
  copyState,
  feedbackState,
  onCopy,
  onStoreChatExample,
  onUseSuggestion,
  onStoreFormulaExample,
}: {
  detail: DevAiThreadDetail;
  chatResult: DevAiChatResult | null;
  formulaResult: RagicFormulaAiSuggestResult | null;
  copyState: "idle" | "copied" | "failed";
  feedbackState: "idle" | "saving" | "saved" | "failed";
  onCopy: () => void;
  onStoreChatExample: () => void;
  onUseSuggestion: () => void;
  onStoreFormulaExample: () => void;
}) {
  const visibleMessages = detail.messages.slice(-8);
  const latestAssistantMessageId = [...visibleMessages]
    .reverse()
    .find((message) => message.role === "assistant")?.id;
  const latestAssistantRef = useRef<HTMLElement | null>(null);
  const focusedMessageIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!latestAssistantMessageId || focusedMessageIdRef.current === latestAssistantMessageId) return;
    focusedMessageIdRef.current = latestAssistantMessageId;
    const frame = window.requestAnimationFrame(() => {
      const target = latestAssistantRef.current;
      if (!target) return;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [latestAssistantMessageId]);

  return (
    <section className="ragic-defs-ai-bot__timeline" aria-label="Dev AI 對話紀錄">
      <div className="ragic-defs-ai-bot__timeline-head">
        <strong>對話</strong>
        <span>{detail.messages.length} 則</span>
      </div>
      {detail.thread.summary ? (
        <div className="ragic-defs-ai-bot__summary">
          <span>Thread summary</span>
          <p>{detail.thread.summary}</p>
        </div>
      ) : null}
      <div className="ragic-defs-ai-bot__messages">
        {visibleMessages.map((message) => {
          const isLatestAssistant = message.id === latestAssistantMessageId;
          const embeddedChat = isLatestAssistant ? chatResult : null;
          const embeddedFormula = isLatestAssistant ? formulaResult : null;
          return (
            <article
              key={message.id}
              ref={isLatestAssistant ? latestAssistantRef : undefined}
              tabIndex={isLatestAssistant ? -1 : undefined}
              className={`ragic-defs-ai-bot__message is-${message.role}${
                isLatestAssistant ? " is-latest" : ""
              }`}
            >
              <span>
                {message.role === "assistant" ? "Dev AI" : "你"}
                {message.intent ? ` · ${intentLabel(message.intent)}` : ""}
              </span>
              {embeddedFormula ? (
                <AiFormulaSuggestionResult
                  result={embeddedFormula}
                  copyState={copyState}
                  feedbackState={feedbackState}
                  onCopy={onCopy}
                  onUseSuggestion={onUseSuggestion}
                  onStoreExample={onStoreFormulaExample}
                />
              ) : (
                <>
                  <p>{message.content}</p>
                  {embeddedChat ? (
                    <AiChatResult
                      result={embeddedChat}
                      copyState={copyState}
                      feedbackState={feedbackState}
                      onCopy={onCopy}
                      onStoreExample={onStoreChatExample}
                      showAnswer={false}
                    />
                  ) : null}
                </>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function AiChatResult({
  result,
  copyState,
  feedbackState,
  onCopy,
  onStoreExample,
  showAnswer = true,
}: {
  result: DevAiChatResult;
  copyState: "idle" | "copied" | "failed";
  feedbackState: "idle" | "saving" | "saved" | "failed";
  onCopy: () => void;
  onStoreExample: () => void;
  showAnswer?: boolean;
}) {
  return (
    <div className="ragic-defs-ai-bot__result">
      <div className="ragic-defs-ai-bot__result-head">
        <div>
          <span>
            {result.mode === "definitions" ? "Definitions RAG" : "General RAG"} ·{" "}
            {speedModeLabel(result.speedMode)}
          </span>
          <strong>{showAnswer ? "AI 回答" : "來源與操作"}</strong>
        </div>
        <span className="ragic-defs-ai-bot__confidence is-medium">{result.latencyMs}ms</span>
      </div>
      {showAnswer ? <p className="ragic-defs-ai-bot__answer">{result.answer}</p> : null}

      <details className="ragic-defs-ai-bot__result-details">
        <summary>
          <span>來源與限制</span>
          <small>
            {result.contextPreview.knowledgeItems + result.contextPreview.definitionItems} 份脈絡 ·{" "}
            {result.sources.length} 來源
          </small>
        </summary>
        <dl className="ragic-defs-ai-bot__context">
          <div>
            <dt>Context</dt>
            <dd>
              {result.contextPreview.knowledgeItems} knowledge ·{" "}
              {result.contextPreview.definitionItems} definitions · {result.contextPreview.chars} chars
            </dd>
          </div>
        </dl>
        {result.sources.length ? (
          <ResultList
            title="來源"
            tone="warn"
            items={result.sources.map(devAiKnowledgeSourceLabel)}
          />
        ) : null}
        {result.assumptions.length ? (
          <ResultList title="假設 / 限制" tone="warn" items={result.assumptions} />
        ) : null}
        {result.followUps.length ? (
          <ResultList title="建議補充" tone="warn" items={result.followUps} />
        ) : null}
      </details>

      <div className="ragic-defs-ai-bot__actions">
        <button type="button" className="dev-mode-btn" onClick={onCopy}>
          <CopyOutlined />
          複製回答
        </button>
        <button
          type="button"
          className="dev-mode-btn"
          disabled={feedbackState === "saving"}
          onClick={onStoreExample}
        >
          收錄成範例
        </button>
      </div>
      {copyState === "copied" ? <span className="ragic-defs-ai-bot__copy is-ok">回答已複製</span> : null}
      {copyState === "failed" ? <span className="ragic-defs-ai-bot__copy is-blocked">複製失敗</span> : null}
      <AiFeedbackStatus state={feedbackState} />
    </div>
  );
}

function AiFormulaSuggestionResult({
  result,
  copyState,
  feedbackState,
  onCopy,
  onUseSuggestion,
  onStoreExample,
}: {
  result: RagicFormulaAiSuggestResult;
  copyState: "idle" | "copied" | "failed";
  feedbackState: "idle" | "saving" | "saved" | "failed";
  onCopy: () => void;
  onUseSuggestion: () => void;
  onStoreExample: () => void;
}) {
  const blocked = result.dryRun.blockers.length > 0 || !result.dryRun.allowed;
  const confidenceClass = blocked ? "is-blocked" : `is-${result.confidence}`;
  return (
    <div className="ragic-defs-ai-bot__result">
      <div className="ragic-defs-ai-bot__result-head">
        <div>
          <span>{blocked ? "Dry-run 已阻擋" : "可進入編輯"}</span>
          <strong>{blocked ? "公式不可直接套用" : "建議公式"}</strong>
        </div>
        <span className={`ragic-defs-ai-bot__confidence ${confidenceClass}`}>
          {blocked ? "已阻擋" : confidenceLabel(result.confidence)}
        </span>
      </div>
      <FormulaSyntax value={result.proposedFormula} block />
      <p>{result.explanation || "AI 未提供說明。"}</p>

      <AiDryRunSummary result={result.dryRun} />
      <details className="ragic-defs-ai-bot__result-details">
        <summary>
          <span>查看依據與風險</span>
          <small>
            {result.contextPreview.fields} 欄 · {result.referencedFields.length} 引用
          </small>
        </summary>
        <dl className="ragic-defs-ai-bot__context">
          <div>
            <dt>Context</dt>
            <dd>
              {result.contextPreview.fields} 欄 · {result.contextPreview.formulas} 公式 ·{" "}
              {result.contextPreview.siblings} 兄弟 · {result.contextPreview.similarItems} 相似
            </dd>
          </div>
        </dl>
        {result.referencedFields.length ? (
          <ResultList
            title="AI 引用欄位"
            tone="warn"
            items={result.referencedFields.map(
              (field) => `${field.position} · ${field.name || field.fieldId}：${field.reason}`
            )}
          />
        ) : null}
        {result.assumptions.length ? (
          <ResultList title="假設" tone="warn" items={result.assumptions} />
        ) : null}
        {result.risks.length ? (
          <ResultList title="風險" tone="danger" items={result.risks} />
        ) : null}
      </details>

      <div className="ragic-defs-ai-bot__actions">
        <button type="button" className="dev-mode-btn" onClick={onCopy}>
          <CopyOutlined />
          複製
        </button>
        <button
          type="button"
          className="dev-mode-btn"
          disabled={feedbackState === "saving"}
          onClick={onStoreExample}
        >
          收錄範例
        </button>
        <button
          type="button"
          className={`dev-mode-btn${blocked ? "" : " dev-mode-btn--primary"}`}
          onClick={onUseSuggestion}
        >
          <EditOutlined />
          {blocked ? "帶入編輯器修正" : "帶入編輯器"}
        </button>
      </div>
      {copyState === "copied" ? <span className="ragic-defs-ai-bot__copy is-ok">公式已複製</span> : null}
      {copyState === "failed" ? <span className="ragic-defs-ai-bot__copy is-blocked">複製失敗</span> : null}
      <AiFeedbackStatus state={feedbackState} />
    </div>
  );
}

function AiFeedbackStatus({
  state,
}: {
  state: "idle" | "saving" | "saved" | "failed";
}) {
  if (state === "idle") return null;
  if (state === "saving") {
    return <span className="ragic-defs-ai-bot__feedback is-saving">正在收錄到本地 knowledge…</span>;
  }
  if (state === "saved") {
    return <span className="ragic-defs-ai-bot__feedback is-ok">已收錄並整理成 clean knowledge。</span>;
  }
  return <span className="ragic-defs-ai-bot__feedback is-blocked">收錄失敗</span>;
}

function AiDryRunSummary({ result }: { result: RagicFormulaPatchDryRunResult }) {
  const blocked = result.blockers.length > 0 || !result.allowed;
  return (
    <div className={`ragic-defs-ai-bot__dryrun${blocked ? " is-blocked" : " is-ok"}`}>
      <div className="ragic-defs-ai-bot__dryrun-head">
        <strong>{blocked ? "Dry-run 阻擋" : "Dry-run 通過"}</strong>
        <code>
          {result.formPath} · {result.fieldId} · {result.position ?? "未定位"}
        </code>
      </div>
      {result.warnings.length ? (
        <ResultList title="警告" tone="warn" items={result.warnings} />
      ) : null}
      {result.blockers.length ? (
        <ResultList title="阻擋原因" tone="danger" items={result.blockers} />
      ) : null}
      {result.oldLinePreview || result.newLinePreview ? (
        <div className="ragic-defs-ai-bot__diff">
          {result.oldLinePreview ? <code>- {result.oldLinePreview}</code> : null}
          {result.newLinePreview ? <code>+ {result.newLinePreview}</code> : null}
        </div>
      ) : null}
    </div>
  );
}

function confidenceLabel(confidence: RagicFormulaAiSuggestResult["confidence"]): string {
  switch (confidence) {
    case "high":
      return "高信心";
    case "medium":
      return "中信心";
    default:
      return "低信心";
  }
}

function speedModeLabel(speedMode: DevAiSpeedMode): string {
  switch (speedMode) {
    case "deep":
      return "Deep";
    case "balanced":
      return "Balanced";
    default:
      return "Fast";
  }
}

function intentLabel(intent: DevAiMessageIntent): string {
  switch (intent) {
    case "formula":
      return "公式";
    case "definitions":
      return "Definitions";
    case "clarify":
      return "需釐清";
    default:
      return "一般";
  }
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import {
  BookOutlined,
  CheckOutlined,
  CloseOutlined,
  ReloadOutlined,
  RobotOutlined,
  SaveOutlined,
  SearchOutlined,
  SyncOutlined,
} from "@ant-design/icons";
import {
  approveDevAiKnowledgeCandidate,
  compileDevAiKnowledge,
  fetchDevAiKnowledgeCandidates,
  fetchDevAiKnowledgeRuntimeStatus,
  fetchDevAiKnowledgeStatus,
  rejectDevAiKnowledgeCandidate,
  updateDevAiKnowledgeCandidate,
  type DevAiKnowledgeCandidate,
  type DevAiKnowledgeCandidateListResult,
  type DevAiKnowledgeCandidateStatus,
  type DevAiKnowledgeDomain,
  type DevAiKnowledgeRuntimeStatus,
  type DevAiKnowledgeStatusResult,
} from "../../../../api/devRagicDefinitions";
import type { DevAiFeedbackKind, DevAiFeedbackRequest } from "@shared-types/ragicDefinitions";
import { extractErrorMessage, isUnauthorized } from "../../../../api/apiErrors";
import { useDevContext } from "../../layout/devContext";
import {
  knowledgeCandidateKindLabel,
  knowledgeCandidateStatusLabel,
  knowledgeDomainLabel,
  hasKnowledgeCandidateUnsavedChanges,
  mergeKnowledgeCandidatePages,
} from "./devKnowledgeViewUtils";

type StatusFilter = DevAiKnowledgeCandidateStatus | "all";
type KindFilter = DevAiFeedbackKind | "all";

const EMPTY_RESULT: DevAiKnowledgeCandidateListResult = {
  items: [],
  counts: { total: 0, pending: 0, publishing: 0, approved: 0, rejected: 0 },
  hasMore: false,
  nextCursor: null,
};

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: "pending", label: "待審核" },
  { value: "publishing", label: "發布中" },
  { value: "approved", label: "已發布" },
  { value: "rejected", label: "已拒絕" },
  { value: "all", label: "全部" },
];

function runtimeStatusLabel(status: DevAiKnowledgeRuntimeStatus | null): string {
  if (!status) return "讀取中";
  if (status.retrievalMode === "lexical") return "Lexical";
  switch (status.index.state) {
    case "ready":
      return "Vector ready";
    case "stale":
      return "Vector stale";
    case "error":
      return "Vector error";
    default:
      return "尚未準備";
  }
}

function runtimeStatusDetail(status: DevAiKnowledgeRuntimeStatus | null): string {
  if (!status) return "正在讀取不啟動模型的狀態快照";
  if (status.retrievalMode === "lexical") {
    return `${status.documents} 份文件 · 目前不使用 embedding 或 vector index`;
  }
  const chunks = `${status.index.storedChunks}/${status.index.expectedChunks} chunks`;
  const checked = status.index.updatedAt
    ? ` · 索引更新 ${new Date(status.index.updatedAt).toLocaleString()}`
    : "";
  const model = status.embedding.state === "prepared"
    ? "模型與索引已由 knowledge:prepare 驗證"
    : "模型需由 knowledge:prepare 明確驗證";
  return `${status.retrievalMode} · ${chunks}${checked} · ${model}`;
}

export function DevKnowledgeView() {
  const { token, onAuthFailure } = useDevContext();
  const [result, setResult] = useState<DevAiKnowledgeCandidateListResult>(EMPTY_RESULT);
  const [knowledgeStatus, setKnowledgeStatus] = useState<DevAiKnowledgeStatusResult | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<DevAiKnowledgeRuntimeStatus | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("pending");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [searchDraft, setSearchDraft] = useState("");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DevAiKnowledgeCandidate | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const candidateRequestRef = useRef<{
    revision: number;
    controller: AbortController | null;
  }>({ revision: 0, controller: null });

  const loadCandidates = useCallback(async (
    options: { append?: boolean; cursor?: string | null } = {}
  ) => {
    const append = options.append === true;
    const revision = candidateRequestRef.current.revision + 1;
    candidateRequestRef.current.controller?.abort();
    const controller = new AbortController();
    candidateRequestRef.current = { revision, controller };
    if (append) setLoadingMore(true);
    else setLoading(true);
    if (!append) setError(null);
    try {
      const next = await fetchDevAiKnowledgeCandidates(token, {
        ...(statusFilter !== "all" ? { status: statusFilter } : {}),
        ...(kindFilter !== "all" ? { kind: kindFilter } : {}),
        ...(query ? { query } : {}),
        ...(options.cursor ? { cursor: options.cursor } : {}),
        limit: 50,
      }, { signal: controller.signal });
      if (revision !== candidateRequestRef.current.revision) return;
      setResult((current) => append ? mergeKnowledgeCandidatePages(current, next) : next);
      if (!append) {
        setSelectedId((current) =>
          current && next.items.some((item) => item.id === current)
            ? current
            : next.items[0]?.id ?? null
        );
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(extractErrorMessage(err, "讀取知識候選失敗"));
      if (isUnauthorized(err)) onAuthFailure("登入已過期，請重新登入");
    } finally {
      if (revision === candidateRequestRef.current.revision) {
        candidateRequestRef.current.controller = null;
        if (append) setLoadingMore(false);
        else setLoading(false);
      }
    }
  }, [kindFilter, onAuthFailure, query, statusFilter, token]);

  const loadKnowledgeStatus = useCallback(async () => {
    try {
      const [compiled, runtime] = await Promise.all([
        fetchDevAiKnowledgeStatus(token),
        fetchDevAiKnowledgeRuntimeStatus(token),
      ]);
      setKnowledgeStatus(compiled);
      setRuntimeStatus(runtime);
    } catch (err) {
      if (isUnauthorized(err)) onAuthFailure("登入已過期，請重新登入");
    }
  }, [onAuthFailure, token]);

  useEffect(() => {
    void loadCandidates();
    return () => candidateRequestRef.current.controller?.abort();
  }, [loadCandidates]);

  useEffect(() => {
    void loadKnowledgeStatus();
  }, [loadKnowledgeStatus]);

  const selected = useMemo(
    () => result.items.find((item) => item.id === selectedId) ?? null,
    [result.items, selectedId]
  );

  useEffect(() => {
    const selectedChanged = draft?.id !== selected?.id;
    const reviewNoteChanged = reviewNote !== (draft?.reviewNote ?? "");
    if (!selectedChanged && (dirty || reviewNoteChanged)) return;
    setDraft(selected ? structuredClone(selected) : null);
    setReviewNote(selected?.reviewNote ?? "");
    setDirty(false);
  }, [dirty, draft?.id, draft?.reviewNote, reviewNote, selected]);

  const hasUnsavedChanges = hasKnowledgeCandidateUnsavedChanges(
    draft,
    dirty,
    reviewNote
  );
  const openCount = result.counts.pending + result.counts.publishing;
  const resolvedCount = result.counts.approved + result.counts.rejected;

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedChanges]);

  function confirmDiscardChanges(): boolean {
    if (!hasUnsavedChanges) return true;
    if (!window.confirm("目前修改或審核備註尚未送出，確定放棄並切換？")) return false;
    setDirty(false);
    setReviewNote(selected?.reviewNote ?? "");
    return true;
  }

  function handleSelect(candidate: DevAiKnowledgeCandidate) {
    if (candidate.id === selectedId) return;
    if (!confirmDiscardChanges()) return;
    setNotice(null);
    setSelectedId(candidate.id);
  }

  function handleStatusFilterChange(next: StatusFilter) {
    if (next === statusFilter || !confirmDiscardChanges()) return;
    setNotice(null);
    setStatusFilter(next);
  }

  function handleKindFilterChange(next: KindFilter) {
    if (next === kindFilter || !confirmDiscardChanges()) return;
    setNotice(null);
    setKindFilter(next);
  }

  function handleSearch() {
    const next = searchDraft.trim();
    if (next === query || !confirmDiscardChanges()) return;
    setNotice(null);
    setQuery(next);
  }

  function handleReload() {
    if (!confirmDiscardChanges()) return;
    setNotice(null);
    void Promise.all([loadCandidates(), loadKnowledgeStatus()]);
  }

  function updateDraft(update: (current: DevAiKnowledgeCandidate) => DevAiKnowledgeCandidate) {
    setDraft((current) => (current ? update(current) : current));
    setDirty(true);
    setNotice(null);
  }

  function updatePayload(patch: Partial<DevAiFeedbackRequest>) {
    updateDraft((current) => ({
      ...current,
      payload: { ...current.payload, ...patch } as DevAiFeedbackRequest,
    }));
  }

  async function handleSave() {
    if (!draft || draft.status !== "pending" || saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await updateDevAiKnowledgeCandidate(token, draft.id, {
        title: draft.title,
        domain: draft.domain,
        payload: draft.payload,
      });
      setResult((current) => ({
        ...current,
        items: current.items.map((item) => (item.id === updated.id ? updated : item)),
      }));
      setDraft(updated);
      setDirty(false);
      setNotice("候選知識已儲存，尚未發布。");
    } catch (err) {
      setError(extractErrorMessage(err, "儲存候選知識失敗"));
      if (isUnauthorized(err)) onAuthFailure("登入已過期，請重新登入");
    } finally {
      setSaving(false);
    }
  }

  async function handleApprove() {
    if (
      !draft ||
      (draft.status !== "pending" && draft.status !== "publishing") ||
      publishing
    ) return;
    if (draft.status === "pending" && dirty) {
      setError("請先儲存目前修改，再核准發布。");
      return;
    }
    const retrying = draft.status === "publishing";
    if (!window.confirm(
      retrying
        ? `重新完成「${draft.title}」的知識發布？`
        : `核准「${draft.title}」並發布到目前 Dev AI knowledge？`
    )) return;
    setPublishing(true);
    setError(null);
    try {
      await approveDevAiKnowledgeCandidate(token, draft.id, reviewNote);
      setNotice(retrying
        ? "知識發布已恢復並完成。"
        : "知識已核准並發布到文字知識庫。");
      await Promise.all([loadCandidates(), loadKnowledgeStatus()]);
    } catch (err) {
      const message = extractErrorMessage(err, "核准知識失敗");
      await loadCandidates();
      setError(message);
      if (isUnauthorized(err)) onAuthFailure("登入已過期，請重新登入");
    } finally {
      setPublishing(false);
    }
  }

  async function handleReject() {
    if (!draft || draft.status !== "pending" || publishing) return;
    if (dirty) {
      setError("請先儲存目前修改，再拒絕候選。");
      return;
    }
    if (!window.confirm(`拒絕「${draft.title}」？這筆內容不會進入 RAG。`)) return;
    setPublishing(true);
    setError(null);
    try {
      await rejectDevAiKnowledgeCandidate(token, draft.id, reviewNote);
      setNotice("候選已拒絕，不會進入 RAG。");
      await loadCandidates();
    } catch (err) {
      setError(extractErrorMessage(err, "拒絕候選知識失敗"));
      if (isUnauthorized(err)) onAuthFailure("登入已過期，請重新登入");
    } finally {
      setPublishing(false);
    }
  }

  async function handleCompile() {
    if (publishing) return;
    setPublishing(true);
    setError(null);
    try {
      const compiled = await compileDevAiKnowledge(token);
      setKnowledgeStatus(compiled.status);
      await loadKnowledgeStatus();
      setNotice("文字知識已重新編譯完成。");
    } catch (err) {
      setError(extractErrorMessage(err, "重新整理 knowledge 失敗"));
      if (isUnauthorized(err)) onAuthFailure("登入已過期，請重新登入");
    } finally {
      setPublishing(false);
    }
  }

  return (
    <section className="dev-knowledge" aria-label="Dev AI 知識治理中心">
      <header className="dev-knowledge__header">
        <div>
          <span className="dev-knowledge__eyebrow">
            <BookOutlined />
            DEV AI
          </span>
          <h1>知識審核與發布</h1>
          <p>確認問答、公式與來源；只有核准內容會提供給 Dev AI 檢索。</p>
        </div>
        <div className="dev-knowledge__header-actions">
          <NavLink className="dev-mode-btn" to="/dev/ai">
            <RobotOutlined />
            AI 對話
          </NavLink>
          <button type="button" className="dev-mode-btn" onClick={handleReload}>
            <ReloadOutlined />
            重新整理
          </button>
        </div>
      </header>

      <section className="dev-knowledge__overview" aria-label="知識治理總覽">
        <div className="dev-knowledge__overview-stat is-primary">
          <span>待處理</span>
          <strong>{openCount}</strong>
          <small>{result.counts.pending} 待審核 · {result.counts.publishing} 發布中</small>
        </div>
        <div className="dev-knowledge__overview-stat">
          <span>治理完成</span>
          <strong>{resolvedCount}</strong>
          <small>{result.counts.approved} 已發布 · {result.counts.rejected} 已拒絕</small>
        </div>
        <div className="dev-knowledge__overview-index">
          <div>
            <span>文字知識編譯</span>
            <strong>
              {knowledgeStatus
                ? knowledgeStatus.compiled.needsCompile
                  ? "待重建"
                  : `${knowledgeStatus.approvedExamples.total} 筆`
                : "讀取中"}
            </strong>
            <small>
              {knowledgeStatus?.compiled.lastCompiledAt
                ? `上次更新 ${new Date(knowledgeStatus.compiled.lastCompiledAt).toLocaleString()}`
                : "尚未建立編譯知識"}
            </small>
          </div>
          <div>
            <span>Retrieval runtime</span>
            <strong>{runtimeStatusLabel(runtimeStatus)}</strong>
            <small>{runtimeStatusDetail(runtimeStatus)}</small>
          </div>
          <button
            type="button"
            disabled={publishing || !knowledgeStatus?.approvedExamples.total}
            onClick={() => void handleCompile()}
          >
            <SyncOutlined />
            重建索引
          </button>
        </div>
      </section>

      <section className="dev-knowledge__toolbar" aria-label="知識篩選">
        <div className="dev-knowledge__status-tabs" role="tablist" aria-label="狀態">
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              role="tab"
              aria-selected={statusFilter === filter.value}
              className={statusFilter === filter.value ? "is-active" : ""}
              onClick={() => handleStatusFilterChange(filter.value)}
            >
              {filter.label}
              <span>{filter.value === "all" ? result.counts.total : result.counts[filter.value]}</span>
            </button>
          ))}
        </div>
        <form
          className="dev-knowledge__search"
          onSubmit={(event) => {
            event.preventDefault();
            handleSearch();
          }}
        >
          <label className="dev-knowledge__search-input">
            <SearchOutlined aria-hidden="true" />
            <input
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder="搜尋標題、問題、公式或 Field ID"
              aria-label="搜尋知識"
            />
          </label>
          <select
            value={kindFilter}
            onChange={(event) => handleKindFilterChange(event.target.value as KindFilter)}
            aria-label="知識類型"
          >
            <option value="all">全部類型</option>
            <option value="chat-answer">問答</option>
            <option value="formula-suggestion">公式</option>
          </select>
          <button type="submit">搜尋</button>
        </form>
      </section>

      {error ? <p className="dev-mode-error dev-knowledge__feedback">{error}</p> : null}
      {notice ? <p className="dev-knowledge__notice">{notice}</p> : null}

      <div className={`dev-knowledge__workspace${result.items.length ? "" : " is-empty"}`}>
        {result.items.length ? (
          <>
            <aside className="dev-knowledge__list" aria-label="候選知識列表">
              <div className="dev-knowledge__list-head">
                <strong>{loading ? "更新中…" : `${result.items.length} 筆候選`}</strong>
                <span>共 {result.counts.total} 筆治理紀錄</span>
              </div>
              <div className="dev-knowledge__rows">
                {result.items.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    className={candidate.id === selectedId ? "is-active" : ""}
                    onClick={() => handleSelect(candidate)}
                  >
                    <span className={`dev-knowledge__status is-${candidate.status}`}>
                      {knowledgeCandidateStatusLabel(candidate.status)}
                    </span>
                    <strong>{candidate.title}</strong>
                    <small>
                      {knowledgeCandidateKindLabel(candidate.kind)} · {knowledgeDomainLabel(candidate.domain)}
                    </small>
                    <time>{new Date(candidate.updatedAt).toLocaleString()}</time>
                  </button>
                ))}
                {result.hasMore ? (
                  <button
                    type="button"
                    className="dev-knowledge__load-more"
                    disabled={loadingMore || !result.nextCursor}
                    onClick={() => void loadCandidates({
                      append: true,
                      cursor: result.nextCursor,
                    })}
                  >
                    {loadingMore ? "載入中…" : "載入更多候選"}
                  </button>
                ) : null}
              </div>
            </aside>

            <main className="dev-knowledge__editor">
              {draft ? (
                <KnowledgeEditor
                  candidate={draft}
                  reviewNote={reviewNote}
                  dirty={dirty}
                  hasUnsavedChanges={hasUnsavedChanges}
                  saving={saving}
                  publishing={publishing}
                  onReviewNoteChange={(value) => {
                    setReviewNote(value);
                    setNotice(null);
                  }}
                  onDraftChange={updateDraft}
                  onPayloadChange={updatePayload}
                  onSave={() => void handleSave()}
                  onApprove={() => void handleApprove()}
                  onReject={() => void handleReject()}
                />
              ) : (
                <div className="dev-knowledge__editor-empty">
                  <BookOutlined />
                  <h2>選擇一筆知識開始檢視</h2>
                  <p>核對問題、答案與來源後，再決定是否發布到 Dev AI。</p>
                </div>
              )}
            </main>
          </>
        ) : (
          <div className="dev-knowledge__workspace-empty" role="status" aria-live="polite">
            <BookOutlined />
            <strong>{loading ? "正在讀取知識…" : "這個篩選目前沒有候選知識"}</strong>
            <p>
              {loading
                ? "正在取得最新治理狀態。"
                : "調整狀態或搜尋條件，或從 AI 回答送交新的知識候選。"}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function KnowledgeEditor({
  candidate,
  reviewNote,
  dirty,
  hasUnsavedChanges,
  saving,
  publishing,
  onReviewNoteChange,
  onDraftChange,
  onPayloadChange,
  onSave,
  onApprove,
  onReject,
}: {
  candidate: DevAiKnowledgeCandidate;
  reviewNote: string;
  dirty: boolean;
  hasUnsavedChanges: boolean;
  saving: boolean;
  publishing: boolean;
  onReviewNoteChange: (value: string) => void;
  onDraftChange: (update: (current: DevAiKnowledgeCandidate) => DevAiKnowledgeCandidate) => void;
  onPayloadChange: (patch: Partial<DevAiFeedbackRequest>) => void;
  onSave: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const editable = candidate.status === "pending";
  const retryable = candidate.status === "publishing";
  const payload = candidate.payload;
  return (
    <>
      <header className="dev-knowledge__editor-head">
        <div>
          <span className={`dev-knowledge__status is-${candidate.status}`}>
            {knowledgeCandidateStatusLabel(candidate.status)}
          </span>
          <small>{candidate.id}</small>
        </div>
        <strong>
          {hasUnsavedChanges
            ? "有尚未送出的修改"
            : editable
              ? "可編輯候選"
              : retryable
                ? "發布未完成，可安全重試"
                : "唯讀發布紀錄"}
        </strong>
      </header>

      <div className="dev-knowledge__form">
        <label className="is-wide">
          <span>知識標題</span>
          <input
            value={candidate.title}
            disabled={!editable}
            onChange={(event) =>
              onDraftChange((current) => ({ ...current, title: event.target.value }))
            }
          />
        </label>
        <label>
          <span>知識域</span>
          <select
            value={candidate.domain}
            disabled={!editable}
            onChange={(event) =>
              onDraftChange((current) => ({
                ...current,
                domain: event.target.value as DevAiKnowledgeDomain,
              }))
            }
          >
            <option value="ragic">Ragic／報工</option>
            <option value="definitions">Definitions／公式</option>
            <option value="internal-sop">內部 SOP</option>
            <option value="meeting">會議決議</option>
          </select>
        </label>
        <label>
          <span>類型</span>
          <input value={knowledgeCandidateKindLabel(candidate.kind)} disabled />
        </label>

        {payload.kind === "chat-answer" ? (
          <>
            <label className="is-wide">
              <span>標準問題</span>
              <textarea
                rows={3}
                value={payload.question ?? ""}
                disabled={!editable}
                onChange={(event) => onPayloadChange({ question: event.target.value })}
              />
            </label>
            <label className="is-wide">
              <span>核准答案</span>
              <textarea
                rows={10}
                value={payload.answer ?? ""}
                disabled={!editable}
                onChange={(event) => onPayloadChange({ answer: event.target.value })}
              />
            </label>
          </>
        ) : (
          <>
            <label className="is-wide">
              <span>需求／適用情境</span>
              <textarea
                rows={3}
                value={payload.objective ?? ""}
                disabled={!editable}
                onChange={(event) => onPayloadChange({ objective: event.target.value })}
              />
            </label>
            <label>
              <span>Form path</span>
              <input
                value={payload.formPath ?? ""}
                disabled={!editable}
                onChange={(event) => onPayloadChange({ formPath: event.target.value })}
              />
            </label>
            <label>
              <span>Field ID</span>
              <input
                value={payload.fieldId ?? ""}
                disabled={!editable}
                onChange={(event) => onPayloadChange({ fieldId: event.target.value })}
              />
            </label>
            <label className="is-wide">
              <span>建議公式</span>
              <textarea
                className="is-code"
                rows={5}
                value={payload.proposedFormula ?? ""}
                disabled={!editable}
                onChange={(event) => onPayloadChange({ proposedFormula: event.target.value })}
              />
            </label>
            <label className="is-wide">
              <span>說明與限制</span>
              <textarea
                rows={5}
                value={payload.explanation ?? ""}
                disabled={!editable}
                onChange={(event) => onPayloadChange({ explanation: event.target.value })}
              />
            </label>
          </>
        )}

        <label className="is-wide">
          <span>補充備註</span>
          <textarea
            rows={3}
            value={payload.notes ?? ""}
            disabled={!editable}
            onChange={(event) => onPayloadChange({ notes: event.target.value })}
          />
        </label>

        <section className="dev-knowledge__source-block">
          <div>
            <strong>來源與追溯</strong>
            <span>{payload.sourceIds?.length ?? 0} 個引用來源</span>
          </div>
          {payload.sourceIds?.length ? (
            <ul>
              {payload.sourceIds.map((sourceId) => <li key={sourceId}>{sourceId}</li>)}
            </ul>
          ) : (
            <p>目前沒有來源；核准前應確認答案是否有足夠證據。</p>
          )}
          <dl>
            <div><dt>建立者</dt><dd>{candidate.createdBy}</dd></div>
            <div><dt>最後編輯者</dt><dd>{candidate.updatedBy}</dd></div>
            <div><dt>來源 Thread</dt><dd>{candidate.sourceThreadId ?? "—"}</dd></div>
            <div><dt>來源 Message</dt><dd>{candidate.sourceMessageId ?? "—"}</dd></div>
          </dl>
        </section>

        <label className="is-wide">
          <span>審核備註</span>
          <textarea
            rows={3}
            value={reviewNote}
            disabled={!editable}
            onChange={(event) => onReviewNoteChange(event.target.value)}
            placeholder="記錄來源確認、拒絕原因或適用範圍"
          />
        </label>
      </div>

      <footer className="dev-knowledge__editor-actions">
        {editable ? (
          <>
            <button type="button" className="dev-mode-btn" disabled={saving || !dirty} onClick={onSave}>
              <SaveOutlined />
              {saving ? "儲存中…" : "儲存候選"}
            </button>
            <span>核准後會寫入知識 Ledger，並重建 AI 檢索索引。</span>
            <button type="button" className="dev-mode-btn is-reject" disabled={publishing} onClick={onReject}>
              <CloseOutlined />
              拒絕
            </button>
            <button type="button" className="dev-mode-btn is-approve" disabled={publishing} onClick={onApprove}>
              <CheckOutlined />
              {publishing ? "處理中…" : "核准並發布"}
            </button>
          </>
        ) : retryable ? (
          <>
            <span>
              知識內容已開始寫入，但狀態尚未完成確認；重試會沿用同一筆候選，不會新增重複知識。
            </span>
            <button
              type="button"
              className="dev-mode-btn is-approve"
              disabled={publishing}
              onClick={onApprove}
            >
              <SyncOutlined />
              {publishing ? "重試中…" : "重試完成發布"}
            </button>
          </>
        ) : (
          <span>
            {candidate.reviewedBy ? `${candidate.reviewedBy} · ` : ""}
            {candidate.reviewedAt ? new Date(candidate.reviewedAt).toLocaleString() : "尚無審核時間"}
            {candidate.reviewNote ? ` · ${candidate.reviewNote}` : ""}
          </span>
        )}
      </footer>
    </>
  );
}

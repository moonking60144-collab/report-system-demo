import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Modal, ConfigProvider, theme as antdTheme } from "antd";
import {
  fetchRagicWorkflowFormDeps,
  fetchRagicWorkflowSource,
  fetchRagicWorkflowStats,
  fetchWorkflowScanState,
  searchRagicFieldIndex,
  triggerWorkflowScan,
  type RagicWorkflowEdgeStats,
  type RagicWorkflowFormDeps,
  type WorkflowScanState,
} from "../../../api/devRagicFieldIndex";
import { extractErrorMessage, isUnauthorized } from "../../../api/apiErrors";

interface RagicWorkflowExplorerProps {
  token: string;
  onAuthFailure: () => void;
}

// 使用者貼 'forms12/8' 自動補 default account；已含 account（3 段 a/b/c）原樣
function normalizeFormPath(input: string): string {
  const trimmed = input.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) return "";
  return trimmed.split("/").length === 2 ? `default/${trimmed}` : trimmed;
}

// 從輸入抽表單路徑：吃「完整網址」「default/forms12/8」「forms12/8」；
// 不像路徑（含中文、沒斜線等）回 null → 改走文字搜表名。
function extractFormPath(input: string): string | null {
  let s = input.trim();
  const urlMatch = s.match(/^https?:\/\/[^/]+\/(.+)$/i);
  if (urlMatch) {
    s = urlMatch[1];
  }
  s = s.split(/[?#]/)[0].replace(/^\/+|\/+$/g, "");
  if (/^[\w-]+\/[\w-]+(\/[\w-]+)?$/.test(s)) {
    return s.split("/").length === 2 ? `default/${s}` : s;
  }
  return null;
}

// 輕量 JS 語法上色：tokenize 成 <span>（不用 dangerouslySetInnerHTML，避免 XSS）。
// 註解 / 字串 / 關鍵字 / 數字，其餘原樣。
const JS_TOKEN_RE =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(function|return|var|let|const|if|else|for|while|do|switch|case|break|continue|new|try|catch|finally|throw|typeof|instanceof|true|false|null|undefined|this|void|in|of)\b|\b(\d+\.?\d*)\b/g;
function highlightJs(code: string): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of code.matchAll(JS_TOKEN_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(code.slice(last, idx));
    const cls = m[1] ? "tok-comment" : m[2] ? "tok-string" : m[3] ? "tok-keyword" : "tok-number";
    out.push(
      <span key={key++} className={cls}>
        {m[0]}
      </span>
    );
    last = idx + m[0].length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

function scopeTags(scopes: string[]): ReactNode {
  return scopes.map((s) => (
    <span key={s} className="dev-deps__tag dev-wf__scope">
      {s}
    </span>
  ));
}

function WfSection({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <div className="dev-wf__section">
      <strong className="dev-wf__section-title">{title}</strong>
      {children}
    </div>
  );
}

function FormRef({
  path,
  url,
  resolved,
  onPick,
}: {
  path: string;
  url: string | null;
  resolved: boolean;
  onPick: (path: string) => void;
}): ReactNode {
  return (
    <span className="dev-wf__formref">
      <button type="button" className="dev-wf__formlink" onClick={() => onPick(path)}>
        {path.replace(/^default\//, "")}
      </button>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="dev-deps__node-link"
          title="開 Ragic"
        >
          ↗
        </a>
      ) : !resolved ? (
        <span className="dev-wf__unresolved" title="不在已知 form 清單（已刪表 / 系統表）">
          ?
        </span>
      ) : null}
    </span>
  );
}

/**
 * Workflow 依賴查詢：server-side workflow JS（doc.jsp / API key 撈不到的盲區）解析出的「表→表」
 * 依賴。貼一張表的 path（或點中樞榜），看它的 workflow 動到哪些表（下游）、被誰的 workflow
 * 動到（上游）、JS setFieldValue 寫哪些欄位、以及連外副作用。
 */
export function RagicWorkflowExplorer({
  token,
  onAuthFailure,
}: RagicWorkflowExplorerProps) {
  const [formPath, setFormPath] = useState("");
  const [matches, setMatches] = useState<Array<{ formPath: string; formName: string }> | null>(
    null
  );
  const [searchingName, setSearchingName] = useState(false);
  const [deps, setDeps] = useState<RagicWorkflowFormDeps | null>(null);
  const [stats, setStats] = useState<RagicWorkflowEdgeStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queried, setQueried] = useState(false);
  const [sourceScope, setSourceScope] = useState<string | null>(null);
  const [sourceJs, setSourceJs] = useState<string | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [scanState, setScanState] = useState<WorkflowScanState | null>(null);

  const onAuthFailureRef = useRef(onAuthFailure);
  useEffect(() => {
    onAuthFailureRef.current = onAuthFailure;
  }, [onAuthFailure]);

  // request-id 守門：較晚回來的舊請求不得覆蓋較新請求的結果
  const latestQueryReqRef = useRef(0);
  const latestSourceReqRef = useRef(0);

  const loadStats = useCallback(async () => {
    if (!token) return;
    try {
      setStats(await fetchRagicWorkflowStats(token));
    } catch (e) {
      if (isUnauthorized(e)) onAuthFailureRef.current();
    }
  }, [token]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  // 直讀 .nui 重撈：狀態 + 進行中輪詢 + 觸發
  const loadScanState = useCallback(async () => {
    if (!token) return;
    try {
      setScanState(await fetchWorkflowScanState(token));
    } catch (e) {
      if (isUnauthorized(e)) onAuthFailureRef.current();
    }
  }, [token]);

  useEffect(() => {
    void loadScanState();
  }, [loadScanState]);

  useEffect(() => {
    if (scanState?.status !== "running") return undefined;
    const id = window.setInterval(() => void loadScanState(), 1500);
    return () => window.clearInterval(id);
  }, [scanState?.status, loadScanState]);

  // 掃完依賴變了 → 刷新中樞榜統計
  useEffect(() => {
    if (scanState?.status === "done") void loadStats();
  }, [scanState?.status, loadStats]);

  const onScan = useCallback(async () => {
    try {
      await triggerWorkflowScan(token);
      await loadScanState();
    } catch (e) {
      if (isUnauthorized(e)) onAuthFailureRef.current();
    }
  }, [token, loadScanState]);

  const runQuery = useCallback(
    async (rawPath: string) => {
      const path = normalizeFormPath(rawPath);
      if (!path) return;
      const reqId = ++latestQueryReqRef.current;
      setLoading(true);
      setError(null);
      setMatches(null);
      setSourceScope(null);
      setSourceJs(null);
      try {
        const r = await fetchRagicWorkflowFormDeps(token, path);
        if (reqId !== latestQueryReqRef.current) return; // 已有更新查詢，丟棄舊回應
        setDeps(r);
        setQueried(true);
      } catch (e) {
        if (reqId !== latestQueryReqRef.current) return;
        if (isUnauthorized(e)) {
          onAuthFailureRef.current();
          return;
        }
        setError(extractErrorMessage(e, "查詢失敗"));
        setDeps(null);
        setQueried(true);
      } finally {
        if (reqId === latestQueryReqRef.current) setLoading(false);
      }
    },
    [token]
  );

  const pickForm = useCallback(
    (path: string) => {
      setFormPath(path.replace(/^default\//, ""));
      void runQuery(path);
    },
    [runQuery]
  );

  // 一框三吃：完整網址 / 路徑片段 → 直接查；其餘文字 → 搜 field index 的表名，列出符合的表讓使用者點選。
  const handleSearch = useCallback(
    async (raw: string) => {
      const input = raw.trim();
      if (!input) return;
      const path = extractFormPath(input);
      if (path) {
        setMatches(null);
        void runQuery(path);
        return;
      }
      setSearchingName(true);
      setMatches(null);
      setError(null);
      try {
        const result = await searchRagicFieldIndex(token, { q: input, limit: 300 });
        const seen = new Map<string, { formPath: string; formName: string }>();
        for (const entry of result.data) {
          if (!seen.has(entry.formPath)) {
            seen.set(entry.formPath, { formPath: entry.formPath, formName: entry.formName });
          }
        }
        // 前端再 filter 一次表名/路徑含關鍵字，避免 search 端只命中欄位名時夾帶不相關的表
        const list = [...seen.values()].filter(
          (m) => m.formName.includes(input) || m.formPath.includes(input)
        );
        if (list.length === 1) {
          pickForm(list[0].formPath);
        } else {
          setMatches(list);
        }
      } catch (e) {
        if (isUnauthorized(e)) {
          onAuthFailureRef.current();
          return;
        }
        setError(extractErrorMessage(e, "搜尋表名失敗"));
      } finally {
        setSearchingName(false);
      }
    },
    [token, runQuery, pickForm]
  );

  // 再點同一個 scope = 收合；換 scope = 載入新原文
  const openSource = useCallback(
    async (path: string, scope: string) => {
      if (sourceScope === scope) {
        setSourceScope(null);
        setSourceJs(null);
        return;
      }
      const reqId = ++latestSourceReqRef.current;
      setSourceScope(scope);
      setSourceJs(null);
      setSourceLoading(true);
      try {
        const src = await fetchRagicWorkflowSource(token, path, scope);
        if (reqId !== latestSourceReqRef.current) return; // 已切到別的 scope，丟棄舊回應
        setSourceJs(src?.js ?? "(此 scope 無原文)");
      } catch (e) {
        if (reqId !== latestSourceReqRef.current) return;
        if (isUnauthorized(e)) {
          onAuthFailureRef.current();
          return;
        }
        setSourceJs("(載入失敗)");
      } finally {
        if (reqId === latestSourceReqRef.current) setSourceLoading(false);
      }
    },
    [token, sourceScope]
  );

  return (
    <div className="dev-deps dev-wf">
      <div className="dev-wf__scan">
        <button
          type="button"
          className="dev-mode-btn dev-mode-btn--primary"
          onClick={() => void onScan()}
          disabled={!scanState?.configured || scanState?.status === "running"}
        >
          {scanState?.status === "running" ? "重撈中…" : "重新撈依賴（直讀 server 檔）"}
        </button>
        {scanState && !scanState.configured ? (
          <span className="dev-wf__occ">此功能僅 server（需 RAGIC_BUILDER_PATH）</span>
        ) : null}
        {scanState?.status === "running" && scanState.progress ? (
          <span className="dev-wf__occ">
            掃描 {scanState.progress.scannedForms}/{scanState.progress.totalForms}（找到 {scanState.progress.foundFiles} 檔）
          </span>
        ) : null}
        {scanState?.status === "done" && scanState.lastResult ? (
          <span className="dev-wf__occ">
            完成：{scanState.lastResult.formsWithWorkflow} 表有 workflow、{scanState.lastResult.edges} 條邊
          </span>
        ) : null}
        {scanState?.status === "error" ? (
          <span className="dev-mode-error">{scanState.message}</span>
        ) : null}
      </div>
      <div className="dev-deps__toolbar">
        <input
          className="dev-mode-input dev-deps__input"
          value={formPath}
          onChange={(e) => setFormPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleSearch(formPath);
          }}
          placeholder="表單路徑 / 完整網址 / 表名（例如 forms12/8、https://…、92工令單）"
        />
        <button
          type="button"
          className="dev-mode-btn dev-mode-btn--primary"
          onClick={() => void handleSearch(formPath)}
          disabled={loading || searchingName || formPath.trim() === ""}
        >
          {loading || searchingName ? "查詢中…" : "查詢"}
        </button>
      </div>

      {searchingName ? (
        <p className="dev-deps__empty">搜尋表名中…</p>
      ) : matches ? (
        matches.length === 0 ? (
          <p className="dev-deps__empty">
            找不到符合「{formPath.trim()}」的表，可改貼表單路徑或完整網址。
          </p>
        ) : (
          <div className="dev-wf__hubs">
            <p className="dev-deps__sidefx-hint">符合的表（點選查依賴）：</p>
            <div className="dev-wf__hub-list">
              {matches.map((m) => (
                <button
                  key={m.formPath}
                  type="button"
                  className="dev-wf__hub"
                  onClick={() => {
                    setMatches(null);
                    pickForm(m.formPath);
                  }}
                  title={m.formPath}
                >
                  {m.formName || m.formPath.replace(/^default\//, "")}
                  <span className="dev-wf__hub-count">{m.formPath.replace(/^default\//, "")}</span>
                </button>
              ))}
            </div>
          </div>
        )
      ) : null}

      {stats ? (
        <div className="dev-deps__stats">
          <span className="dev-deps__stats-total">
            {stats.formsWithWorkflow} 張表有 workflow
          </span>
          <span className="dev-deps__chip">跨表 query {stats.queryEdges}</span>
          <span className="dev-deps__chip">JS 寫值 {stats.setEdges}</span>
          <span className="dev-deps__chip">連外 {stats.externalEdges}</span>
        </div>
      ) : null}

      {stats && stats.topDepended.length > 0 ? (
        <div className="dev-wf__hubs">
          <p className="dev-deps__sidefx-hint">
            中樞表（被最多其他表的 workflow query；點擊查它的依賴）：
          </p>
          <div className="dev-wf__hub-list">
            {stats.topDepended.map((t) => (
              <button
                key={t.formPath}
                type="button"
                className="dev-wf__hub"
                onClick={() => pickForm(t.formPath)}
                title={t.formPath}
              >
                {t.formPath.replace(/^default\//, "")}
                <span className="dev-wf__hub-count">{t.dependedByCount}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {error ? <p className="dev-mode-error">{error}</p> : null}

      {queried && !error && deps ? (
        <div className="dev-wf__result">
          <div className="dev-wf__current">
            目前表單：<code className="dev-deps__node-id">{deps.formPath.replace(/^default\//, "")}</code>
          </div>
          {deps.sourceScopes.length > 0 ? (
            <div className="dev-wf__source">
              <span className="dev-wf__source-label">原始碼：</span>
              {deps.sourceScopes.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`dev-mode-btn dev-wf__source-btn${
                    sourceScope === s ? " dev-mode-btn--primary" : ""
                  }`}
                  onClick={() => void openSource(deps.formPath, s)}
                >
                  {s}
                </button>
              ))}
              {sourceLoading ? <span className="dev-wf__occ ragic-loading-inline">載入中…</span> : null}
            </div>
          ) : (
            <p className="dev-deps__empty">
              此表沒有 workflow 原文可看（它本身沒設 server-side workflow，或原文尚未在本機 analyze 匯入）。
            </p>
          )}
          {sourceScope ? (
            <ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}>
              <Modal
                open
                onCancel={() => {
                  setSourceScope(null);
                  setSourceJs(null);
                }}
                footer={null}
                width="80vw"
                title={`workflow 原始碼：${deps.formPath}`}
                styles={{ body: { maxHeight: "75vh", overflow: "auto", padding: 0 } }}
              >
                {sourceLoading || sourceJs === null ? (
                  <p className="dev-deps__empty ragic-loading-inline">載入中…</p>
                ) : (
                  <pre className="dev-wf__code dev-wf__code--modal">{highlightJs(sourceJs)}</pre>
                )}
              </Modal>
            </ConfigProvider>
          ) : null}

          <WfSection title={`下游 — 這張表的 workflow 會動到（${deps.downstreamForms.length}）`}>
            {deps.downstreamForms.length === 0 ? (
              <p className="dev-deps__empty">不 query 其他表</p>
            ) : (
              deps.downstreamForms.map((d) => (
                <div key={d.targetFormPath} className="dev-wf__row">
                  {scopeTags(d.scopes)}
                  <FormRef
                    path={d.targetFormPath}
                    url={d.ragicUrl}
                    resolved={d.resolved}
                    onPick={pickForm}
                  />
                  <span className="dev-wf__occ">×{d.occurCount}</span>
                </div>
              ))
            )}
          </WfSection>

          <WfSection title={`上游 — 哪些表的 workflow 動到它（${deps.upstreamForms.length}）`}>
            {deps.upstreamForms.length === 0 ? (
              <p className="dev-deps__empty">沒有其他表的 workflow query 它</p>
            ) : (
              deps.upstreamForms.map((u) => (
                <div key={u.srcFormPath} className="dev-wf__row">
                  {scopeTags(u.scopes)}
                  <FormRef path={u.srcFormPath} url={u.ragicUrl} resolved onPick={pickForm} />
                  <span className="dev-wf__occ">×{u.occurCount}</span>
                </div>
              ))
            )}
          </WfSection>

          <WfSection title={`JS 寫值 — setFieldValue 的欄位（${deps.writes.length}）`}>
            {deps.writes.length === 0 ? (
              <p className="dev-deps__empty">workflow 沒有 setFieldValue</p>
            ) : (
              deps.writes.map((w) => (
                <div key={w.fieldId} className="dev-wf__row">
                  {scopeTags(w.scopes)}
                  <span className="dev-deps__node-field">{w.fieldName ?? "(未知欄位)"}</span>
                  <code className="dev-deps__node-id">{w.fieldId}</code>
                  <span className="dev-wf__occ">×{w.occurCount}</span>
                </div>
              ))
            )}
          </WfSection>

          {deps.externals.length > 0 ? (
            <WfSection title={`連外副作用（${deps.externals.length}）`}>
              {deps.externals.map((x, i) => (
                <div key={`${x.via}-${x.target}-${i}`} className="dev-wf__row">
                  <span className="dev-deps__tag">{x.via}</span>
                  <code className="dev-deps__target">{x.target}</code>
                  <span className="dev-wf__occ">×{x.occurCount}</span>
                </div>
              ))}
            </WfSection>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

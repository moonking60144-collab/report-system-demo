import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchRagicDependencies,
  fetchRagicEdgeStats,
  fetchRagicSideEffects,
  type DependencyDirection,
  type RagicDependencyNode,
  type RagicEdgeStats,
  type RagicSideEffectEdge,
} from "../../../api/devRagicFieldIndex";
import { extractErrorMessage, isUnauthorized } from "../../../api/apiErrors";

interface RagicDependencyExplorerProps {
  token: string;
  onAuthFailure: () => void;
}

const EDGE_TYPE_LABEL: Record<string, string> = {
  link: "連結",
  load: "載入",
  formula_ref: "公式引用",
  reference: "自動產生參照",
  external_db_write: "外部 DB 寫入",
  cross_form_write: "跨表寫入",
  external_http: "外部 HTTP",
  ragic_action: "動作按鈕",
};

const SIDE_EFFECT_TYPES = new Set([
  "external_db_write",
  "cross_form_write",
  "external_http",
  "ragic_action",
]);

function edgeTypeLabel(type: string): string {
  return EDGE_TYPE_LABEL[type] ?? type;
}

/**
 * 欄位依賴查詢：貼一個 Ragic 欄位 ID，沿依賴邊往上游（它引用誰）或下游（誰引用它）
 * 展開成縮排樹。刻意不畫全域節點大圖（54000+ 欄位會糊成 hairball），只做「單欄位
 * 局部展開」這個真正有用的視角。另列出會寫外部系統的副作用欄位清單。
 */
export function RagicDependencyExplorer({
  token,
  onAuthFailure,
}: RagicDependencyExplorerProps) {
  const [fieldId, setFieldId] = useState("");
  const [direction, setDirection] = useState<DependencyDirection>("upstream");
  const [nodes, setNodes] = useState<RagicDependencyNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queried, setQueried] = useState(false);
  const [stats, setStats] = useState<RagicEdgeStats | null>(null);
  const [sideEffects, setSideEffects] = useState<RagicSideEffectEdge[]>([]);
  const [showSideEffects, setShowSideEffects] = useState(false);

  const onAuthFailureRef = useRef(onAuthFailure);
  useEffect(() => {
    onAuthFailureRef.current = onAuthFailure;
  }, [onAuthFailure]);

  // 概覽（邊統計 + 副作用清單）。掛載拉一次；查詢成功後也重抓——edge 表可能在
  // 元件掛載當下還沒 rebuild（統計顯示 0），查詢有結果就代表已建好，順手刷新統計。
  const loadOverview = useCallback(async () => {
    if (!token) return;
    try {
      const [s, se] = await Promise.all([
        fetchRagicEdgeStats(token),
        fetchRagicSideEffects(token),
      ]);
      setStats(s);
      setSideEffects(se);
    } catch (e) {
      if (isUnauthorized(e)) onAuthFailureRef.current();
    }
  }, [token]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const runQuery = useCallback(async () => {
    const id = fieldId.trim();
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetchRagicDependencies(token, id, direction);
      setNodes(r);
      setQueried(true);
      void loadOverview();
    } catch (e) {
      if (isUnauthorized(e)) {
        onAuthFailureRef.current();
        return;
      }
      setError(extractErrorMessage(e, "查詢失敗"));
      setNodes([]);
      setQueried(true);
    } finally {
      setLoading(false);
    }
  }, [token, fieldId, direction, loadOverview]);

  return (
    <div className="dev-deps">
      <div className="dev-deps__toolbar">
        <input
          className="dev-mode-input dev-deps__input"
          value={fieldId}
          onChange={(e) => setFieldId(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void runQuery();
          }}
          placeholder="貼上欄位 ID（例如 1006365）查依賴"
          inputMode="numeric"
        />
        <div className="dev-deps__dir">
          <button
            type="button"
            className={`dev-mode-btn${direction === "upstream" ? " dev-mode-btn--primary" : ""}`}
            onClick={() => setDirection("upstream")}
          >
            上游（它依賴誰）
          </button>
          <button
            type="button"
            className={`dev-mode-btn${direction === "downstream" ? " dev-mode-btn--primary" : ""}`}
            onClick={() => setDirection("downstream")}
          >
            下游（誰依賴它）
          </button>
        </div>
        <button
          type="button"
          className="dev-mode-btn dev-mode-btn--primary"
          onClick={() => void runQuery()}
          disabled={loading || fieldId.trim() === ""}
        >
          {loading ? "查詢中…" : "查詢依賴"}
        </button>
      </div>

      {stats ? (
        <div className="dev-deps__stats">
          <span className="dev-deps__stats-total">
            關係邊 {stats.totalData}（已解析 {stats.resolvedData}
            {stats.brokenData > 0 ? `、斷鏈 ${stats.brokenData}` : ""}）
          </span>
          {stats.byType
            .filter((t) => !SIDE_EFFECT_TYPES.has(t.edgeType))
            .map((t) => (
              <span key={t.edgeType} className="dev-deps__chip">
                {edgeTypeLabel(t.edgeType)} {t.count}
              </span>
            ))}
          {sideEffects.length > 0 ? (
            <button
              type="button"
              className="dev-deps__sidefx-toggle"
              onClick={() => setShowSideEffects((v) => !v)}
            >
              副作用欄位 {sideEffects.length} {showSideEffects ? "▲" : "▼"}
            </button>
          ) : null}
        </div>
      ) : null}

      {showSideEffects && sideEffects.length > 0 ? (
        <div className="dev-deps__sidefx">
          <p className="dev-deps__sidefx-hint">
            這些欄位的公式會寫外部系統，鏡像資料無法重現其執行（營運自主缺口）：
          </p>
          {sideEffects.map((s) => (
            <div
              key={`${s.srcFieldId}-${s.edgeType}`}
              className="dev-deps__sidefx-row"
            >
              <span className="dev-deps__tag">{edgeTypeLabel(s.edgeType)}</span>
              {s.ragicUrl ? (
                <a
                  className="dev-deps__sidefx-form dev-deps__node-link"
                  href={s.ragicUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {s.srcFormName ?? s.srcFormPath} ↗
                </a>
              ) : (
                <span className="dev-deps__sidefx-form">
                  {s.srcFormName ?? s.srcFormPath}
                </span>
              )}
              <code className="dev-deps__node-id">{s.srcFieldName ?? s.srcFieldId}</code>
              {s.via ? <span className="dev-deps__via">via {s.via}</span> : null}
              {s.target ? (
                <code className="dev-deps__target">{s.target}</code>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {error ? <p className="dev-mode-error">{error}</p> : null}

      {queried && !error ? (
        nodes.length === 0 ? (
          <p className="dev-deps__empty">
            查無
            {direction === "upstream" ? "上游依賴" : "下游依賴"}
            （此欄位
            {direction === "upstream"
              ? "不引用其他欄位"
              : "未被其他欄位引用"}
            ，或其關係未解析到具體欄位）。
          </p>
        ) : (
          <ul className="dev-deps__tree">
            {nodes.map((n, i) => (
              <li
                key={`${n.fieldId}-${n.viaFieldId}-${i}`}
                className="dev-deps__node"
                style={{ paddingLeft: `${(n.depth - 1) * 20 + 8}px` }}
              >
                <span className="dev-deps__node-depth">L{n.depth}</span>
                <span className="dev-deps__tag">{edgeTypeLabel(n.edgeType)}</span>
                {n.sync ? <span className="dev-deps__sync">同步</span> : null}
                {n.ragicUrl ? (
                  <a
                    className="dev-deps__node-form dev-deps__node-link"
                    href={n.ragicUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {n.formName ?? n.formPath ?? "(未知表單)"} ↗
                  </a>
                ) : (
                  <span className="dev-deps__node-form">
                    {n.formName ?? n.formPath ?? "(未知表單)"}
                  </span>
                )}
                <span className="dev-deps__node-field">
                  {n.fieldName ?? "(未知欄位)"}
                </span>
                <code className="dev-deps__node-id">{n.fieldId}</code>
                {n.fieldType ? (
                  <span className="dev-deps__node-type">{n.fieldType}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

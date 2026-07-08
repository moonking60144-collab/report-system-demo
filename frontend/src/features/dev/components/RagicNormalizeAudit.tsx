import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  fetchNormalizationAudit,
  type RagicNormalizationTable,
  type RagicNormalizationCycle,
  type RagicTableKind,
} from "../../../api/devRagicFieldIndex";
import { extractErrorMessage, isUnauthorized } from "../../../api/apiErrors";

const KIND_ORDER: RagicTableKind[] = ["master", "transaction", "leaf"];
const KIND_META: Record<RagicTableKind, { label: string; hint: string }> = {
  master: {
    label: "主檔",
    hint: "被多表 Link 引用、自己少引用——獨立的人/事/物，描述它的欄位該集中在這、別散到別表",
  },
  transaction: {
    label: "交易檔",
    hint: "引用多張主檔（常帶子表）——記錄事件本身，實體資訊一律靠 Link&Load 帶入、不複製",
  },
  leaf: {
    label: "葉表 / 待確認",
    hint: "進出度都低——可能是工具表、設定表，或關係還沒建（也可能是該補 Link&Load 的對象）",
  },
};

interface Props {
  token: string;
  onAuthFailure: () => void;
}

/**
 * 正規化體檢：用 Link&Load 的 fan-in（被幾張表引用）/ fan-out（引用幾張表）啟發式把每張表
 * 分成 主檔 / 交易檔 / 葉表。是「候選清單」不是結論——縮小範圍給人看，拆不拆使用者拍板。
 */
export function RagicNormalizeAudit({ token, onAuthFailure }: Props) {
  const [tables, setTables] = useState<RagicNormalizationTable[]>([]);
  const [cycles, setCycles] = useState<RagicNormalizationCycle[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onAuthFailureRef = useRef(onAuthFailure);
  useEffect(() => {
    onAuthFailureRef.current = onAuthFailure;
  }, [onAuthFailure]);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const audit = await fetchNormalizationAudit(token);
      setTables(audit.tables);
      setCycles(audit.cycles);
    } catch (e) {
      if (isUnauthorized(e)) {
        onAuthFailureRef.current();
        return;
      }
      setError(extractErrorMessage(e, "載入正規化體檢失敗（邊表可能還沒 rebuild，先做一次重新抓取）"));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const q = filter.trim().toLowerCase();
  const shown = q
    ? tables.filter((t) => t.formName.toLowerCase().includes(q) || t.formPath.includes(q))
    : tables;

  return (
    <div className="dev-norm">
      <div className="dev-norm__toolbar">
        <input
          className="dev-mode-input dev-norm__filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="篩選表單（名稱 / form_path）"
        />
        <span className="dev-norm__count">
          {shown.length}/{tables.length} 實體
        </span>
        <button
          type="button"
          className="dev-mode-button"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? "載入中…" : "重新載入"}
        </button>
      </div>

      <p className="dev-norm__note">
        以<strong>實體</strong>為單位（多版本同 mainKey 已合併、測試表已排除），用 Link&Load 的
        fan-in（被幾個實體引用）/ fan-out（引用幾個實體）啟發式分類。
      </p>

      {error ? <p className="dev-mode-error">{error}</p> : null}
      {loading && tables.length === 0 ? (
        <p className="dev-norm__hint ragic-loading-inline">載入中…</p>
      ) : null}

      {cycles.length > 0 ? (
        <section className="dev-norm__cycles">
          <h3 className="dev-norm__cycles-title">
            ⚠ Link&Load 循環依賴 {cycles.length} 組
            <span className="dev-norm__cycles-sub">A→B→…→A，運算可能卡死、該優先打斷</span>
          </h3>
          <div className="dev-norm__cycles-list">
            {[...cycles]
              .sort((a, b) => a.members.length - b.members.length)
              .map((c, i) => (
                <div key={i} className="dev-norm__cycle">
                  <span className="dev-norm__cycle-size">{c.members.length}</span>
                  <span className="dev-norm__cycle-members">
                    {c.members.slice(0, 15).map((m, j) => (
                      <Fragment key={m.formPath}>
                        {j > 0 ? <span className="dev-norm__cycle-arrow"> ⇄ </span> : null}
                        <a
                          className="dev-deps__node-link"
                          href={m.ragicUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {m.formName}
                        </a>
                      </Fragment>
                    ))}
                    {c.members.length > 15 ? <span> …等 {c.members.length} 個</span> : null}
                  </span>
                </div>
              ))}
          </div>
        </section>
      ) : null}

      {KIND_ORDER.map((k) => {
        const rows = shown.filter((t) => t.kind === k);
        if (!rows.length) return null;
        return (
          <section key={k} className="dev-norm__sec">
            <h3 className={`dev-norm__title dev-norm__title--${k}`}>
              {KIND_META[k].label} <span className="dev-norm__title-n">{rows.length}</span>
            </h3>
            <p className="dev-norm__hint">{KIND_META[k].hint}</p>
            <table className="dev-ent__fields dev-norm__table">
              <thead>
                <tr>
                  <th>表單</th>
                  <th>被引用</th>
                  <th>引用</th>
                  <th>子表</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.formPath}>
                    <td>
                      <a
                        className="dev-deps__node-link"
                        href={t.ragicUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {t.formName} ↗
                      </a>
                      {t.versionCount > 1 ? (
                        <span className="dev-norm__ver">{t.versionCount} 版本合併</span>
                      ) : null}
                      <code className="dev-norm__path">{t.formPath}</code>
                    </td>
                    <td className="dev-norm__num">{t.fanIn}</td>
                    <td className="dev-norm__num">{t.fanOut}</td>
                    <td className="dev-norm__sub">{t.hasSubtable ? "有" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, ConfigProvider, theme as antdTheme } from "antd";
import {
  fetchRagicEntities,
  fetchRagicEntityFields,
  type RagicEntityDetail,
  type RagicEntitySummary,
  type RagicFieldRole,
} from "../../../api/devRagicFieldIndex";
import { extractErrorMessage, isUnauthorized } from "../../../api/apiErrors";

interface RagicEntityBrowserProps {
  token: string;
  onAuthFailure: () => void;
}

const ROLE_LABEL: Record<RagicFieldRole, string> = {
  primary: "原始",
  derived: "衍生",
  foreign: "外來",
  side_effect: "副作用",
};

const ROLE_CLASS: Record<RagicFieldRole, string> = {
  primary: "is-primary",
  derived: "is-derived",
  foreign: "is-foreign",
  side_effect: "is-sidefx",
};

/**
 * 實體瀏覽：把匯出的「實體聚類」搬進 UI。每個實體 = 一個 mainKey（正規化後的一張表），
 * 多版本視圖已合併。點實體看它的欄位（角色/約束/FK 標好）+ 掛它的子表（FK 指向本實體）。
 * 不用開 CSV 就能在畫面上看整理 DB 的藍圖。
 */
export function RagicEntityBrowser({ token, onAuthFailure }: RagicEntityBrowserProps) {
  const [entities, setEntities] = useState<RagicEntitySummary[]>([]);
  const [filter, setFilter] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<RagicEntityDetail | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onAuthFailureRef = useRef(onAuthFailure);
  useEffect(() => {
    onAuthFailureRef.current = onAuthFailure;
  }, [onAuthFailure]);

  const loadList = useCallback(async () => {
    if (!token) return;
    setLoadingList(true);
    setError(null);
    try {
      setEntities(await fetchRagicEntities(token));
    } catch (e) {
      if (isUnauthorized(e)) {
        onAuthFailureRef.current();
        return;
      }
      setError(extractErrorMessage(e, "載入實體清單失敗（邊表可能還沒 rebuild，先做一次重新抓取）"));
    } finally {
      setLoadingList(false);
    }
  }, [token]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const selectEntity = useCallback(
    async (key: string) => {
      setSelectedKey(key);
      setDetail(null);
      setLoadingDetail(true);
      setError(null);
      try {
        setDetail(await fetchRagicEntityFields(token, key));
      } catch (e) {
        if (isUnauthorized(e)) {
          onAuthFailureRef.current();
          return;
        }
        setError(extractErrorMessage(e, "載入實體詳情失敗"));
      } finally {
        setLoadingDetail(false);
      }
    },
    [token]
  );

  const q = filter.trim().toLowerCase();
  const shown = q
    ? entities.filter(
        (e) => (e.repName ?? "").toLowerCase().includes(q) || e.entityKey.includes(q)
      )
    : entities;

  return (
    <div className="dev-ent">
      <div className="dev-ent__toolbar">
        <input
          className="dev-mode-input dev-ent__filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="篩選實體（表單名 / mainKey）"
        />
        <span className="dev-ent__count">
          {shown.length}/{entities.length} 實體
        </span>
      </div>

      {error ? <p className="dev-mode-error">{error}</p> : null}
      {loadingList ? <p className="dev-ent__hint ragic-loading-inline">載入中…</p> : null}

      <div className="dev-ent__list">
        {shown.slice(0, 300).map((e) => (
          <button
            type="button"
            key={e.entityKey}
            className={`dev-ent__row${selectedKey === e.entityKey ? " is-active" : ""}${
              e.dangling ? " is-dangling" : ""
            }`}
            onClick={() => void selectEntity(e.entityKey)}
          >
            <span className="dev-ent__name">{e.repName ?? `(實體 ${e.entityKey})`}</span>
            <span className="dev-ent__meta">
              {e.dangling ? "懸空(僅子表引用)" : `${e.fieldCount} 欄`}
              {e.viewCount > 1 ? ` · ${e.viewCount} 視圖` : ""}
              {e.refCount > 0 ? ` · ${e.refCount} 子表` : ""}
            </span>
          </button>
        ))}
        {shown.length > 300 ? (
          <p className="dev-ent__hint">只顯示前 300，請用篩選縮小範圍</p>
        ) : null}
      </div>

      {selectedKey && loadingDetail ? (
        <p className="dev-ent__hint ragic-loading-inline">載入欄位中…</p>
      ) : null}

      {detail ? (
        <ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}>
          <Modal
            open
            onCancel={() => {
              setSelectedKey(null);
              setDetail(null);
            }}
            footer={null}
            width="80vw"
            title={`${detail.repName ?? `實體 ${detail.entityKey}`}（mainKey ${detail.entityKey} · ${detail.fields.length} 欄 · ${detail.views.length} 視圖）`}
            styles={{ body: { maxHeight: "75vh", overflow: "auto" } }}
          >
            <div className="dev-modal-scope dev-ent__detail dev-ent__detail--modal">

          {detail.views.length > 1 ? (
            <div className="dev-ent__views">
              <span className="dev-ent__views-label">多版本視圖：</span>
              {detail.views.map((v) => (
                <a
                  key={v.formPath}
                  className="dev-deps__node-link"
                  href={v.ragicUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {v.formPath} ↗
                </a>
              ))}
            </div>
          ) : null}

          <table className="dev-ent__fields">
            <thead>
              <tr>
                <th>位置</th>
                <th>欄位</th>
                <th>角色</th>
                <th>約束 / FK</th>
                <th>型別</th>
              </tr>
            </thead>
            <tbody>
              {detail.fields.map((f) => (
                <tr key={f.fieldId}>
                  <td className="dev-ent__pos">{f.fieldPos ?? ""}</td>
                  <td className="dev-ent__fname">
                    {f.fieldName} <code>{f.fieldId}</code>
                  </td>
                  <td>
                    <span className={`dev-ent__role ${ROLE_CLASS[f.role]}`}>
                      {ROLE_LABEL[f.role]}
                    </span>
                  </td>
                  <td className="dev-ent__marks">
                    {f.unique && f.autoGen ? (
                      <span className="dev-ent__mark is-pk">PK候選</span>
                    ) : f.unique ? (
                      <span className="dev-ent__mark">UNIQUE</span>
                    ) : null}
                    {f.required ? <span className="dev-ent__mark">必填</span> : null}
                    {f.readOnly ? <span className="dev-ent__mark is-muted">唯讀</span> : null}
                    {f.role === "foreign" ? (
                      <span className="dev-ent__mark is-fk">
                        {f.fkTarget ? `FK→${f.fkTarget}` : f.broken ? "FK→已失效" : "FK→?"}
                      </span>
                    ) : null}
                    {f.role === "derived" ? (
                      <span className="dev-ent__mark is-derived">computed/VIEW</span>
                    ) : null}
                    {f.role === "side_effect" ? (
                      <span className="dev-ent__mark is-sidefx">外部副作用</span>
                    ) : null}
                  </td>
                  <td className="dev-ent__type">{f.fieldType ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {detail.childTables.length ? (
            <div className="dev-ent__children">
              <span className="dev-ent__views-label">
                掛它的子表（FK 指向本實體，{detail.childTables.length}）：
              </span>
              {detail.childTables.map((c) => (
                <a
                  key={c.formPath}
                  className="dev-deps__node-link"
                  href={c.ragicUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {c.formPath}
                  {c.subtableName ? ` (${c.subtableName})` : ""} ↗
                </a>
              ))}
            </div>
          ) : null}
            </div>
          </Modal>
        </ConfigProvider>
      ) : null}
    </div>
  );
}

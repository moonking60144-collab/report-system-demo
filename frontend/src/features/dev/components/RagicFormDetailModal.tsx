import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, ConfigProvider, theme as antdTheme } from "antd";
import {
  searchRagicFieldIndex,
  type RagicFieldIndexEntry,
  type RagicFieldIndexState,
} from "../../../api/devRagicFieldIndex";
import { extractErrorMessage, isUnauthorized } from "../../../api/apiErrors";
import { useLingering } from "../hooks/useLingering";
import { RagicRefreshProgress } from "./RagicRefreshProgress";

interface Props {
  open: boolean;
  token: string;
  formPath: string | null;
  formName: string | null;
  /** 共用 state — 由 panel 提供 */
  state: RagicFieldIndexState | null;
  /** 觸發 refresh */
  onRefresh: () => Promise<void> | void;
  refreshError: string | null;
  onClose: () => void;
  onAuthFailure: () => void;
}

interface GroupedSubtable {
  label: string;
  key: string | null;
  rows: RagicFieldIndexEntry[];
}

interface GroupedForm {
  formPath: string;
  formName: string;
  mainKey: string | null;
  main: RagicFieldIndexEntry[];
  subtables: GroupedSubtable[];
}

function groupOne(entries: RagicFieldIndexEntry[]): GroupedForm | null {
  if (entries.length === 0) return null;
  const first = entries[0];
  const bucket: GroupedForm = {
    formPath: first.formPath,
    formName: first.formName,
    mainKey: null,
    main: [],
    subtables: [],
  };
  for (const entry of entries) {
    if (entry.scope === "main") {
      bucket.main.push(entry);
      if (!bucket.mainKey && entry.subtableKey) {
        bucket.mainKey = entry.subtableKey;
      }
    } else {
      const subKey = entry.subtableKey ?? "";
      let sub = bucket.subtables.find((s) => (s.key ?? "") === subKey);
      if (!sub) {
        sub = {
          label:
            entry.subtableName || (subKey ? `子表 (Key: ${subKey})` : "子表"),
          key: subKey || null,
          rows: [],
        };
        bucket.subtables.push(sub);
      }
      sub.rows.push(entry);
    }
  }
  return bucket;
}

function matchEntry(entry: RagicFieldIndexEntry, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    entry.fieldName.toLowerCase().includes(needle) ||
    entry.fieldId.toLowerCase().includes(needle) ||
    (entry.fieldPos ?? "").toLowerCase().includes(needle) ||
    (entry.fieldType ?? "").toLowerCase().includes(needle) ||
    (entry.fieldNote ?? "").toLowerCase().includes(needle) ||
    (entry.subtableName ?? "").toLowerCase().includes(needle) ||
    (entry.subtableKey ?? "").toLowerCase().includes(needle)
  );
}

export function RagicFormDetailModal({
  open,
  token,
  formPath,
  formName,
  state,
  onRefresh,
  refreshError,
  onClose,
  onAuthFailure,
}: Props) {
  const [entries, setEntries] = useState<RagicFieldIndexEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [copyToast, setCopyToast] = useState<string | null>(null);
  const onAuthFailureRef = useRef(onAuthFailure);
  const abortRef = useRef<AbortController | null>(null);
  const lastRefreshStatusRef = useRef<string | null>(null);

  useEffect(() => {
    onAuthFailureRef.current = onAuthFailure;
  }, [onAuthFailure]);

  // 載入欄位 — 開 modal / 換 form / refresh 完成都會觸發
  useEffect(() => {
    if (!open || !formPath) {
      setEntries([]);
      setQuery("");
      setError(null);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const data = await searchRagicFieldIndex(
          token,
          { formPath, limit: 1000 },
          { signal: controller.signal }
        );
        if (!cancelled && !controller.signal.aborted) {
          setEntries(data);
        }
      } catch (e) {
        if (cancelled || controller.signal.aborted) return;
        if (isUnauthorized(e)) {
          onAuthFailureRef.current();
          return;
        }
        setError(extractErrorMessage(e, "讀取欄位失敗"));
      } finally {
        if (!cancelled && !controller.signal.aborted) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open, formPath, token]);

  // refresh 結束（refreshing → ready/error）→ 自動 reload entries
  useEffect(() => {
    const status = state?.status ?? null;
    const prev = lastRefreshStatusRef.current;
    lastRefreshStatusRef.current = status;
    if (prev === "refreshing" && status !== "refreshing" && open && formPath) {
      // 觸發上面的 effect rerun 重抓 entries（透過手動 reload）
      // 簡單做法：另一個 effect 根據 prev/curr 直接 setQuery 一個 noop？
      // 更乾淨：直接呼叫一次 search
      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;
      setLoading(true);
      (async () => {
        try {
          const data = await searchRagicFieldIndex(
            token,
            { formPath, limit: 1000 },
            { signal: controller.signal }
          );
          if (!controller.signal.aborted) setEntries(data);
        } catch (e) {
          if (controller.signal.aborted) return;
          if (isUnauthorized(e)) {
            onAuthFailureRef.current();
            return;
          }
          setError(extractErrorMessage(e, "讀取欄位失敗"));
        } finally {
          if (!controller.signal.aborted) setLoading(false);
        }
      })();
    }
  }, [state?.status, open, formPath, token]);

  // unmount 取消 in-flight
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return entries;
    return entries.filter((e) => matchEntry(e, q));
  }, [entries, query]);

  const grouped = useMemo(() => groupOne(filtered), [filtered]);
  const totalGrouped = useMemo(() => groupOne(entries), [entries]);

  async function handleCopy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopyToast(`已複製 ${text}`);
      window.setTimeout(() => setCopyToast(null), 1500);
    } catch {
      setCopyToast("複製失敗，請手動選取");
      window.setTimeout(() => setCopyToast(null), 1500);
    }
  }

  const titleSuffix = totalGrouped
    ? `（主表 ${totalGrouped.main.length} 欄 · 子表 ${totalGrouped.subtables.length} 個）`
    : "";
  const refreshing = state?.status === "refreshing";
  const showProgress = useLingering(refreshing, 500);

  return (
    <ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}>
      <Modal
        open={open}
        onCancel={onClose}
        footer={null}
        title={
          <span>
            <span style={{ marginRight: 8 }}>{formName ?? "Ragic 表單"}</span>
            <code
              style={{
                fontSize: 12,
                background: "rgba(88,166,255,0.12)",
                color: "#79c0ff",
                padding: "2px 8px",
                borderRadius: 4,
              }}
            >
              {formPath ?? ""}
            </code>
            <span
              style={{ marginLeft: 8, fontSize: 12, color: "#8b949e" }}
            >
              {titleSuffix}
            </span>
          </span>
        }
        width="80vw"
        style={{ top: 24, maxWidth: "1200px" }}
        styles={{
          body: { padding: 0, maxHeight: "calc(100vh - 140px)", overflow: "hidden" },
        }}
        destroyOnClose
      >
        <div className="ragic-modal">
          <div className="ragic-modal__toolbar">
            <input
              type="search"
              className="ragic-modal__search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="在此表單內搜尋欄位名 / 欄位 ID / 位置 / 型態 / 備註"
              aria-label="search within form"
              autoFocus
            />
            <button
              type="button"
              className="ragic-modal__refresh-btn"
              onClick={() => void onRefresh()}
              disabled={refreshing}
              title="重新從 Ragic /sims/doc.jsp 抓取最新欄位（會 refresh 整個索引）"
            >
              {refreshing ? "抓取中…" : "↻ 重新抓取"}
            </button>
          </div>

          {copyToast ? (
            <div className="ragic-modal__statusbar">
              <span className="ragic-modal__copy-toast">{copyToast}</span>
            </div>
          ) : null}

          {showProgress ? (
            <div className="ragic-modal__progress-wrap">
              <RagicRefreshProgress
                key={state?.progress?.startedAt ?? "init"}
                progress={state?.progress ?? null}
                variant="modal"
                complete={!refreshing}
              />
            </div>
          ) : null}

          {refreshError ? (
            <p className="ragic-modal__error">{refreshError}</p>
          ) : null}
          {error ? <p className="ragic-modal__error">{error}</p> : null}

          <div className="ragic-modal__body">
            {loading ? (
              <p className="ragic-modal__hint">載入中…</p>
            ) : !grouped ? (
              <p className="ragic-modal__hint">
                {query.trim()
                  ? "此表單內沒有符合的欄位"
                  : "此表單沒有欄位資料"}
              </p>
            ) : (
              <div className="ragic-modal__form-body" style={{ paddingLeft: 0 }}>
                {grouped.mainKey ? (
                  <KeyBadge
                    label="主表 Key"
                    keyValue={grouped.mainKey}
                    tone="primary"
                    onCopy={(v) => void handleCopy(v)}
                  />
                ) : null}

                {grouped.main.length > 0 ? (
                  <FieldTable
                    title="主表欄位"
                    rows={grouped.main}
                    onCopy={(v) => void handleCopy(v)}
                  />
                ) : null}

                {grouped.subtables.map((sub, idx) => (
                  <div
                    key={sub.key ?? `${idx}`}
                    className="ragic-modal__subtable"
                  >
                    <div className="ragic-modal__subtable-head">
                      <span className="ragic-modal__subtable-title">
                        {sub.label}
                      </span>
                      {sub.key ? (
                        <KeyBadge
                          label="子表 Key"
                          keyValue={sub.key}
                          tone="warn"
                          onCopy={(v) => void handleCopy(v)}
                        />
                      ) : null}
                    </div>
                    <FieldTable
                      title=""
                      rows={sub.rows}
                      onCopy={(v) => void handleCopy(v)}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </Modal>
    </ConfigProvider>
  );
}

function KeyBadge({
  label,
  keyValue,
  tone,
  onCopy,
}: {
  label: string;
  keyValue: string;
  tone: "primary" | "warn";
  onCopy: (value: string) => void;
}) {
  return (
    <button
      type="button"
      className={`ragic-modal__key-badge ragic-modal__key-badge--${tone}`}
      onClick={() => onCopy(keyValue)}
      title={`複製 ${label} ${keyValue}`}
    >
      <span className="ragic-modal__key-badge-label">{label}</span>
      <span className="ragic-modal__key-badge-value">{keyValue}</span>
    </button>
  );
}

function FieldTable({
  title,
  rows,
  onCopy,
}: {
  title: string;
  rows: RagicFieldIndexEntry[];
  onCopy: (text: string) => void;
}) {
  return (
    <div className="ragic-modal__table-wrap">
      {title ? <div className="ragic-modal__table-title">{title}</div> : null}
      <table className="ragic-modal__table">
        <thead>
          <tr>
            <th>位置</th>
            <th>欄位名</th>
            <th>欄位 ID</th>
            <th>型態</th>
            <th>備註</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="ragic-modal__td-pos">{row.fieldPos ?? "—"}</td>
              <td className="ragic-modal__td-name">{row.fieldName}</td>
              <td>
                <button
                  type="button"
                  className="ragic-modal__id-btn"
                  onClick={() => onCopy(row.fieldId)}
                  title={`複製 ${row.fieldId}`}
                >
                  {row.fieldId}
                </button>
              </td>
              <td className="ragic-modal__td-type">{row.fieldType ?? "—"}</td>
              <td className="ragic-modal__td-note">{row.fieldNote ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

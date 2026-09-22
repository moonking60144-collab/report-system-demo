import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Modal, ConfigProvider, theme as antdTheme, message } from "antd";
import {
  abortRagicFieldIndexRefresh,
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
  state: RagicFieldIndexState | null;
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

function escapeMd(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

// 把 form path 變成可當檔名片段的 slug：去頭尾斜線 → / 轉 dash → 非 ascii 轉底線 → 壓平 → 限長
function slugify(formPath: string): string {
  return (
    formPath
      .replace(/^\/+|\/+$/g, "")
      .replace(/\//g, "-")
      .replace(/[^a-zA-Z0-9\-_]/g, "_")
      .replace(/_{2,}/g, "_")
      .replace(/-{2,}/g, "-")
      .slice(0, 64) || "form"
  );
}

// 本地時間 yyyyMMdd-HHmmss，比 UTC ISO 容易對上「我什麼時候 dump 的」
function localTimestamp(): string {
  const t = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;
}

function buildHaystack(entry: RagicFieldIndexEntry): string {
  // 預先把所有可搜尋欄位串成單一小寫字串，避免每次 filter 都重跑 7 次 toLowerCase().includes()
  return [
    entry.fieldName,
    entry.fieldId,
    entry.fieldPos ?? "",
    entry.fieldType ?? "",
    entry.fieldNote ?? "",
    entry.subtableName ?? "",
    entry.subtableKey ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

// ----- 備註 chip 拆解 -----
type NoteTone =
  | "formula"
  | "autogen"
  | "default-value"
  | "option"
  | "readonly"
  | "writable"
  | "required"
  | "hidden"
  | "unique"
  | "link"
  | "warn"
  | "neutral";

interface NoteSegment {
  text: string;
  tone: NoteTone;
}

function parseFieldNote(note: string | null): NoteSegment[] {
  if (!note) return [];
  // parser 已用 "; " 串接 raw <br> 切的 segment，這裡再拆
  const parts = note
    .split(/\s*;\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.map<NoteSegment>((text) => {
    if (/^公式:/.test(text)) return { text, tone: "formula" };
    if (/^自動產生:/.test(text)) return { text, tone: "autogen" };
    if (/^預設值/.test(text)) return { text, tone: "default-value" };
    if (/^選項:/.test(text)) return { text, tone: "option" };
    if (text === "唯讀" || /^唯讀\b/.test(text)) return { text, tone: "readonly" };
    if (text === "必填") return { text, tone: "required" };
    if (text === "隱藏") return { text, tone: "hidden" };
    if (text === "不可重複") return { text, tone: "unique" };
    if (/^連結到/.test(text) || /^從 /.test(text)) return { text, tone: "link" };
    if (/Linked to sheet not found/i.test(text)) return { text, tone: "warn" };
    if (text.includes("可寫入")) return { text, tone: "writable" };
    return { text, tone: "neutral" };
  });
}

// ----- Quick filter rules -----
const QUICK_FILTERS: Array<{
  key: string;
  label: string;
  match: (e: RagicFieldIndexEntry) => boolean;
}> = [
  { key: "formula", label: "公式", match: (e) => !!e.fieldNote?.includes("公式:") },
  {
    key: "link",
    label: "連結",
    match: (e) => {
      const note = e.fieldNote ?? "";
      const type = e.fieldType ?? "";
      // 中文沒有 \w/\W 邊界，不能用 \b；改純 substring match
      return (
        note.includes("連結到") ||
        note.includes("從 ") ||
        type.includes("連結欄位")
      );
    },
  },
  { key: "readonly", label: "唯讀", match: (e) => !!e.fieldNote?.includes("唯讀") },
  { key: "required", label: "必填", match: (e) => !!e.fieldNote?.includes("必填") },
  { key: "hidden", label: "隱藏", match: (e) => !!e.fieldNote?.includes("隱藏") },
];

// ----- Sort -----
type SortKey = "pos" | "name" | "id" | "type" | null;
type SortDir = "asc" | "desc";

function compareRow(
  a: RagicFieldIndexEntry,
  b: RagicFieldIndexEntry,
  key: NonNullable<SortKey>,
  dir: SortDir
): number {
  const sign = dir === "asc" ? 1 : -1;
  if (key === "id") {
    const an = Number.parseInt(a.fieldId, 10);
    const bn = Number.parseInt(b.fieldId, 10);
    if (!Number.isNaN(an) && !Number.isNaN(bn)) return sign * (an - bn);
    return sign * a.fieldId.localeCompare(b.fieldId);
  }
  if (key === "pos") {
    // natural sort: A1 < A2 < A10 < B1
    const re = /^([A-Z]+)(\d+)$/;
    const ma = re.exec(a.fieldPos ?? "");
    const mb = re.exec(b.fieldPos ?? "");
    if (ma && mb) {
      const letterCmp = ma[1].localeCompare(mb[1]);
      if (letterCmp !== 0) return sign * letterCmp;
      return sign * (Number.parseInt(ma[2], 10) - Number.parseInt(mb[2], 10));
    }
    return sign * (a.fieldPos ?? "").localeCompare(b.fieldPos ?? "");
  }
  if (key === "name") return sign * a.fieldName.localeCompare(b.fieldName);
  if (key === "type") return sign * (a.fieldType ?? "").localeCompare(b.fieldType ?? "");
  return 0;
}

// ----- Highlight helper -----
function highlightSegments(text: string, query: string): Array<{ part: string; hit: boolean }> {
  if (!query) return [{ part: text, hit: false }];
  const needle = query.toLowerCase();
  const lower = text.toLowerCase();
  const out: Array<{ part: string; hit: boolean }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const idx = lower.indexOf(needle, cursor);
    if (idx < 0) {
      out.push({ part: text.slice(cursor), hit: false });
      break;
    }
    if (idx > cursor) out.push({ part: text.slice(cursor, idx), hit: false });
    out.push({ part: text.slice(idx, idx + needle.length), hit: true });
    cursor = idx + needle.length;
  }
  return out;
}

function HighlightText({ text, query }: { text: string; query: string }) {
  const segs = highlightSegments(text, query);
  return (
    <>
      {segs.map((s, i) =>
        s.hit ? (
          <mark key={i} className="ragic-modal__mark">
            {s.part}
          </mark>
        ) : (
          <span key={i}>{s.part}</span>
        )
      )}
    </>
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
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [quickFilters, setQuickFilters] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [messageApi, contextHolder] = message.useMessage();
  const deferredQuery = useDeferredValue(query);
  const onAuthFailureRef = useRef(onAuthFailure);
  const abortRef = useRef<AbortController | null>(null);
  const lastRefreshStatusRef = useRef<string | null>(null);
  /**
   * refresh 開始時的時間戳（ISO）。
   * 用途：refreshing → ready 轉換時計算耗時。
   * 為何不直接讀 state.progress.startedAt：完成瞬間 progress 可能已被後端清空，
   * 這裡在 status === 'refreshing' 期間 latch 住，轉態時取出 → 不依賴 progress 物件還活著。
   */
  const refreshStartedAtRef = useRef<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    onAuthFailureRef.current = onAuthFailure;
  }, [onAuthFailure]);

  // 載入欄位
  useEffect(() => {
    if (!open || !formPath) {
      setEntries([]);
      setTruncated(false);
      setQuery("");
      setQuickFilters(new Set());
      setSortKey(null);
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
        const result = await searchRagicFieldIndex(
          token,
          { formPath, limit: 1000 },
          { signal: controller.signal }
        );
        if (!cancelled && !controller.signal.aborted) {
          setEntries(result.data);
          setTruncated(result.truncated);
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

  // refresh 完成自動 reload + 成功提示
  useEffect(() => {
    const status = state?.status ?? null;
    const prev = lastRefreshStatusRef.current;
    lastRefreshStatusRef.current = status;
    // latch startedAt while refreshing — progress 物件在轉態瞬間可能已被清掉
    if (status === "refreshing" && state?.progress?.startedAt) {
      refreshStartedAtRef.current = state.progress.startedAt;
    }
    if (prev === "refreshing" && status !== "refreshing") {
      // 成功才提示；error 走另一條 refreshError 文案，不蓋掉
      if (status === "ready" && state) {
        const startedAt = refreshStartedAtRef.current;
        const updatedAt = state.updatedAt;
        const elapsedMs =
          startedAt && updatedAt
            ? Math.max(0, Date.parse(updatedAt) - Date.parse(startedAt))
            : null;
        const elapsedLabel =
          elapsedMs !== null && Number.isFinite(elapsedMs)
            ? `${(elapsedMs / 1000).toFixed(1)}s`
            : "—";
        messageApi.success({
          content: `已更新 ${state.totalForms} forms / ${state.totalFields} fields，耗時 ${elapsedLabel}`,
          duration: 3,
        });
      }
      refreshStartedAtRef.current = null;
      if (open && formPath) {
        const controller = new AbortController();
        abortRef.current?.abort();
        abortRef.current = controller;
        setLoading(true);
        (async () => {
          try {
            const result = await searchRagicFieldIndex(
              token,
              { formPath, limit: 1000 },
              { signal: controller.signal }
            );
            if (!controller.signal.aborted) {
              setEntries(result.data);
              setTruncated(result.truncated);
            }
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
    }
  }, [state, open, formPath, token, messageApi]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // `/` 快捷鍵：modal 開啟且當前焦點不在 input/textarea 時，focus 搜尋框
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/") return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) {
        return;
      }
      e.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // ESC 清搜尋（modal 本身的 ESC 已由 antd 處理關閉，這裡只在搜尋框有值時攔 ESC 改成 clear）
  function handleSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape" && query) {
      e.stopPropagation();
      setQuery("");
    }
  }

  // 預先 build 每筆 entry 的小寫 haystack（搜尋時單一 includes 即可）
  // entries 變動才重算，搜尋打字不會觸發。
  const haystacks = useMemo(() => entries.map(buildHaystack), [entries]);

  // 預先把所有不重複的 fieldNote 解析成 NoteSegment[]，避免每個 row 各自 useMemo 累積 500+ 快取槽
  // entries 變動才重算；row 重渲染直接 cache.get() O(1) 拿結果
  const noteCache = useMemo(() => {
    const m = new Map<string, NoteSegment[]>();
    for (const e of entries) {
      const note = e.fieldNote;
      if (note != null && !m.has(note)) {
        m.set(note, parseFieldNote(note));
      }
    }
    return m;
  }, [entries]);

  // 篩選 + 排序（useDeferredValue 推遲 query）
  const filtered = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    let result = entries;
    if (q) {
      result = entries.filter((_, i) => haystacks[i].includes(q));
    }
    if (quickFilters.size > 0) {
      const rules = QUICK_FILTERS.filter((r) => quickFilters.has(r.key));
      result = result.filter((e) => rules.every((r) => r.match(e)));
    }
    return result;
  }, [entries, haystacks, deferredQuery, quickFilters]);

  const grouped = useMemo(() => {
    const g = groupOne(filtered);
    if (g && sortKey) {
      const k = sortKey;
      g.main = [...g.main].sort((a, b) => compareRow(a, b, k, sortDir));
      g.subtables = g.subtables.map((s) => ({
        ...s,
        rows: [...s.rows].sort((a, b) => compareRow(a, b, k, sortDir)),
      }));
    }
    return g;
  }, [filtered, sortKey, sortDir]);

  const totalGrouped = useMemo(() => groupOne(entries), [entries]);

  const filteredCount = useMemo(() => {
    if (!grouped) return 0;
    return (
      grouped.main.length +
      grouped.subtables.reduce((a, s) => a + s.rows.length, 0)
    );
  }, [grouped]);
  const totalCount = useMemo(() => {
    if (!totalGrouped) return 0;
    return (
      totalGrouped.main.length +
      totalGrouped.subtables.reduce((a, s) => a + s.rows.length, 0)
    );
  }, [totalGrouped]);

  function toggleQuickFilter(key: string) {
    setQuickFilters((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function clearQuickFilters() {
    setQuickFilters(new Set());
  }
  function toggleSort(key: NonNullable<SortKey>) {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir("asc");
      return;
    }
    if (sortDir === "asc") {
      setSortDir("desc");
      return;
    }
    setSortKey(null);
    setSortDir("asc");
  }

  async function handleCopy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      messageApi.success({ content: `已複製 ${text}`, duration: 1.2 });
    } catch {
      messageApi.error({ content: "複製失敗，請手動選取", duration: 2 });
    }
  }

  async function handleCancelRefresh() {
    try {
      const result = await abortRagicFieldIndexRefresh(token);
      // 沒有 in-flight job 可中止（如點擊瞬間 job 剛收尾）→ 不跳誤導性的「已中止」toast
      if (result.aborted) {
        messageApi.info({ content: "已要求中止重新抓取", duration: 1.8 });
      }
    } catch (e) {
      if (isUnauthorized(e)) {
        onAuthFailureRef.current();
        return;
      }
      messageApi.error({
        content: extractErrorMessage(e, "中止失敗"),
        duration: 2,
      });
    }
  }

  function buildMarkdownDump(g: GroupedForm): string {
    const lines: string[] = [];
    lines.push(`# ${g.formName}`);
    lines.push("");
    lines.push(`- Path: \`${g.formPath}\``);
    if (g.mainKey) lines.push(`- 主表 Key: \`${g.mainKey}\``);
    lines.push(`- 主表 ${g.main.length} 欄、子表 ${g.subtables.length} 個`);
    lines.push("");
    if (g.main.length > 0) {
      lines.push("## 主表欄位");
      lines.push("");
      lines.push("| 位置 | 欄位名 | 欄位 ID | 型態 | 備註 |");
      lines.push("|---|---|---|---|---|");
      for (const f of g.main) {
        lines.push(
          `| ${f.fieldPos ?? "—"} | ${escapeMd(f.fieldName)} | \`${f.fieldId}\` | ${escapeMd(f.fieldType ?? "—")} | ${escapeMd(f.fieldNote ?? "—")} |`
        );
      }
      lines.push("");
    }
    for (const sub of g.subtables) {
      const headerSuffix = sub.key ? ` (Key: \`${sub.key}\`)` : "";
      lines.push(`## ${sub.label}${headerSuffix}`);
      lines.push("");
      lines.push("| 位置 | 欄位名 | 欄位 ID | 型態 | 備註 |");
      lines.push("|---|---|---|---|---|");
      for (const f of sub.rows) {
        lines.push(
          `| ${f.fieldPos ?? "—"} | ${escapeMd(f.fieldName)} | \`${f.fieldId}\` | ${escapeMd(f.fieldType ?? "—")} | ${escapeMd(f.fieldNote ?? "—")} |`
        );
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  async function handleCopyAll() {
    if (!totalGrouped) return;
    const md = buildMarkdownDump(totalGrouped);
    try {
      await navigator.clipboard.writeText(md);
      messageApi.success({
        content: `已複製整表 Markdown (${totalCount} 欄)`,
        duration: 1.8,
      });
    } catch {
      // 不自動觸發 download：unsolicited download 容易被瀏覽器當可疑行為
      // 改提示使用者按旁邊的「下載 .md」按鈕
      messageApi.error({
        content: "複製失敗（clipboard 權限），請改按右側「↓ 下載 .md」",
        duration: 3,
      });
    }
  }

  function handleDownloadAll() {
    if (!totalGrouped || !formPath) return;
    const md = buildMarkdownDump(totalGrouped);
    const filename = `ragic-form-${slugify(formPath)}-${localTimestamp()}.md`;
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      messageApi.success({
        content: `已下載 ${filename}`,
        duration: 1.8,
      });
    } finally {
      // 下一個 tick 再 revoke，避免 Safari 偶發 download 還沒拿到 blob 就被收掉
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }

  const titleSuffix = totalGrouped
    ? `（主表 ${totalGrouped.main.length} 欄 · 子表 ${totalGrouped.subtables.length} 個）`
    : "";
  const refreshing = state?.status === "refreshing";
  // 背景排程觸發的 refresh：不給「中止」（DELETE 對背景 job 是 no-op，會跳假成功 toast）
  const autoRefreshing = refreshing && state?.autoRefreshing === true;
  const userRefreshing = refreshing && !autoRefreshing;
  const showProgress = useLingering(refreshing, 500);
  const isFiltering = quickFilters.size > 0 || deferredQuery.trim().length > 0;
  const isStale = query !== deferredQuery;

  return (
    <ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}>
      {contextHolder}
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
            <span style={{ marginLeft: 8, fontSize: 12, color: "#8b949e" }}>
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
              ref={searchInputRef}
              type="search"
              className={`ragic-modal__search ${isStale ? "is-stale" : ""}`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="搜尋欄位名 / 欄位 ID / 位置 / 型態 / 備註 (/ 聚焦, Esc 清除)"
              aria-label="search within form"
              autoFocus
            />
            <button
              type="button"
              className="ragic-modal__refresh-btn"
              onClick={() => void handleCopyAll()}
              disabled={!totalGrouped || loading}
              title="把整個表單的欄位列表複製成 Markdown，方便貼到 AI prompt"
            >
              ⧉ 複製全表 (MD)
            </button>
            <button
              type="button"
              className="ragic-modal__refresh-btn"
              onClick={handleDownloadAll}
              disabled={!totalGrouped || loading}
              title="下載整表 Markdown 檔（clipboard 失敗時備援）"
            >
              ↓ 下載 .md
            </button>
            <button
              type="button"
              className="ragic-modal__refresh-btn"
              onClick={() => void onRefresh()}
              disabled={refreshing}
              title="重新從 Ragic /sims/doc.jsp 抓取最新欄位"
            >
              {refreshing ? "抓取中…" : "↻ 重新抓取"}
            </button>
          </div>

          {truncated ? (
            <div className="ragic-modal__truncated-banner" role="alert">
              ⚠️ 此表單欄位 &gt; 1000，僅顯示前 1000；提高 backend search limit 才能完整顯示
            </div>
          ) : null}

          <div className="ragic-modal__filter-row">
            <span className="ragic-modal__filter-label">快篩：</span>
            {QUICK_FILTERS.map((q) => (
              <button
                key={q.key}
                type="button"
                className={`ragic-modal__filter-chip ${quickFilters.has(q.key) ? "is-active" : ""}`}
                onClick={() => toggleQuickFilter(q.key)}
              >
                {q.label}
              </button>
            ))}
            {quickFilters.size > 0 ? (
              <button
                type="button"
                className="ragic-modal__filter-chip ragic-modal__filter-chip--clear"
                onClick={clearQuickFilters}
              >
                清除
              </button>
            ) : null}
            <span className="ragic-modal__filter-count">
              {isFiltering ? (
                <>
                  <strong>{filteredCount}</strong> / {totalCount} 欄
                </>
              ) : (
                <>{totalCount} 欄</>
              )}
            </span>
          </div>

          {showProgress ? (
            <div className="ragic-modal__progress-wrap">
              <RagicRefreshProgress
                key={state?.progress?.startedAt ?? "init"}
                progress={state?.progress ?? null}
                variant="modal"
                complete={!refreshing}
                phaseLabelOverride={
                  autoRefreshing ? "背景自動更新中…" : undefined
                }
                onCancel={
                  userRefreshing ? () => void handleCancelRefresh() : undefined
                }
              />
            </div>
          ) : null}

          {refreshError ? (
            <p className="ragic-modal__error">{refreshError}</p>
          ) : null}
          {error ? <p className="ragic-modal__error">{error}</p> : null}

          <div className="ragic-modal__body">
            {loading ? (
              <p className="ragic-modal__hint ragic-loading-inline">載入中…</p>
            ) : !grouped ? (
              <p className="ragic-modal__hint">
                {isFiltering ? "此表單內沒有符合的欄位" : "此表單沒有欄位資料"}
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
                    query={deferredQuery.trim()}
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onSortToggle={toggleSort}
                    onCopy={(v) => void handleCopy(v)}
                    noteCache={noteCache}
                    stickyOffset={0}
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
                      query={deferredQuery.trim()}
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSortToggle={toggleSort}
                      onCopy={(v) => void handleCopy(v)}
                      noteCache={noteCache}
                      stickyOffset={0}
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

function SortableTh({
  field,
  label,
  sortKey,
  sortDir,
  onToggle,
}: {
  field: NonNullable<SortKey>;
  label: string;
  sortKey: SortKey;
  sortDir: SortDir;
  onToggle: (key: NonNullable<SortKey>) => void;
}) {
  const active = sortKey === field;
  const arrow = active ? (sortDir === "asc" ? "▲" : "▼") : "↕";
  return (
    <th
      className={`ragic-modal__th-sortable ${active ? "is-active" : ""}`}
      onClick={() => onToggle(field)}
      title={`點擊排序 (${active ? (sortDir === "asc" ? "改降序" : "取消") : "升序"})`}
    >
      <span>{label}</span>
      <span className="ragic-modal__sort-arrow">{arrow}</span>
    </th>
  );
}

function FieldTable({
  title,
  rows,
  query,
  sortKey,
  sortDir,
  onSortToggle,
  onCopy,
  noteCache,
}: {
  title: string;
  rows: RagicFieldIndexEntry[];
  query: string;
  sortKey: SortKey;
  sortDir: SortDir;
  onSortToggle: (key: NonNullable<SortKey>) => void;
  onCopy: (text: string) => void;
  noteCache: Map<string, NoteSegment[]>;
  stickyOffset?: number;
}) {
  return (
    <div className="ragic-modal__table-wrap">
      {title ? <div className="ragic-modal__table-title">{title}</div> : null}
      <table className="ragic-modal__table">
        <thead>
          <tr>
            <SortableTh field="pos" label="位置" sortKey={sortKey} sortDir={sortDir} onToggle={onSortToggle} />
            <SortableTh field="name" label="欄位名" sortKey={sortKey} sortDir={sortDir} onToggle={onSortToggle} />
            <SortableTh field="id" label="欄位 ID" sortKey={sortKey} sortDir={sortDir} onToggle={onSortToggle} />
            <SortableTh field="type" label="型態" sortKey={sortKey} sortDir={sortDir} onToggle={onSortToggle} />
            <th>備註</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="ragic-modal__td-pos">{row.fieldPos ?? "—"}</td>
              <td className="ragic-modal__td-name">
                <HighlightText text={row.fieldName} query={query} />
              </td>
              <td>
                <button
                  type="button"
                  className="ragic-modal__id-btn"
                  onClick={() => onCopy(row.fieldId)}
                  title={`複製 ${row.fieldId}`}
                >
                  <HighlightText text={row.fieldId} query={query} />
                </button>
              </td>
              <td className="ragic-modal__td-type">
                {row.fieldType ? (
                  <HighlightText text={row.fieldType} query={query} />
                ) : (
                  "—"
                )}
              </td>
              <td className="ragic-modal__td-note">
                <NoteChips
                  note={row.fieldNote}
                  query={query}
                  noteCache={noteCache}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NoteChips({
  note,
  query,
  noteCache,
}: {
  note: string | null;
  query: string;
  noteCache: Map<string, NoteSegment[]>;
}) {
  // 從 parent 預算的快取讀；cache miss 時 fallback 到 parseFieldNote（純函式，安全）
  const segs =
    note == null
      ? []
      : (noteCache.get(note) ?? parseFieldNote(note));
  if (segs.length === 0) return <span className="ragic-modal__note-empty">—</span>;
  return (
    <div className="ragic-modal__note-chips">
      {segs.map((seg, idx) => (
        <span
          key={idx}
          className={`ragic-modal__note-chip ragic-modal__note-chip--${seg.tone}`}
          title={seg.text}
        >
          <HighlightText text={seg.text} query={query} />
        </span>
      ))}
    </div>
  );
}

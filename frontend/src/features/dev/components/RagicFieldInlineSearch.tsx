import { useEffect, useMemo, useRef, useState } from "react";
import {
  searchRagicFieldIndex,
  type RagicFieldIndexEntry,
  type RagicFieldIndexState,
} from "../../../api/devRagicFieldIndex";
import { extractErrorMessage, isUnauthorized } from "../../../api/apiErrors";
import { useDevFormBookmarks, type DevFormRef } from "../hooks/useDevFormBookmarks";

const SEARCH_DEBOUNCE_MS = 300;

interface Props {
  token: string;
  /** 共用 state — DevLayout 用 useRagicFieldIndexState 提供（判斷索引是否就緒）*/
  state: RagicFieldIndexState | null;
  /** 401 時通知 parent → re-login */
  onAuthFailure: () => void;
  /** 點擊某 form 時通知 parent 開 detail modal */
  onSelectForm: (formPath: string, formName: string) => void;
}

/** 嘗試從輸入字串抓出 Ragic 表單 path（"default/forms8/104" / "default/c1/16"）*/
function detectFormPath(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const re = /(?:^|\/)(default\/[a-z0-9_-]+\/\d+)(?:[/?#]|$)/i;
  const match = re.exec(trimmed);
  return match?.[1] ?? null;
}

interface FormSummary {
  formPath: string;
  formName: string;
  mainCount: number;
  subtableCount: number;
}

function summariseEntries(entries: RagicFieldIndexEntry[]): FormSummary[] {
  const map = new Map<
    string,
    { formPath: string; formName: string; main: number; subKeys: Set<string> }
  >();
  for (const entry of entries) {
    let bucket = map.get(entry.formPath);
    if (!bucket) {
      bucket = {
        formPath: entry.formPath,
        formName: entry.formName,
        main: 0,
        subKeys: new Set(),
      };
      map.set(entry.formPath, bucket);
    }
    if (entry.scope === "main") {
      bucket.main += 1;
    } else {
      const subKey = entry.subtableKey ?? entry.subtableName ?? "_default";
      bucket.subKeys.add(subKey);
    }
  }
  return [...map.values()].map((b) => ({
    formPath: b.formPath,
    formName: b.formName,
    mainCount: b.main,
    subtableCount: b.subKeys.size,
  }));
}

/**
 * 對 summary 排序，讓 form-number 前綴匹配的 form 浮到最上面。
 *
 * 解決：user 輸入 "73" 想找 `[73] 工令單...`，但後端 search_text 是平等 LIKE
 * → 任何 fieldId / fieldNote 含 73 的 form 全混進來、目標被淹掉。
 *
 * 排序 priority（值越小越前面）：
 *   0: formName 開頭就是 [<query>] （exact form-number 命中）
 *   1: formName 任意位置含 [<query>]
 *   2: formName 含 <query>（不在方括號內）
 *   3: 其他（只匹配到 field-level）
 *
 * 純文字 query（含字母 / 中文）也適用 — bracketed 比對只有 [query] 完全相等才走 0/1，
 * 沒中也只是 fall through 到 2/3，不會破壞既有行為。
 */
function rankSummariesByQuery(
  summaries: FormSummary[],
  query: string
): FormSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return summaries;
  const bracketed = `[${q}]`;
  function priority(s: FormSummary): number {
    const name = s.formName.toLowerCase();
    if (name.startsWith(bracketed)) return 0;
    if (name.includes(bracketed)) return 1;
    if (name.includes(q)) return 2;
    return 3;
  }
  return [...summaries].sort((a, b) => {
    const pa = priority(a);
    const pb = priority(b);
    if (pa !== pb) return pa - pb;
    return a.formName.localeCompare(b.formName);
  });
}

export function RagicFieldInlineSearch({
  token,
  state,
  onAuthFailure,
  onSelectForm,
}: Props) {
  const [results, setResults] = useState<RagicFieldIndexEntry[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const debounceRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const onAuthFailureRef = useRef(onAuthFailure);
  useEffect(() => {
    onAuthFailureRef.current = onAuthFailure;
  }, [onAuthFailure]);

  // 搜尋：debounce + URL 偵測 + AbortController
  useEffect(() => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setSearching(false);
      setSearchError(null);
      return;
    }
    setSearching(true);
    debounceRef.current = window.setTimeout(async () => {
      // 取消上一次 in-flight
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const detectedPath = detectFormPath(trimmed);
        let data: RagicFieldIndexEntry[];
        if (detectedPath) {
          const r = await searchRagicFieldIndex(
            token,
            { formPath: detectedPath, limit: 1000 },
            { signal: controller.signal }
          );
          data = r.data;
        } else if (/^\d{1,4}$/.test(trimmed)) {
          // 純數字 query：除了一般 q 搜尋，再額外打一條 `[<digits>]` 確保 form-number
          // 命中的表單會出現（後端 LIKE 搜+限額 500 有時會把目標 form 擠掉）
          const [byText, byBracket] = await Promise.all([
            searchRagicFieldIndex(
              token,
              { q: trimmed, limit: 500 },
              { signal: controller.signal }
            ),
            searchRagicFieldIndex(
              token,
              { q: `[${trimmed}]`, limit: 500 },
              { signal: controller.signal }
            ),
          ]);
          // 合併去重，bracket 命中放前面（後續 ranking 還會再排）
          const seen = new Set<number>();
          data = [];
          for (const e of [...byBracket.data, ...byText.data]) {
            if (seen.has(e.id)) continue;
            seen.add(e.id);
            data.push(e);
          }
        } else {
          const r = await searchRagicFieldIndex(
            token,
            { q: trimmed, limit: 500 },
            { signal: controller.signal }
          );
          data = r.data;
        }
        if (controller.signal.aborted) return;
        setResults(data);
        setSearchError(null);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (isUnauthorized(error)) {
          onAuthFailureRef.current();
          return;
        }
        setSearchError(extractErrorMessage(error, "search failed"));
        setResults([]);
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [query, token]);

  // unmount 時取消 in-flight
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const summaries = useMemo(
    () => rankSummariesByQuery(summariseEntries(results), query),
    [results, query]
  );

  const searchDisabled =
    !state || (state.status !== "ready" && state.totalFields === 0);

  const { recent, pinned, pushRecent, togglePin, isPinned } = useDevFormBookmarks();
  const openForm = (formPath: string, formName: string) => {
    pushRecent({ formPath, formName });
    onSelectForm(formPath, formName);
  };

  return (
    <div className="ragic-inline">
      <div className="ragic-inline__toolbar">
        <input
          type="search"
          className="ragic-inline__search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="輸入名稱、ID，或直接貼上 Ragic 表單網址…"
          aria-label="search ragic field"
          disabled={searchDisabled}
        />
        <span
          className="ragic-inline__info"
          role="img"
          aria-label="使用說明"
          title={
            "輸入表單名 / 欄位名 / 欄位 ID 即時搜尋\n貼上 Ragic 表單網址（如 https://fdtw.app/default/forms8/104）→ 自動鎖定該表單\n點任何表單可開啟詳細欄位列表，並在裡面再次搜尋"
          }
        >
          ⓘ
        </span>
      </div>

      {searchDisabled ? (
        <p className="ragic-inline__hint">索引尚未建立 — 點右上角「↻ 重新抓取」先建索引。</p>
      ) : null}
      {searchError ? (
        <p className="ragic-inline__error">{searchError}</p>
      ) : null}

      <div className="ragic-inline__body">
        {query.trim() === "" ? (
          <DevSearchDashboard
            state={state}
            recent={recent}
            pinned={pinned}
            isPinned={isPinned}
            onOpen={openForm}
            onTogglePin={togglePin}
          />
        ) : searching ? (
          <p className="ragic-inline__hint">搜尋中…</p>
        ) : summaries.length === 0 ? (
          <p className="ragic-inline__hint">沒有結果</p>
        ) : (
          <div className="ragic-inline__results">
            {summaries.map((s) => (
              <FormCard
                key={s.formPath}
                formPath={s.formPath}
                formName={s.formName}
                meta={`主表 ${s.mainCount} 欄 · 子表 ${s.subtableCount} 個`}
                pinned={isPinned(s.formPath)}
                onOpen={openForm}
                onTogglePin={togglePin}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FormCard({
  formPath,
  formName,
  meta,
  pinned,
  onOpen,
  onTogglePin,
}: {
  formPath: string;
  formName: string;
  meta?: string;
  pinned: boolean;
  onOpen: (formPath: string, formName: string) => void;
  onTogglePin: (form: DevFormRef) => void;
}) {
  return (
    <div
      className="ragic-inline__form-card"
      role="button"
      tabIndex={0}
      onClick={() => onOpen(formPath, formName)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(formPath, formName);
        }
      }}
    >
      <span className="ragic-inline__form-name">{formName}</span>
      <span className="ragic-inline__form-meta">
        <code className="ragic-inline__form-path">{formPath}</code>
        {meta ? <span className="ragic-inline__form-counts">{meta}</span> : null}
      </span>
      <button
        type="button"
        className={`ragic-inline__pin${pinned ? " is-pinned" : ""}`}
        title={pinned ? "取消釘選" : "釘選到總覽"}
        aria-label={pinned ? "取消釘選" : "釘選到總覽"}
        onClick={(e) => {
          e.stopPropagation();
          onTogglePin({ formPath, formName });
        }}
      >
        {pinned ? "★" : "☆"}
      </button>
    </div>
  );
}

function DevSearchDashboard({
  state,
  recent,
  pinned,
  isPinned,
  onOpen,
  onTogglePin,
}: {
  state: RagicFieldIndexState | null;
  recent: DevFormRef[];
  pinned: DevFormRef[];
  isPinned: (formPath: string) => boolean;
  onOpen: (formPath: string, formName: string) => void;
  onTogglePin: (form: DevFormRef) => void;
}) {
  const hasBookmarks = pinned.length > 0 || recent.length > 0;
  return (
    <div className="ragic-inline__dash">
      <div className="ragic-inline__stats">
        <div className="ragic-inline__stat">
          <span className="ragic-inline__stat-num">
            {state ? state.totalForms.toLocaleString() : "—"}
          </span>
          <span className="ragic-inline__stat-label">表單</span>
        </div>
        <div className="ragic-inline__stat">
          <span className="ragic-inline__stat-num">
            {state ? state.totalFields.toLocaleString() : "—"}
          </span>
          <span className="ragic-inline__stat-label">欄位</span>
        </div>
      </div>

      {pinned.length > 0 ? (
        <section className="ragic-inline__dash-sec">
          <h4 className="ragic-inline__dash-title">釘選</h4>
          <div className="ragic-inline__results">
            {pinned.map((f) => (
              <FormCard
                key={f.formPath}
                formPath={f.formPath}
                formName={f.formName}
                pinned
                onOpen={onOpen}
                onTogglePin={onTogglePin}
              />
            ))}
          </div>
        </section>
      ) : null}

      {recent.length > 0 ? (
        <section className="ragic-inline__dash-sec">
          <h4 className="ragic-inline__dash-title">最近開啟</h4>
          <div className="ragic-inline__results">
            {recent.map((f) => (
              <FormCard
                key={f.formPath}
                formPath={f.formPath}
                formName={f.formName}
                pinned={isPinned(f.formPath)}
                onOpen={onOpen}
                onTogglePin={onTogglePin}
              />
            ))}
          </div>
        </section>
      ) : null}

      {!hasBookmarks ? (
        <p className="ragic-inline__hint">
          上方搜尋框輸入名稱／ID／表單網址開始。開過的表單會留在「最近開啟」，常用的按 ☆ 釘選到這裡。
        </p>
      ) : null}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import {
  searchRagicFieldIndex,
  type RagicFieldIndexEntry,
  type RagicFieldIndexState,
} from "../../../api/devRagicFieldIndex";
import { extractErrorMessage, isUnauthorized } from "../../../api/apiErrors";
import { useLingering } from "../hooks/useLingering";
import { RagicRefreshProgress } from "./RagicRefreshProgress";

const SEARCH_DEBOUNCE_MS = 300;

interface Props {
  token: string;
  /** 共用 state — 由 panel 用 useRagicFieldIndexState 提供 */
  state: RagicFieldIndexState | null;
  /** 觸發 refresh — panel 已包好 401 / 錯誤處理 */
  onRefresh: () => Promise<void> | void;
  /** refresh 失敗訊息（panel 統一拿） */
  refreshError: string | null;
  /** 401 時通知 parent → re-login */
  onAuthFailure: () => void;
  /** 點擊某 form 時通知 parent 開 detail modal */
  onSelectForm: (formPath: string, formName: string) => void;
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "尚未抓取";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))} 秒前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分鐘前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小時前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
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

export function RagicFieldInlineSearch({
  token,
  state,
  onRefresh,
  refreshError,
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
        const data = detectedPath
          ? await searchRagicFieldIndex(
              token,
              { formPath: detectedPath, limit: 1000 },
              { signal: controller.signal }
            )
          : await searchRagicFieldIndex(
              token,
              { q: trimmed, limit: 500 },
              { signal: controller.signal }
            );
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

  const summaries = useMemo(() => summariseEntries(results), [results]);

  const stateLine = (() => {
    if (!state) return "載入中…";
    if (state.status === "refreshing") return "正在重新抓取…";
    if (state.status === "error") return `錯誤：${state.message ?? "unknown"}`;
    if (state.status === "idle" || !state.refreshedAt) {
      return "尚未抓取（請按右側「重新抓取」）";
    }
    return `已索引 ${state.totalForms} form / ${state.totalFields} 欄位 · 更新於 ${formatRelativeTime(state.refreshedAt)}`;
  })();

  const refreshing = state?.status === "refreshing";
  // refresh 完成後再保留進度條 500ms 顯示 100% / 「完成」
  const showProgress = useLingering(refreshing, 500);
  const searchDisabled =
    !state || (state.status !== "ready" && state.totalFields === 0);

  return (
    <div className="ragic-inline">
      <div className="ragic-inline__toolbar">
        <input
          type="search"
          className="ragic-inline__search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜尋表單名 / 欄位名 / 欄位 ID，或貼上 Ragic 表單網址"
          aria-label="search ragic field"
          disabled={searchDisabled}
        />
        <button
          type="button"
          className="ragic-inline__refresh-btn"
          onClick={() => void onRefresh()}
          disabled={refreshing}
          title="重新從 Ragic /sims/doc.jsp 抓取最新欄位"
        >
          {refreshing ? "抓取中…" : "↻ 重新抓取"}
        </button>
      </div>

      <div className="ragic-inline__statusline">{stateLine}</div>

      {showProgress ? (
        <RagicRefreshProgress
          key={state?.progress?.startedAt ?? "init"}
          progress={state?.progress ?? null}
          variant="inline"
          complete={!refreshing}
        />
      ) : null}

      {refreshError ? (
        <p className="ragic-inline__error">{refreshError}</p>
      ) : null}
      {searchError ? (
        <p className="ragic-inline__error">{searchError}</p>
      ) : null}

      <div className="ragic-inline__body">
        {query.trim() === "" ? (
          <div className="ragic-inline__hint">
            <p>使用方法：</p>
            <ul>
              <li>輸入表單名 / 欄位名 / 欄位 ID 即時搜尋</li>
              <li>
                或貼上 Ragic 表單網址（如{" "}
                <code>https://demo.local/default/forms8/104</code>）→ 自動鎖定該表單
              </li>
              <li>點擊任何符合的表單可開啟詳細欄位列表，並在裡面再次搜尋</li>
            </ul>
          </div>
        ) : searching ? (
          <p className="ragic-inline__hint">搜尋中…</p>
        ) : summaries.length === 0 ? (
          <p className="ragic-inline__hint">沒有結果</p>
        ) : (
          <div className="ragic-inline__results">
            {summaries.map((s) => (
              <button
                key={s.formPath}
                type="button"
                className="ragic-inline__form-card"
                onClick={() => onSelectForm(s.formPath, s.formName)}
              >
                <span className="ragic-inline__form-name">{s.formName}</span>
                <span className="ragic-inline__form-meta">
                  <code className="ragic-inline__form-path">{s.formPath}</code>
                  <span className="ragic-inline__form-counts">
                    主表 {s.mainCount} 欄 · 子表 {s.subtableCount} 個
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

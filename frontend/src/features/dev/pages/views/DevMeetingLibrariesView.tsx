import {
  AudioOutlined,
  CheckOutlined,
  CopyOutlined,
  FolderOpenOutlined,
  KeyOutlined,
  LoadingOutlined,
  ReloadOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { isUnauthorized } from "../../../../api/apiErrors";
import {
  fetchMeetingAdminLibraries,
  openMeetingAdminLibrary,
  rotateMeetingAdminLibraryCode,
  type MeetingAdminLibrary,
} from "../../../meeting-minutes/api/meetingLibraryAdminApi";
import { resolveMeetingRecordingApiError } from "../../../meeting-minutes/api/meetingRecordingApi";
import { MEETING_LIBRARY_ROUTE } from "../../../meeting-minutes/routes";
import { useDevContext } from "../../layout/devContext";

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("zh-TW", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
}

export function DevMeetingLibrariesView() {
  const { token, onAuthFailure } = useDevContext();
  const navigate = useNavigate();
  const requestRevisionRef = useRef(0);
  const actionInFlightRef = useRef(false);
  const [query, setQuery] = useState("");
  const [libraries, setLibraries] = useState<MeetingAdminLibrary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const [totalRecordingCount, setTotalRecordingCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [revealedCode, setRevealedCode] = useState<{
    libraryId: string;
    code: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleError = useCallback(
    (error: unknown, fallback: string) => {
      if (isUnauthorized(error)) {
        onAuthFailure("開發者登入已過期，請重新登入");
        return;
      }
      setErrorMessage(resolveMeetingRecordingApiError(error) ?? fallback);
    },
    [onAuthFailure]
  );

  const loadLibraries = useCallback(
    async (searchQuery: string, cursor: string | null = null) => {
      const revision = requestRevisionRef.current + 1;
      requestRevisionRef.current = revision;
      setLoading(true);
      setErrorMessage(null);
      try {
        const page = await fetchMeetingAdminLibraries(token, searchQuery, 100, cursor);
        if (requestRevisionRef.current === revision) {
          setLibraries((current) => {
            if (!cursor) return page.items;
            const knownIds = new Set(current.map((library) => library.libraryId));
            return [...current, ...page.items.filter((library) => !knownIds.has(library.libraryId))];
          });
          setNextCursor(page.nextCursor);
          setHasMore(page.hasMore);
          setTotalCount(page.totalCount);
          setTotalRecordingCount(page.totalRecordingCount);
        }
      } catch (error) {
        if (requestRevisionRef.current === revision) {
          handleError(error, "讀取會議錄音庫失敗");
        }
      } finally {
        if (requestRevisionRef.current === revision) setLoading(false);
      }
    },
    [handleError, token]
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadLibraries(query.trim(), null);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [loadLibraries, query]);

  const updateQuery = (value: string) => {
    requestRevisionRef.current += 1;
    setQuery(value);
    setLoading(true);
    setConfirmingId(null);
  };

  const openLibrary = async (libraryId: string) => {
    if (actionInFlightRef.current || loading) return;
    actionInFlightRef.current = true;
    setOpeningId(libraryId);
    setErrorMessage(null);
    try {
      await openMeetingAdminLibrary(token, libraryId);
      navigate(MEETING_LIBRARY_ROUTE, {
        state: { meetingLibrarySource: "dev-meeting-libraries" },
      });
    } catch (error) {
      handleError(error, "開啟會議錄音庫失敗");
    } finally {
      actionInFlightRef.current = false;
      setOpeningId(null);
    }
  };

  const rotateCode = async (libraryId: string) => {
    if (actionInFlightRef.current || loading) return;
    actionInFlightRef.current = true;
    requestRevisionRef.current += 1;
    setLoading(false);
    setRotatingId(libraryId);
    setErrorMessage(null);
    setCopied(false);
    try {
      const result = await rotateMeetingAdminLibraryCode(token, libraryId);
      if (!result.code || !result.library) {
        throw new Error("後端未回傳新錄音庫 Code");
      }
      setRevealedCode({ libraryId, code: result.code });
      setLibraries((current) =>
        current.map((library) =>
          library.libraryId === libraryId
            ? { ...library, ...result.library }
            : library
        )
      );
      setConfirmingId(null);
    } catch (error) {
      handleError(error, "重設會議錄音庫 Code 失敗");
    } finally {
      actionInFlightRef.current = false;
      setRotatingId(null);
    }
  };

  const copyCode = async () => {
    if (!revealedCode) return;
    try {
      await navigator.clipboard.writeText(revealedCode.code);
      setCopied(true);
      setErrorMessage(null);
    } catch {
      setCopied(false);
      setErrorMessage("無法自動複製，請手動選取 Code");
    }
  };

  return (
    <section className="dev-meeting-libraries" aria-labelledby="dev-meeting-libraries-title">
      <header className="dev-meeting-libraries__hero">
        <div>
          <span className="dev-meeting-libraries__eyebrow">MEETING DATA</span>
          <h1 id="dev-meeting-libraries-title">會議錄音庫管理</h1>
          <p>跨錄音庫查詢與唯讀檢視。既有 Code 不可讀回；重設後只顯示新 Code 一次。</p>
        </div>
        <button
          type="button"
          className="dev-mode-btn"
          onClick={() => void loadLibraries(query.trim(), null)}
          disabled={loading}
        >
          <ReloadOutlined spin={loading} aria-hidden="true" />
          重新整理
        </button>
      </header>

      <div className="dev-meeting-libraries__toolbar">
        <label>
          <SearchOutlined aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => updateQuery(event.target.value)}
            placeholder="搜尋 Library ID 或會議名稱"
            aria-label="搜尋會議錄音庫"
          />
        </label>
        <dl>
          <div><dt>錄音庫</dt><dd>{totalCount}</dd></div>
          <div><dt>錄音</dt><dd>{totalRecordingCount}</dd></div>
        </dl>
      </div>

      {revealedCode ? (
        <section className="dev-meeting-code-reveal" aria-live="polite">
          <div>
            <span>新 Code · {revealedCode.libraryId.slice(0, 8).toUpperCase()}</span>
            <strong>{revealedCode.code}</strong>
            <small>這是唯一一次顯示。關閉後只能再次重設，不能讀回舊 Code。</small>
          </div>
          <div>
            <button type="button" className="dev-mode-btn" onClick={() => void copyCode()}>
              {copied ? <CheckOutlined aria-hidden="true" /> : <CopyOutlined aria-hidden="true" />}
              {copied ? "已複製" : "複製 Code"}
            </button>
            <button type="button" className="dev-mode-btn" onClick={() => setRevealedCode(null)}>
              我已保存
            </button>
          </div>
        </section>
      ) : null}

      {errorMessage ? <p className="dev-mode-error" role="alert">{errorMessage}</p> : null}

      <div className="dev-meeting-libraries__table" role="region" aria-label="會議錄音庫清單">
        <div className="dev-meeting-libraries__head" aria-hidden="true">
          <span>Library</span><span>最近錄音</span><span>數量</span><span>Code</span><span>操作</span>
        </div>
        {loading && libraries.length === 0 ? (
          <div className="dev-meeting-libraries__empty" role="status">
            <LoadingOutlined spin aria-hidden="true" />
            讀取錄音庫中…
          </div>
        ) : libraries.length === 0 ? (
          <div className="dev-meeting-libraries__empty">
            <AudioOutlined aria-hidden="true" />
            {query.trim() ? "找不到符合條件的錄音庫" : "目前尚無會議錄音庫"}
          </div>
        ) : (
          <ol className="dev-meeting-libraries__rows">
            {libraries.map((library) => (
              <li key={library.libraryId}>
                <div className="dev-meeting-libraries__identity">
                  <code>{library.libraryId}</code>
                  <small>建立 {formatDateTime(library.createdAt)}</small>
                </div>
                <div className="dev-meeting-libraries__latest">
                  <strong>{library.latestRecording?.title ?? "尚無錄音"}</strong>
                  <small>{library.latestRecording ? formatDateTime(library.latestRecording.createdAt) : "--"}</small>
                </div>
                <strong className="dev-meeting-libraries__count">{library.recordingCount}</strong>
                <div className="dev-meeting-libraries__code-state">
                  <KeyOutlined aria-hidden="true" />
                  <span>第 {library.accessVersion} 版</span>
                  <small>{formatDateTime(library.codeRotatedAt)}</small>
                </div>
                <div className="dev-meeting-libraries__actions">
                  <button
                    type="button"
                    className="dev-mode-btn dev-mode-btn--primary"
                    onClick={() => void openLibrary(library.libraryId)}
                    disabled={loading || Boolean(openingId || rotatingId)}
                  >
                    {openingId === library.libraryId ? <LoadingOutlined spin /> : <FolderOpenOutlined />}
                    唯讀開啟
                  </button>
                  {confirmingId === library.libraryId ? (
                    <div className="dev-meeting-libraries__confirm" role="alert">
                      <span>舊 Code 與既有 viewer session 會立即失效。</span>
                      <button
                        type="button"
                        onClick={() => void rotateCode(library.libraryId)}
                        disabled={loading || rotatingId === library.libraryId}
                      >
                        {rotatingId === library.libraryId ? <LoadingOutlined spin /> : null}
                        確認重設
                      </button>
                      <button type="button" onClick={() => setConfirmingId(null)} disabled={Boolean(rotatingId)}>
                        取消
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="dev-mode-btn"
                      onClick={() => setConfirmingId(library.libraryId)}
                      disabled={loading || Boolean(openingId || rotatingId)}
                    >
                      <ReloadOutlined aria-hidden="true" />
                      重設 Code
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
        {hasMore && nextCursor ? (
          <button
            type="button"
            className="dev-mode-btn dev-meeting-libraries__more"
            onClick={() => void loadLibraries(query.trim(), nextCursor)}
            disabled={loading}
          >
            {loading ? <LoadingOutlined spin aria-hidden="true" /> : null}
            載入更多錄音庫
          </button>
        ) : null}
      </div>
    </section>
  );
}

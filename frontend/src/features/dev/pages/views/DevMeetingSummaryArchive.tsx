import { DownloadOutlined, LoadingOutlined, ReloadOutlined } from "@ant-design/icons";
import { ConfigProvider, Modal, theme as antdTheme } from "antd";
import { useEffect, useState } from "react";
import { downloadMeetingSummaryHtml, fetchMeetingSummaryArchive, fetchMeetingSummaryHtml, type MeetingSummaryItem } from "../../../meeting-minutes/api/meetingLibraryAdminApi";
import { useDevContext } from "../../layout/devContext";
import { isUnauthorized } from "../../../../api/apiErrors";
import { DevLegacyRecordings } from "./DevLegacyRecordings";
import { DevMeetingDevices } from "./DevMeetingDevices";
import "../../styles/dev-meeting-summaries.css";

export function DevMeetingSummaryArchive() {
  const { token, onAuthFailure } = useDevContext();
  const [query, setQuery] = useState("");
  const [showLegacy, setShowLegacy] = useState(false);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [items, setItems] = useState<MeetingSummaryItem[]>([]);
  const [stats, setStats] = useState<{ count: number; bytes: number; maxBytes: number } | null>(null);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ sessionId: string; token: string; html: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [modalDownloadError, setModalDownloadError] = useState<string | null>(null);
  const html = preview?.sessionId === selectedId && preview?.token === token ? preview.html : null;
  const selectedItem = items.find(item => item.sessionId === selectedId) ?? null;
  const [loading, setLoading] = useState(true);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      setLoading(true); setError(null);
      void fetchMeetingSummaryArchive(token, query.trim(), offset).then(result => {
        if (active) { setItems(result.items); setStats(result.stats); setBlockedReason(result.admission?.reason ?? null); }
      }).catch(cause => {
        if (!active) return;
        if (isUnauthorized(cause)) onAuthFailure("開發者登入已過期，請重新登入");
        else setError("無法讀取摘要庫，請重新整理。");
      }).finally(() => { if (active) setLoading(false); });
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [token, query, offset, revision, onAuthFailure]);
  useEffect(() => {
    if (!selectedId) { setPreviewLoading(false); setPreviewError(null); return; }
    if (preview?.sessionId === selectedId && preview.token === token) {
      setPreviewLoading(false); setPreviewError(null); return;
    }
    let active = true;
    setPreviewLoading(true); setPreviewError(null);
    void fetchMeetingSummaryHtml(token, selectedId).then(result => { if (active) setPreview({ sessionId: selectedId, token, html: result }); }).catch(cause => {
      if (!active) return;
      if (isUnauthorized(cause)) onAuthFailure("開發者登入已過期，請重新登入");
      else setPreviewError("摘要讀取失敗，請關閉後重試。");
    }).finally(() => { if (active) setPreviewLoading(false); });
    return () => { active = false; };
  }, [token, selectedId, preview, onAuthFailure]);
  const closePreview = () => { setSelectedId(null); setModalDownloadError(null); };
  const openPreview = (sessionId: string) => { setModalDownloadError(null); setSelectedId(sessionId); };
  const download = async (sessionId: string, source: "list" | "modal" = "list") => {
    setDownloadingId(sessionId);
    if (source === "modal") setModalDownloadError(null); else setError(null);
    try { await downloadMeetingSummaryHtml(token, sessionId); }
    catch (cause) {
      if (isUnauthorized(cause)) onAuthFailure("開發者登入已過期，請重新登入");
      else if (source === "modal") setModalDownloadError("HTML 下載失敗，請重試。");
      else setError("HTML 下載失敗，請重試。");
    } finally { setDownloadingId(null); }
  };
  return <section className="dev-meeting-libraries" aria-labelledby="meeting-summary-archive-title">
    <header className="dev-meeting-libraries__hero"><div><h1 id="meeting-summary-archive-title">會議摘要庫</h1><p>僅開發者可見。每場保留一份摘要 HTML，不保存長期音檔或逐字稿。</p></div><button className="dev-mode-btn" disabled={loading} onClick={() => setRevision(value => value + 1)}><ReloadOutlined spin={loading} />重新整理摘要</button></header>
    <DevMeetingDevices />
    <div className="dev-meeting-libraries__toolbar"><label><input aria-label="搜尋會議摘要" placeholder="搜尋會議名稱" value={query} onChange={event => { setLoading(true); setQuery(event.target.value); setOffset(0); }} /></label>{stats && <span>{stats.count} 份 · {(stats.bytes / 1048576).toFixed(2)} / {(stats.maxBytes / 1048576).toFixed(0)} MiB HTML</span>}</div>
    {blockedReason === "MEETING_SUMMARY_ARCHIVE_FULL" && <p role="alert">摘要庫剩餘容量不足，新的錄音已暫停；請處理容量，不會自動刪除舊摘要。</p>}
    {blockedReason === "MEETING_ONE_SHOT_PROVIDER_NOT_READY" && <p role="alert">會議處理服務尚未啟用，新的錄音已暫停。</p>}
    {error && <p className="dev-mode-error" role="alert">{error}</p>}
    {loading && <p role="status"><LoadingOutlined spin /> 讀取摘要中…</p>}
    {!loading && !error && items.length === 0 && <p>尚無符合條件的摘要。</p>}
    <ul>{items.map(item => <li key={item.sessionId}><button className="dev-mode-btn" disabled={loading} onClick={() => openPreview(item.sessionId)}>{item.title}</button> <time>{new Date(item.archivedAt).toLocaleString()}</time> <button className="dev-mode-btn" aria-label={`下載 ${item.title} HTML`} disabled={loading || downloadingId !== null} onClick={() => void download(item.sessionId)}>{downloadingId === item.sessionId ? <LoadingOutlined spin /> : <DownloadOutlined />} 下載 HTML</button></li>)}</ul>
    <div><button className="dev-mode-btn" disabled={loading || offset === 0} onClick={() => setOffset(value => Math.max(0, value - 50))}>上一頁</button><button className="dev-mode-btn" disabled={loading || items.length < 50} onClick={() => setOffset(value => value + 50)}>下一頁</button></div>
    <ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}>
      <Modal
        open={selectedId !== null}
        title={selectedItem ? `會議摘要預覽 · ${selectedItem.title}` : "會議摘要預覽"}
        onCancel={closePreview}
        width="min(1120px, calc(100vw - 32px))"
        className="dev-meeting-summary-modal"
        footer={
          <div className="dev-meeting-summary-modal__actions">
            {modalDownloadError && <p className="dev-mode-error" role="alert">{modalDownloadError}</p>}
            {selectedId && <button className="dev-mode-btn" aria-label="下載目前摘要 HTML" disabled={downloadingId !== null} onClick={() => void download(selectedId, "modal")}>{downloadingId === selectedId ? <LoadingOutlined spin /> : <DownloadOutlined />} 下載 HTML</button>}
            <button className="dev-mode-btn dev-mode-btn--primary" onClick={closePreview}>關閉預覽</button>
          </div>
        }
      >
        <div className="dev-meeting-summary-modal__body">
          {previewLoading && !html && <p className="dev-meeting-summary-modal__status" role="status"><LoadingOutlined spin /> 讀取摘要內容中…</p>}
          {previewError && <p className="dev-mode-error" role="alert">{previewError}</p>}
          {html && !previewError && <iframe className="dev-meeting-summary-modal__frame" title="後台會議摘要" sandbox="" srcDoc={html} />}
        </div>
      </Modal>
    </ConfigProvider>
    <button className="dev-mode-btn" aria-expanded={showLegacy} onClick={() => setShowLegacy(value => !value)}>{showLegacy ? "關閉既有錄音" : "查閱既有錄音（唯讀）"}</button>
    {showLegacy && <DevLegacyRecordings key={token} />}
  </section>;
}

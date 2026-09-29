import { useEffect, useState } from "react";
import { downloadLegacyRecordingFile, fetchLegacyMinutesVersions, fetchLegacyRecordings } from "../../../meeting-minutes/api/meetingLibraryAdminApi";
import type { MeetingRecordingSession, MeetingMinutesVersion } from "../../../meeting-minutes/api/meetingRecordingApi";
import { useDevContext } from "../../layout/devContext";
import { isUnauthorized } from "../../../../api/apiErrors";

export function DevLegacyRecordings() {
  const { token, onAuthFailure } = useDevContext();
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<MeetingRecordingSession[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [versions, setVersions] = useState<MeetingMinutesVersion[]>([]);
  const [versionsError, setVersionsError] = useState(false);
  const [versionsRetry, setVersionsRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void fetchLegacyRecordings(token, offset).then(result => { if (active) setItems(result); }).catch(cause => {
      if (!active) return;
      if (isUnauthorized(cause)) onAuthFailure("開發者登入已過期，請重新登入");
      else setError("舊錄音讀取失敗，請關閉後重試。");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, offset, onAuthFailure]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    void fetchLegacyMinutesVersions(token, selected).then(result => { if (active) setVersions(result); }).catch(cause => {
      if (!active) return;
      if (isUnauthorized(cause)) onAuthFailure("開發者登入已過期，請重新登入");
      else setVersionsError(true);
    });
    return () => { active = false; };
  }, [token, selected, onAuthFailure, versionsRetry]);
  const download = async (sessionId: string, suffix: string, filename: string) => {
    try { await downloadLegacyRecordingFile(token, sessionId, suffix, filename); }
    catch (cause) {
      if (isUnauthorized(cause)) onAuthFailure("開發者登入已過期，請重新登入");
      else setError("下載失敗，請重試。");
    }
  };
  return <section aria-label="既有錄音唯讀資料">
    <p>僅供查閱退場前已保存的錄音；不提供新增、Code 設定或重新產生摘要。</p>
    {loading && <p role="status">讀取舊錄音中…</p>}
    {error && <p role="alert">{error}</p>}
    {!loading && items.length === 0 && <p>沒有既有錄音。</p>}
    <ul>{items.map(item => <li key={item.sessionId}>
      <button className="dev-mode-btn" onClick={() => { if (selected === item.sessionId) return; setVersions([]); setVersionsError(false); setError(null); setSelected(item.sessionId); }}>{item.title}</button>
      {item.tracks.filter(track => track.available).map(track => <button className="dev-mode-btn" key={track.sourceId} onClick={() => void download(item.sessionId, `tracks/${track.sourceId}`, `${item.sessionId}-${track.sourceId}.${track.mimeType.includes("ogg") ? "ogg" : "webm"}`)}>下載 {track.sourceId}</button>)}
    </li>)}</ul>
    {selected && versionsError && <p role="alert">舊摘要讀取失敗。<button className="dev-mode-btn" onClick={() => { setVersionsError(false); setVersionsRetry(value => value + 1); }}>重試讀取摘要</button></p>}
    {selected && <ul aria-label="既有摘要版本">{versions.map(version => <li key={version.versionId}>版本 {version.versionNumber} <button className="dev-mode-btn" onClick={() => void download(selected, `minutes/versions/${encodeURIComponent(version.versionId)}/package.zip`, `${selected}.zip`)}>下載既有 ZIP</button></li>)}</ul>}
    <button className="dev-mode-btn" disabled={loading || offset === 0} onClick={() => { setLoading(true); setItems([]); setError(null); setSelected(null); setOffset(value => Math.max(0, value - 50)); }}>上一頁舊錄音</button>
    <button className="dev-mode-btn" disabled={loading || items.length < 50} onClick={() => { setLoading(true); setItems([]); setError(null); setSelected(null); setOffset(value => value + 50); }}>下一頁舊錄音</button>
  </section>;
}

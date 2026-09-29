import { subscribeMeetingStateEvents } from "../../../meeting-minutes/api/meetingStateEvents";
import { LoadingOutlined, ReloadOutlined } from "@ant-design/icons";
import { useEffect, useState } from "react";
import { isUnauthorized } from "../../../../api/apiErrors";
import {
  cancelAdminMeeting,
  fetchAdminMeetings,
  retryAdminMeeting,
  type MeetingAdminMeeting,
  type MeetingAdminPhase,
  type MeetingAdminState,
} from "../../../meeting-minutes/api/meetingLibraryAdminApi";
import { useDevContext } from "../../layout/devContext";

function phaseLabel(phase: MeetingAdminPhase): string {
  if (phase === "recording") return "錄音中";
  if (phase === "interrupted") return "錄音連線已中斷";
  if (phase === "finalizing") return "正在完成錄音收尾";
  if (phase === "processing") return "正在整理音檔";
  if (phase === "transcribing") return "正在產生逐字稿";
  if (phase === "summarizing") return "正在產生摘要";
  if (phase === "cancelling") return "正在取消";
  if (phase === "cancelled") return "已取消";
  if (phase === "ready") return "已完成";
  if (phase === "expired") return "已到期";
  if (phase === "failed") return "失敗／可重試";
  return "狀態讀取失敗";
}

export function DevMeetingDevices() {
  const { token, onAuthFailure } = useDevContext();
  const [state, setState] = useState<MeetingAdminState | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busySession, setBusySession] = useState<string | null>(null);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    let pending = false;
    const load = async (showLoading: boolean) => {
      if (inFlight) { pending = true; return; }
      inFlight = true;
      if (showLoading) setLoading(true);
      try {
        const result = await fetchAdminMeetings(token);
        if (!active) return;
        setState(result);
        setError(null);
        setRefreshedAt(new Date());
      } catch (cause) {
        if (!active) return;
        if (isUnauthorized(cause)) onAuthFailure("開發者登入已過期，請重新登入");
        else setError("無法讀取會議狀態，系統會自動重試。");
      } finally {
        inFlight = false;
        if (active && showLoading) setLoading(false);
        if (active && pending) { pending = false; void load(false); }
      }
    };
    const unsubscribe = subscribeMeetingStateEvents(() => void load(false), setConnected);
    void load(true);
    return () => { active = false; unsubscribe(); };
  }, [token, revision, onAuthFailure]);

  const run = async (meeting: MeetingAdminMeeting, action: () => Promise<unknown>) => {
    setBusySession(meeting.sessionId);
    setError(null);
    try { await action(); setRevision(value => value + 1); }
    catch (cause) {
      if (isUnauthorized(cause)) onAuthFailure("開發者登入已過期，請重新登入");
      else setError("會議操作失敗，請重新整理後再試。");
    } finally { setBusySession(null); }
  };

  const cancel = (meeting: MeetingAdminMeeting) => {
    if (!window.confirm(`取消「${meeting.title}」？系統會先停止相關背景工作，再釋放會議名額。`)) return;
    void run(meeting, () => cancelAdminMeeting(token, meeting.sessionId));
  };

  const retry = (meeting: MeetingAdminMeeting) => {
    if (!window.confirm(`重試「${meeting.title}」？只有取得會議名額後才會開始。`)) return;
    void run(meeting, () => retryAdminMeeting(token, meeting.sessionId));
  };

  return <section className="dev-meeting-devices" aria-labelledby="meeting-devices-title">
    <header><div><p className="dev-meeting-libraries__eyebrow">MEETING CONTROL</p><h2 id="meeting-devices-title">進行中會議</h2><p>瀏覽器數量不受限制；Server 最多同時承接兩場錄音或背景處理中的會議。</p></div>
      <button className="dev-mode-btn" disabled={loading} onClick={() => setRevision(value => value + 1)}><ReloadOutlined spin={loading} />重新整理</button></header>
    {state && <><div className="dev-meeting-devices__stats"><span>目前已占用：{state.stats.activeMeetings}／{state.stats.maxMeetings}</span></div>
      <p className="dev-meeting-devices__freshness">{connected ? "即時連線中" : "即時連線中斷，正在重新連線"}{refreshedAt ? ` · 最後更新 ${refreshedAt.toLocaleTimeString()}` : ""}</p></>}
    {error && <p className="dev-mode-error" role="alert">{error}</p>}
    {loading && <p role="status"><LoadingOutlined spin /> 讀取會議中…</p>}
    {!loading && state?.meetings.length === 0 && <p>目前沒有會議紀錄。</p>}
    {!loading && state && state.meetings.length > 0 && <section className="dev-meeting-pipelines" aria-label="會議管理">
      <ul>{state.meetings.map(meeting => <li key={meeting.sessionId} className={meeting.occupiesSlot ? "is-active" : ""}>
        <div><strong>{meeting.title}</strong><small>{meeting.sessionId.slice(0, 8)}… · 建立於 {new Date(meeting.createdAt).toLocaleString()}</small></div>
        <span data-phase={meeting.phase}>{phaseLabel(meeting.phase)}</span>
        <div><strong>{meeting.source.displayName}</strong><small>{meeting.source.ip ?? "IP 未記錄"}</small></div>
        <div className="dev-meeting-devices__actions">
          <button className="dev-mode-btn" onClick={() => setExpandedSession(value => value === meeting.sessionId ? null : meeting.sessionId)}>查看</button>
          {meeting.actions.canCancel && <button className="dev-mode-btn is-danger" disabled={busySession === meeting.sessionId} onClick={() => cancel(meeting)}>取消</button>}
          {meeting.actions.canRetry && <button className="dev-mode-btn" disabled={busySession === meeting.sessionId} onClick={() => retry(meeting)}>重試</button>}
        </div>
        {expandedSession === meeting.sessionId && <div className="dev-meeting-pipelines__detail">
          <small>來源：{meeting.source.userAgent ?? "瀏覽器資訊未記錄"}</small>
          <small>錯誤：{meeting.errorCode ?? "—"}{meeting.errorMessage ? ` · ${meeting.errorMessage}` : ""}</small>
          <small>名額：{meeting.occupiesSlot ? "占用中" : "已釋放"}</small>
        </div>}
      </li>)}</ul>
    </section>}
  </section>;
}

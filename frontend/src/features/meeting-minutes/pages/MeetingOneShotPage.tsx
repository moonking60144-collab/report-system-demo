import { subscribeMeetingStateEvents } from "../api/meetingStateEvents";
import { AudioOutlined, CheckCircleOutlined, DownloadOutlined, LoadingOutlined, StopOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMeetingAudioCheck } from "../audio/useMeetingAudioCheck";
import { useMeetingPersistentRecording } from "../audio/useMeetingPersistentRecording";
import { MeetingProcessingProgress } from "../components/MeetingProcessingProgress";
import { MeetingRecordingMeter } from "../components/MeetingRecordingMeter";
import { MeetingSummaryPreview } from "../components/MeetingSummaryPreview";
import { MeetingSummaryRevision } from "../components/MeetingSummaryRevision";
import {
  canLeaveMeetingOneShot,
  getMeetingOneShotActiveJob,
  isMeetingOneShotPipelineBusy,
  isMeetingOneShotRecorderPhase,
  shouldShowMeetingOutputPanel,
} from "./meetingOneShotPresentation";
import { downloadMeetingRecordingTrack, fetchCurrentMeetingContext, fetchMeetingOneShotAvailability, fetchMeetingOneShotStatus, meetingMinutesArtifactUrl, meetingMinutesPackageUrl, meetingOneShotHtmlUrl, releaseCurrentMeeting,
  isMeetingSessionAccessTerminalErrorCode, resolveMeetingRecordingApiError, resolveMeetingRecordingApiErrorCode, retryMeetingMinutesJob, retryMeetingProcessingJob, retryMeetingTranscriptionJob, type MeetingOneShotAvailability, type MeetingOneShotStatus } from "../api/meetingRecordingApi";

const SESSION_KEY = "meeting-one-shot-session";
const UNKNOWN_AVAILABILITY: MeetingOneShotAvailability = {
  mode: "one-shot",
  available: false,
  reason: "MEETING_AVAILABILITY_UNKNOWN",
  deliveryMs: 86_400_000,
  admission: { activeMeetings: 0, maxMeetings: 2 },
};
function restoredSession(): string | null {
  try { return sessionStorage.getItem(SESSION_KEY); } catch { return null; }
}

function elapsedLabel(seconds: number): string {
  const clock = [Math.floor(seconds / 60) % 60, seconds % 60].map(value => String(value).padStart(2, "0")).join(":");
  return seconds >= 3600 ? `${String(Math.floor(seconds / 3600)).padStart(2,"0")}:${clock}` : clock;
}

export function MeetingOneShotPage({ availability: initialAvailability }: { availability?: MeetingOneShotAvailability }) {
  const { t } = useTranslation("meetingMinutes");
  const navigate = useNavigate();
  const audio = useMeetingAudioCheck();
  const recording = useMeetingPersistentRecording({ getConnectedStreams: audio.getConnectedStreams, deliveryMode: "one-shot" });
  const [refreshedAvailability, setAvailability] = useState<MeetingOneShotAvailability | null>(initialAvailability ?? null);
  const [availabilityLoaded, setAvailabilityLoaded] = useState(Boolean(initialAvailability));
  const [availabilityRefreshing, setAvailabilityRefreshing] = useState(!initialAvailability);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);
  const availability = refreshedAvailability ?? initialAvailability ?? UNKNOWN_AVAILABILITY;
  const availabilityRequest = useRef<Promise<MeetingOneShotAvailability | null> | null>(null);
  const availabilityRefreshPending = useRef(false);
  const availabilityRevision = useRef<number | null>(null);
  const loadAvailability = useCallback((invalidateInFlight = false) => {
    if (availabilityRequest.current) {
      if (invalidateInFlight) availabilityRefreshPending.current = true;
      return availabilityRequest.current;
    }
    const request = (async () => {
      let result: MeetingOneShotAvailability | null = null;
      let failed = false;
      let failure: unknown;
      do {
        availabilityRefreshPending.current = false;
        try {
          result = await fetchMeetingOneShotAvailability();
          failed = false;
          failure = undefined;
        } catch (cause) {
          failed = true;
          failure = cause;
        }
      } while (availabilityRefreshPending.current);
      if (failed) throw failure;
      return result;
    })().finally(() => {
      if (availabilityRequest.current === request) availabilityRequest.current = null;
    });
    availabilityRequest.current = request;
    return request;
  }, []);
  const [sessionId, setSessionId] = useState(restoredSession);
  const [state, setState] = useState<MeetingOneShotStatus | null>(null);
  const [remote, setRemote] = useState(false);
  const [additionalSectionRequest, setAdditionalSectionRequest] = useState("");
  const [showRecordingInfo, setShowRecordingInfo] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const retryInFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [contextRevision, setContextRevision] = useState(0);
  const [accessLost, setAccessLost] = useState(false);
  const refreshStatus = useRef<() => void>(() => undefined);
  const starting = useRef(false);
  const savedId = recording.savedSession?.sessionId ?? recording.activeSessionId;
  useEffect(() => {
    let active = true;
    void fetchCurrentMeetingContext().then(current => {
      if (!active) return;
      const visibleSessionId = current.sessionId ?? savedId ?? restoredSession();
      setSessionId(visibleSessionId);
      try {
        if (visibleSessionId) sessionStorage.setItem(SESSION_KEY, visibleSessionId);
        else sessionStorage.removeItem(SESSION_KEY);
      } catch { /* Server remains authoritative. */ }
    }).catch(cause => {
      if (!active) return;
      setError(resolveMeetingRecordingApiError(cause) ?? t("oneShot.statusFailed"));
    });
    return () => { active = false; };
  }, [savedId, contextRevision, t]);
  useEffect(() => {
    let active = true;
    const invalidateInFlight = availabilityRevision.current !== null && availabilityRevision.current !== contextRevision;
    availabilityRevision.current = contextRevision;
    setAvailabilityRefreshing(true);
    void loadAvailability(invalidateInFlight).then(result => {
      if (!result) throw new Error("會議服務版本不相容，請更新後端後再重新整理。");
      if (!active) return;
      setAvailability(result);
      setAvailabilityError(null);
      setAvailabilityLoaded(true);
    }).catch(cause => {
      if (!active) return;
      setAvailabilityError(resolveMeetingRecordingApiError(cause) ?? (cause instanceof Error ? cause.message : t("oneShot.statusFailed")));
      setAvailabilityLoaded(true);
    }).finally(() => {
      if (active) setAvailabilityRefreshing(false);
    });
    return () => { active = false; };
  }, [contextRevision, loadAvailability, t]);
  useEffect(() => {
    if (!savedId) return;
    setSessionId(savedId);
    try { sessionStorage.setItem(SESSION_KEY, savedId); } catch { /* The current tab still holds the result. */ }
  }, [savedId]);
  useEffect(() => {
    if (!sessionId) {
      refreshStatus.current = () => undefined;
      return subscribeMeetingStateEvents(() => setContextRevision(value => value + 1));
    }
    let active = true;
    let inFlight = false;
    let pending = false;
    const poll = async () => {
      if (inFlight) { pending = true; return; }
      inFlight = true;
      try {
        const result = await fetchMeetingOneShotStatus(sessionId);
        if (!active) return;
        setState(result);
        if (result.admission) setAvailability(current => current ? { ...current, admission: result.admission! } : current);
        setPollError(null);
        setAccessLost(false);
        if (result.phase === "expired" || result.phase === "legacy-saved") return;
      } catch (cause) {
        if (!active) return;
        setPollError(resolveMeetingRecordingApiError(cause) ?? t("oneShot.statusFailed"));
        const code = resolveMeetingRecordingApiErrorCode(cause);
        if (isMeetingSessionAccessTerminalErrorCode(code) || ["MEETING_ONE_SHOT_NOT_FOUND", "MEETING_RECORDING_NOT_FOUND", "MEETING_RECORDING_OWNER_INVALID"].includes(code ?? "")) {
          setAccessLost(true);
          return;
        }
      } finally {
        inFlight = false;
        if (active && pending) { pending = false; void poll(); }
      }
    };
    refreshStatus.current = () => { void poll(); };
    const unsubscribe = subscribeMeetingStateEvents(() => { void poll(); });
    void poll();
    return () => {
      active = false;
      refreshStatus.current = () => undefined;
      unsubscribe();
    };
  }, [sessionId, t]);

  const locked = recording.active || recording.recoveryLoading || recording.recoveryBlocked || Boolean(recording.localRecovery) || Boolean(recording.recoveryError) || preparing;
  const availabilityAllowsStart = availabilityLoaded && !availabilityRefreshing && !availabilityError && availability.available
    && availability.admission.activeMeetings < availability.admission.maxMeetings;
  const start = async () => {
    if (starting.current || locked || sessionId || !availabilityAllowsStart) return;
    starting.current = true;
    setPreparing(true);
    setError(null);
    try {
      if (remote) {
        const issue = await audio.connectRemoteTab();
        if (issue) { setError(t(`issues.${issue}`)); return; }
      }
      const issue = await audio.connectRoomMic();
      if (issue) { audio.stopSource("remote-tab"); setError(t(`issues.${issue}`)); return; }
      const result = await recording.startRecording(t("flow.automaticTitle", { timestamp: new Date().toLocaleString() }), additionalSectionRequest.trim());
      if (result === "reused") {
        audio.stopSource("room-mic");
        audio.stopSource("remote-tab");
      }
    } finally {
      setPreparing(false);
      starting.current = false;
    }
  };
  const stop = async () => {
    const pending = recording.stopRecording();
    audio.stopSource("room-mic");
    audio.stopSource("remote-tab");
    await pending;
  };
  const stopSource = audio.stopSource;
  const cancelRecordingLocally = recording.cancelRecordingLocally;
  useEffect(() => {
    if (state?.phase !== "cancelling" && state?.phase !== "cancelled") return;
    stopSource("room-mic");
    stopSource("remote-tab");
    void cancelRecordingLocally();
  }, [state?.phase, stopSource, cancelRecordingLocally]);
  useEffect(() => {
    if (recording.phase !== "failed" && recording.phase !== "upload-pending") return;
    stopSource("room-mic"); stopSource("remote-tab");
  }, [recording.phase, stopSource]);
  const next = async () => {
    if (locked || (!accessLost && !canLeaveMeetingOneShot(state?.phase ?? null))) return;
    if ((state?.phase === "ready" || state?.phase === "legacy-saved") && !window.confirm(t("oneShot.savedConfirm"))) return;
    if ((accessLost || state?.phase === "failed") && !window.confirm(t("oneShot.leaveConfirm"))) return;
    if (sessionId && !accessLost) {
      try { await releaseCurrentMeeting(sessionId); }
      catch (cause) { setError(resolveMeetingRecordingApiError(cause) ?? t("oneShot.statusFailed")); return; }
    }
    try { sessionStorage.removeItem(SESSION_KEY); } catch { setError(t("oneShot.resetFailed")); return; }
    window.location.reload();
  };
  const refresh = async () => {
    setError(null);
    setAvailabilityError(null);
    setAvailabilityRefreshing(true);
    try {
      const result = await loadAvailability(true);
      if (!result) throw new Error("會議服務版本不相容，請更新後端後再重新整理。");
      setAvailability(result);
      setAvailabilityLoaded(true);
    } catch (cause) {
      setAvailabilityError(resolveMeetingRecordingApiError(cause) ?? (cause instanceof Error ? cause.message : t("oneShot.statusFailed")));
      setAvailabilityLoaded(true);
    } finally {
      setAvailabilityRefreshing(false);
    }
    refreshStatus.current();
  };
  const version = state?.minutes?.version;
  const playback = version?.artifacts.find(artifact => artifact.type === "minutes-audio");
  const failedJob = state?.phase === "failed" && state.retryAvailable !== false
    ? state.minutes?.status === "failed" ? state.minutes : state.transcription?.status === "failed" ? state.transcription : state.processing?.status === "failed" ? state.processing : null
    : null;
  const retry = async () => {
    if (!failedJob || !sessionId || retryInFlight.current) return;
    retryInFlight.current = true; setRetrying(true); setError(null);
    try {
      const action = failedJob === state?.minutes ? retryMeetingMinutesJob : failedJob === state?.transcription ? retryMeetingTranscriptionJob : retryMeetingProcessingJob;
      await action(sessionId, failedJob.jobId);
      refreshStatus.current();
    } catch (cause) { setError(resolveMeetingRecordingApiError(cause) ?? t("oneShot.statusFailed")); }
    finally { retryInFlight.current = false; setRetrying(false); }
  };
  const busy = Boolean(sessionId && !accessLost && isMeetingOneShotPipelineBusy(state?.phase ?? null));
  const activeJob = getMeetingOneShotActiveJob(state);
  const waitingRetry = activeJob?.status === "failed" && activeJob.attemptCount < activeJob.maxAttempts;
  const queued = activeJob?.status === "pending";
  const progressLabel = waitingRetry ? "oneShot.waitingRetry" : queued ? "oneShot.stepQueued" : state ? `oneShot.phases.${state.phase}` : "oneShot.loading";
  const duration = elapsedLabel(recording.elapsedSeconds);
  const liveSources = state?.liveTranscription ?? [];
  const expectedSources = state?.session?.tracks.map(track => track.sourceId) ?? (remote ? ["room-mic", "remote-tab"] : ["room-mic"]);
  const processedSeconds = expectedSources.length ? Math.floor(Math.min(...expectedSources.map(id => liveSources.find(source => source.sourceId === id)?.processedMs ?? 0)) / 1000) : 0;
  const liveTime = elapsedLabel(processedSeconds);
  const compactRecording = Boolean(sessionId && state && !isMeetingOneShotRecorderPhase(state.phase) && !locked && !recording.issue);
  const interrupted = state?.phase === "interrupted";
  const observingRecording = state?.phase === "recording" && !recording.active && !recording.localRecovery;
  const capacityFull = availabilityLoaded && !availabilityRefreshing && !availabilityError && !sessionId
    && availability.admission.activeMeetings >= availability.admission.maxMeetings;
  return <main className="meeting-audio-page meeting-one-shot">
    <header className="meeting-audio-header"><button className="meeting-header-link" disabled={locked} onClick={() => navigate("/")}>{t("actions.backToReport")}</button></header>
    <div className="meeting-audio-shell">
      <section className="meeting-audio-intro"><div><p className="meeting-audio-eyebrow">MEETING RECORDER</p><h1>{t(interrupted ? "oneShot.interruptedTitle" : observingRecording ? "oneShot.observingTitle" : compactRecording ? "oneShot.result" : "page.title")}</h1><p className="meeting-audio-lead">{t(interrupted ? "oneShot.interruptedHint" : observingRecording ? "oneShot.observingRecording" : compactRecording ? busy ? "oneShot.resultHint" : state?.phase === "ready" && !accessLost ? "oneShot.resultReadyHint" : "oneShot.resultNeedsAttention" : recording.paused ? "oneShot.pausedIntro" : recording.recording ? "persistent.activeHint" : "oneShot.intro")}</p></div></section>
      <div className="meeting-capacity-status" role="status" aria-busy={availabilityRefreshing}><strong>{availabilityRefreshing ? t("oneShot.checkingAvailability") : availabilityLoaded && !availabilityError ? `目前已占用：${availability.admission.activeMeetings}／${availability.admission.maxMeetings}` : t("oneShot.availabilityUnavailable")}</strong>{sessionId && state && <span>{recording.savedSession?.title ?? state.session?.title ?? "目前會議"} · {t(progressLabel)}</span>}</div>
      {compactRecording && <button className="meeting-info-toggle" aria-expanded={showRecordingInfo} aria-controls="meeting-recorder-settings" onClick={() => setShowRecordingInfo(value => !value)}>{t(showRecordingInfo ? "oneShot.hideRecordingInfo" : "oneShot.showRecordingInfo")}</button>}
      <section id="meeting-recorder-settings" className="meeting-recorder" hidden={compactRecording && !showRecordingInfo} aria-label={t("flow.title")}>
        <div className="meeting-recorder__heading"><div><h2>{t("flow.title")}</h2><p>{t("oneShot.retention", { hours: availability.deliveryMs / 3_600_000 })}</p></div></div>
        <div className="meeting-recorder__body">
          {availabilityError && !sessionId && <p role="alert">{availabilityError} <button onClick={() => void refresh()}>{t("oneShot.refresh")}</button></p>}
          {availabilityLoaded && !availabilityError && !availability.available && !sessionId && <p role="alert">{t(availability.reason === "MEETING_SUMMARY_ARCHIVE_FULL" ? "oneShot.full" : availability.reason === "DEMO_MEETING_DISABLED" ? "oneShot.demoDisabled" : "oneShot.unavailable")} {availability.reason !== "DEMO_MEETING_DISABLED" && <button onClick={() => void refresh()}>{t("oneShot.refresh")}</button>}</p>}
          {capacityFull && <p role="alert">目前已有 {availability.admission.maxMeetings} 場會議進行中，請待其中一場完成後再開始錄音。</p>}
          <label className="meeting-remote-option"><input type="checkbox" checked={remote} disabled={locked || Boolean(sessionId) || !audio.capabilities.canCaptureRemoteTab} onChange={event => setRemote(event.target.checked)} /><span>{t("flow.remoteOptionTitle")}</span></label>
          {remote && <p>{t("flow.remotePermissionHint")}</p>}
          {expectedSources.length > 1 && <p>{t("oneShot.multitrackCapacity")}</p>}
          <details className="meeting-additional-options">
            <summary>{t("oneShot.additionalSectionsLabel")}</summary>
          <div className="meeting-additional-sections">
            <label htmlFor="meeting-additional-sections">{t("oneShot.additionalSectionsLabel")}</label>
            <textarea id="meeting-additional-sections" rows={3} maxLength={2000}
              value={sessionId ? state?.additionalSectionRequest ?? additionalSectionRequest : additionalSectionRequest}
              disabled={locked || Boolean(sessionId)}
              placeholder={t("oneShot.additionalSectionsPlaceholder")}
              aria-describedby="meeting-additional-sections-hint"
              onChange={event => setAdditionalSectionRequest(event.target.value)} />
            <p id="meeting-additional-sections-hint">{t("oneShot.additionalSectionsHint")}</p>
          </div>
          </details>
          {!sessionId && !recording.active && <p className="meeting-start-hint">{t("oneShot.startHint")}</p>}
          {(recording.active || recording.elapsedSeconds > 0) && <div className="meeting-recording-status">
            <div className="meeting-recording-clock"><small>{recording.recording ? <span className="meeting-recording-live">{t("oneShot.recordingLive")}</span> : t("persistent.elapsed")}</small><strong>{duration}</strong><span>{(recording.uploadedBytes / 1048576).toFixed(1)} MiB {t("persistent.uploaded")}</span></div>
            {recording.recording && <MeetingRecordingMeter getConnectedStreams={audio.getConnectedStreams} />}
          </div>}
          {(recording.recording || recording.paused) && <p role="status">
            {t(recording.paused ? "oneShot.pausedHint" : "oneShot.liveTranscription", { time: liveTime, seconds: Math.max(0, recording.elapsedSeconds - processedSeconds) })}
            {liveSources.some(source => source.failed) && <span> {t("oneShot.liveTranscriptionRetry")}</span>}
            {liveSources.some(source => source.deferred) && <span> {t("oneShot.liveTranscriptionDeferred")}</span>}
          </p>}
          {interrupted && <div className="meeting-recovery-panel" role="status"><strong>{t("oneShot.interruptedTitle")}</strong><p>{t("oneShot.interruptedHint")}</p><button disabled={locked} onClick={next}>{t("oneShot.leave")}</button></div>}
          <div className={`meeting-recorder__action${recording.recording || recording.paused ? " with-pause" : ""}`}>
            {(recording.recording || recording.paused) && <button className="meeting-recording-pause" onClick={recording.togglePause}>{t(recording.paused ? "oneShot.resume" : "oneShot.pause")}</button>}
            {recording.recording || recording.paused || recording.stopping ? <button className="meeting-recording-primary is-stop" disabled={recording.stopping} onClick={() => void stop()}>{recording.stopping ? <LoadingOutlined spin aria-hidden="true" /> : <StopOutlined aria-hidden="true" />}{t(recording.stopping ? "persistent.actions.finalizing" : "flow.stopRecording")}</button>
              : recording.canRetryUpload ? <button className="meeting-recording-primary" disabled={recording.recoveryLoading} onClick={() => void recording.retryUpload()}>{t("persistent.actions.retryUpload")}</button>
                : recording.canRetryFinalize ? <button className="meeting-recording-primary" disabled={recording.recoveryLoading} onClick={() => void recording.retryFinalize()}>{t("persistent.actions.retryFinalize")}</button>
                  : !sessionId ? <button className="meeting-recording-primary" disabled={locked || !availabilityAllowsStart || !audio.capabilities.ready} onClick={() => void start()}>{preparing || recording.recoveryLoading ? <LoadingOutlined spin aria-hidden="true" /> : <AudioOutlined aria-hidden="true" />}{t(preparing ? "flow.preparingRecording" : "flow.startRecording")}</button> : null}
          </div>
          {recording.localRecovery && !recording.recording && !recording.paused && !recording.stopping && <div className="meeting-recovery-panel" role="status"><strong>{t("persistent.recoveryTitle", { title: recording.localRecovery.title })}</strong><p>{t("persistent.recoveryHint")}</p><button onClick={() => void recording.downloadLocalRecovery()}>{t("persistent.downloadLocal")}</button><button onClick={() => { if (window.confirm(t("persistent.discardLocalConfirm"))) void recording.discardLocalRecovery().then(discarded => { if (!discarded) return; try { sessionStorage.removeItem(SESSION_KEY); } catch { setError(t("oneShot.resetFailed")); return; } setSessionId(null); setState(null); }); }}>{t("persistent.discardLocal")}</button></div>}
          {recording.recoveryBlocked && <p role="status">{t("persistent.recoveryBlocked")} <button onClick={recording.retryRecovery}>{t("persistent.retryRecovery")}</button></p>}
          {recording.issue && <p role="alert">{t(`persistent.issues.${recording.issue}`)} {recording.errorDetail}</p>}
          {recording.recoveryError && <p role="alert">{recording.recoveryError}</p>}
        </div>
      </section>
      {error && <p role="alert">{error}</p>}
      {sessionId && (accessLost || shouldShowMeetingOutputPanel({ hasSession: true, phase: state?.phase ?? null, localRecording: recording.recording, localPaused: recording.paused })) && <section className="meeting-minutes-panel" aria-label={t("oneShot.result")}>
        <div className="meeting-minutes-panel__heading"><h2>{t("oneShot.result")}</h2><span role="status">{busy && !waitingRetry && !queued && <LoadingOutlined spin />} {t(progressLabel)}</span></div>
        <div className="meeting-minutes-panel__body">
          {busy && <MeetingProcessingProgress state={state} />}
          {pollError && <p role="alert">{pollError} <button onClick={() => void refresh()}>{t("oneShot.refresh")}</button></p>}
          {(accessLost || state?.phase === "failed") && <button disabled={locked} onClick={next}>{t("oneShot.leave")}</button>}
          {state?.errorMessage && <p role="alert">{state.errorMessage} <button onClick={() => void refresh()}>{t("oneShot.refresh")}</button></p>}
          {failedJob && <button disabled={retrying} onClick={() => void retry()}>{retrying && <LoadingOutlined spin />}{t("minutes.actions.retry")}</button>}
          {state?.phase === "cancelled" && <button disabled={locked} onClick={next}>{t("oneShot.leave")}</button>}
          {state?.phase === "ready" && <>
            <div className="meeting-delivery-heading"><CheckCircleOutlined aria-hidden="true" /><div><h3>{t("oneShot.readyTitle")}</h3><p>{t("oneShot.deadline", { time: new Date(state.expiresAt!).toLocaleString() })}</p></div></div>
            <p className="meeting-draft-notice">{t("oneShot.aiNotice")}</p>
            <div className="meeting-minutes-document__controls"><a className="meeting-download-primary" href={meetingOneShotHtmlUrl(sessionId, true)} download="meeting-summary.html"><DownloadOutlined aria-hidden="true" /> {t("minutes.actions.downloadHtml")}</a>{playback && <a href={meetingMinutesArtifactUrl(playback, true)} download={playback.filename}><DownloadOutlined aria-hidden="true" /> {t("oneShot.downloadRecording")}</a>}{version && <a href={meetingMinutesPackageUrl(version)} download>{t("minutes.actions.downloadPackage")}</a>}</div>
            <MeetingSummaryPreview sessionId={sessionId} versionId={version?.versionId} />
            {version && <MeetingSummaryRevision key={version.versionId} sessionId={sessionId} version={version} revision={state.revision ?? null}
              refresh={() => refreshStatus.current()} queued={job => setState(current => current ? { ...current, revision: job } : current)} />}
            <div className="meeting-next-session"><p>{t(state.revision ? "oneShot.revisionNextHint" : "oneShot.nextHint")}</p><button disabled={locked || Boolean(state.revision)} onClick={next}>{t("oneShot.next")}</button></div>
          </>}
          {state?.phase === "legacy-saved" && <><p>{t("oneShot.legacySaved")}</p>{state.session?.tracks.filter(track => track.available).map(track => <button key={track.sourceId} onClick={() => void downloadMeetingRecordingTrack(sessionId, track.sourceId).catch(cause => setError(resolveMeetingRecordingApiError(cause) ?? t("oneShot.statusFailed")))}>{t("oneShot.downloadTrack", { source: track.sourceId })}</button>)}<button disabled={locked} onClick={next}>{t("oneShot.next")}</button></>}
          {state?.phase === "expired" && <><p>{t("oneShot.expired")}</p><button disabled={locked} onClick={next}>{t("flow.startRecording")}</button></>}
        </div>
      </section>}
    </div>
  </main>;
}

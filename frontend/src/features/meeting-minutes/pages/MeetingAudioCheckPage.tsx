import {
  AudioOutlined,
  CheckCircleFilled,
  CloudUploadOutlined,
  DatabaseOutlined,
  DesktopOutlined,
  DownloadOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  InfoCircleOutlined,
  LeftOutlined,
  LoadingOutlined,
  ReloadOutlined,
  SearchOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { SubsystemMenu } from "../../subsystems/components/SubsystemMenu";
import {
  type MeetingAudioIssue,
  useMeetingAudioCheck,
} from "../audio/useMeetingAudioCheck";
import {
  type MeetingPersistentRecordingIssue,
  useMeetingPersistentRecording,
} from "../audio/useMeetingPersistentRecording";
import { useMeetingProcessingJob } from "../audio/useMeetingProcessingJob";
import { useMeetingTranscriptionJob } from "../audio/useMeetingTranscriptionJob";
import { useMeetingMinutesJob } from "../audio/useMeetingMinutesJob";
import { MeetingLibraryOwnerAccess } from "../components/MeetingLibraryOwnerAccess";
import { MeetingTranscriptDialog } from "../components/MeetingTranscriptDialog";
import {
  downloadMeetingTranscriptionArtifact,
  isMeetingSessionAccessTerminalErrorCode,
  meetingMinutesArtifactUrl,
  meetingMinutesPackageUrl,
  meetingProcessingArtifactUrl,
  resolveMeetingRecordingApiErrorCode,
  type MeetingMinutesHumanInput,
} from "../api/meetingRecordingApi";
import { MEETING_LIBRARY_ROUTE } from "../routes";
import { createMeetingTranscriptCacheKey } from "../useMeetingTranscriptDocument";
import "../styles/meeting-audio-check.css";

function formatSeconds(seconds: number): string {
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = seconds % 60;
  return [hours, minutes, remainingSeconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const EMPTY_MEETING_MINUTES_INPUT: MeetingMinutesHumanInput = {
  title: "",
  date: null,
  attendees: "",
  confirmedFacts: "",
  confirmedDecisions: "",
  termCorrections: "",
  otherNotes: "",
};

export function MeetingAudioCheckPage() {
  const { t } = useTranslation("meetingMinutes");
  const navigate = useNavigate();
  const audio = useMeetingAudioCheck();
  const stopAudioSource = audio.stopSource;
  const persistent = useMeetingPersistentRecording({
    getConnectedStreams: audio.getConnectedStreams,
  });
  const updateLibraryAccess = persistent.updateLibraryAccess;
  const processing = useMeetingProcessingJob(persistent.savedSession);
  const transcription = useMeetingTranscriptionJob(processing.job);
  const minutes = useMeetingMinutesJob(transcription.job);
  const resetPersistentAfterAccessLoss = persistent.resetAfterAccessLoss;
  const resetProcessingForAccessRecovery = processing.resetForAccessRecovery;
  const resetTranscriptionForAccessRecovery = transcription.resetForAccessRecovery;
  const resetMinutesForAccessRecovery = minutes.resetForAccessRecovery;
  const [includeRemoteAudio, setIncludeRemoteAudio] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [minutesInput, setMinutesInput] = useState<MeetingMinutesHumanInput>(
    EMPTY_MEETING_MINUTES_INPUT
  );
  const [preparing, setPreparing] = useState(false);
  const [libraryReady, setLibraryReady] = useState(false);
  const [setupIssue, setSetupIssue] = useState<MeetingAudioIssue | null>(null);
  const [remoteFallbackIssue, setRemoteFallbackIssue] =
    useState<MeetingAudioIssue | null>(null);
  const startFlowInProgressRef = useRef(false);
  const playbackAudioRef = useRef<HTMLAudioElement | null>(null);
  const minutesInputTouchedRef = useRef(false);

  const processingState = processing.unknown
    ? "unknown"
    : processing.retrying
      ? "retrying"
      : processing.enqueueing || (processing.hasCursor && !processing.job)
        ? "pending"
        : processing.job?.status ?? (processing.actionFailed ? "unavailable" : "idle");
  const showProcessing = Boolean(
    persistent.savedSession ||
      processing.hasCursor ||
      processing.job ||
      processing.enqueueing ||
      processing.unknown ||
      processing.actionFailed
  );
  const playbackArtifact = processing.job?.artifacts.find(
    (artifact) => artifact.type === "playback"
  );
  const transcriptionState = transcription.unknown
    ? "unknown"
    : transcription.providerDisabled
      ? "disabled"
      : transcription.retrying
        ? "retrying"
        : transcription.enqueueing || (transcription.hasCursor && !transcription.job)
          ? "pending"
          : transcription.job?.status ??
            (transcription.actionFailed ? "unavailable" : "idle");
  const showTranscription = Boolean(
    processing.job?.status === "ready" ||
      transcription.hasCursor ||
      transcription.job ||
      transcription.enqueueing ||
      transcription.unknown ||
      transcription.actionFailed
  );
  const transcriptJsonArtifact = transcription.job?.artifacts.find(
    (artifact) => artifact.type === "transcript-merged-json"
  );
  const transcriptTextArtifact = transcription.job?.artifacts.find(
    (artifact) => artifact.type === "transcript-text"
  );
  const minutesState = minutes.unknown
    ? "unknown"
    : minutes.retrying
      ? "retrying"
      : minutes.enqueueing || (minutes.hasCursor && !minutes.job)
        ? "pending"
        : minutes.job?.status ?? (minutes.failedAction ? "unavailable" : "idle");
  const selectedMinutesHtml = minutes.selectedVersion?.artifacts.find(
    (artifact) => artifact.type === "minutes-html"
  );
  const selectedMinutesJson = minutes.selectedVersion?.artifacts.find(
    (artifact) => artifact.type === "minutes-record-json"
  );
  const minutesActive =
    minutes.hasCursor ||
    minutes.enqueueing ||
    minutes.retrying ||
    minutes.job?.status === "pending" ||
    minutes.job?.status === "running";
  const activeLevel = Math.max(
    audio.sources["room-mic"].level,
    audio.sources["remote-tab"].level
  );
  const recordingMode = remoteFallbackIssue
    ? t("flow.modeMicrophoneFallback")
    : includeRemoteAudio
      ? t("flow.modeMicrophoneAndRemote")
      : t("flow.modeMicrophoneOnly");
  const startDisabled =
    preparing ||
    persistent.active ||
    Boolean(persistent.savedSession) ||
    !libraryReady ||
    !audio.capabilities.canCaptureMicrophone ||
    !audio.capabilities.canRecord;

  useEffect(() => {
    const previousTitle = document.title;
    document.title = t("page.documentTitle");
    return () => {
      document.title = previousTitle;
    };
  }, [t]);

  useEffect(() => {
    if (minutesInputTouchedRef.current) return;
    if (minutes.job?.input) {
      setMinutesInput(minutes.job.input);
      return;
    }
    const title = persistent.savedSession?.title.trim();
    if (title) setMinutesInput((current) => ({ ...current, title }));
  }, [minutes.job?.input, persistent.savedSession?.title]);

  useEffect(() => {
    if (persistent.phase !== "failed" || persistent.canRetryFinalize) return;
    stopAudioSource("room-mic");
    stopAudioSource("remote-tab");
  }, [persistent.canRetryFinalize, persistent.phase, stopAudioSource]);

  const recoverSessionAccess = useCallback((sessionId: string | null = null) => {
    const inaccessibleSessionId = sessionId ??
      minutes.job?.sessionId ??
      transcription.job?.sessionId ??
      processing.job?.sessionId ??
      persistent.savedSession?.sessionId ??
      null;
    setTranscriptOpen(false);
    resetMinutesForAccessRecovery();
    resetTranscriptionForAccessRecovery();
    resetProcessingForAccessRecovery();
    resetPersistentAfterAccessLoss(inaccessibleSessionId);
    minutesInputTouchedRef.current = false;
    setMinutesInput(EMPTY_MEETING_MINUTES_INPUT);
    updateLibraryAccess({
      enabled: true,
      library: null,
      code: null,
      accessMode: "recorder",
    });
    setLibraryReady(false);
  }, [
    minutes.job?.sessionId,
    persistent.savedSession?.sessionId,
    processing.job?.sessionId,
    resetMinutesForAccessRecovery,
    resetPersistentAfterAccessLoss,
    resetProcessingForAccessRecovery,
    resetTranscriptionForAccessRecovery,
    transcription.job?.sessionId,
    updateLibraryAccess,
  ]);

  useEffect(() => {
    if (
      !processing.authorizationRequired &&
      !transcription.authorizationRequired &&
      !minutes.authorizationRequired
    ) {
      return;
    }
    recoverSessionAccess();
  }, [
    minutes.authorizationRequired,
    processing.authorizationRequired,
    recoverSessionAccess,
    transcription.authorizationRequired,
  ]);

  const handleTranscriptActionError = useCallback(
    (error: unknown) => {
      const errorCode = resolveMeetingRecordingApiErrorCode(error);
      if (isMeetingSessionAccessTerminalErrorCode(errorCode)) {
        recoverSessionAccess(transcriptJsonArtifact?.sessionId ?? null);
      }
    },
    [recoverSessionAccess, transcriptJsonArtifact?.sessionId]
  );

  const updateMinutesInput = useCallback(
    (field: keyof MeetingMinutesHumanInput, value: string) => {
      minutesInputTouchedRef.current = true;
      setMinutesInput((current) => ({
        ...current,
        [field]: field === "date" ? (value || null) : value,
      }));
    },
    []
  );

  const submitMinutes = useCallback(() => {
    if (!minutesInput.title.trim() || minutesActive) return;
    minutes.submit({ ...minutesInput, title: minutesInput.title.trim() });
  }, [minutes, minutesActive, minutesInput]);

  const startMeetingRecording = useCallback(async () => {
    if (startFlowInProgressRef.current || startDisabled) return;
    startFlowInProgressRef.current = true;
    setPreparing(true);
    setSetupIssue(null);
    setRemoteFallbackIssue(null);

    try {
      if (includeRemoteAudio) {
        const remoteIssue = await audio.connectRemoteTab();
        if (remoteIssue === "capture-cancelled") return;
        if (remoteIssue) setRemoteFallbackIssue(remoteIssue);
      } else {
        audio.stopSource("remote-tab");
      }

      const microphoneIssue = await audio.connectRoomMic();
      if (microphoneIssue === "capture-cancelled") return;
      if (microphoneIssue) {
        setSetupIssue(microphoneIssue);
        audio.stopSource("room-mic");
        audio.stopSource("remote-tab");
        return;
      }

      const timestamp = new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date());
      await persistent.startRecording(t("flow.automaticTitle", { timestamp }));
    } finally {
      startFlowInProgressRef.current = false;
      setPreparing(false);
    }
  }, [audio, includeRemoteAudio, persistent, startDisabled, t]);

  const stopMeetingRecording = useCallback(async () => {
    const stopPromise = persistent.stopRecording();
    audio.stopSource("room-mic");
    audio.stopSource("remote-tab");
    await stopPromise;
  }, [audio, persistent]);

  const seekPlayback = useCallback((startMs: number) => {
    const player = playbackAudioRef.current;
    if (!player) return;
    player.currentTime = Math.max(0, startMs / 1_000);
    player.scrollIntoView({ behavior: "smooth", block: "center" });
    void player.play().catch(() => undefined);
  }, []);

  const recorderStatus = useMemo(() => {
    if (preparing) return t("flow.states.preparing");
    if (persistent.recording) return t("flow.states.recording");
    if (persistent.stopping) return t("flow.states.saving");
    if (persistent.savedSession) return t("flow.states.saved");
    if (!libraryReady) return t("flow.states.libraryRequired");
    return t("flow.states.ready");
  }, [libraryReady, persistent.recording, persistent.savedSession, persistent.stopping, preparing, t]);
  const recorderStateClass =
    !libraryReady && persistent.phase === "idle" ? "library-required" : persistent.phase;

  return (
    <main className="meeting-audio-page">
      <header className="meeting-audio-header">
        <button
          type="button"
          className="meeting-header-link"
          onClick={() => navigate("/")}
          disabled={persistent.active}
        >
          <LeftOutlined aria-hidden="true" />
          {t("actions.backToReport")}
        </button>
        <div className="meeting-header-actions">
          <button
            type="button"
            className="meeting-header-link"
            onClick={() => navigate(MEETING_LIBRARY_ROUTE)}
            disabled={persistent.active}
          >
            <FolderOpenOutlined aria-hidden="true" />
            {t("library.actions.openLibrary")}
          </button>
          <SubsystemMenu className="meeting-header-subsystem" disabled={persistent.active} />
        </div>
      </header>

      <div className="meeting-audio-shell">
        <section className="meeting-audio-intro" aria-labelledby="meeting-audio-title">
          <div>
            <p className="meeting-audio-eyebrow">MEETING RECORDER</p>
            <h1 id="meeting-audio-title">{t("page.title")}</h1>
            <p className="meeting-audio-lead">{t("page.subtitle")}</p>
          </div>
          <div
            className={`meeting-browser-readiness ${
              audio.capabilities.ready ? "is-ready" : "is-limited"
            }`}
          >
            <span aria-hidden="true">
              {audio.capabilities.ready ? <CheckCircleFilled /> : <InfoCircleOutlined />}
            </span>
            <div>
              <strong>
                {audio.capabilities.ready ? t("capability.ready") : t("capability.limited")}
              </strong>
              <small>{t("capability.browserScope")}</small>
            </div>
          </div>
        </section>

        <section className="meeting-recorder" aria-labelledby="meeting-recorder-title">
          <div className="meeting-recorder__heading">
            <div>
              <p className="meeting-audio-eyebrow">ONE-CLICK RECORDING</p>
              <h2 id="meeting-recorder-title">{t("flow.title")}</h2>
              <p>{t("flow.description")}</p>
            </div>
            <span
              className={`meeting-persistent-state is-${recorderStateClass}`}
              aria-live="polite"
            >
              {persistent.recording ? <span className="meeting-live-dot" aria-hidden="true" /> : null}
              {recorderStatus}
            </span>
          </div>

          <div className="meeting-recorder__body">
            <MeetingLibraryOwnerAccess
              initialAccess={persistent.libraryAccess}
              onAccessChange={persistent.updateLibraryAccess}
              onCodeConsumed={persistent.consumeLibraryCode}
              onReadyChange={setLibraryReady}
              disabled={persistent.active || preparing}
            />

            <label className={`meeting-remote-option ${includeRemoteAudio ? "is-selected" : ""}`}>
              <input
                type="checkbox"
                checked={includeRemoteAudio}
                onChange={(event) => setIncludeRemoteAudio(event.target.checked)}
                disabled={
                  persistent.active ||
                  preparing ||
                  Boolean(persistent.savedSession) ||
                  !audio.capabilities.canCaptureRemoteTab
                }
              />
              <span className="meeting-remote-option__icon" aria-hidden="true">
                <DesktopOutlined />
              </span>
              <span className="meeting-remote-option__copy">
                <strong>{t("flow.remoteOptionTitle")}</strong>
                <small>{t("flow.remoteOptionDescription")}</small>
              </span>
              <span className="meeting-remote-option__state">
                {!audio.capabilities.canCaptureRemoteTab
                  ? t("flow.unavailable")
                  : includeRemoteAudio
                    ? t("flow.selected")
                    : t("flow.optional")}
              </span>
            </label>

            {includeRemoteAudio ? (
              <aside className="meeting-remote-hint">
                <InfoCircleOutlined aria-hidden="true" />
                <span>{t("flow.remotePermissionHint")}</span>
              </aside>
            ) : null}

            <div className="meeting-recorder__console">
              <div className="meeting-recording-clock" aria-live="polite">
                <small>{t("persistent.elapsed")}</small>
                <strong>{formatSeconds(persistent.elapsedSeconds)}</strong>
                <span>{recordingMode}</span>
              </div>

              <div className="meeting-recording-signal">
                <div>
                  <AudioOutlined aria-hidden="true" />
                  <span>{t("flow.audioSignal")}</span>
                </div>
                <div
                  className="meeting-level-meter"
                  role="meter"
                  aria-label={t("flow.audioSignal")}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={activeLevel}
                >
                  <span style={{ transform: `scaleX(${activeLevel / 100})` }} />
                </div>
                <small>
                  {persistent.recording ? t("flow.signalActive") : t("flow.signalIdle")}
                </small>
              </div>

              <div className="meeting-recording-upload">
                <small>{t("persistent.uploaded")}</small>
                <strong>{formatBytes(persistent.uploadedBytes)}</strong>
                <span>
                  <DatabaseOutlined aria-hidden="true" />
                  {t("persistent.storageHint")}
                </span>
              </div>
            </div>

            <div className="meeting-recorder__action">
              {persistent.recording || persistent.stopping ? (
                <button
                  type="button"
                  className="meeting-recording-primary is-stop"
                  onClick={() => void stopMeetingRecording()}
                  disabled={persistent.stopping}
                >
                  {persistent.stopping ? (
                    <LoadingOutlined spin aria-hidden="true" />
                  ) : (
                    <StopOutlined aria-hidden="true" />
                  )}
                  <span>
                    <strong>
                      {persistent.stopping
                        ? t("persistent.actions.finalizing")
                        : t("flow.stopRecording")}
                    </strong>
                    <small>
                      {persistent.stopping ? t("flow.savingHint") : t("flow.stopHint")}
                    </small>
                  </span>
                </button>
              ) : persistent.canRetryFinalize ? (
                <button
                  type="button"
                  className="meeting-recording-primary"
                  onClick={() => void persistent.retryFinalize()}
                >
                  <CloudUploadOutlined aria-hidden="true" />
                  <span>
                    <strong>{t("persistent.actions.retryFinalize")}</strong>
                    <small>{t("flow.retryFinalizeHint")}</small>
                  </span>
                </button>
              ) : persistent.savedSession ? (
                <div className="meeting-recording-saved" role="status">
                  <CheckCircleFilled aria-hidden="true" />
                  <span>
                    <strong>{t("persistent.savedTitle")}</strong>
                    <small>{t("flow.processingNext")}</small>
                  </span>
                </div>
              ) : (
                <button
                  type="button"
                  className="meeting-recording-primary"
                  onClick={() => void startMeetingRecording()}
                  disabled={startDisabled}
                >
                  {preparing || persistent.phase === "starting" ? (
                    <LoadingOutlined spin aria-hidden="true" />
                  ) : (
                    <AudioOutlined aria-hidden="true" />
                  )}
                  <span>
                    <strong>
                      {preparing || persistent.phase === "starting"
                        ? t("flow.preparingRecording")
                        : t("flow.startRecording")}
                    </strong>
                    <small>{t("flow.startHint")}</small>
                  </span>
                </button>
              )}
            </div>
          </div>

          {remoteFallbackIssue ? (
            <p className="meeting-recorder-notice" role="status">
              <InfoCircleOutlined aria-hidden="true" />
              <span>
                <strong>{t("flow.remoteFallbackTitle")}</strong>
                {t("flow.remoteFallbackDescription", {
                  reason: t(`issues.${remoteFallbackIssue}` as `issues.${MeetingAudioIssue}`),
                })}
              </span>
            </p>
          ) : null}

          {setupIssue ? (
            <p className="meeting-persistent-issue" role="alert">
              {t(`issues.${setupIssue}` as `issues.${MeetingAudioIssue}`)}
            </p>
          ) : null}

          {persistent.issue ? (
            <p className="meeting-persistent-issue" role="alert">
              {t(
                `persistent.issues.${persistent.issue}` as `persistent.issues.${MeetingPersistentRecordingIssue}`
              )}
              {persistent.errorDetail ? ` ${persistent.errorDetail}` : ""}
            </p>
          ) : null}
        </section>

        {showProcessing ? (
          <section
            className={`meeting-processing-panel is-${processingState}`}
            aria-labelledby="meeting-processing-title"
          >
            <div className="meeting-processing-panel__heading">
              <div>
                <p className="meeting-audio-eyebrow">AUDIO PROCESSING</p>
                <h2 id="meeting-processing-title">{t("processing.title")}</h2>
                <p>{t("processing.description")}</p>
              </div>
              <span className="meeting-processing-state" aria-live="polite">
                {processingState === "pending" ||
                processingState === "running" ||
                processingState === "retrying" ? (
                  <LoadingOutlined spin aria-hidden="true" />
                ) : processingState === "ready" ? (
                  <CheckCircleFilled aria-hidden="true" />
                ) : (
                  <InfoCircleOutlined aria-hidden="true" />
                )}
                {t(`processing.states.${processingState}`)}
              </span>
            </div>

            <div className="meeting-processing-panel__body">
              <div className="meeting-processing-progress">
                <span>{t("processing.currentStep")}</span>
                <strong>
                  {processing.job
                    ? t(`processing.phases.${processing.job.phase}`)
                    : processing.enqueueing
                      ? t("processing.phases.queued")
                      : t("processing.waitingForStatus")}
                </strong>
                <small>
                  {processing.job
                    ? t("processing.attempt", {
                        current: processing.job.attemptCount,
                        max: processing.job.maxAttempts,
                      })
                    : t("processing.recordingSafe")}
                </small>
              </div>

              {processing.pollingErrorMessage !== null ? (
                <p className="meeting-processing-notice" role="status">
                  {t("processing.pollingDelayed")}
                  {processing.pollingErrorMessage ? ` ${processing.pollingErrorMessage}` : ""}
                </p>
              ) : null}

              {processing.unknown ? (
                <p className="meeting-processing-issue" role="alert">
                  {t("processing.unknown")}
                </p>
              ) : null}

              {processing.actionFailed ? (
                <div className="meeting-processing-issue" role="alert">
                  <p>
                    {processing.actionErrorCode === "MEETING_PROCESSING_WORKER_DISABLED"
                      ? t("processing.workerDisabled")
                      : processing.failedAction === "retry"
                        ? t("processing.retryFailed")
                        : t("processing.enqueueFailed")}
                    {processing.actionErrorMessage ? ` ${processing.actionErrorMessage}` : ""}
                  </p>
                  {(persistent.savedSession || processing.hasCursor) &&
                  !processing.job &&
                  processing.failedAction === "enqueue" ? (
                    <button type="button" onClick={processing.retryEnqueue}>
                      <ReloadOutlined aria-hidden="true" />
                      {t("processing.actions.retryEnqueue")}
                    </button>
                  ) : null}
                </div>
              ) : null}

              {processing.job?.status === "failed" ? (
                <div className="meeting-processing-issue" role="alert">
                  <p>
                    {t("processing.failed")}
                    {processing.job.errorMessage ? ` ${processing.job.errorMessage}` : ""}
                  </p>
                  {processing.canRetry ? (
                    <button
                      type="button"
                      onClick={() => void processing.retry()}
                      disabled={processing.retrying}
                    >
                      {processing.retrying ? (
                        <LoadingOutlined spin aria-hidden="true" />
                      ) : (
                        <ReloadOutlined aria-hidden="true" />
                      )}
                      {t("processing.actions.retry")}
                    </button>
                  ) : (
                    <small>{t("processing.retryExhausted")}</small>
                  )}
                </div>
              ) : null}

              {processing.job?.status === "ready" ? (
                <div className="meeting-processing-ready">
                  <div className="meeting-processing-ready__summary">
                    <CheckCircleFilled aria-hidden="true" />
                    <div>
                      <strong>{t("processing.readyTitle")}</strong>
                      <small>{t("processing.readyDescription")}</small>
                    </div>
                  </div>

                  {playbackArtifact ? (
                    <article className="meeting-processing-playback">
                      <div>
                        <strong>{t("processing.playbackTitle")}</strong>
                        <small>{formatBytes(playbackArtifact.sizeBytes)}</small>
                      </div>
                      <audio
                        ref={playbackAudioRef}
                        controls
                        preload="metadata"
                        crossOrigin="use-credentials"
                        src={meetingProcessingArtifactUrl(playbackArtifact)}
                      />
                      <a
                        href={meetingProcessingArtifactUrl(playbackArtifact, true)}
                        download="meeting-playback.m4a"
                      >
                        <DownloadOutlined aria-hidden="true" />
                        {t("processing.actions.downloadPlayback")}
                      </a>
                    </article>
                  ) : (
                    <p className="meeting-processing-notice">
                      {t("processing.playbackMissing")}
                    </p>
                  )}
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {showTranscription ? (
          <section
            className={`meeting-processing-panel meeting-transcript-panel is-${transcriptionState}`}
            aria-labelledby="meeting-transcription-title"
          >
            <div className="meeting-processing-panel__heading">
              <div>
                <p className="meeting-audio-eyebrow">MEETING TRANSCRIPT</p>
                <h2 id="meeting-transcription-title">{t("transcription.title")}</h2>
                <p>{t("transcription.description")}</p>
              </div>
              <span className="meeting-processing-state" aria-live="polite">
                {transcriptionState === "pending" ||
                transcriptionState === "running" ||
                transcriptionState === "retrying" ? (
                  <span
                    className="meeting-transcription-spinner"
                    aria-hidden="true"
                  />
                ) : transcriptionState === "ready" ? (
                  <CheckCircleFilled aria-hidden="true" />
                ) : (
                  <InfoCircleOutlined aria-hidden="true" />
                )}
                {t(`transcription.states.${transcriptionState}`)}
              </span>
            </div>

            <div className="meeting-processing-panel__body">
              {!transcription.providerDisabled ? (
                <div className="meeting-processing-progress">
                  <span>{t("transcription.currentStep")}</span>
                  <strong>
                    {transcription.job
                      ? t(`transcription.phases.${transcription.job.phase}`)
                      : transcription.enqueueing
                        ? t("transcription.phases.queued")
                        : t("transcription.waitingForStatus")}
                  </strong>
                  <small>
                    {transcription.job
                      ? t("transcription.attempt", {
                          current: transcription.job.attemptCount,
                          max: transcription.job.maxAttempts,
                        })
                      : t("transcription.audioReady")}
                  </small>
                </div>
              ) : null}

              {transcription.pollingErrorMessage !== null ? (
                <p className="meeting-processing-notice" role="status">
                  {t("transcription.pollingDelayed")}
                  {transcription.pollingErrorMessage
                    ? ` ${transcription.pollingErrorMessage}`
                    : ""}
                </p>
              ) : null}

              {transcription.providerDisabled ? (
                <div className="meeting-transcript-disabled" role="status">
                  <InfoCircleOutlined aria-hidden="true" />
                  <div>
                    <strong>{t("transcription.providerDisabledTitle")}</strong>
                    <p>{t("transcription.providerDisabledDescription")}</p>
                  </div>
                </div>
              ) : null}

              {transcription.unknown ? (
                <p className="meeting-processing-issue" role="alert">
                  {t("transcription.unknown")}
                </p>
              ) : null}

              {transcription.actionFailed && !transcription.providerDisabled ? (
                <div className="meeting-processing-issue" role="alert">
                  <p>
                    {transcription.failedAction === "retry"
                      ? t("transcription.retryFailed")
                      : t("transcription.enqueueFailed")}
                    {transcription.actionErrorMessage
                      ? ` ${transcription.actionErrorMessage}`
                      : ""}
                  </p>
                  {!transcription.job && transcription.failedAction === "enqueue" ? (
                    <button type="button" onClick={transcription.retryEnqueue}>
                      <ReloadOutlined aria-hidden="true" />
                      {t("transcription.actions.retryEnqueue")}
                    </button>
                  ) : null}
                </div>
              ) : null}

              {transcription.job?.status === "failed" ? (
                <div className="meeting-processing-issue" role="alert">
                  <p>
                    {t("transcription.failed")}
                    {transcription.job.errorMessage
                      ? ` ${transcription.job.errorMessage}`
                      : ""}
                  </p>
                  {transcription.canRetry ? (
                    <button
                      type="button"
                      onClick={() => void transcription.retry()}
                      disabled={transcription.retrying}
                    >
                      {transcription.retrying ? (
                        <LoadingOutlined spin aria-hidden="true" />
                      ) : (
                        <ReloadOutlined aria-hidden="true" />
                      )}
                      {t("transcription.actions.retry")}
                    </button>
                  ) : (
                    <small>{t("transcription.retryExhausted")}</small>
                  )}
                </div>
              ) : null}

              {transcription.job?.status === "ready" ? (
                <div className="meeting-transcript-ready">
                  <div className="meeting-transcript-ready__summary">
                    <div>
                      <strong>{t("transcription.readyTitle")}</strong>
                      <small>
                        {t("transcription.generatedWith", {
                          provider: transcription.job.provider,
                          model: transcription.job.model,
                        })}
                      </small>
                    </div>
                    <div className="meeting-transcript-ready__actions">
                      {transcriptJsonArtifact ? (
                        <button
                          type="button"
                          className="meeting-transcript-toggle"
                          onClick={() => setTranscriptOpen(true)}
                        >
                          <SearchOutlined aria-hidden="true" />
                          <span>
                            {t("transcription.reader.open")}
                          </span>
                          {transcription.document ? (
                            <small>
                              {t("transcription.segmentCount", {
                                count: transcription.document.segments.length,
                              })}
                            </small>
                          ) : null}
                        </button>
                      ) : null}
                    </div>
                  </div>

                  {transcription.loadingDocument ? (
                    <p className="meeting-processing-notice" role="status">
                      <LoadingOutlined spin aria-hidden="true" />
                      {t("transcription.loadingPreview")}
                    </p>
                  ) : null}

                  {transcription.documentErrorMessage !== null ? (
                    <div className="meeting-processing-issue" role="alert">
                      <p>
                        {transcription.documentErrorMessage ===
                        "MEETING_TRANSCRIPTION_MERGED_ARTIFACT_MISSING"
                          ? t("transcription.previewMissing")
                          : t("transcription.previewUnavailable")}
                        {transcription.documentErrorMessage &&
                        transcription.documentErrorMessage !==
                          "MEETING_TRANSCRIPTION_MERGED_ARTIFACT_MISSING"
                          ? ` ${transcription.documentErrorMessage}`
                          : ""}
                      </p>
                      {transcriptJsonArtifact ? (
                        <button type="button" onClick={transcription.retryDocument}>
                          <ReloadOutlined aria-hidden="true" />
                          {t("transcription.actions.retryPreview")}
                        </button>
                      ) : null}
                    </div>
                  ) : null}

                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {transcription.job?.status === "ready" ? (
          <section
            className={`meeting-minutes-panel is-${minutesState}`}
            aria-labelledby="meeting-minutes-title"
          >
            <div className="meeting-minutes-panel__heading">
              <div>
                <p className="meeting-audio-eyebrow">AI MEETING MINUTES</p>
                <h2 id="meeting-minutes-title">{t("minutes.title")}</h2>
                <p>{t("minutes.description")}</p>
              </div>
              <span className="meeting-processing-state" aria-live="polite">
                {minutesState === "pending" ||
                minutesState === "running" ||
                minutesState === "retrying" ? (
                  <LoadingOutlined spin aria-hidden="true" />
                ) : minutesState === "ready" ? (
                  <CheckCircleFilled aria-hidden="true" />
                ) : (
                  <FileTextOutlined aria-hidden="true" />
                )}
                {t(`minutes.states.${minutesState}`)}
              </span>
            </div>

            <div className="meeting-minutes-panel__body">
              <div className="meeting-minutes-intro">
                <strong>{t("minutes.formTitle")}</strong>
                <p>{t("minutes.formDescription")}</p>
              </div>
              <form
                className="meeting-minutes-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitMinutes();
                }}
              >
                <div className="meeting-minutes-form__row">
                  <label>
                    <span>{t("minutes.fields.title")}</span>
                    <input
                      required
                      maxLength={200}
                      value={minutesInput.title}
                      onChange={(event) => updateMinutesInput("title", event.target.value)}
                      placeholder={t("minutes.placeholders.title")}
                    />
                  </label>
                  <label>
                    <span>{t("minutes.fields.date")}</span>
                    <input
                      type="date"
                      value={minutesInput.date ?? ""}
                      onChange={(event) => updateMinutesInput("date", event.target.value)}
                    />
                  </label>
                </div>
                <label>
                  <span>{t("minutes.fields.attendees")}</span>
                  <textarea
                    rows={3}
                    value={minutesInput.attendees}
                    onChange={(event) => updateMinutesInput("attendees", event.target.value)}
                    placeholder={t("minutes.placeholders.attendees")}
                  />
                </label>
                <div className="meeting-minutes-form__row is-textarea">
                  <label>
                    <span>{t("minutes.fields.confirmedFacts")}</span>
                    <textarea
                      rows={5}
                      value={minutesInput.confirmedFacts}
                      onChange={(event) =>
                        updateMinutesInput("confirmedFacts", event.target.value)
                      }
                      placeholder={t("minutes.placeholders.confirmedFacts")}
                    />
                  </label>
                  <label>
                    <span>{t("minutes.fields.confirmedDecisions")}</span>
                    <textarea
                      rows={5}
                      value={minutesInput.confirmedDecisions}
                      onChange={(event) =>
                        updateMinutesInput("confirmedDecisions", event.target.value)
                      }
                      placeholder={t("minutes.placeholders.confirmedDecisions")}
                    />
                  </label>
                </div>
                <div className="meeting-minutes-form__row is-textarea">
                  <label>
                    <span>{t("minutes.fields.termCorrections")}</span>
                    <textarea
                      rows={4}
                      value={minutesInput.termCorrections}
                      onChange={(event) =>
                        updateMinutesInput("termCorrections", event.target.value)
                      }
                      placeholder={t("minutes.placeholders.termCorrections")}
                    />
                  </label>
                  <label>
                    <span>{t("minutes.fields.otherNotes")}</span>
                    <textarea
                      rows={4}
                      value={minutesInput.otherNotes}
                      onChange={(event) => updateMinutesInput("otherNotes", event.target.value)}
                      placeholder={t("minutes.placeholders.otherNotes")}
                    />
                  </label>
                </div>
                <div className="meeting-minutes-form__actions">
                  <p>{t("minutes.humanPriority")}</p>
                  <button
                    type="submit"
                    className="meeting-recording-primary"
                    disabled={minutesActive || !minutesInput.title.trim()}
                  >
                    {minutesActive ? <LoadingOutlined spin aria-hidden="true" /> : <FileTextOutlined aria-hidden="true" />}
                    {minutesActive
                      ? t("minutes.actions.generating")
                      : minutes.versions.length > 0
                        ? t("minutes.actions.regenerate")
                        : t("minutes.actions.generate")}
                  </button>
                </div>
              </form>

              {minutes.pollingErrorMessage !== null ? (
                <p className="meeting-processing-notice" role="status">
                  {t("minutes.pollingDelayed")}
                  {minutes.pollingErrorMessage ? ` ${minutes.pollingErrorMessage}` : ""}
                </p>
              ) : null}

              {minutes.unknown ? (
                <p className="meeting-processing-issue" role="alert">
                  {t("minutes.unknown")}
                </p>
              ) : null}

              {minutes.failedAction ? (
                <div className="meeting-processing-issue" role="alert">
                  <p>
                    {minutes.providerDisabled
                      ? t("minutes.providerDisabled")
                      : minutes.failedAction === "retry"
                        ? t("minutes.retryFailed")
                        : minutes.failedAction === "versions"
                          ? t("minutes.versionsFailed")
                          : t("minutes.enqueueFailed")}
                    {minutes.actionErrorMessage ? ` ${minutes.actionErrorMessage}` : ""}
                  </p>
                  {minutes.failedAction === "enqueue" && minutes.hasCursor ? (
                    <button type="button" onClick={minutes.retryEnqueue}>
                      <ReloadOutlined aria-hidden="true" />
                      {t("minutes.actions.retryEnqueue")}
                    </button>
                  ) : null}
                  {minutes.failedAction === "versions" ? (
                    <button type="button" onClick={() => void minutes.refreshVersions()}>
                      <ReloadOutlined aria-hidden="true" />
                      {t("minutes.actions.refreshVersions")}
                    </button>
                  ) : null}
                </div>
              ) : null}

              {minutes.job?.status === "failed" ? (
                <div className="meeting-processing-issue" role="alert">
                  <p>
                    {t("minutes.failed")}
                    {minutes.job.errorMessage ? ` ${minutes.job.errorMessage}` : ""}
                  </p>
                  {minutes.canRetry ? (
                    <button
                      type="button"
                      onClick={() => void minutes.retry()}
                      disabled={minutes.retrying}
                    >
                      <ReloadOutlined aria-hidden="true" />
                      {t("minutes.actions.retry")}
                    </button>
                  ) : (
                    <small>{t("minutes.retryExhausted")}</small>
                  )}
                </div>
              ) : null}

              {minutes.selectedVersion ? (
                <div className="meeting-minutes-document">
                  <div className="meeting-minutes-document__toolbar">
                    <div>
                      <strong>{t("minutes.readyTitle")}</strong>
                      <small>
                        {t("minutes.versionGeneratedAt", {
                          version: minutes.selectedVersion.versionNumber,
                          time: new Date(minutes.selectedVersion.generatedAt).toLocaleString(),
                        })}
                      </small>
                    </div>
                    <div className="meeting-minutes-document__controls">
                      <label>
                        <span>{t("minutes.versionLabel")}</span>
                        <select
                          value={minutes.selectedVersionId ?? ""}
                          onChange={(event) => minutes.setSelectedVersionId(event.target.value)}
                        >
                          {minutes.versions.map((version) => (
                            <option key={version.versionId} value={version.versionId}>
                              v{version.versionNumber}
                            </option>
                          ))}
                        </select>
                      </label>
                      {selectedMinutesHtml ? (
                        <a
                          href={meetingMinutesArtifactUrl(selectedMinutesHtml, true)}
                          download={`meeting-minutes-v${minutes.selectedVersion.versionNumber}.html`}
                        >
                          <DownloadOutlined aria-hidden="true" />
                          {t("minutes.actions.downloadHtml")}
                        </a>
                      ) : null}
                      {selectedMinutesJson ? (
                        <a
                          href={meetingMinutesArtifactUrl(selectedMinutesJson, true)}
                          download={`meeting-minutes-v${minutes.selectedVersion.versionNumber}.json`}
                        >
                          <DownloadOutlined aria-hidden="true" />
                          {t("minutes.actions.downloadJson")}
                        </a>
                      ) : null}
                      <a
                        href={meetingMinutesPackageUrl(minutes.selectedVersion)}
                        download={`meeting-minutes-v${minutes.selectedVersion.versionNumber}.zip`}
                      >
                        <DownloadOutlined aria-hidden="true" />
                        {t("minutes.actions.downloadPackage")}
                      </a>
                    </div>
                  </div>
                  {selectedMinutesHtml ? (
                    <iframe
                      className="meeting-minutes-preview"
                      title={t("minutes.previewTitle")}
                      src={meetingMinutesArtifactUrl(selectedMinutesHtml)}
                      sandbox=""
                    />
                  ) : (
                    <p className="meeting-processing-issue">{t("minutes.previewMissing")}</p>
                  )}
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        <footer className="meeting-audio-footer">
          {persistent.libraryAccess.library ? (
            <div className="meeting-audio-footer__library">
              <span>{t("library.owner.currentLibrary")}</span>
              <strong>
                {persistent.libraryAccess.library.displayName?.trim() ||
                  t("library.owner.unnamed")}
              </strong>
              <code>
                {persistent.libraryAccess.library.codeHint ||
                  t("library.owner.codeHintUnavailable")}
              </code>
            </div>
          ) : null}
          <div className="meeting-audio-footer__boundary">
            <span>{t("footer.phase")}</span>
            <p>{t("footer.boundary")}</p>
          </div>
        </footer>
      </div>
      <MeetingTranscriptDialog
        open={transcriptOpen}
        onClose={() => setTranscriptOpen(false)}
        title={persistent.savedSession?.title ?? t("transcription.title")}
        transcriptKey={
          transcriptJsonArtifact
            ? createMeetingTranscriptCacheKey(transcriptJsonArtifact)
            : transcription.job?.jobId ?? ""
        }
        document={transcription.document}
        loading={transcription.loadingDocument}
        errorMessage={transcription.documentErrorMessage}
        onRetry={transcription.retryDocument}
        onDownloadText={
          transcriptTextArtifact
            ? () =>
                downloadMeetingTranscriptionArtifact(
                  transcriptTextArtifact,
                  "meeting-transcript.txt"
                )
            : undefined
        }
        onDownloadJson={
          transcriptJsonArtifact
            ? () =>
                downloadMeetingTranscriptionArtifact(
                  transcriptJsonArtifact,
                  "meeting-transcript.json"
                )
            : undefined
        }
        onActionError={handleTranscriptActionError}
        onSegmentSelect={playbackArtifact ? seekPlayback : undefined}
      />
    </main>
  );
}

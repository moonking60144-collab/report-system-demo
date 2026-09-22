import {
  AudioOutlined,
  CheckCircleFilled,
  DownloadOutlined,
  FileTextOutlined,
  LeftOutlined,
  LoadingOutlined,
  LockOutlined,
  LogoutOutlined,
  ReloadOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import {
  authorizeMeetingLibrary,
  downloadMeetingTranscriptionArtifact,
  fetchMeetingLibrary,
  fetchMeetingLibraryRecording,
  fetchMeetingLibraryRecordings,
  isMeetingLibraryViewerAccessTerminalErrorCode,
  logoutMeetingLibrary,
  meetingLibraryTrackUrl,
  meetingMinutesArtifactUrl,
  meetingMinutesPackageUrl,
  meetingProcessingArtifactUrl,
  resolveMeetingRecordingApiError,
  resolveMeetingRecordingApiErrorCode,
  type MeetingLibraryInfo,
  type MeetingLibraryRecordingDetail,
  type MeetingRecordingSession,
} from "../api/meetingRecordingApi";
import { MeetingTranscriptDialog } from "../components/MeetingTranscriptDialog";
import { MEETING_AUDIO_CHECK_ROUTE } from "../routes";
import { useMeetingTranscriptDocument } from "../useMeetingTranscriptDocument";
import { formatMeetingLibraryCodeInput } from "../utils/meetingLibraryCode";
import "../styles/meeting-audio-check.css";

type LibraryPagePhase = "checking" | "entry" | "ready";

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
}

function formatDuration(durationMs: number | null): string {
  if (!durationMs) return "--:--";
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":")
    : [minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${Math.ceil(bytes / 1_024)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

export function MeetingLibraryPage() {
  const { t } = useTranslation("meetingMinutes");
  const location = useLocation();
  const navigate = useNavigate();
  const openedFromDevAdmin =
    (location.state as { meetingLibrarySource?: unknown } | null)
      ?.meetingLibrarySource === "dev-meeting-libraries";
  const codeInputRef = useRef<HTMLInputElement | null>(null);
  const detailRequestRef = useRef(0);
  const recordingsRequestRef = useRef(0);
  const viewerGenerationRef = useRef(0);
  const libraryIdentityRef = useRef<string | null>(null);
  const submitInFlightRef = useRef(false);
  const logoutInFlightRef = useRef(false);
  const [phase, setPhase] = useState<LibraryPagePhase>("checking");
  const [library, setLibrary] = useState<MeetingLibraryInfo | null>(null);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [recordings, setRecordings] = useState<MeetingRecordingSession[]>([]);
  const [recordingsCursor, setRecordingsCursor] = useState<string | null>(null);
  const [hasMoreRecordings, setHasMoreRecordings] = useState(false);
  const [loadingRecordings, setLoadingRecordings] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MeetingLibraryRecordingDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const resetToEntry = useCallback((message: string | null = null) => {
    viewerGenerationRef.current += 1;
    libraryIdentityRef.current = null;
    recordingsRequestRef.current += 1;
    detailRequestRef.current += 1;
    setLibrary(null);
    setRecordings([]);
    setRecordingsCursor(null);
    setHasMoreRecordings(false);
    setSelectedSessionId(null);
    setDetail(null);
    setTranscriptOpen(false);
    setCode("");
    setLoadingRecordings(false);
    setLoadingDetail(false);
    setErrorMessage(message);
    setPhase("entry");
  }, []);

  const activateLibrary = useCallback((metadata: MeetingLibraryInfo) => {
    viewerGenerationRef.current += 1;
    libraryIdentityRef.current = `${metadata.libraryId}:${metadata.accessVersion}`;
    recordingsRequestRef.current += 1;
    detailRequestRef.current += 1;
    setLibrary(metadata);
    setRecordings([]);
    setRecordingsCursor(null);
    setHasMoreRecordings(false);
    setSelectedSessionId(null);
    setDetail(null);
    setTranscriptOpen(false);
    setPhase("ready");
  }, []);

  const handleApiError = useCallback(
    (error: unknown, fallbackKey: string) => {
      const codeValue = resolveMeetingRecordingApiErrorCode(error);
      if (isMeetingLibraryViewerAccessTerminalErrorCode(codeValue)) {
        resetToEntry(t("library.viewer.expired"));
        return true;
      }
      setErrorMessage(resolveMeetingRecordingApiError(error) ?? t(fallbackKey));
      return false;
    },
    [resetToEntry, t]
  );

  const transcriptJsonArtifact = detail?.transcriptionJob?.artifacts.find(
    (artifact) => artifact.type === "transcript-merged-json"
  ) ?? null;
  const transcriptTextArtifact = detail?.transcriptionJob?.artifacts.find(
    (artifact) => artifact.type === "transcript-text"
  ) ?? null;
  const handleTranscriptTerminalAccessError = useCallback(
    (error: unknown) => {
      setTranscriptOpen(false);
      handleApiError(error, "library.viewer.transcriptFailed");
    },
    [handleApiError]
  );
  const transcriptDocument = useMeetingTranscriptDocument({
    artifact: transcriptJsonArtifact,
    open: transcriptOpen,
    onTerminalAccessError: handleTranscriptTerminalAccessError,
  });

  const loadRecordings = useCallback(async (cursor: string | null = null) => {
    const generation = viewerGenerationRef.current;
    const libraryIdentity = libraryIdentityRef.current;
    if (!libraryIdentity) return;
    const requestId = recordingsRequestRef.current + 1;
    recordingsRequestRef.current = requestId;
    setLoadingRecordings(true);
    setErrorMessage(null);
    try {
      const page = await fetchMeetingLibraryRecordings(50, cursor);
      if (
        viewerGenerationRef.current !== generation ||
        libraryIdentityRef.current !== libraryIdentity ||
        recordingsRequestRef.current !== requestId
      ) {
        return;
      }
      setRecordings((current) => {
        if (!cursor) return page.items;
        const knownIds = new Set(current.map((recording) => recording.sessionId));
        return [...current, ...page.items.filter((recording) => !knownIds.has(recording.sessionId))];
      });
      setRecordingsCursor(page.nextCursor);
      setHasMoreRecordings(page.hasMore);
      setSelectedSessionId((current) =>
        current && (cursor || page.items.some((recording) => recording.sessionId === current))
          ? current
          : page.items[0]?.sessionId ?? null
      );
    } catch (error) {
      if (
        viewerGenerationRef.current === generation &&
        libraryIdentityRef.current === libraryIdentity &&
        recordingsRequestRef.current === requestId
      ) {
        handleApiError(error, "library.viewer.loadFailed");
      }
    } finally {
      if (
        viewerGenerationRef.current === generation &&
        libraryIdentityRef.current === libraryIdentity &&
        recordingsRequestRef.current === requestId
      ) {
        setLoadingRecordings(false);
      }
    }
  }, [handleApiError]);

  useEffect(() => {
    let cancelled = false;
    void fetchMeetingLibrary()
      .then((metadata) => {
        if (cancelled) return;
        activateLibrary(metadata);
      })
      .catch((error) => {
        if (cancelled) return;
        const codeValue = resolveMeetingRecordingApiErrorCode(error);
        if (
          codeValue === "MEETING_LIBRARY_VIEWER_REQUIRED" ||
          codeValue === "MEETING_LIBRARY_VIEWER_EXPIRED"
        ) {
          resetToEntry(codeValue === "MEETING_LIBRARY_VIEWER_EXPIRED" ? t("library.viewer.expired") : null);
          return;
        }
        resetToEntry(resolveMeetingRecordingApiError(error) ?? t("library.viewer.checkFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [activateLibrary, resetToEntry, t]);

  useEffect(() => {
    if (phase !== "entry") return;
    codeInputRef.current?.focus();
  }, [phase]);

  useEffect(() => {
    if (phase === "ready") void loadRecordings(null);
  }, [loadRecordings, phase]);

  useEffect(() => {
    if (!selectedSessionId || phase !== "ready") {
      setDetail(null);
      return;
    }
    const requestId = detailRequestRef.current + 1;
    detailRequestRef.current = requestId;
    const generation = viewerGenerationRef.current;
    const libraryIdentity = libraryIdentityRef.current;
    const isCurrentRequest = () =>
      detailRequestRef.current === requestId &&
      viewerGenerationRef.current === generation &&
      libraryIdentityRef.current === libraryIdentity;
    setLoadingDetail(true);
    setDetail(null);
    void fetchMeetingLibraryRecording(selectedSessionId)
      .then((nextDetail) => {
        if (!isCurrentRequest()) return;
        setDetail(nextDetail);
      })
      .catch((error) => {
        if (isCurrentRequest()) {
          handleApiError(error, "library.viewer.detailFailed");
        }
      })
      .finally(() => {
        if (isCurrentRequest()) setLoadingDetail(false);
      });
  }, [handleApiError, phase, selectedSessionId]);

  const submitCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitInFlightRef.current || code.replace("-", "").length !== 6) return;
    submitInFlightRef.current = true;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const metadata = await authorizeMeetingLibrary(code);
      activateLibrary(metadata);
      setCode("");
    } catch (error) {
      setErrorMessage(resolveMeetingRecordingApiError(error) ?? t("library.viewer.invalid"));
      requestAnimationFrame(() => codeInputRef.current?.focus());
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
    }
  };

  const logout = async () => {
    if (logoutInFlightRef.current) return;
    logoutInFlightRef.current = true;
    setLoggingOut(true);
    setErrorMessage(null);
    try {
      await logoutMeetingLibrary();
      resetToEntry();
    } catch (error) {
      handleApiError(error, "library.viewer.logoutFailed");
    } finally {
      logoutInFlightRef.current = false;
      setLoggingOut(false);
    }
  };

  const playbackArtifact = detail?.processingJob?.artifacts.find(
    (artifact) => artifact.type === "playback"
  );
  const latestMinutes = detail?.minutesVersions[0] ?? null;
  const minutesHtml = latestMinutes?.artifacts.find(
    (artifact) => artifact.type === "minutes-html"
  );

  return (
    <main className="meeting-audio-page meeting-library-page">
      <header className="meeting-audio-header">
        <button
          type="button"
          className="meeting-header-link"
          onClick={() =>
            openedFromDevAdmin ? navigate(-1) : navigate(MEETING_AUDIO_CHECK_ROUTE)
          }
        >
          <LeftOutlined aria-hidden="true" />
          {t(
            openedFromDevAdmin
              ? "library.actions.backToAdmin"
              : "library.actions.backToRecorder"
          )}
        </button>
        {phase === "ready" ? (
          <button type="button" className="meeting-header-link" onClick={() => void logout()} disabled={loggingOut}>
            {loggingOut ? <LoadingOutlined spin aria-hidden="true" /> : <LogoutOutlined aria-hidden="true" />}
            {t("library.actions.leave")}
          </button>
        ) : null}
      </header>

      <div className="meeting-library-shell">
        <section className="meeting-library-intro">
          <p className="meeting-audio-eyebrow">MEETING LIBRARY</p>
          <h1>{t("library.page.title")}</h1>
          <p>{t("library.page.subtitle")}</p>
        </section>

        {phase === "checking" ? (
          <section className="meeting-library-gate is-checking" role="status">
            <LoadingOutlined spin aria-hidden="true" />
            <div>
              <strong>{t("library.viewer.checking")}</strong>
              <p>{t("library.viewer.checkingDescription")}</p>
            </div>
          </section>
        ) : null}

        {phase === "entry" ? (
          <section className="meeting-library-gate" aria-labelledby="meeting-library-code-title">
            <div className="meeting-library-gate__mark" aria-hidden="true">
              <LockOutlined />
            </div>
            <div className="meeting-library-gate__copy">
              <p className="meeting-audio-eyebrow">READ-ONLY ACCESS</p>
              <h2 id="meeting-library-code-title">{t("library.viewer.enterTitle")}</h2>
              <p>{t("library.viewer.enterDescription")}</p>
            </div>
            <form onSubmit={(event) => void submitCode(event)} className="meeting-library-code-form">
              <label htmlFor="meeting-library-code">{t("library.viewer.codeLabel")}</label>
              <div>
                <input
                  ref={codeInputRef}
                  id="meeting-library-code"
                  type="password"
                  value={code}
                  onChange={(event) => setCode(formatMeetingLibraryCodeInput(event.target.value))}
                  placeholder="ABC-234"
                  autoComplete="current-password"
                  autoCapitalize="characters"
                  spellCheck={false}
                  inputMode="text"
                  maxLength={7}
                  aria-invalid={Boolean(errorMessage)}
                />
                <button type="submit" disabled={submitting || code.replace("-", "").length !== 6}>
                  {submitting ? <LoadingOutlined spin aria-hidden="true" /> : <LockOutlined aria-hidden="true" />}
                  {submitting ? t("library.viewer.entering") : t("library.viewer.enter")}
                </button>
              </div>
              <small>{t("library.viewer.codeHint")}</small>
            </form>
            {errorMessage ? <p className="meeting-library-error" role="alert">{errorMessage}</p> : null}
          </section>
        ) : null}

        {phase === "ready" ? (
          <section className="meeting-library-workspace" aria-label={t("library.page.title")}>
            <aside className="meeting-library-index">
              <div className="meeting-library-index__heading">
                <div>
                  <span>{t("library.viewer.libraryLabel")}</span>
                  <strong>
                    {library?.displayName?.trim() || t("library.owner.unnamed")}
                  </strong>
                  <code>
                    {library?.codeHint || t("library.owner.codeHintUnavailable")}
                  </code>
                </div>
                <button type="button" onClick={() => void loadRecordings(null)} disabled={loadingRecordings} aria-label={t("library.actions.refresh")}>
                  <ReloadOutlined spin={loadingRecordings} aria-hidden="true" />
                </button>
              </div>
              {recordings.length > 0 ? (
                <ol className="meeting-library-recording-list">
                  {recordings.map((recording, index) => (
                    <li key={recording.sessionId}>
                      <button
                        type="button"
                        className={selectedSessionId === recording.sessionId ? "is-selected" : ""}
                        onClick={() => {
                          setTranscriptOpen(false);
                          setSelectedSessionId(recording.sessionId);
                        }}
                      >
                        <span>{String(index + 1).padStart(2, "0")}</span>
                        <div>
                          <strong>{recording.title}</strong>
                          <small>{formatDateTime(recording.createdAt)}</small>
                        </div>
                        <em>{formatDuration(recording.durationMs)}</em>
                      </button>
                    </li>
                  ))}
                </ol>
              ) : loadingRecordings ? (
                <p className="meeting-library-index__empty"><LoadingOutlined spin /> {t("library.viewer.loading")}</p>
              ) : (
                <p className="meeting-library-index__empty">{t("library.viewer.empty")}</p>
              )}
              {hasMoreRecordings && recordingsCursor ? (
                <button
                  type="button"
                  className="meeting-library-index__more"
                  onClick={() => void loadRecordings(recordingsCursor)}
                  disabled={loadingRecordings}
                >
                  {loadingRecordings ? <LoadingOutlined spin aria-hidden="true" /> : null}
                  {t("library.actions.loadMore")}
                </button>
              ) : null}
            </aside>

            <div className="meeting-library-document">
              {loadingDetail ? (
                <div className="meeting-library-document__empty" role="status">
                  <LoadingOutlined spin />
                  <span>{t("library.viewer.loadingDetail")}</span>
                </div>
              ) : detail ? (
                <>
                  <header className="meeting-library-document__heading">
                    <div>
                      <p className="meeting-audio-eyebrow">RECORDING ARCHIVE</p>
                      <h2>{detail.session.title}</h2>
                      <p>{formatDateTime(detail.session.createdAt)} · {formatDuration(detail.session.durationMs)}</p>
                    </div>
                    <span><CheckCircleFilled aria-hidden="true" /> {t("library.viewer.readOnly")}</span>
                  </header>

                  <section className="meeting-library-section">
                    <div className="meeting-library-section__heading">
                      <AudioOutlined aria-hidden="true" />
                      <div><h3>{t("library.content.audio")}</h3><p>{t("library.content.audioDescription")}</p></div>
                    </div>
                    {playbackArtifact ? (
                      <div className="meeting-library-playback">
                        <audio controls preload="metadata" src={meetingProcessingArtifactUrl(playbackArtifact)}>
                          {t("results.audioUnsupported")}
                        </audio>
                        <a href={meetingProcessingArtifactUrl(playbackArtifact, true)} download>
                          <DownloadOutlined aria-hidden="true" /> {t("library.actions.downloadAudio")}
                        </a>
                      </div>
                    ) : (
                      <div className="meeting-library-track-list">
                        {detail.session.tracks.filter((track) => track.available).map((track) => (
                          <article key={track.sourceId}>
                            <strong>{t(`transcription.sources.${track.sourceId}`)}</strong>
                            <audio controls preload="metadata" src={meetingLibraryTrackUrl(detail.session.sessionId, track.sourceId)}>
                              {t("results.audioUnsupported")}
                            </audio>
                            <a href={meetingLibraryTrackUrl(detail.session.sessionId, track.sourceId, true)} download>
                              <DownloadOutlined aria-hidden="true" /> {t("library.actions.downloadAudio")}
                            </a>
                          </article>
                        ))}
                        {detail.session.tracks.every((track) => !track.available) ? <p>{t("library.content.audioPending")}</p> : null}
                      </div>
                    )}
                  </section>

                  <section className="meeting-library-section">
                    <div className="meeting-library-section__heading">
                      <SearchOutlined aria-hidden="true" />
                      <div><h3>{t("library.content.transcript")}</h3><p>{t("library.content.transcriptDescription")}</p></div>
                    </div>
                    {transcriptJsonArtifact ? (
                      <div className="meeting-library-transcript-summary">
                        <div>
                          <strong>{t("transcription.readyTitle")}</strong>
                          <span>
                            {formatDuration(detail.session.durationMs)} · {formatBytes(transcriptJsonArtifact.sizeBytes)}
                          </span>
                        </div>
                        <button type="button" onClick={() => setTranscriptOpen(true)}>
                          <SearchOutlined aria-hidden="true" />
                          {t("transcription.reader.open")}
                        </button>
                      </div>
                    ) : (
                      <p className="meeting-library-muted">{t("library.content.transcriptPending")}</p>
                    )}
                  </section>

                  <section className="meeting-library-section">
                    <div className="meeting-library-section__heading">
                      <FileTextOutlined aria-hidden="true" />
                      <div><h3>{t("library.content.minutes")}</h3><p>{t("library.content.minutesDescription")}</p></div>
                    </div>
                    {latestMinutes && minutesHtml ? (
                      <>
                        <div className="meeting-library-minutes-actions">
                          <span>{t("minutes.versionGeneratedAt", { version: latestMinutes.versionNumber, time: formatDateTime(latestMinutes.generatedAt) })}</span>
                          <a href={meetingMinutesArtifactUrl(minutesHtml, true)} download><DownloadOutlined /> HTML</a>
                          <a href={meetingMinutesPackageUrl(latestMinutes)} download><DownloadOutlined /> ZIP</a>
                        </div>
                        <iframe className="meeting-library-minutes-preview" title={t("minutes.previewTitle")} src={meetingMinutesArtifactUrl(minutesHtml)} sandbox="" />
                      </>
                    ) : (
                      <p className="meeting-library-muted">{t("library.content.minutesPending")}</p>
                    )}
                  </section>
                </>
              ) : (
                <div className="meeting-library-document__empty">
                  <FileTextOutlined aria-hidden="true" />
                  <span>{t("library.viewer.selectRecording")}</span>
                </div>
              )}
              {errorMessage ? <p className="meeting-library-error" role="alert">{errorMessage}</p> : null}
            </div>
          </section>
        ) : null}
      </div>
      <MeetingTranscriptDialog
        open={transcriptOpen}
        onClose={() => setTranscriptOpen(false)}
        title={detail?.session.title ?? t("transcription.title")}
        transcriptKey={transcriptDocument.artifactKey}
        document={transcriptDocument.document}
        loading={transcriptDocument.loading}
        errorMessage={transcriptDocument.errorMessage}
        onRetry={transcriptDocument.retry}
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
        onActionError={(error) => {
          if (handleApiError(error, "library.viewer.transcriptFailed")) {
            setTranscriptOpen(false);
          }
        }}
      />
    </main>
  );
}

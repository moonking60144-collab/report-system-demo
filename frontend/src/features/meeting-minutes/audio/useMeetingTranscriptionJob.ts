import { useCallback, useEffect, useRef, useState } from "react";
import {
  enqueueMeetingTranscription,
  fetchMeetingMergedTranscript,
  fetchMeetingTranscriptionJob,
  isMeetingSessionAccessTerminalErrorCode,
  persistMeetingSessionCapability,
  resolveMeetingRecordingApiError,
  resolveMeetingRecordingApiErrorCode,
  retryMeetingTranscriptionJob,
  type MeetingMergedTranscriptDocument,
  type MeetingProcessingJob,
  type MeetingTranscriptionJob,
} from "../api/meetingRecordingApi";
import {
  canRetryMeetingAiJob,
  createMeetingJobCursorStore,
  getMeetingBrowserStorage,
  isMeetingAiProviderChangedFailure,
  pollMeetingJob,
  type MeetingJobPollResult,
  type MeetingJobStorageLike,
} from "./meetingJobTracking";

export interface MeetingTranscriptionCursor {
  sessionId: string;
  jobId: string | null;
}

interface MeetingTranscriptionTrackingCursor extends MeetingTranscriptionCursor {
  jobId: string;
}

export type MeetingTranscriptionPollResult = MeetingJobPollResult<MeetingTranscriptionJob>;

interface PollDependencies {
  fetchJob?: typeof fetchMeetingTranscriptionJob;
  wait?: (delayMs: number) => Promise<void>;
  isCancelled?: () => boolean;
  isPaused?: () => boolean;
  onJob?: (job: MeetingTranscriptionJob) => void;
  onTransientError?: (error: unknown | null) => void;
  pollIntervalMs?: number;
}

const TRANSCRIPTION_CURSOR_PREFIX = "meeting-minutes:transcription-job:v1:";
const SELECTED_TRANSCRIPTION_SESSION_KEY =
  "meeting-minutes:transcription-job-session:v1";
const TRANSCRIPTION_POLL_INTERVAL_MS = 3_000;
const TERMINAL_LOOKUP_ERROR_CODES = new Set([
  "MEETING_TRANSCRIPTION_JOB_NOT_FOUND",
  "MEETING_RECORDING_OWNER_REQUIRED",
]);

export function parseMeetingTranscriptionCursor(
  raw: string | null
): MeetingTranscriptionCursor | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<MeetingTranscriptionCursor>;
    if (
      typeof value.sessionId !== "string" ||
      value.sessionId.length === 0 ||
      !(
        value.jobId === null ||
        (typeof value.jobId === "string" && value.jobId.length > 0)
      )
    ) {
      return null;
    }
    return { sessionId: value.sessionId, jobId: value.jobId };
  } catch {
    return null;
  }
}

const cursorStore = createMeetingJobCursorStore({
  cursorPrefix: TRANSCRIPTION_CURSOR_PREFIX,
  selectedSessionKey: SELECTED_TRANSCRIPTION_SESSION_KEY,
  parse: parseMeetingTranscriptionCursor,
});

export function readMeetingTranscriptionCursor(
  localStorage: MeetingJobStorageLike | null = getMeetingBrowserStorage("localStorage"),
  sessionStorage: MeetingJobStorageLike | null = getMeetingBrowserStorage("sessionStorage")
): MeetingTranscriptionCursor | null {
  return cursorStore.read(localStorage, sessionStorage);
}

export function persistMeetingTranscriptionCursor(
  cursor: MeetingTranscriptionCursor,
  localStorage: MeetingJobStorageLike | null = getMeetingBrowserStorage("localStorage"),
  sessionStorage: MeetingJobStorageLike | null = getMeetingBrowserStorage("sessionStorage")
): void {
  cursorStore.persist(cursor, localStorage, sessionStorage);
}

export function clearMeetingTranscriptionCursor(
  cursor: MeetingTranscriptionCursor,
  localStorage: MeetingJobStorageLike | null = getMeetingBrowserStorage("localStorage"),
  sessionStorage: MeetingJobStorageLike | null = getMeetingBrowserStorage("sessionStorage")
): void {
  cursorStore.clear(cursor, localStorage, sessionStorage);
}

export async function pollMeetingTranscriptionJob(
  cursor: MeetingTranscriptionTrackingCursor,
  deps: PollDependencies = {}
): Promise<MeetingTranscriptionPollResult> {
  return pollMeetingJob({
    cursor,
    fetchJob: deps.fetchJob ?? fetchMeetingTranscriptionJob,
    resolveErrorCode: resolveMeetingRecordingApiErrorCode,
    terminalLookupErrorCodes: TERMINAL_LOOKUP_ERROR_CODES,
    isSessionAccessTerminalErrorCode: isMeetingSessionAccessTerminalErrorCode,
    isTerminalFailure: isMeetingAiProviderChangedFailure,
    wait: deps.wait,
    isCancelled: deps.isCancelled,
    isPaused: deps.isPaused,
    onJob: deps.onJob,
    onTransientError: deps.onTransientError,
    pollIntervalMs: deps.pollIntervalMs ?? TRANSCRIPTION_POLL_INTERVAL_MS,
  });
}

type MeetingTranscriptionAction = "idle" | "enqueueing" | "retrying";
type MeetingTranscriptionFailedAction = "enqueue" | "retry";

export function useMeetingTranscriptionJob(processingJob: MeetingProcessingJob | null) {
  const [initialCursor] = useState(readMeetingTranscriptionCursor);
  const [cursor, setCursor] = useState<MeetingTranscriptionCursor | null>(initialCursor);
  const [job, setJob] = useState<MeetingTranscriptionJob | null>(null);
  const [transcriptDocument, setTranscriptDocument] =
    useState<MeetingMergedTranscriptDocument | null>(null);
  const [action, setAction] = useState<MeetingTranscriptionAction>("idle");
  const [failedAction, setFailedAction] =
    useState<MeetingTranscriptionFailedAction | null>(null);
  const [actionErrorCode, setActionErrorCode] = useState<string | null>(null);
  const [actionErrorMessage, setActionErrorMessage] = useState<string | null>(null);
  const [pollingErrorMessage, setPollingErrorMessage] = useState<string | null>(null);
  const [documentErrorMessage, setDocumentErrorMessage] = useState<string | null>(null);
  const [documentErrorCode, setDocumentErrorCode] = useState<string | null>(null);
  const [loadingDocument, setLoadingDocument] = useState(false);
  const [unknownErrorCode, setUnknownErrorCode] = useState<string | null>(null);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const enqueuePromiseRef = useRef<{
    sessionId: string;
    promise: ReturnType<typeof enqueueMeetingTranscription>;
  } | null>(null);

  const enqueueOnce = useCallback((sessionId: string) => {
    const current = enqueuePromiseRef.current;
    if (current?.sessionId === sessionId) return current.promise;
    const promise = enqueueMeetingTranscription(sessionId);
    enqueuePromiseRef.current = { sessionId, promise };
    const clear = () => {
      if (enqueuePromiseRef.current?.promise === promise) {
        enqueuePromiseRef.current = null;
      }
    };
    void promise.then(clear, clear);
    return promise;
  }, []);

  const loadDocument = useCallback(async (readyJob: MeetingTranscriptionJob) => {
    const artifact = readyJob.artifacts.find(
      (candidate) => candidate.type === "transcript-merged-json"
    );
    if (!artifact) {
      setTranscriptDocument(null);
      setDocumentErrorMessage("MEETING_TRANSCRIPTION_MERGED_ARTIFACT_MISSING");
      setDocumentErrorCode("MEETING_TRANSCRIPTION_MERGED_ARTIFACT_MISSING");
      return;
    }
    setLoadingDocument(true);
    setDocumentErrorMessage(null);
    setDocumentErrorCode(null);
    try {
      setTranscriptDocument(await fetchMeetingMergedTranscript(artifact));
    } catch (error) {
      setTranscriptDocument(null);
      setDocumentErrorCode(resolveMeetingRecordingApiErrorCode(error));
      setDocumentErrorMessage(resolveMeetingRecordingApiError(error) ?? "");
    } finally {
      setLoadingDocument(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const readyProcessingSessionId =
      processingJob?.status === "ready" ? processingJob.sessionId : null;
    const targetCursor =
      cursor &&
      (!readyProcessingSessionId || cursor.sessionId === readyProcessingSessionId)
        ? cursor
        : null;
    const enqueueSessionId =
      targetCursor?.jobId === null
        ? targetCursor.sessionId
        : readyProcessingSessionId && !targetCursor
          ? readyProcessingSessionId
          : null;

    if (enqueueSessionId) {
      if (!targetCursor) {
        const awaitingCursor = { sessionId: enqueueSessionId, jobId: null };
        persistMeetingTranscriptionCursor(awaitingCursor);
      }
      setJob(null);
      setTranscriptDocument(null);
      setDocumentErrorMessage(null);
      setDocumentErrorCode(null);
      setUnknownErrorCode(null);
      setPollingErrorMessage(null);
      setFailedAction(null);
      setActionErrorCode(null);
      setActionErrorMessage(null);
      setAction("enqueueing");
      void enqueueOnce(enqueueSessionId)
        .then(({ job: acceptedJob }) => {
          if (cancelled) return;
          const nextCursor = {
            sessionId: acceptedJob.sessionId,
            jobId: acceptedJob.jobId,
          };
          persistMeetingTranscriptionCursor(nextCursor);
          setJob(acceptedJob);
          setCursor(nextCursor);
          setFailedAction(null);
          setAction("idle");
        })
        .catch((error) => {
          if (cancelled) return;
          setAction("idle");
          setFailedAction("enqueue");
          setActionErrorCode(resolveMeetingRecordingApiErrorCode(error));
          setActionErrorMessage(resolveMeetingRecordingApiError(error));
        });
      return () => {
        cancelled = true;
      };
    }

    if (!targetCursor || targetCursor.jobId === null) return;
    const trackingCursor: MeetingTranscriptionTrackingCursor = {
      sessionId: targetCursor.sessionId,
      jobId: targetCursor.jobId,
    };
    setUnknownErrorCode(null);
    void pollMeetingTranscriptionJob(trackingCursor, {
      isCancelled: () => cancelled,
      isPaused: () => document.hidden,
      onJob: (nextJob) => {
        if (!cancelled) {
          setJob(nextJob);
          setFailedAction(null);
          setActionErrorCode(null);
          setActionErrorMessage(null);
        }
      },
      onTransientError: (error) => {
        if (!cancelled) {
          setPollingErrorMessage(
            error ? (resolveMeetingRecordingApiError(error) ?? "") : null
          );
        }
      },
    }).then((result) => {
      if (cancelled) return;
      if (result.kind === "ready") {
        clearMeetingTranscriptionCursor(trackingCursor);
        setPollingErrorMessage(null);
        void loadDocument(result.job);
      } else if (result.kind === "unknown") {
        clearMeetingTranscriptionCursor(trackingCursor);
        if (isMeetingSessionAccessTerminalErrorCode(result.errorCode)) {
          persistMeetingSessionCapability(trackingCursor.sessionId, null);
        }
        setUnknownErrorCode(result.errorCode);
        setPollingErrorMessage(null);
        setActionErrorCode(null);
        setActionErrorMessage(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [cursor, enqueueOnce, loadDocument, processingJob, refreshGeneration]);

  const retry = useCallback(async (): Promise<void> => {
    if (!canRetryMeetingAiJob(job)) return;
    setAction("retrying");
    setFailedAction(null);
    setActionErrorCode(null);
    setActionErrorMessage(null);
    setPollingErrorMessage(null);
    setTranscriptDocument(null);
    setDocumentErrorMessage(null);
    setDocumentErrorCode(null);
    setUnknownErrorCode(null);
    try {
      const retried = await retryMeetingTranscriptionJob(job.sessionId, job.jobId);
      const nextCursor = { sessionId: retried.sessionId, jobId: retried.jobId };
      persistMeetingTranscriptionCursor(nextCursor);
      setCursor(nextCursor);
      setJob(retried);
      setRefreshGeneration((value) => value + 1);
    } catch (error) {
      const errorCode = resolveMeetingRecordingApiErrorCode(error);
      setFailedAction("retry");
      setActionErrorCode(errorCode);
      setActionErrorMessage(resolveMeetingRecordingApiError(error));
      if (!isMeetingSessionAccessTerminalErrorCode(errorCode)) {
        setRefreshGeneration((value) => value + 1);
      }
    } finally {
      setAction("idle");
    }
  }, [job]);

  const retryEnqueue = useCallback(() => {
    setFailedAction(null);
    setActionErrorCode(null);
    setActionErrorMessage(null);
    setRefreshGeneration((value) => value + 1);
  }, []);

  const retryDocument = useCallback(() => {
    if (job?.status === "ready") void loadDocument(job);
  }, [job, loadDocument]);

  const resetForAccessRecovery = useCallback(() => {
    const sessionId = cursor?.sessionId ?? job?.sessionId ?? processingJob?.sessionId ?? null;
    if (sessionId) {
      clearMeetingTranscriptionCursor({ sessionId, jobId: null });
      persistMeetingSessionCapability(sessionId, null);
    }
    setCursor(null);
    setJob(null);
    setTranscriptDocument(null);
    setAction("idle");
    setFailedAction(null);
    setActionErrorCode(null);
    setActionErrorMessage(null);
    setPollingErrorMessage(null);
    setDocumentErrorCode(null);
    setDocumentErrorMessage(null);
    setLoadingDocument(false);
    setUnknownErrorCode(null);
  }, [cursor?.sessionId, job?.sessionId, processingJob?.sessionId]);

  return {
    job,
    document: transcriptDocument,
    action,
    hasCursor: Boolean(cursor),
    enqueueing: action === "enqueueing",
    retrying: action === "retrying",
    loadingDocument,
    unknown: unknownErrorCode !== null,
    authorizationRequired:
      isMeetingSessionAccessTerminalErrorCode(unknownErrorCode) ||
      isMeetingSessionAccessTerminalErrorCode(actionErrorCode) ||
      isMeetingSessionAccessTerminalErrorCode(documentErrorCode),
    providerDisabled:
      actionErrorCode === "MEETING_TRANSCRIPTION_PROVIDER_DISABLED",
    actionFailed: failedAction !== null,
    failedAction,
    actionErrorCode,
    actionErrorMessage,
    pollingErrorMessage,
    documentErrorMessage,
    canRetry: Boolean(
      canRetryMeetingAiJob(job) && action === "idle"
    ),
    retry,
    retryEnqueue,
    retryDocument,
    resetForAccessRecovery,
  };
}

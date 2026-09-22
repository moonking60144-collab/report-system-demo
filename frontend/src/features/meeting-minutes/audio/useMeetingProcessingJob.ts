import { useCallback, useEffect, useRef, useState } from "react";
import {
  enqueueMeetingRecordingProcessing,
  fetchMeetingProcessingJob,
  isMeetingSessionAccessTerminalErrorCode,
  persistMeetingSessionCapability,
  resolveMeetingRecordingApiError,
  resolveMeetingRecordingApiErrorCode,
  retryMeetingProcessingJob,
  type MeetingProcessingJob,
  type MeetingRecordingSession,
} from "../api/meetingRecordingApi";
import {
  createMeetingJobCursorStore,
  getMeetingBrowserStorage,
  pollMeetingJob,
  type MeetingJobPollResult,
  type MeetingJobStorageLike,
} from "./meetingJobTracking";

export interface MeetingProcessingCursor {
  sessionId: string;
  jobId: string | null;
}

interface MeetingProcessingTrackingCursor extends MeetingProcessingCursor {
  jobId: string;
}

export type MeetingProcessingPollResult = MeetingJobPollResult<MeetingProcessingJob>;

interface PollDependencies {
  fetchJob?: typeof fetchMeetingProcessingJob;
  wait?: (delayMs: number) => Promise<void>;
  isCancelled?: () => boolean;
  isPaused?: () => boolean;
  onJob?: (job: MeetingProcessingJob) => void;
  onTransientError?: (error: unknown | null) => void;
  pollIntervalMs?: number;
}

const PROCESSING_CURSOR_PREFIX = "meeting-minutes:processing-job:v1:";
const SELECTED_PROCESSING_SESSION_KEY = "meeting-minutes:processing-job-session:v1";
const PROCESSING_POLL_INTERVAL_MS = 3_000;
const PROCESSING_ARTIFACT_EVICTED_ERROR_CODE =
  "MEETING_PROCESSING_ARTIFACT_EVICTED";
const TERMINAL_LOOKUP_ERROR_CODES = new Set([
  "MEETING_PROCESSING_JOB_NOT_FOUND",
  "MEETING_RECORDING_OWNER_REQUIRED",
]);

export function parseMeetingProcessingCursor(raw: string | null): MeetingProcessingCursor | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<MeetingProcessingCursor>;
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
  cursorPrefix: PROCESSING_CURSOR_PREFIX,
  selectedSessionKey: SELECTED_PROCESSING_SESSION_KEY,
  parse: parseMeetingProcessingCursor,
});

export function readMeetingProcessingCursor(
  localStorage: MeetingJobStorageLike | null = getMeetingBrowserStorage("localStorage"),
  sessionStorage: MeetingJobStorageLike | null = getMeetingBrowserStorage("sessionStorage")
): MeetingProcessingCursor | null {
  return cursorStore.read(localStorage, sessionStorage);
}

export function persistMeetingProcessingCursor(
  cursor: MeetingProcessingCursor,
  localStorage: MeetingJobStorageLike | null = getMeetingBrowserStorage("localStorage"),
  sessionStorage: MeetingJobStorageLike | null = getMeetingBrowserStorage("sessionStorage")
): void {
  cursorStore.persist(cursor, localStorage, sessionStorage);
}

export function persistMeetingProcessingAwaitingEnqueue(
  sessionId: string,
  localStorage: MeetingJobStorageLike | null = getMeetingBrowserStorage("localStorage"),
  sessionStorage: MeetingJobStorageLike | null = getMeetingBrowserStorage("sessionStorage")
): void {
  persistMeetingProcessingCursor({ sessionId, jobId: null }, localStorage, sessionStorage);
}

export function clearMeetingProcessingCursor(
  cursor: MeetingProcessingCursor,
  localStorage: MeetingJobStorageLike | null = getMeetingBrowserStorage("localStorage"),
  sessionStorage: MeetingJobStorageLike | null = getMeetingBrowserStorage("sessionStorage")
): void {
  cursorStore.clear(cursor, localStorage, sessionStorage);
}

export async function pollMeetingProcessingJob(
  cursor: MeetingProcessingTrackingCursor,
  deps: PollDependencies = {}
): Promise<MeetingProcessingPollResult> {
  return pollMeetingJob({
    cursor,
    fetchJob: deps.fetchJob ?? fetchMeetingProcessingJob,
    resolveErrorCode: resolveMeetingRecordingApiErrorCode,
    terminalLookupErrorCodes: TERMINAL_LOOKUP_ERROR_CODES,
    isSessionAccessTerminalErrorCode: isMeetingSessionAccessTerminalErrorCode,
    isTerminalFailure: (job) =>
      job.errorCode === PROCESSING_ARTIFACT_EVICTED_ERROR_CODE,
    wait: deps.wait,
    isCancelled: deps.isCancelled,
    isPaused: deps.isPaused,
    onJob: deps.onJob,
    onTransientError: deps.onTransientError,
    pollIntervalMs: deps.pollIntervalMs ?? PROCESSING_POLL_INTERVAL_MS,
  });
}

type MeetingProcessingAction = "idle" | "enqueueing" | "retrying";
type MeetingProcessingFailedAction = "enqueue" | "retry";

export function useMeetingProcessingJob(savedSession: MeetingRecordingSession | null) {
  const [initialCursor] = useState(readMeetingProcessingCursor);
  const [cursor, setCursor] = useState<MeetingProcessingCursor | null>(initialCursor);
  const [job, setJob] = useState<MeetingProcessingJob | null>(null);
  const [action, setAction] = useState<MeetingProcessingAction>("idle");
  const [failedAction, setFailedAction] = useState<MeetingProcessingFailedAction | null>(null);
  const [actionErrorCode, setActionErrorCode] = useState<string | null>(null);
  const [actionErrorMessage, setActionErrorMessage] = useState<string | null>(null);
  const [pollingErrorMessage, setPollingErrorMessage] = useState<string | null>(null);
  const [unknownErrorCode, setUnknownErrorCode] = useState<string | null>(null);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const enqueuePromiseRef = useRef<{
    sessionId: string;
    promise: ReturnType<typeof enqueueMeetingRecordingProcessing>;
  } | null>(null);

  const enqueueOnce = useCallback((sessionId: string) => {
    const current = enqueuePromiseRef.current;
    if (current?.sessionId === sessionId) return current.promise;
    const promise = enqueueMeetingRecordingProcessing(sessionId);
    enqueuePromiseRef.current = { sessionId, promise };
    const clear = () => {
      if (enqueuePromiseRef.current?.promise === promise) enqueuePromiseRef.current = null;
    };
    void promise.then(clear, clear);
    return promise;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const savedSessionId = savedSession?.sessionId ?? null;
    const targetCursor =
      cursor && (!savedSessionId || cursor.sessionId === savedSessionId) ? cursor : null;
    const enqueueSessionId =
      targetCursor?.jobId === null
        ? targetCursor.sessionId
        : savedSessionId && !targetCursor
          ? savedSessionId
          : null;

    if (enqueueSessionId) {
      if (!targetCursor) persistMeetingProcessingAwaitingEnqueue(enqueueSessionId);
      setJob(null);
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
          persistMeetingProcessingCursor(nextCursor);
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
    const trackingCursor: MeetingProcessingTrackingCursor = {
      sessionId: targetCursor.sessionId,
      jobId: targetCursor.jobId,
    };
    setUnknownErrorCode(null);
    void pollMeetingProcessingJob(trackingCursor, {
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
        clearMeetingProcessingCursor(trackingCursor);
        setPollingErrorMessage(null);
      } else if (result.kind === "unknown") {
        clearMeetingProcessingCursor(trackingCursor);
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
  }, [cursor, enqueueOnce, refreshGeneration, savedSession?.sessionId]);

  const retry = useCallback(async (): Promise<void> => {
    if (!job || job.status !== "failed" || job.attemptCount >= job.maxAttempts) return;
    setAction("retrying");
    setFailedAction(null);
    setActionErrorCode(null);
    setActionErrorMessage(null);
    setPollingErrorMessage(null);
    setUnknownErrorCode(null);
    try {
      const retried = await retryMeetingProcessingJob(job.sessionId, job.jobId);
      const nextCursor = { sessionId: retried.sessionId, jobId: retried.jobId };
      persistMeetingProcessingCursor(nextCursor);
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

  const resetForAccessRecovery = useCallback(() => {
    const sessionId = cursor?.sessionId ?? job?.sessionId ?? savedSession?.sessionId ?? null;
    if (sessionId) {
      clearMeetingProcessingCursor({ sessionId, jobId: null });
      persistMeetingSessionCapability(sessionId, null);
    }
    setCursor(null);
    setJob(null);
    setAction("idle");
    setFailedAction(null);
    setActionErrorCode(null);
    setActionErrorMessage(null);
    setPollingErrorMessage(null);
    setUnknownErrorCode(null);
  }, [cursor?.sessionId, job?.sessionId, savedSession?.sessionId]);

  return {
    job,
    action,
    hasCursor: Boolean(cursor),
    enqueueing: action === "enqueueing",
    retrying: action === "retrying",
    unknown: unknownErrorCode !== null,
    authorizationRequired:
      isMeetingSessionAccessTerminalErrorCode(unknownErrorCode) ||
      isMeetingSessionAccessTerminalErrorCode(actionErrorCode),
    actionFailed: failedAction !== null,
    failedAction,
    actionErrorCode,
    actionErrorMessage,
    pollingErrorMessage,
    canRetry: Boolean(
      job?.status === "failed" && job.attemptCount < job.maxAttempts && action === "idle"
    ),
    retry,
    retryEnqueue,
    resetForAccessRecovery,
  };
}

import { useCallback, useEffect, useRef, useState } from "react";
import {
  enqueueMeetingMinutes,
  fetchMeetingMinutesJob,
  fetchMeetingMinutesVersions,
  isMeetingSessionAccessTerminalErrorCode,
  persistMeetingSessionCapability,
  resolveMeetingRecordingApiError,
  resolveMeetingRecordingApiErrorCode,
  retryMeetingMinutesJob,
  type MeetingMinutesAcceptedResult,
  type MeetingMinutesHumanInput,
  type MeetingMinutesJob,
  type MeetingMinutesVersion,
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

export interface MeetingMinutesCursor {
  sessionId: string;
  jobId: string | null;
  clientRequestKey: string;
  humanInput: MeetingMinutesHumanInput;
}

interface PollDependencies {
  fetchJob?: typeof fetchMeetingMinutesJob;
  wait?: (delayMs: number) => Promise<void>;
  isCancelled?: () => boolean;
  isPaused?: () => boolean;
  onJob?: (job: MeetingMinutesJob) => void;
  onTransientError?: (error: unknown | null) => void;
  pollIntervalMs?: number;
}

export type MeetingMinutesPollResult = MeetingJobPollResult<MeetingMinutesJob>;

const CURSOR_PREFIX = "meeting-minutes:generation-job:v1:";
const SELECTED_SESSION_KEY = "meeting-minutes:generation-job-session:v1";
const POLL_INTERVAL_MS = 3_000;
const TERMINAL_LOOKUP_ERROR_CODES = new Set([
  "MEETING_MINUTES_JOB_NOT_FOUND",
  "MEETING_RECORDING_OWNER_REQUIRED",
]);

function isHumanInput(value: unknown): value is MeetingMinutesHumanInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return (
    typeof input.title === "string" &&
    input.title.length > 0 &&
    (input.date === null || typeof input.date === "string") &&
    typeof input.attendees === "string" &&
    typeof input.confirmedFacts === "string" &&
    typeof input.confirmedDecisions === "string" &&
    typeof input.termCorrections === "string" &&
    typeof input.otherNotes === "string"
  );
}

export function parseMeetingMinutesCursor(raw: string | null): MeetingMinutesCursor | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<MeetingMinutesCursor>;
    if (
      typeof value.sessionId !== "string" ||
      !value.sessionId ||
      !(value.jobId === null || (typeof value.jobId === "string" && value.jobId)) ||
      typeof value.clientRequestKey !== "string" ||
      !value.clientRequestKey ||
      !isHumanInput(value.humanInput)
    ) {
      return null;
    }
    return {
      sessionId: value.sessionId,
      jobId: value.jobId,
      clientRequestKey: value.clientRequestKey,
      humanInput: value.humanInput,
    };
  } catch {
    return null;
  }
}

const cursorStore = createMeetingJobCursorStore({
  cursorPrefix: CURSOR_PREFIX,
  selectedSessionKey: SELECTED_SESSION_KEY,
  parse: parseMeetingMinutesCursor,
});

export function readMeetingMinutesCursor(
  localStorage: MeetingJobStorageLike | null = getMeetingBrowserStorage("localStorage"),
  sessionStorage: MeetingJobStorageLike | null = getMeetingBrowserStorage("sessionStorage")
): MeetingMinutesCursor | null {
  return cursorStore.read(localStorage, sessionStorage);
}

export function persistMeetingMinutesCursor(
  cursor: MeetingMinutesCursor,
  localStorage: MeetingJobStorageLike | null = getMeetingBrowserStorage("localStorage"),
  sessionStorage: MeetingJobStorageLike | null = getMeetingBrowserStorage("sessionStorage")
): void {
  cursorStore.persist(cursor, localStorage, sessionStorage);
}

export function clearMeetingMinutesCursor(
  cursor: Pick<MeetingMinutesCursor, "sessionId">,
  localStorage: MeetingJobStorageLike | null = getMeetingBrowserStorage("localStorage"),
  sessionStorage: MeetingJobStorageLike | null = getMeetingBrowserStorage("sessionStorage")
): void {
  cursorStore.clear(cursor, localStorage, sessionStorage);
}

export async function pollMeetingMinutesJob(
  cursor: Pick<MeetingMinutesCursor, "sessionId" | "jobId"> & { jobId: string },
  deps: PollDependencies = {}
): Promise<MeetingMinutesPollResult> {
  return pollMeetingJob({
    cursor,
    fetchJob: deps.fetchJob ?? fetchMeetingMinutesJob,
    resolveErrorCode: resolveMeetingRecordingApiErrorCode,
    terminalLookupErrorCodes: TERMINAL_LOOKUP_ERROR_CODES,
    isSessionAccessTerminalErrorCode: isMeetingSessionAccessTerminalErrorCode,
    isTerminalFailure: isMeetingAiProviderChangedFailure,
    wait: deps.wait,
    isCancelled: deps.isCancelled,
    isPaused: deps.isPaused,
    onJob: deps.onJob,
    onTransientError: deps.onTransientError,
    pollIntervalMs: deps.pollIntervalMs ?? POLL_INTERVAL_MS,
  });
}

export function createMeetingMinutesEnqueueGate(
  enqueue: typeof enqueueMeetingMinutes = enqueueMeetingMinutes
): (input: Parameters<typeof enqueueMeetingMinutes>[0]) => Promise<MeetingMinutesAcceptedResult> {
  let current: { key: string; promise: Promise<MeetingMinutesAcceptedResult> } | null = null;
  return (input) => {
    if (current?.key === input.clientRequestKey) return current.promise;
    const promise = enqueue(input);
    current = { key: input.clientRequestKey, promise };
    const clear = () => {
      if (current?.promise === promise) current = null;
    };
    void promise.then(clear, clear);
    return promise;
  };
}

function requestKey(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

type Action = "idle" | "enqueueing" | "retrying" | "loading-versions";
type FailedAction = "enqueue" | "retry" | "versions";

export function useMeetingMinutesJob(transcriptionJob: MeetingTranscriptionJob | null) {
  const [initialCursor] = useState(readMeetingMinutesCursor);
  const [cursor, setCursor] = useState<MeetingMinutesCursor | null>(initialCursor);
  const [job, setJob] = useState<MeetingMinutesJob | null>(null);
  const [versions, setVersions] = useState<MeetingMinutesVersion[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [action, setAction] = useState<Action>("idle");
  const [failedAction, setFailedAction] = useState<FailedAction | null>(null);
  const [actionErrorCode, setActionErrorCode] = useState<string | null>(null);
  const [actionErrorMessage, setActionErrorMessage] = useState<string | null>(null);
  const [pollingErrorMessage, setPollingErrorMessage] = useState<string | null>(null);
  const [unknownErrorCode, setUnknownErrorCode] = useState<string | null>(null);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const submitLockedRef = useRef(false);
  const enqueueOnceRef = useRef(createMeetingMinutesEnqueueGate());

  const loadVersions = useCallback(async (sessionId: string) => {
    setAction((current) => (current === "idle" ? "loading-versions" : current));
    try {
      const next = await fetchMeetingMinutesVersions(sessionId);
      setVersions(next);
      setSelectedVersionId((current) =>
        current && next.some((version) => version.versionId === current)
          ? current
          : (next[0]?.versionId ?? null)
      );
      setFailedAction(null);
    } catch (error) {
      setFailedAction("versions");
      setActionErrorCode(resolveMeetingRecordingApiErrorCode(error));
      setActionErrorMessage(resolveMeetingRecordingApiError(error));
    } finally {
      setAction((current) => (current === "loading-versions" ? "idle" : current));
    }
  }, []);

  useEffect(() => {
    const sessionId = transcriptionJob?.status === "ready" ? transcriptionJob.sessionId : null;
    if (sessionId) void loadVersions(sessionId);
  }, [loadVersions, transcriptionJob?.sessionId, transcriptionJob?.status]);

  useEffect(() => {
    let cancelled = false;
    const readySessionId =
      transcriptionJob?.status === "ready" ? transcriptionJob.sessionId : null;
    const target = cursor && (!readySessionId || cursor.sessionId === readySessionId) ? cursor : null;
    if (!target) return;

    if (target.jobId === null) {
      setAction("enqueueing");
      setFailedAction(null);
      setUnknownErrorCode(null);
      void enqueueOnceRef.current({
        sessionId: target.sessionId,
        clientRequestKey: target.clientRequestKey,
        humanInput: target.humanInput,
      })
        .then(({ job: accepted }) => {
          if (cancelled) return;
          const next = { ...target, jobId: accepted.jobId };
          persistMeetingMinutesCursor(next);
          setCursor(next);
          setJob(accepted);
          setAction("idle");
          submitLockedRef.current = false;
        })
        .catch((error) => {
          if (cancelled) return;
          setFailedAction("enqueue");
          setActionErrorCode(resolveMeetingRecordingApiErrorCode(error));
          setActionErrorMessage(resolveMeetingRecordingApiError(error));
          setAction("idle");
          submitLockedRef.current = false;
        });
      return () => {
        cancelled = true;
      };
    }

    setUnknownErrorCode(null);
    void pollMeetingMinutesJob(
      { sessionId: target.sessionId, jobId: target.jobId },
      {
        isCancelled: () => cancelled,
        isPaused: () => document.hidden,
        onJob: (next) => {
          if (!cancelled) {
            setJob(next);
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
      }
    ).then((result) => {
      if (cancelled) return;
      if (result.kind === "ready") {
        clearMeetingMinutesCursor(target);
        setCursor(null);
        setPollingErrorMessage(null);
        if (result.job.version) {
          const readyVersion = result.job.version;
          setVersions((current) => [
            readyVersion,
            ...current.filter((version) => version.versionId !== readyVersion.versionId),
          ]);
          setSelectedVersionId(readyVersion.versionId);
        }
        void loadVersions(result.job.sessionId);
      } else if (result.kind === "failed") {
        clearMeetingMinutesCursor(target);
        setCursor(null);
        setPollingErrorMessage(null);
      } else if (result.kind === "unknown") {
        clearMeetingMinutesCursor(target);
        setCursor(null);
        if (isMeetingSessionAccessTerminalErrorCode(result.errorCode)) {
          persistMeetingSessionCapability(target.sessionId, null);
        }
        setUnknownErrorCode(result.errorCode);
        setPollingErrorMessage(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [cursor, loadVersions, refreshGeneration, transcriptionJob?.sessionId, transcriptionJob?.status]);

  const submit = useCallback(
    (humanInput: MeetingMinutesHumanInput): boolean => {
      if (
        submitLockedRef.current ||
        cursor !== null ||
        transcriptionJob?.status !== "ready"
      ) {
        return false;
      }
      submitLockedRef.current = true;
      const next: MeetingMinutesCursor = {
        sessionId: transcriptionJob.sessionId,
        jobId: null,
        clientRequestKey: requestKey(),
        humanInput,
      };
      persistMeetingMinutesCursor(next);
      setJob(null);
      setCursor(next);
      setFailedAction(null);
      setActionErrorCode(null);
      setActionErrorMessage(null);
      setPollingErrorMessage(null);
      setUnknownErrorCode(null);
      return true;
    },
    [cursor, transcriptionJob]
  );

  const retry = useCallback(async () => {
    if (!canRetryMeetingAiJob(job)) return;
    setAction("retrying");
    setFailedAction(null);
    try {
      const retried = await retryMeetingMinutesJob(job.sessionId, job.jobId);
      const next: MeetingMinutesCursor = {
        sessionId: retried.sessionId,
        jobId: retried.jobId,
        clientRequestKey: retried.clientRequestKey,
        humanInput: retried.input,
      };
      persistMeetingMinutesCursor(next);
      setCursor(next);
      setJob(retried);
      setRefreshGeneration((value) => value + 1);
    } catch (error) {
      setFailedAction("retry");
      setActionErrorCode(resolveMeetingRecordingApiErrorCode(error));
      setActionErrorMessage(resolveMeetingRecordingApiError(error));
    } finally {
      setAction("idle");
    }
  }, [job]);

  const retryEnqueue = useCallback(() => {
    if (!cursor || cursor.jobId !== null) return;
    setFailedAction(null);
    setActionErrorCode(null);
    setActionErrorMessage(null);
    setRefreshGeneration((value) => value + 1);
  }, [cursor]);

  const resetForAccessRecovery = useCallback(() => {
    const sessionId = cursor?.sessionId ?? job?.sessionId ?? transcriptionJob?.sessionId ?? null;
    if (sessionId) {
      clearMeetingMinutesCursor({ sessionId });
      persistMeetingSessionCapability(sessionId, null);
    }
    setCursor(null);
    setJob(null);
    setVersions([]);
    setSelectedVersionId(null);
    setAction("idle");
    setFailedAction(null);
    setActionErrorCode(null);
    setActionErrorMessage(null);
    setPollingErrorMessage(null);
    setUnknownErrorCode(null);
    submitLockedRef.current = false;
  }, [cursor?.sessionId, job?.sessionId, transcriptionJob?.sessionId]);

  const selectedVersion =
    versions.find((version) => version.versionId === selectedVersionId) ?? null;

  return {
    job,
    versions,
    selectedVersion,
    selectedVersionId,
    setSelectedVersionId,
    action,
    enqueueing: action === "enqueueing",
    retrying: action === "retrying",
    loadingVersions: action === "loading-versions",
    hasCursor: Boolean(cursor),
    unknown: unknownErrorCode !== null,
    authorizationRequired:
      isMeetingSessionAccessTerminalErrorCode(unknownErrorCode) ||
      isMeetingSessionAccessTerminalErrorCode(actionErrorCode),
    failedAction,
    actionErrorCode,
    actionErrorMessage,
    pollingErrorMessage,
    providerDisabled: actionErrorCode === "MEETING_MINUTES_PROVIDER_DISABLED",
    canRetry: Boolean(
      canRetryMeetingAiJob(job) && action === "idle"
    ),
    submit,
    retry,
    retryEnqueue,
    resetForAccessRecovery,
    refreshVersions: () =>
      transcriptionJob?.status === "ready"
        ? loadVersions(transcriptionJob.sessionId)
        : Promise.resolve(),
  };
}

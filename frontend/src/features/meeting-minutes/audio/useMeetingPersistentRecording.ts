import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  abortMeetingRecordingSession,
  createMeetingRecordingSession,
  finalizeMeetingRecordingSession,
  isMeetingSessionAccessTerminalErrorCode,
  persistMeetingSessionCapability,
  readMeetingSessionCapability,
  resolveMeetingRecordingApiError,
  resolveMeetingRecordingApiErrorCode,
  uploadMeetingRecordingChunk,
  type MeetingLibraryCodeResult,
  type MeetingRecordingSession,
} from "../api/meetingRecordingApi";
import { selectMeetingRecordingMimeType } from "./meetingAudioSupport";
import { persistMeetingProcessingAwaitingEnqueue } from "./useMeetingProcessingJob";
import type { MeetingAudioSourceId } from "./useMeetingAudioCheck";

export type MeetingPersistentRecordingPhase =
  | "idle"
  | "starting"
  | "recording"
  | "stopping"
  | "saved"
  | "failed";

export type MeetingPersistentRecordingIssue =
  | "source-required"
  | "create-failed"
  | "recording-failed"
  | "upload-failed"
  | "finalize-failed";

export function isMeetingSessionCapabilityTerminalErrorCode(
  code: string | null
): boolean {
  return isMeetingSessionAccessTerminalErrorCode(code);
}

interface FailedChunk {
  sequence: number;
  blob: Blob;
}

interface PersistentRecorderTrack {
  sourceId: MeetingAudioSourceId;
  recorder: MediaRecorder;
  mimeType: string;
  nextSequence: number;
  uploadChain: Promise<void>;
  failedChunks: Map<number, FailedChunk>;
  expectedStop: boolean;
  stopped: boolean;
  stoppedPromise: Promise<void>;
  resolveStopped: () => void;
}

interface ActivePersistentRecording {
  sessionId: string;
  startedAtMs: number;
  tracks: PersistentRecorderTrack[];
  elapsedTimer: number | null;
  stopPromise: Promise<void> | null;
  failureIssue: MeetingPersistentRecordingIssue | null;
}

interface PendingFinalizeRequest {
  sessionId: string;
  durationMs: number;
  tracks: Array<{ sourceId: MeetingAudioSourceId; chunkCount: number }>;
  requiresSessionCapability?: boolean;
}

interface PersistentRecordingDeps {
  getConnectedStreams: () => Array<{ sourceId: MeetingAudioSourceId; stream: MediaStream }>;
}

const CHUNK_TIMESLICE_MS = 5_000;
const UPLOAD_RETRY_DELAYS_MS = [400, 1_200, 2_500] as const;
const LEGACY_PENDING_FINALIZE_STORAGE_KEY = "meeting-minutes:pending-finalize:v1";
const PENDING_FINALIZE_STORAGE_PREFIX = "meeting-minutes:pending-finalize:v2:";
const SELECTED_PENDING_FINALIZE_SESSION_KEY =
  "meeting-minutes:pending-finalize-session:v1";
const NO_PENDING_FINALIZE_SESSION = "none";

function isPendingFinalizeRequest(value: unknown): value is PendingFinalizeRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PendingFinalizeRequest>;
  return (
    typeof candidate.sessionId === "string" &&
    Number.isFinite(candidate.durationMs) &&
    candidate.durationMs! > 0 &&
    (candidate.requiresSessionCapability === undefined ||
      typeof candidate.requiresSessionCapability === "boolean") &&
    Array.isArray(candidate.tracks) &&
    candidate.tracks.length > 0 &&
    candidate.tracks.every(
      (track) =>
        (track.sourceId === "room-mic" || track.sourceId === "remote-tab") &&
        Number.isInteger(track.chunkCount) &&
        track.chunkCount > 0
    )
  );
}

function pendingFinalizeStorageKey(sessionId: string): string {
  return `${PENDING_FINALIZE_STORAGE_PREFIX}${sessionId}`;
}

function parsePendingFinalizeRequest(raw: string | null): PendingFinalizeRequest | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPendingFinalizeRequest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readPendingFinalizeRequest(): PendingFinalizeRequest | null {
  if (typeof window === "undefined") return null;
  try {
    const legacyRaw = window.localStorage.getItem(LEGACY_PENDING_FINALIZE_STORAGE_KEY);
    if (legacyRaw) {
      const legacyRequest = parsePendingFinalizeRequest(legacyRaw);
      window.localStorage.removeItem(LEGACY_PENDING_FINALIZE_STORAGE_KEY);
      if (legacyRequest) {
        window.localStorage.setItem(
          pendingFinalizeStorageKey(legacyRequest.sessionId),
          JSON.stringify(legacyRequest)
        );
        window.sessionStorage.setItem(
          SELECTED_PENDING_FINALIZE_SESSION_KEY,
          legacyRequest.sessionId
        );
      }
    }

    const selectedSessionId = window.sessionStorage.getItem(
      SELECTED_PENDING_FINALIZE_SESSION_KEY
    );
    if (selectedSessionId === NO_PENDING_FINALIZE_SESSION) return null;
    if (selectedSessionId) {
      const selectedKey = pendingFinalizeStorageKey(selectedSessionId);
      const selectedRequest = parsePendingFinalizeRequest(
        window.localStorage.getItem(selectedKey)
      );
      if (selectedRequest) {
        if (
          selectedRequest.requiresSessionCapability &&
          !readMeetingSessionCapability(selectedRequest.sessionId)
        ) {
          window.sessionStorage.setItem(
            SELECTED_PENDING_FINALIZE_SESSION_KEY,
            NO_PENDING_FINALIZE_SESSION
          );
          return null;
        }
        return selectedRequest;
      }
      window.localStorage.removeItem(selectedKey);
      window.sessionStorage.setItem(
        SELECTED_PENDING_FINALIZE_SESSION_KEY,
        NO_PENDING_FINALIZE_SESSION
      );
      return null;
    }

    const candidateKeys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(PENDING_FINALIZE_STORAGE_PREFIX)) candidateKeys.push(key);
    }
    candidateKeys.sort();
    for (const key of candidateKeys) {
      const request = parsePendingFinalizeRequest(window.localStorage.getItem(key));
      if (!request) {
        window.localStorage.removeItem(key);
        continue;
      }
      if (
        request.requiresSessionCapability &&
        !readMeetingSessionCapability(request.sessionId)
      ) {
        continue;
      }
      window.sessionStorage.setItem(SELECTED_PENDING_FINALIZE_SESSION_KEY, request.sessionId);
      return request;
    }
    window.sessionStorage.setItem(
      SELECTED_PENDING_FINALIZE_SESSION_KEY,
      NO_PENDING_FINALIZE_SESSION
    );
  } catch {
    // Web Storage 不可用時仍保留目前頁面的記憶體重試能力。
  }
  return null;
}

function persistPendingFinalizeRequest(
  request: PendingFinalizeRequest | null,
  previousSessionId: string | null
): void {
  if (typeof window === "undefined") return;
  try {
    if (request) {
      window.localStorage.setItem(
        pendingFinalizeStorageKey(request.sessionId),
        JSON.stringify(request)
      );
      window.sessionStorage.setItem(SELECTED_PENDING_FINALIZE_SESSION_KEY, request.sessionId);
      return;
    }
    if (previousSessionId) {
      window.localStorage.removeItem(pendingFinalizeStorageKey(previousSessionId));
      if (
        window.sessionStorage.getItem(SELECTED_PENDING_FINALIZE_SESSION_KEY) ===
        previousSessionId
      ) {
        window.sessionStorage.setItem(
          SELECTED_PENDING_FINALIZE_SESSION_KEY,
          NO_PENDING_FINALIZE_SESSION
        );
      }
    }
  } catch {
    // Web Storage 不可用時仍保留目前頁面的記憶體重試能力。
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

export async function uploadMeetingChunkWithRetry(
  input: Parameters<typeof uploadMeetingRecordingChunk>[0],
  deps: {
    upload?: typeof uploadMeetingRecordingChunk;
    wait?: (delayMs: number) => Promise<void>;
    retryDelaysMs?: readonly number[];
  } = {}
): Promise<void> {
  const upload = deps.upload ?? uploadMeetingRecordingChunk;
  const wait = deps.wait ?? sleep;
  const retryDelaysMs = deps.retryDelaysMs ?? UPLOAD_RETRY_DELAYS_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      await upload(input);
      return;
    } catch (error) {
      lastError = error;
      const delayMs = retryDelaysMs[attempt];
      if (delayMs === undefined) break;
      await wait(delayMs);
    }
  }
  throw lastError;
}

function settleTrack(track: PersistentRecorderTrack): void {
  if (track.stopped) return;
  track.stopped = true;
  track.resolveStopped();
}

export function mergeMeetingLibraryAccessAfterCreate(
  current: MeetingLibraryCodeResult,
  created: MeetingLibraryCodeResult
): MeetingLibraryCodeResult {
  return {
    ...created,
    ownedLibrary: created.ownedLibrary ?? current.ownedLibrary ?? null,
    code:
      created.code ??
      (current.library?.libraryId === created.library?.libraryId &&
      current.library?.accessVersion === created.library?.accessVersion
        ? current.code
        : null),
  };
}

export function useMeetingPersistentRecording({ getConnectedStreams }: PersistentRecordingDeps) {
  const [initialPendingFinalize] = useState(readPendingFinalizeRequest);
  const [phase, setPhaseState] = useState<MeetingPersistentRecordingPhase>(
    initialPendingFinalize ? "failed" : "idle"
  );
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [uploadedBytes, setUploadedBytes] = useState(0);
  const [issue, setIssue] = useState<MeetingPersistentRecordingIssue | null>(
    initialPendingFinalize ? "finalize-failed" : null
  );
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [savedSession, setSavedSession] = useState<MeetingRecordingSession | null>(null);
  const [libraryAccess, setLibraryAccess] = useState<MeetingLibraryCodeResult>({
    enabled: false,
    library: null,
    code: null,
  });
  const selectedLibraryId = libraryAccess.library?.libraryId ?? null;
  const [canRetryFinalize, setCanRetryFinalize] = useState(Boolean(initialPendingFinalize));
  const phaseRef = useRef<MeetingPersistentRecordingPhase>("idle");
  const activeRef = useRef<ActivePersistentRecording | null>(null);
  const pendingFinalizeRef = useRef<PendingFinalizeRequest | null>(initialPendingFinalize);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);

  const setPhase = useCallback((nextPhase: MeetingPersistentRecordingPhase) => {
    phaseRef.current = nextPhase;
    if (mountedRef.current) setPhaseState(nextPhase);
  }, []);

  const updatePendingFinalize = useCallback((request: PendingFinalizeRequest | null) => {
    const previousSessionId = pendingFinalizeRef.current?.sessionId ?? null;
    pendingFinalizeRef.current = request;
    persistPendingFinalizeRequest(request, previousSessionId);
    if (mountedRef.current) setCanRetryFinalize(Boolean(request));
  }, []);

  const clearTerminalFinalizeState = useCallback(
    (request: PendingFinalizeRequest, errorCode: string | null) => {
      const capabilityFailure =
        isMeetingSessionCapabilityTerminalErrorCode(errorCode);
      if (errorCode !== "MEETING_RECORDING_NOT_FOUND" && !capabilityFailure) return;
      persistMeetingSessionCapability(request.sessionId, null);
      updatePendingFinalize(null);
      if (capabilityFailure && mountedRef.current) {
        setLibraryAccess({
          enabled: true,
          library: null,
          code: null,
          accessMode: "recorder",
        });
      }
    },
    [updatePendingFinalize]
  );

  const queueChunk = useCallback(
    (active: ActivePersistentRecording, track: PersistentRecorderTrack, blob: Blob) => {
      const sequence = track.nextSequence;
      track.nextSequence += 1;
      track.uploadChain = track.uploadChain.then(async () => {
        try {
          await uploadMeetingChunkWithRetry({
            sessionId: active.sessionId,
            sourceId: track.sourceId,
            sequence,
            blob,
            mimeType: track.mimeType,
          });
          track.failedChunks.delete(sequence);
          if (mountedRef.current && activeRef.current === active) {
            setUploadedBytes((value) => value + blob.size);
          }
        } catch {
          track.failedChunks.set(sequence, { sequence, blob });
          active.failureIssue = "upload-failed";
        }
      });
    },
    []
  );

  const stopRecording = useCallback(
    (markFailed = false): Promise<void> => {
      const active = activeRef.current;
      if (!active) return Promise.resolve();
      if (markFailed && !active.failureIssue) active.failureIssue = "recording-failed";
      if (active.stopPromise) return active.stopPromise;

      setPhase("stopping");
      if (active.elapsedTimer !== null) {
        window.clearInterval(active.elapsedTimer);
        active.elapsedTimer = null;
      }
      active.stopPromise = (async () => {
        active.tracks.forEach((track) => {
          track.expectedStop = true;
          if (track.recorder.state === "inactive") {
            settleTrack(track);
            return;
          }
          try {
            track.recorder.stop();
          } catch {
            active.failureIssue = "recording-failed";
            settleTrack(track);
          }
        });
        await Promise.all(active.tracks.map((track) => track.stoppedPromise));
        await Promise.all(active.tracks.map((track) => track.uploadChain));

        if (!active.failureIssue || active.failureIssue === "upload-failed") {
          for (const track of active.tracks) {
            const failedChunks = [...track.failedChunks.values()].sort(
              (left, right) => left.sequence - right.sequence
            );
            for (const failedChunk of failedChunks) {
              try {
                await uploadMeetingChunkWithRetry({
                  sessionId: active.sessionId,
                  sourceId: track.sourceId,
                  sequence: failedChunk.sequence,
                  blob: failedChunk.blob,
                  mimeType: track.mimeType,
                });
                track.failedChunks.delete(failedChunk.sequence);
                if (mountedRef.current && activeRef.current === active) {
                  setUploadedBytes((value) => value + failedChunk.blob.size);
                }
              } catch {
                active.failureIssue = "upload-failed";
                break;
              }
            }
          }
          if (active.tracks.every((track) => track.failedChunks.size === 0)) {
            active.failureIssue = null;
          }
        }

        if (active.failureIssue) {
          throw new Error(active.failureIssue);
        }
        if (active.tracks.some((track) => track.nextSequence === 0)) {
          active.failureIssue = "recording-failed";
          throw new Error("recording produced no audio chunks");
        }
        const finalizeRequest: PendingFinalizeRequest = {
          sessionId: active.sessionId,
          durationMs: Math.max(1_000, Date.now() - active.startedAtMs),
          requiresSessionCapability: Boolean(
            readMeetingSessionCapability(active.sessionId)
          ),
          tracks: active.tracks.map((track) => ({
            sourceId: track.sourceId,
            chunkCount: track.nextSequence,
          })),
        };
        updatePendingFinalize(finalizeRequest);
        let finalized: MeetingRecordingSession;
        try {
          finalized = await finalizeMeetingRecordingSession(finalizeRequest);
        } catch (error) {
          active.failureIssue = "finalize-failed";
          clearTerminalFinalizeState(
            finalizeRequest,
            resolveMeetingRecordingApiErrorCode(error)
          );
          throw error;
        }
        persistMeetingProcessingAwaitingEnqueue(finalized.sessionId);
        updatePendingFinalize(null);

        if (mountedRef.current && activeRef.current === active) {
          setSavedSession(finalized);
          setIssue(null);
          setErrorDetail(null);
          setPhase("saved");
        }
      })()
        .catch(async (error) => {
          if (active.failureIssue !== "finalize-failed") {
            try {
              await abortMeetingRecordingSession(active.sessionId);
            } catch {
              // 網路失敗時由 backend stale-session cleanup 回收未完成 session。
            }
          }
          if (mountedRef.current && activeRef.current === active) {
            const nextIssue = active.failureIssue ?? "recording-failed";
            setIssue(nextIssue);
            setErrorDetail(resolveMeetingRecordingApiError(error));
            setPhase("failed");
          }
        })
        .finally(() => {
          if (activeRef.current === active) activeRef.current = null;
        });
      return active.stopPromise;
    },
    [clearTerminalFinalizeState, setPhase, updatePendingFinalize]
  );

  const startRecording = useCallback(
    async (title: string): Promise<void> => {
      if (activeRef.current || phaseRef.current === "starting" || phaseRef.current === "stopping") {
        return;
      }
      if (pendingFinalizeRef.current) return;
      const sources = getConnectedStreams();
      if (sources.length === 0) {
        setIssue("source-required");
        setPhase("failed");
        return;
      }
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      setIssue(null);
      setErrorDetail(null);
      setSavedSession(null);
      setUploadedBytes(0);
      setElapsedSeconds(0);
      setPhase("starting");

      let session: MeetingRecordingSession;
      try {
        const created = await createMeetingRecordingSession({
          title,
          sourceIds: sources.map((source) => source.sourceId),
          libraryId: selectedLibraryId,
        });
        session = created.session;
        if (mountedRef.current && generationRef.current === generation) {
          setLibraryAccess((current) =>
            mergeMeetingLibraryAccessAfterCreate(current, created.libraryAccess)
          );
        }
      } catch (error) {
        if (mountedRef.current && generationRef.current === generation) {
          const errorCode = resolveMeetingRecordingApiErrorCode(error);
          if (
            errorCode === "MEETING_LIBRARY_RECORDER_REQUIRED" ||
            errorCode === "MEETING_LIBRARY_RECORDER_EXPIRED" ||
            errorCode === "MEETING_RECORDING_LIBRARY_SELECTION_CHANGED"
          ) {
            setLibraryAccess({
              enabled: true,
              library: null,
              code: null,
              accessMode: "recorder",
            });
          }
          setIssue("create-failed");
          setErrorDetail(resolveMeetingRecordingApiError(error));
          setPhase("failed");
        }
        return;
      }
      if (!mountedRef.current || generationRef.current !== generation) {
        void abortMeetingRecordingSession(session.sessionId).catch(() => undefined);
        return;
      }

      const mimeType = selectMeetingRecordingMimeType((candidate) =>
        MediaRecorder.isTypeSupported(candidate)
      );
      const active: ActivePersistentRecording = {
        sessionId: session.sessionId,
        startedAtMs: Date.now(),
        tracks: [],
        elapsedTimer: null,
        stopPromise: null,
        failureIssue: null,
      };
      activeRef.current = active;

      try {
        for (const source of sources) {
          const recorder = new MediaRecorder(
            new MediaStream(source.stream.getAudioTracks()),
            mimeType ? { mimeType } : undefined
          );
          let resolveStopped: () => void = () => undefined;
          const stoppedPromise = new Promise<void>((resolve) => {
            resolveStopped = resolve;
          });
          const track: PersistentRecorderTrack = {
            sourceId: source.sourceId,
            recorder,
            mimeType: recorder.mimeType || mimeType || "audio/webm",
            nextSequence: 0,
            uploadChain: Promise.resolve(),
            failedChunks: new Map(),
            expectedStop: false,
            stopped: false,
            stoppedPromise,
            resolveStopped,
          };
          active.tracks.push(track);
          recorder.addEventListener("dataavailable", (event) => {
            if (event.data.size > 0) queueChunk(active, track, event.data);
          });
          recorder.addEventListener("error", () => {
            active.failureIssue = "recording-failed";
            if (activeRef.current === active) void stopRecording(true);
          });
          recorder.addEventListener(
            "stop",
            () => {
              const unexpected = !track.expectedStop;
              settleTrack(track);
              if (unexpected && activeRef.current === active) {
                active.failureIssue = "recording-failed";
                void stopRecording(true);
              }
            },
            { once: true }
          );
          recorder.start(CHUNK_TIMESLICE_MS);
        }
      } catch {
        active.failureIssue = "recording-failed";
        await stopRecording(true);
        return;
      }

      setPhase("recording");
      active.elapsedTimer = window.setInterval(() => {
        if (mountedRef.current && activeRef.current === active) {
          setElapsedSeconds(Math.floor((Date.now() - active.startedAtMs) / 1_000));
        }
      }, 500);
    },
    [getConnectedStreams, queueChunk, selectedLibraryId, setPhase, stopRecording]
  );

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      if (activeRef.current) void stopRecording();
    };
  }, [stopRecording]);

  const retryFinalize = useCallback(async (): Promise<void> => {
    const request = pendingFinalizeRef.current;
    if (!request || activeRef.current || phaseRef.current === "stopping") return;
    setIssue(null);
    setErrorDetail(null);
    setPhase("stopping");
    try {
      const finalized = await finalizeMeetingRecordingSession(request);
      persistMeetingProcessingAwaitingEnqueue(finalized.sessionId);
      updatePendingFinalize(null);
      if (mountedRef.current) {
        setSavedSession(finalized);
        setIssue(null);
        setErrorDetail(null);
        setPhase("saved");
      }
    } catch (error) {
      clearTerminalFinalizeState(
        request,
        resolveMeetingRecordingApiErrorCode(error)
      );
      if (mountedRef.current) {
        setIssue("finalize-failed");
        setErrorDetail(resolveMeetingRecordingApiError(error));
        setPhase("failed");
      }
    }
  }, [clearTerminalFinalizeState, setPhase, updatePendingFinalize]);

  const active = phase === "starting" || phase === "recording" || phase === "stopping";
  const updateLibraryAccess = useCallback((next: MeetingLibraryCodeResult) => {
    setLibraryAccess(next);
  }, []);
  const consumeLibraryCode = useCallback(() => {
    setLibraryAccess((current) => ({ ...current, code: null }));
  }, []);
  const resetAfterAccessLoss = useCallback(
    (sessionId: string | null) => {
      generationRef.current += 1;
      if (sessionId) persistMeetingSessionCapability(sessionId, null);
      if (
        pendingFinalizeRef.current &&
        (!sessionId || pendingFinalizeRef.current.sessionId === sessionId)
      ) {
        updatePendingFinalize(null);
      }
      setSavedSession(null);
      setIssue(null);
      setErrorDetail(null);
      setElapsedSeconds(0);
      setUploadedBytes(0);
      setPhase("idle");
    },
    [setPhase, updatePendingFinalize]
  );
  useEffect(() => {
    if (!active && !canRetryFinalize) return;
    const blockUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", blockUnload);
    return () => window.removeEventListener("beforeunload", blockUnload);
  }, [active, canRetryFinalize]);

  return {
    phase,
    active,
    recording: phase === "recording",
    stopping: phase === "stopping",
    elapsedSeconds,
    uploadedBytes,
    issue,
    errorDetail,
    savedSession,
    libraryAccess,
    updateLibraryAccess,
    consumeLibraryCode,
    resetAfterAccessLoss,
    canRetryFinalize,
    startRecording,
    stopRecording,
    retryFinalize,
  };
}

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  abortMeetingRecordingSession,
  createMeetingRecordingSession,
  finalizeMeetingRecordingSession,
  fetchMeetingRecordingSession,
  heartbeatMeetingRecordingSession,
  isMeetingSessionAccessTerminalErrorCode,
  persistMeetingSessionCapability,
  readMeetingSessionCapability,
  resolveMeetingRecordingApiError,
  resolveMeetingRecordingApiErrorCode,
  uploadMeetingRecordingChunk,
  type MeetingRecordingSession,
} from "../api/meetingRecordingApi";
import { selectMeetingRecordingMimeType } from "./meetingAudioSupport";
import type { MeetingAudioSourceId } from "./useMeetingAudioCheck";
import {
  acquireRecoveryLock, createRecoverySession, listRecoverySessions, readRecoveryChunks,
  removeRecoverySession, saveRecoveryChunk, stopRecoverySession, type RecoverySession,
} from "./meetingRecordingRecoveryStore";

export type MeetingPersistentRecordingPhase =
  | "idle"
  | "starting"
  | "recording"
  | "paused"
  | "stopping"
  | "upload-pending"
  | "observing"
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
  recorder: MediaRecorder | null;
  mimeType: string;
  nextSequence: number;
  uploadChain: Promise<void>;
  persistenceChain: Promise<boolean>;
  failedChunks: Map<number, FailedChunk>;
  expectedStop: boolean;
  stopped: boolean;
  stoppedPromise: Promise<void>;
  resolveStopped: () => void;
}

interface ActivePersistentRecording {
  sessionId: string;
  startedAtMs: number;
  stoppedAtMs: number | null;
  pausedAtMs: number | null;
  pausedMs: number;
  tracks: PersistentRecorderTrack[];
  elapsedTimer: number | null;
  heartbeatTimer: number | null;
  heartbeatFailures: number;
  uploadAbortController: AbortController;
  stopPromise: Promise<void> | null;
  failureIssue: MeetingPersistentRecordingIssue | null;
  recovered: boolean;
  requiresSessionCapability: boolean;
  recoveryIncomplete: boolean;
  hasLocalRecovery: boolean;
  cancelled: boolean;
}

interface PendingFinalizeRequest {
  sessionId: string;
  durationMs: number;
  tracks: Array<{ sourceId: MeetingAudioSourceId; chunkCount: number }>;
  requiresSessionCapability?: boolean;
}

function recordedDuration(active: ActivePersistentRecording): number {
  return Math.max(0, (active.pausedAtMs ?? active.stoppedAtMs ?? Date.now()) - active.startedAtMs - active.pausedMs);
}

interface PersistentRecordingDeps {
  deliveryMode?: "one-shot";
  getConnectedStreams: () => Array<{ sourceId: MeetingAudioSourceId; stream: MediaStream }>;
}

const CHUNK_TIMESLICE_MS = 5_000;
const RECORDER_HEARTBEAT_INTERVAL_MS = 20_000;
const UPLOAD_RETRY_DELAYS_MS = [400, 1_200, 2_500] as const;
const LEGACY_PENDING_FINALIZE_STORAGE_KEY = "meeting-minutes:pending-finalize:v1";
const PENDING_FINALIZE_STORAGE_PREFIX = "meeting-minutes:pending-finalize:v2:";
const SELECTED_PENDING_FINALIZE_SESSION_KEY =
  "meeting-minutes:pending-finalize-session:v1";
const NO_PENDING_FINALIZE_SESSION = "none";
const SELECTED_RECOVERY_SESSION_KEY = "meeting-minutes:recovery-session:v1";

function clearRecoverySelection(): void {
  try {
    window.sessionStorage.setItem(SELECTED_RECOVERY_SESSION_KEY, NO_PENDING_FINALIZE_SESSION);
  } catch {
    // 清理分頁指標失敗不能把已確認的 finalize 成功改判成失敗或 abort。
  }
}

function describeRecordingError(error: unknown): string {
  return resolveMeetingRecordingApiError(error) ?? (error instanceof Error ? error.message : "錄音保存發生錯誤。");
}

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
    input.signal?.throwIfAborted();
    try {
      await upload(input);
      return;
    } catch (error) {
      input.signal?.throwIfAborted();
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

export function useMeetingPersistentRecording({ getConnectedStreams, deliveryMode }: PersistentRecordingDeps) {
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
  const [canRetryFinalize, setCanRetryFinalize] = useState(Boolean(initialPendingFinalize));
  const phaseRef = useRef<MeetingPersistentRecordingPhase>("idle");
  const activeRef = useRef<ActivePersistentRecording | null>(null);
  const pendingFinalizeRef = useRef<PendingFinalizeRequest | null>(initialPendingFinalize);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const [recoveryLoading, setRecoveryLoading] = useState(true);
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const [recoveryScan, setRecoveryScan] = useState(0);
  const [localRecovery, setLocalRecovery] = useState<RecoverySession | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const stopRecordingRef = useRef<() => Promise<void>>(async () => {});
  const recoveryLockRef = useRef<{ sessionId: string; release: () => void } | null>(null);

  const releaseRecoveryLock = useCallback((sessionId?: string) => {
    if (sessionId && recoveryLockRef.current?.sessionId !== sessionId) return;
    recoveryLockRef.current?.release();
    recoveryLockRef.current = null;
  }, []);

  const ensureRecoveryLock = useCallback(async (sessionId: string) => {
    if (recoveryLockRef.current) return recoveryLockRef.current.sessionId === sessionId;
    const release = await acquireRecoveryLock(sessionId);
    if (!release) throw new Error("此筆錄音正在其他分頁處理，請回原分頁操作。");
    if (!mountedRef.current) { release(); return false; }
    recoveryLockRef.current = { sessionId, release };
    return true;
  }, []);

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
    },
    [updatePendingFinalize]
  );

  const queueChunk = useCallback(
    (active: ActivePersistentRecording, track: PersistentRecorderTrack, blob: Blob) => {
      if (active.cancelled) return;
      const sequence = track.nextSequence;
      track.nextSequence += 1;
      // 本機保存獨立於網路佇列；斷網不能讓後續片段卡在尚未寫入 IndexedDB 的 Promise 後面。
      const persisted = saveRecoveryChunk({ sessionId: active.sessionId, sourceId: track.sourceId, sequence, blob },
        Math.max(1_000, recordedDuration(active)))
        .then(() => true, (error: unknown) => {
          track.failedChunks.set(sequence, { sequence, blob });
          active.failureIssue ??= "upload-failed";
          if (mountedRef.current) setRecoveryError(describeRecordingError(error));
          void stopRecordingRef.current();
          return false;
        });
      track.persistenceChain = Promise.all([track.persistenceChain, persisted]).then(results => results.every(Boolean));
      track.uploadChain = track.uploadChain.then(async () => {
        try {
          if (!await persisted) return;
          await uploadMeetingChunkWithRetry({
            sessionId: active.sessionId,
            sourceId: track.sourceId,
            sequence,
            blob,
            mimeType: track.mimeType,
            signal: active.uploadAbortController.signal,
          });
          track.failedChunks.delete(sequence);
          if (mountedRef.current && activeRef.current === active) {
            setUploadedBytes((value) => value + blob.size);
          }
        } catch {
          track.failedChunks.set(sequence, { sequence, blob });
          active.failureIssue ??= "upload-failed";
        }
      });
    },
    []
  );

  const stopRecording = useCallback(
    (markFailed = false): Promise<void> => {
      const active = activeRef.current;
      if (!active) return Promise.resolve();
      if (markFailed) active.failureIssue = "recording-failed";
      if (active.stopPromise) return active.stopPromise;

      active.stoppedAtMs ??= Date.now();
      if (mountedRef.current) {
        setElapsedSeconds(Math.floor(recordedDuration(active) / 1_000));
        setIssue(null);
        setErrorDetail(null);
      }
      setPhase("stopping");
      if (active.elapsedTimer !== null) {
        window.clearInterval(active.elapsedTimer);
        active.elapsedTimer = null;
      }
      if (active.heartbeatTimer !== null) {
        window.clearInterval(active.heartbeatTimer);
        active.heartbeatTimer = null;
      }
      active.stopPromise = (async () => {
        if (active.recovered) {
          active.failureIssue = "upload-failed";
          if (active.recoveryIncomplete) throw new Error("本機錄音有缺失片段，不能完成收尾；請下載現存片段備份。");
          if (active.requiresSessionCapability && !readMeetingSessionCapability(active.sessionId)) {
            throw new Error("此分頁缺少原錄音權限，不能續傳；請先下載本機備份。");
          }
          const remote = await fetchMeetingRecordingSession(active.sessionId);
          if (remote.status === "finalized") {
            updatePendingFinalize(null);
            clearRecoverySelection();
            await removeRecoverySession(remote.sessionId).catch(error => {
              if (mountedRef.current) setRecoveryError(describeRecordingError(error));
            });
            active.failureIssue = null;
            if (mountedRef.current) { setLocalRecovery(null); setSavedSession(remote); setPhase("saved"); }
            return;
          }
          if (remote.recoveryUntil && Date.parse(remote.recoveryUntil) <= Date.now()) {
            throw new Error("後端錄音續傳期限已過，請下載本機備份；不會自動建立另一筆錄音。");
          }
        }
        active.tracks.forEach((track) => {
          track.expectedStop = true;
          if (!track.recorder || track.recorder.state === "inactive") {
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
        // 停止且所有尾段已落盤即可留下完整性證據，不等待網路上傳成功。
        const persisted = await Promise.all(active.tracks.map(track => track.persistenceChain));
        if (active.hasLocalRecovery && persisted.every(Boolean) && (!active.failureIssue || active.failureIssue === "upload-failed")) {
          try {
            await stopRecoverySession(active.sessionId, Math.max(1_000, recordedDuration(active)),
              active.tracks.map(track => ({ sourceId: track.sourceId, chunkCount: track.nextSequence })));
          } catch (error) { active.failureIssue = "upload-failed"; throw error; }
        }
        await Promise.all(active.tracks.map((track) => track.uploadChain));
        if (active.uploadAbortController.signal.aborted) {
          throw new Error("錄音連線已中斷，音訊已保留於本機；請待連線恢復後重試上傳。");
        }

        if (!active.failureIssue || active.failureIssue === "upload-failed") {
          for (const track of active.tracks) {
            const failedChunks = [...track.failedChunks.values()].sort(
              (left, right) => left.sequence - right.sequence
            );
            for (const failedChunk of failedChunks) {
              try {
                await saveRecoveryChunk({ sessionId: active.sessionId, sourceId: track.sourceId,
                  sequence: failedChunk.sequence, blob: failedChunk.blob },
                  Math.max(1_000, recordedDuration(active)));
                await uploadMeetingChunkWithRetry({
                  sessionId: active.sessionId,
                  sourceId: track.sourceId,
                  sequence: failedChunk.sequence,
                  blob: failedChunk.blob,
                  mimeType: track.mimeType,
                  signal: active.uploadAbortController.signal,
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
          active.failureIssue = active.recovered ? "upload-failed" : "recording-failed";
          throw new Error("recording produced no audio chunks");
        }
        const finalizeRequest: PendingFinalizeRequest = {
          sessionId: active.sessionId,
          durationMs: Math.max(1_000, recordedDuration(active)),
          requiresSessionCapability: Boolean(
            readMeetingSessionCapability(active.sessionId)
          ),
          tracks: active.tracks.map((track) => ({
            sourceId: track.sourceId,
            chunkCount: track.nextSequence,
          })),
        };
        active.failureIssue = "upload-failed";
        await stopRecoverySession(active.sessionId, finalizeRequest.durationMs, finalizeRequest.tracks);
        if (mountedRef.current) setRecoveryError(null);
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
        updatePendingFinalize(null);
        active.failureIssue = null;
        clearRecoverySelection();
        await removeRecoverySession(finalized.sessionId).catch(error => {
          if (mountedRef.current) setRecoveryError(describeRecordingError(error));
        });

        if (mountedRef.current && activeRef.current === active) {
          setSavedSession(finalized);
          setLocalRecovery(null);
          setIssue(null);
          setErrorDetail(null);
          setPhase("saved");
        }
      })()
        .catch(async (error) => {
          if (active.failureIssue !== "finalize-failed" && active.failureIssue !== "upload-failed") {
            try {
              await abortMeetingRecordingSession(active.sessionId);
            } catch {
              // 網路失敗時由 backend stale-session cleanup 回收未完成 session。
            }
          }
          if (mountedRef.current && activeRef.current === active) {
            const nextIssue = active.failureIssue ?? "recording-failed";
            setIssue(nextIssue);
            setErrorDetail(describeRecordingError(error));
            setPhase(nextIssue === "upload-failed" ? "upload-pending" : "failed");
          }
        })
        .finally(() => {
          if (active.failureIssue === "upload-failed") {
            // 留在原 session 補送失敗片段；下一次重試不能沿用已結束的 Promise。
            active.stopPromise = null;
          } else if (activeRef.current === active) {
            activeRef.current = null;
          }
          if (!active.failureIssue || !active.hasLocalRecovery || !mountedRef.current) releaseRecoveryLock(active.sessionId);
        });
      return active.stopPromise;
    },
    [clearTerminalFinalizeState, setPhase, updatePendingFinalize, releaseRecoveryLock]
  );

  const startRecording = useCallback(
    async (title: string, additionalSectionRequest?: string): Promise<"started" | "reused" | null> => {
      if (activeRef.current || phaseRef.current === "starting" || phaseRef.current === "stopping") {
        return null;
      }
      if (pendingFinalizeRef.current) return null;
      if (recoveryLoading || recoveryBlocked || localRecovery || recoveryError) return null;
      const sources = getConnectedStreams();
      if (sources.length === 0) {
        setIssue("source-required");
        setPhase("failed");
        return null;
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
          deliveryMode,
          ...(additionalSectionRequest ? { additionalSectionRequest } : {}),
          title,
          sourceIds: sources.map((source) => source.sourceId),
        });
        session = created.session;
        if (created.reusedSession) {
          setSavedSession(created.session);
          setPhase("observing");
          return "reused";
        }
      } catch (error) {
        if (mountedRef.current && generationRef.current === generation) {
          setIssue("create-failed");
          setErrorDetail(describeRecordingError(error));
          setPhase("failed");
        }
        return null;
      }
      if (!mountedRef.current || generationRef.current !== generation) {
        void abortMeetingRecordingSession(session.sessionId).catch(() => undefined);
        return null;
      }

      const mimeType = selectMeetingRecordingMimeType((candidate) =>
        MediaRecorder.isTypeSupported(candidate)
      );
      const active: ActivePersistentRecording = {
        sessionId: session.sessionId,
        startedAtMs: Date.now(),
        stoppedAtMs: null,
        pausedAtMs: null,
        pausedMs: 0,
        tracks: [],
        elapsedTimer: null,
        heartbeatTimer: null,
        heartbeatFailures: 0,
        uploadAbortController: new AbortController(),
        stopPromise: null,
        failureIssue: null,
        recovered: false,
        requiresSessionCapability: Boolean(readMeetingSessionCapability(session.sessionId)),
        recoveryIncomplete: false,
        hasLocalRecovery: false,
        cancelled: false,
      };
      activeRef.current = active;

      try {
        if (!await ensureRecoveryLock(session.sessionId)) throw new Error("錄音頁面已關閉。");
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
            persistenceChain: Promise.resolve(true),
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
        }
        const recovery: RecoverySession = { sessionId: active.sessionId, title: session.title,
          deliveryMode: session.deliveryMode,
          startedAtMs: active.startedAtMs, durationMs: 0, stopped: false, totalBytes: 0,
          requiresSessionCapability: active.requiresSessionCapability,
          tracks: active.tracks.map(track => ({ sourceId: track.sourceId, mimeType: track.mimeType })) };
        await createRecoverySession(recovery);
        active.hasLocalRecovery = true;
        window.sessionStorage.setItem(SELECTED_RECOVERY_SESSION_KEY, session.sessionId);
        if (!mountedRef.current || generationRef.current !== generation) {
          await removeRecoverySession(session.sessionId);
          active.failureIssue = "recording-failed";
          await stopRecording(true);
          return null;
        }
        setLocalRecovery(recovery);
        for (const track of active.tracks) track.recorder!.start(CHUNK_TIMESLICE_MS);
      } catch (error) {
        if (mountedRef.current) setRecoveryError(describeRecordingError(error));
        active.failureIssue = "recording-failed";
        await stopRecording(true);
        return null;
      }

      setPhase("recording");
      active.elapsedTimer = window.setInterval(() => {
        if (mountedRef.current && activeRef.current === active) {
          setElapsedSeconds(Math.floor(recordedDuration(active) / 1_000));
        }
      }, 500);
      active.heartbeatTimer = window.setInterval(() => {
        void heartbeatMeetingRecordingSession(active.sessionId).then(
          () => {
            if (activeRef.current === active && active.stoppedAtMs === null) active.heartbeatFailures = 0;
          },
          (error: unknown) => {
            if (activeRef.current !== active || active.stoppedAtMs !== null) return;
            active.heartbeatFailures += 1;
            const code = resolveMeetingRecordingApiErrorCode(error);
            const terminal = [
              "MEETING_PIPELINE_CAPACITY_FULL",
              "MEETING_RECORDER_LEASE_NOT_OWNER",
              "MEETING_RECORDING_NOT_ACTIVE",
              "MEETING_CANCEL_IN_PROGRESS",
            ].includes(code ?? "");
            if (!terminal && active.heartbeatFailures < 3) return;
            active.failureIssue ??= "upload-failed";
            active.uploadAbortController.abort();
            if (mountedRef.current && activeRef.current === active) {
              setRecoveryError(describeRecordingError(error));
            }
            void stopRecording();
          }
        );
      }, RECORDER_HEARTBEAT_INTERVAL_MS);
      return "started";
    },
    [deliveryMode, getConnectedStreams, queueChunk, setPhase, stopRecording, recoveryLoading, recoveryBlocked, localRecovery, recoveryError, ensureRecoveryLock]
  );

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      if (activeRef.current) void stopRecording();
      else releaseRecoveryLock();
    };
  }, [stopRecording, releaseRecoveryLock]);

  useEffect(() => { stopRecordingRef.current = stopRecording; }, [stopRecording]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!("indexedDB" in window) || !("locks" in navigator)) throw new Error("此瀏覽器不支援安全的本機錄音恢復，請使用支援 IndexedDB 與 Web Locks 的瀏覽器。");
      const sessions = await listRecoverySessions();
      if (cancelled) return;
      const selectedSessionId = window.sessionStorage.getItem(SELECTED_RECOVERY_SESSION_KEY);
      if (selectedSessionId === NO_PENDING_FINALIZE_SESSION && !pendingFinalizeRef.current) return;
      sessions.sort((left, right) => left.startedAtMs - right.startedAtMs);
      for (const session of sessions) {
        const pending = pendingFinalizeRef.current;
        if (pending && pending.sessionId !== session.sessionId) continue;
        if (!pending && selectedSessionId && selectedSessionId !== session.sessionId) continue;
        const release = await acquireRecoveryLock(session.sessionId);
        if (cancelled) { release?.(); return; }
        if (!release) { setRecoveryBlocked(true); break; }
        try {
          window.sessionStorage.setItem(SELECTED_RECOVERY_SESSION_KEY, session.sessionId);
          setLocalRecovery(session);
          if (pending && session.stopped) {
            recoveryLockRef.current = { sessionId: session.sessionId, release };
            break;
          }
          const chunks = await readRecoveryChunks(session.sessionId);
          if (cancelled) { release(); return; }
          let recoveryIncomplete = !session.stopped;
          const tracks: PersistentRecorderTrack[] = session.tracks.map(track => {
            const stored = chunks.filter(chunk => chunk.sourceId === track.sourceId).sort((a, b) => a.sequence - b.sequence);
            if (stored.some((chunk, index) => chunk.sequence !== index)) recoveryIncomplete = true;
            if (session.expectedChunks && session.expectedChunks.find(item => item.sourceId === track.sourceId)?.chunkCount !== stored.length) recoveryIncomplete = true;
            return { ...track, recorder: null, nextSequence: stored.length,
              failedChunks: new Map(stored.map(chunk => [chunk.sequence, chunk])), uploadChain: Promise.resolve(), persistenceChain: Promise.resolve(true),
              expectedStop: true, stopped: true, stoppedPromise: Promise.resolve(), resolveStopped: () => {} };
          });
          activeRef.current = { sessionId: session.sessionId, startedAtMs: session.startedAtMs,
            stoppedAtMs: session.startedAtMs + Math.max(1_000, session.durationMs), pausedAtMs: null, pausedMs: 0, tracks, elapsedTimer: null,
            heartbeatTimer: null, heartbeatFailures: 0,
            uploadAbortController: new AbortController(),
            stopPromise: null, failureIssue: "upload-failed", recovered: true,
            requiresSessionCapability: session.requiresSessionCapability, recoveryIncomplete, hasLocalRecovery: true, cancelled: false };
          recoveryLockRef.current = { sessionId: session.sessionId, release };
          if (pending?.sessionId === session.sessionId) updatePendingFinalize(null);
          setLocalRecovery(session);
          setElapsedSeconds(Math.floor(session.durationMs / 1_000));
          setIssue("upload-failed");
          if (recoveryIncomplete) setErrorDetail("無法確認錄音尾段已完整保存，不能自動收尾；請下載本機音軌備份。");
          setPhase("upload-pending");
          break;
        } catch (error) { release(); throw error; }
      }
    })().catch(error => { if (!cancelled) setRecoveryError(describeRecordingError(error)); })
      .finally(() => { if (!cancelled) setRecoveryLoading(false); });
    return () => { cancelled = true; };
  }, [setPhase, updatePendingFinalize, recoveryScan]);

  const retryRecovery = useCallback(() => {
    if (recoveryLoading || !recoveryBlocked) return;
    setRecoveryLoading(true);
    setRecoveryBlocked(false);
    setRecoveryScan(value => value + 1);
  }, [recoveryLoading, recoveryBlocked]);

  const retryFinalize = useCallback(async (): Promise<void> => {
    const request = pendingFinalizeRef.current;
    if (recoveryLoading || !request || activeRef.current || phaseRef.current === "stopping") return;
    setIssue(null);
    setErrorDetail(null);
    setPhase("stopping");
    try {
      if (!await ensureRecoveryLock(request.sessionId)) return;
      if (mountedRef.current) setRecoveryError(null);
      const finalized = await finalizeMeetingRecordingSession(request);
      updatePendingFinalize(null);
      clearRecoverySelection();
      await removeRecoverySession(finalized.sessionId).catch(error => {
        if (mountedRef.current) setRecoveryError(describeRecordingError(error));
      });
      if (mountedRef.current) {
        setLocalRecovery(null);
        setSavedSession(finalized);
        setIssue(null);
        setErrorDetail(null);
        setPhase("saved");
      }
      releaseRecoveryLock(request.sessionId);
    } catch (error) {
      clearTerminalFinalizeState(
        request,
        resolveMeetingRecordingApiErrorCode(error)
      );
      if (mountedRef.current) {
        setIssue("finalize-failed");
        setErrorDetail(describeRecordingError(error));
        setPhase("failed");
      }
    } finally {
      if (!mountedRef.current) releaseRecoveryLock(request.sessionId);
    }
  }, [clearTerminalFinalizeState, setPhase, updatePendingFinalize, ensureRecoveryLock, releaseRecoveryLock, recoveryLoading]);

  const retryUpload = useCallback((): Promise<void> => {
    if (phaseRef.current !== "upload-pending") return Promise.resolve();
    const active = activeRef.current;
    if (active && !active.stopPromise && active.uploadAbortController.signal.aborted) {
      active.uploadAbortController = new AbortController();
    }
    return stopRecording();
  }, [stopRecording]);

  const downloadLocalRecovery = useCallback(async () => {
    if (!localRecovery) return;
    try {
    const chunks = await readRecoveryChunks(localRecovery.sessionId);
    for (const track of localRecovery.tracks) {
      const pieces = new Map(chunks.filter(chunk => chunk.sourceId === track.sourceId).map(chunk => [chunk.sequence, chunk.blob]));
      activeRef.current?.tracks.find(item => item.sourceId === track.sourceId)?.failedChunks.forEach(chunk => pieces.set(chunk.sequence, chunk.blob));
      const blob = new Blob([...pieces].sort(([a], [b]) => a - b).map(([, piece]) => piece), { type: track.mimeType });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${localRecovery.sessionId}-${track.sourceId}.${track.mimeType.includes("ogg") ? "ogg" : "webm"}`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
    } catch (error) { setRecoveryError(describeRecordingError(error)); }
  }, [localRecovery]);

  const discardLocalRecovery = useCallback(async () => {
    if (recoveryLoading || !localRecovery || ["recording", "paused", "stopping"].includes(phaseRef.current)) return false;
    const previousPhase = phaseRef.current;
    setPhase("stopping");
    try {
      if (!await ensureRecoveryLock(localRecovery.sessionId)) { setPhase(previousPhase); return false; }
      await removeRecoverySession(localRecovery.sessionId);
      clearRecoverySelection();
    }
    catch (error) { setRecoveryError(describeRecordingError(error)); setPhase(previousPhase); return false; }
    releaseRecoveryLock(localRecovery.sessionId);
    activeRef.current = null;
    if (pendingFinalizeRef.current?.sessionId === localRecovery.sessionId) updatePendingFinalize(null);
    setLocalRecovery(null);
    setRecoveryError(null);
    setIssue(null);
    setErrorDetail(null);
    setPhase("idle");
    return true;
  }, [localRecovery, setPhase, updatePendingFinalize, ensureRecoveryLock, releaseRecoveryLock, recoveryLoading]);

  const cancelRecordingLocally = useCallback(async () => {
    const current = activeRef.current;
    if (!current) return;
    current.cancelled = true;
    current.uploadAbortController.abort();
    current.stoppedAtMs ??= Date.now();
    if (current.elapsedTimer !== null) {
      window.clearInterval(current.elapsedTimer);
      current.elapsedTimer = null;
    }
    if (current.heartbeatTimer !== null) {
      window.clearInterval(current.heartbeatTimer);
      current.heartbeatTimer = null;
    }
    for (const track of current.tracks) {
      track.expectedStop = true;
      if (!track.recorder || track.recorder.state === "inactive") settleTrack(track);
      else {
        try { track.recorder.stop(); } catch { settleTrack(track); }
      }
    }
    await Promise.all(current.tracks.map(track => track.stoppedPromise));
    activeRef.current = null;
    updatePendingFinalize(null);
    clearRecoverySelection();
    await removeRecoverySession(current.sessionId).catch(() => undefined);
    persistMeetingSessionCapability(current.sessionId, null);
    releaseRecoveryLock(current.sessionId);
    if (mountedRef.current) {
      setLocalRecovery(null);
      setRecoveryError(null);
      setSavedSession(null);
      setIssue(null);
      setErrorDetail(null);
      setPhase("idle");
    }
  }, [releaseRecoveryLock, setPhase, updatePendingFinalize]);

  const togglePause = useCallback(() => {
    const current = activeRef.current;
    if (!current || !["recording", "paused"].includes(phaseRef.current)) return;
    try {
      if (current.pausedAtMs === null) {
        current.pausedAtMs = Date.now();
        current.tracks.forEach(track => { track.recorder!.requestData(); track.recorder!.pause(); });
        setPhase("paused");
      } else {
        current.tracks.forEach(track => track.recorder!.resume());
        current.pausedMs += Date.now() - current.pausedAtMs;
        current.pausedAtMs = null;
        setPhase("recording");
      }
    } catch {
      current.failureIssue = "recording-failed";
      void stopRecording(true);
    }
  }, [setPhase, stopRecording]);

  const active = phase === "starting" || phase === "recording" || phase === "paused" || phase === "stopping" || phase === "upload-pending";
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
    paused: phase === "paused",
    togglePause,
    activeSessionId: activeRef.current?.sessionId ?? null,
    stopping: phase === "stopping",
    elapsedSeconds,
    uploadedBytes,
    issue,
    errorDetail,
    savedSession,
    canRetryFinalize,
    canRetryUpload: phase === "upload-pending",
    recoveryLoading, recoveryBlocked, retryRecovery, recoveryError, localRecovery, downloadLocalRecovery, discardLocalRecovery,
    startRecording,
    stopRecording,
    cancelRecordingLocally,
    retryFinalize,
    retryUpload,
  };
}

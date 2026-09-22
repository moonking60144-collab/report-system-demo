import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  inspectMeetingAudioCapabilities,
  selectMeetingRecordingMimeType,
} from "./meetingAudioSupport";

export type MeetingAudioSourceId = "room-mic" | "remote-tab";
export type MeetingAudioIssue =
  | "permission-denied"
  | "device-not-found"
  | "capture-cancelled"
  | "remote-audio-missing"
  | "capture-failed"
  | "recording-unsupported"
  | "recording-source-required"
  | "recording-failed";

export type MeetingAudioRecordingPhase = "idle" | "recording" | "stopping";

export interface MeetingAudioSourceState {
  status: "idle" | "connecting" | "connected";
  level: number;
  deviceLabel: string;
  issue: MeetingAudioIssue | null;
}

export interface MeetingAudioRecordingResult {
  sourceId: MeetingAudioSourceId;
  url: string;
  mimeType: string;
  extension: "webm" | "ogg";
}

interface RecorderSession {
  sourceId: MeetingAudioSourceId;
  recorder: MediaRecorder;
  chunks: Blob[];
  mimeType: string;
  expectedStop: boolean;
  failed: boolean;
  stopped: boolean;
  stoppedPromise: Promise<void>;
  resolveStopped: () => void;
}

interface ActiveRecording {
  generation: number;
  sessions: RecorderSession[];
  failed: boolean;
  stopPromise: Promise<void> | null;
  elapsedTimer: number | null;
  autoStopTimer: number | null;
}

const TEST_RECORDING_LIMIT_SECONDS = 30;

const INITIAL_SOURCE_STATE: MeetingAudioSourceState = {
  status: "idle",
  level: 0,
  deviceLabel: "",
  issue: null,
};

function resolveCaptureIssue(error: unknown): MeetingAudioIssue {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "permission-denied";
    }
    if (error.name === "NotFoundError" || error.name === "OverconstrainedError") {
      return "device-not-found";
    }
    if (error.name === "AbortError") {
      return "capture-cancelled";
    }
  }
  return "capture-failed";
}

function createAudioLevelMonitor(
  stream: MediaStream,
  onLevel: (level: number) => void
): () => void {
  const AudioContextConstructor =
    window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) {
    return () => undefined;
  }

  let audioContext: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let analyser: AnalyserNode | null = null;
  let timer: number | null = null;

  try {
    audioContext = new AudioContextConstructor();
    const audioStream = new MediaStream(stream.getAudioTracks());
    source = audioContext.createMediaStreamSource(audioStream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.72;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.frequencyBinCount);
    timer = window.setInterval(() => {
      analyser?.getByteFrequencyData(samples);
      const average = samples.reduce((total, sample) => total + sample, 0) / samples.length;
      onLevel(Math.min(100, Math.round((average / 128) * 100)));
    }, 100);
  } catch (error) {
    if (timer !== null) {
      window.clearInterval(timer);
    }
    source?.disconnect();
    analyser?.disconnect();
    if (audioContext) {
      void audioContext.close();
    }
    throw error;
  }

  return () => {
    if (timer !== null) {
      window.clearInterval(timer);
    }
    source?.disconnect();
    analyser?.disconnect();
    if (audioContext) {
      void audioContext.close();
    }
  };
}

function stopStream(stream: MediaStream | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function settleRecorderSession(session: RecorderSession): void {
  if (session.stopped) {
    return;
  }
  session.stopped = true;
  session.resolveStopped();
}

function clearActiveRecordingTimers(activeRecording: ActiveRecording): void {
  if (activeRecording.elapsedTimer !== null) {
    window.clearInterval(activeRecording.elapsedTimer);
    activeRecording.elapsedTimer = null;
  }
  if (activeRecording.autoStopTimer !== null) {
    window.clearTimeout(activeRecording.autoStopTimer);
    activeRecording.autoStopTimer = null;
  }
}

export function useMeetingAudioCheck() {
  const capabilities = useMemo(() => inspectMeetingAudioCapabilities(), []);
  const [sources, setSources] = useState<Record<MeetingAudioSourceId, MeetingAudioSourceState>>({
    "room-mic": INITIAL_SOURCE_STATE,
    "remote-tab": INITIAL_SOURCE_STATE,
  });
  const [recordingPhase, setRecordingPhaseState] =
    useState<MeetingAudioRecordingPhase>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [recordingIssue, setRecordingIssue] = useState<MeetingAudioIssue | null>(null);
  const [recordingResults, setRecordingResults] = useState<MeetingAudioRecordingResult[]>([]);
  const streamsRef = useRef<Partial<Record<MeetingAudioSourceId, MediaStream>>>({});
  const monitorCleanupRef = useRef<Partial<Record<MeetingAudioSourceId, () => void>>>({});
  const sourceRequestGenerationRef = useRef<Record<MeetingAudioSourceId, number>>({
    "room-mic": 0,
    "remote-tab": 0,
  });
  const recordingPhaseRef = useRef<MeetingAudioRecordingPhase>("idle");
  const recordingGenerationRef = useRef(0);
  const activeRecordingRef = useRef<ActiveRecording | null>(null);
  const resultUrlsRef = useRef<string[]>([]);
  const mountedRef = useRef(true);

  const setRecordingPhase = useCallback((phase: MeetingAudioRecordingPhase) => {
    recordingPhaseRef.current = phase;
    setRecordingPhaseState(phase);
  }, []);

  const clearRecordingResults = useCallback(() => {
    resultUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    resultUrlsRef.current = [];
    setRecordingResults([]);
  }, []);

  const stopSource = useCallback((sourceId: MeetingAudioSourceId) => {
    sourceRequestGenerationRef.current[sourceId] += 1;
    monitorCleanupRef.current[sourceId]?.();
    delete monitorCleanupRef.current[sourceId];
    stopStream(streamsRef.current[sourceId]);
    delete streamsRef.current[sourceId];
    if (mountedRef.current) {
      setSources((previous) => ({
        ...previous,
        [sourceId]: INITIAL_SOURCE_STATE,
      }));
    }
  }, []);

  const attachSource = useCallback(
    (sourceId: MeetingAudioSourceId, stream: MediaStream) => {
      const audioTrack = stream.getAudioTracks()[0];
      const cleanupMonitor = createAudioLevelMonitor(stream, (level) => {
        if (!mountedRef.current || streamsRef.current[sourceId] !== stream) {
          return;
        }
        setSources((previous) => ({
          ...previous,
          [sourceId]: { ...previous[sourceId], level },
        }));
      });
      monitorCleanupRef.current[sourceId]?.();
      stopStream(streamsRef.current[sourceId]);
      streamsRef.current[sourceId] = stream;
      monitorCleanupRef.current[sourceId] = cleanupMonitor;
      stream.getTracks().forEach((track) => {
        track.addEventListener(
          "ended",
          () => {
            if (streamsRef.current[sourceId] === stream) {
              stopSource(sourceId);
            }
          },
          { once: true }
        );
      });
      if (mountedRef.current) {
        setSources((previous) => ({
          ...previous,
          [sourceId]: {
            status: "connected",
            level: 0,
            deviceLabel: audioTrack?.label ?? "",
            issue: null,
          },
        }));
      }
    },
    [stopSource]
  );

  const connectRoomMic = useCallback(async () => {
    if (!mountedRef.current) return "capture-cancelled" as const;
    if (
      streamsRef.current["room-mic"]?.getAudioTracks().some((track) => track.readyState === "live")
    ) {
      return null;
    }
    if (!capabilities.canCaptureMicrophone || recordingPhaseRef.current !== "idle") {
      return "capture-failed" as const;
    }
    const requestGeneration = sourceRequestGenerationRef.current["room-mic"] + 1;
    sourceRequestGenerationRef.current["room-mic"] = requestGeneration;
    setSources((previous) => ({
      ...previous,
      "room-mic": { ...INITIAL_SOURCE_STATE, status: "connecting" },
    }));
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (
        !mountedRef.current ||
        sourceRequestGenerationRef.current["room-mic"] !== requestGeneration
      ) {
        stopStream(stream);
        return "capture-cancelled" as const;
      }
      try {
        attachSource("room-mic", stream);
        return null;
      } catch {
        stopStream(stream);
        if (
          mountedRef.current &&
          sourceRequestGenerationRef.current["room-mic"] === requestGeneration
        ) {
          setSources((previous) => ({
            ...previous,
            "room-mic": { ...INITIAL_SOURCE_STATE, issue: "capture-failed" },
          }));
        }
        return "capture-failed" as const;
      }
    } catch (error) {
      if (
        !mountedRef.current ||
        sourceRequestGenerationRef.current["room-mic"] !== requestGeneration
      ) {
        return "capture-cancelled" as const;
      }
      const issue = resolveCaptureIssue(error);
      setSources((previous) => ({
        ...previous,
        "room-mic": {
          ...INITIAL_SOURCE_STATE,
          issue,
        },
      }));
      return issue;
    }
  }, [attachSource, capabilities.canCaptureMicrophone]);

  const connectRemoteTab = useCallback(async () => {
    if (!mountedRef.current) return "capture-cancelled" as const;
    if (
      streamsRef.current["remote-tab"]?.getAudioTracks().some((track) => track.readyState === "live")
    ) {
      return null;
    }
    if (!capabilities.canCaptureRemoteTab || recordingPhaseRef.current !== "idle") {
      return "capture-failed" as const;
    }
    const requestGeneration = sourceRequestGenerationRef.current["remote-tab"] + 1;
    sourceRequestGenerationRef.current["remote-tab"] = requestGeneration;
    setSources((previous) => ({
      ...previous,
      "remote-tab": { ...INITIAL_SOURCE_STATE, status: "connecting" },
    }));
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      if (
        !mountedRef.current ||
        sourceRequestGenerationRef.current["remote-tab"] !== requestGeneration
      ) {
        stopStream(stream);
        return "capture-cancelled" as const;
      }
      if (stream.getAudioTracks().length === 0) {
        stopStream(stream);
        setSources((previous) => ({
          ...previous,
          "remote-tab": {
            ...INITIAL_SOURCE_STATE,
            issue: "remote-audio-missing",
          },
        }));
        return "remote-audio-missing" as const;
      }
      try {
        attachSource("remote-tab", stream);
        return null;
      } catch {
        stopStream(stream);
        if (
          mountedRef.current &&
          sourceRequestGenerationRef.current["remote-tab"] === requestGeneration
        ) {
          setSources((previous) => ({
            ...previous,
            "remote-tab": { ...INITIAL_SOURCE_STATE, issue: "capture-failed" },
          }));
        }
        return "capture-failed" as const;
      }
    } catch (error) {
      if (
        !mountedRef.current ||
        sourceRequestGenerationRef.current["remote-tab"] !== requestGeneration
      ) {
        return "capture-cancelled" as const;
      }
      const issue = resolveCaptureIssue(error);
      setSources((previous) => ({
        ...previous,
        "remote-tab": {
          ...INITIAL_SOURCE_STATE,
          issue,
        },
      }));
      return issue;
    }
  }, [attachSource, capabilities.canCaptureRemoteTab]);

  const finishRecording = useCallback(
    (markFailed = false): Promise<void> => {
      const activeRecording = activeRecordingRef.current;
      if (!activeRecording) {
        return Promise.resolve();
      }
      if (markFailed) {
        activeRecording.failed = true;
      }
      if (activeRecording.stopPromise) {
        return activeRecording.stopPromise;
      }

      if (mountedRef.current) {
        setRecordingPhase("stopping");
      }
      clearActiveRecordingTimers(activeRecording);

      activeRecording.stopPromise = Promise.resolve().then(async () => {
        activeRecording.sessions.forEach((session) => {
          if (session.recorder.state === "inactive") {
            return;
          }
          session.expectedStop = true;
          try {
            session.recorder.stop();
          } catch {
            session.failed = true;
            activeRecording.failed = true;
            settleRecorderSession(session);
          }
        });

        await Promise.all(activeRecording.sessions.map((session) => session.stoppedPromise));
        if (!mountedRef.current || activeRecordingRef.current !== activeRecording) {
          return;
        }

        activeRecordingRef.current = null;
        const failed =
          activeRecording.failed || activeRecording.sessions.some((session) => session.failed);
        const blobs = activeRecording.sessions.map((session) => {
          const mimeType = session.recorder.mimeType || session.mimeType || "audio/webm";
          return {
            session,
            mimeType,
            blob: new Blob(session.chunks, { type: mimeType }),
          };
        });

        if (failed || blobs.some(({ blob }) => blob.size === 0)) {
          clearRecordingResults();
          setRecordingIssue("recording-failed");
          setRecordingPhase("idle");
          return;
        }

        const results = blobs.map(({ session, mimeType, blob }) => ({
          sourceId: session.sourceId,
          url: URL.createObjectURL(blob),
          mimeType,
          extension: mimeType.includes("ogg") ? ("ogg" as const) : ("webm" as const),
        }));
        clearRecordingResults();
        resultUrlsRef.current = results.map((result) => result.url);
        setRecordingResults(results);
        setRecordingIssue(null);
        setRecordingPhase("idle");
      });

      return activeRecording.stopPromise;
    },
    [clearRecordingResults, setRecordingPhase]
  );

  const stopRecording = useCallback(() => finishRecording(false), [finishRecording]);

  const getConnectedStreams = useCallback(
    () =>
      (Object.entries(streamsRef.current) as Array<[
        MeetingAudioSourceId,
        MediaStream | undefined,
      ]>)
        .filter((entry): entry is [MeetingAudioSourceId, MediaStream] =>
          Boolean(entry[1]?.getAudioTracks().some((track) => track.readyState === "live"))
        )
        .map(([sourceId, stream]) => ({ sourceId, stream })),
    []
  );

  const startRecording = useCallback(() => {
    if (recordingPhaseRef.current !== "idle") {
      return;
    }
    if (!capabilities.canRecord) {
      setRecordingIssue("recording-unsupported");
      return;
    }
    const activeSources = (Object.entries(streamsRef.current) as Array<[
      MeetingAudioSourceId,
      MediaStream | undefined,
    ]>).filter((entry): entry is [MeetingAudioSourceId, MediaStream] =>
      Boolean(entry[1]?.getAudioTracks().some((track) => track.readyState === "live"))
    );
    if (activeSources.length === 0) {
      setRecordingIssue("recording-source-required");
      return;
    }

    clearRecordingResults();
    setRecordingIssue(null);
    const mimeType = selectMeetingRecordingMimeType((candidate) =>
      MediaRecorder.isTypeSupported(candidate)
    );
    const activeRecording: ActiveRecording = {
      generation: recordingGenerationRef.current + 1,
      sessions: [],
      failed: false,
      stopPromise: null,
      elapsedTimer: null,
      autoStopTimer: null,
    };
    recordingGenerationRef.current = activeRecording.generation;
    activeRecordingRef.current = activeRecording;

    try {
      activeSources.forEach(([sourceId, stream]) => {
        const audioStream = new MediaStream(stream.getAudioTracks());
        const recorder = new MediaRecorder(audioStream, mimeType ? { mimeType } : undefined);
        let resolveStopped: () => void = () => undefined;
        const stoppedPromise = new Promise<void>((resolve) => {
          resolveStopped = resolve;
        });
        const session: RecorderSession = {
          sourceId,
          recorder,
          chunks: [],
          mimeType: mimeType ?? recorder.mimeType,
          expectedStop: false,
          failed: false,
          stopped: false,
          stoppedPromise,
          resolveStopped,
        };
        activeRecording.sessions.push(session);
        recorder.addEventListener("dataavailable", (event) => {
          if (event.data.size > 0) {
            session.chunks.push(event.data);
          }
        });
        recorder.addEventListener("error", () => {
          session.failed = true;
          activeRecording.failed = true;
          if (activeRecordingRef.current === activeRecording) {
            void finishRecording(true);
          }
        });
        recorder.addEventListener(
          "stop",
          () => {
            const unexpectedStop = !session.expectedStop;
            if (unexpectedStop) {
              session.failed = true;
              activeRecording.failed = true;
            }
            settleRecorderSession(session);
            if (unexpectedStop && activeRecordingRef.current === activeRecording) {
              void finishRecording(true);
            }
          },
          { once: true }
        );
        try {
          recorder.start(1_000);
        } catch (error) {
          session.failed = true;
          settleRecorderSession(session);
          throw error;
        }
      });
    } catch {
      activeRecording.failed = true;
      void finishRecording(true);
      return;
    }

    setElapsedSeconds(0);
    setRecordingPhase("recording");
    const startedAt = Date.now();
    activeRecording.elapsedTimer = window.setInterval(() => {
      if (
        !mountedRef.current ||
        activeRecordingRef.current !== activeRecording ||
        recordingPhaseRef.current !== "recording"
      ) {
        return;
      }
      setElapsedSeconds(
        Math.min(TEST_RECORDING_LIMIT_SECONDS, Math.floor((Date.now() - startedAt) / 1_000))
      );
    }, 250);
    activeRecording.autoStopTimer = window.setTimeout(() => {
      if (activeRecordingRef.current === activeRecording) {
        void finishRecording(false);
      }
    }, TEST_RECORDING_LIMIT_SECONDS * 1_000);
  }, [
    capabilities.canRecord,
    clearRecordingResults,
    finishRecording,
    setRecordingPhase,
  ]);

  useEffect(() => {
    const sourceRequestGeneration = sourceRequestGenerationRef.current;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sourceRequestGeneration["room-mic"] += 1;
      sourceRequestGeneration["remote-tab"] += 1;
      recordingGenerationRef.current += 1;

      const activeRecording = activeRecordingRef.current;
      activeRecordingRef.current = null;
      if (activeRecording) {
        clearActiveRecordingTimers(activeRecording);
        activeRecording.sessions.forEach((session) => {
          if (session.recorder.state !== "inactive") {
            session.expectedStop = true;
            try {
              session.recorder.stop();
            } catch {
              settleRecorderSession(session);
            }
          }
        });
      }

      (Object.keys(streamsRef.current) as MeetingAudioSourceId[]).forEach((sourceId) => {
        monitorCleanupRef.current[sourceId]?.();
        stopStream(streamsRef.current[sourceId]);
      });
      streamsRef.current = {};
      monitorCleanupRef.current = {};
      resultUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      resultUrlsRef.current = [];
    };
  }, []);

  const recording = recordingPhase !== "idle";

  return {
    capabilities,
    sources,
    recording,
    recordingPhase,
    stopping: recordingPhase === "stopping",
    elapsedSeconds,
    recordingLimitSeconds: TEST_RECORDING_LIMIT_SECONDS,
    recordingIssue,
    recordingResults,
    connectRoomMic,
    connectRemoteTab,
    stopSource,
    getConnectedStreams,
    startRecording,
    stopRecording,
  };
}

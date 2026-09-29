import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  inspectMeetingAudioCapabilities,
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

function stopStream(stream: MediaStream | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}

export function useMeetingAudioCheck() {
  const capabilities = useMemo(() => inspectMeetingAudioCapabilities(), []);
  const streamsRef = useRef<Partial<Record<MeetingAudioSourceId, MediaStream>>>({});
  const sourceRequestGenerationRef = useRef<Record<MeetingAudioSourceId, number>>({
    "room-mic": 0,
    "remote-tab": 0,
  });
  const mountedRef = useRef(true);

  const stopSource = useCallback((sourceId: MeetingAudioSourceId) => {
    sourceRequestGenerationRef.current[sourceId] += 1;
    stopStream(streamsRef.current[sourceId]);
    delete streamsRef.current[sourceId];
  }, []);

  const attachSource = useCallback(
    (sourceId: MeetingAudioSourceId, stream: MediaStream) => {
      stopStream(streamsRef.current[sourceId]);
      streamsRef.current[sourceId] = stream;
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
    if (!capabilities.canCaptureMicrophone) {
      return "capture-failed" as const;
    }
    const requestGeneration = sourceRequestGenerationRef.current["room-mic"] + 1;
    sourceRequestGenerationRef.current["room-mic"] = requestGeneration;
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
    if (!capabilities.canCaptureRemoteTab) {
      return "capture-failed" as const;
    }
    const requestGeneration = sourceRequestGenerationRef.current["remote-tab"] + 1;
    sourceRequestGenerationRef.current["remote-tab"] = requestGeneration;
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
        return "remote-audio-missing" as const;
      }
      try {
        attachSource("remote-tab", stream);
        return null;
      } catch {
        stopStream(stream);
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
      return issue;
    }
  }, [attachSource, capabilities.canCaptureRemoteTab]);

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

  useEffect(() => {
    const generation = sourceRequestGenerationRef.current;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generation["room-mic"] += 1;
      generation["remote-tab"] += 1;
      Object.values(streamsRef.current).forEach(stopStream);
      streamsRef.current = {};
    };
  }, []);

  return { capabilities, connectRoomMic, connectRemoteTab, stopSource, getConnectedStreams };
}

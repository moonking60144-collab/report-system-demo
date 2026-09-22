export interface MeetingAudioCapabilityInput {
  secureContext: boolean;
  hasMediaDevices: boolean;
  hasGetUserMedia: boolean;
  hasGetDisplayMedia: boolean;
  hasMediaRecorder: boolean;
  hasAudioContext: boolean;
}

export interface MeetingAudioCapabilities extends MeetingAudioCapabilityInput {
  canCaptureMicrophone: boolean;
  canCaptureRemoteTab: boolean;
  canRecord: boolean;
  ready: boolean;
}

export function evaluateMeetingAudioCapabilities(
  input: MeetingAudioCapabilityInput
): MeetingAudioCapabilities {
  const canCaptureMicrophone =
    input.secureContext && input.hasMediaDevices && input.hasGetUserMedia;
  const canCaptureRemoteTab =
    input.secureContext && input.hasMediaDevices && input.hasGetDisplayMedia;
  const canRecord = input.hasMediaRecorder && input.hasAudioContext;

  return {
    ...input,
    canCaptureMicrophone,
    canCaptureRemoteTab,
    canRecord,
    ready: canCaptureMicrophone && canRecord,
  };
}

export function inspectMeetingAudioCapabilities(): MeetingAudioCapabilities {
  const mediaDevices = navigator.mediaDevices;
  const webkitAudioContext = (
    window as typeof window & { webkitAudioContext?: typeof AudioContext }
  ).webkitAudioContext;
  return evaluateMeetingAudioCapabilities({
    secureContext: window.isSecureContext,
    hasMediaDevices: Boolean(mediaDevices),
    hasGetUserMedia: typeof mediaDevices?.getUserMedia === "function",
    hasGetDisplayMedia: typeof mediaDevices?.getDisplayMedia === "function",
    hasMediaRecorder: typeof window.MediaRecorder !== "undefined",
    hasAudioContext:
      typeof window.AudioContext !== "undefined" ||
      typeof webkitAudioContext !== "undefined",
  });
}

const RECORDING_MIME_TYPE_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
] as const;

export function selectMeetingRecordingMimeType(
  isTypeSupported: (mimeType: string) => boolean
): string | undefined {
  return RECORDING_MIME_TYPE_CANDIDATES.find((mimeType) => isTypeSupported(mimeType));
}

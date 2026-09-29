import type { MeetingOneShotStatus } from "../api/meetingRecordingApi";

export type MeetingOneShotPhase = MeetingOneShotStatus["phase"];

export function getMeetingOneShotActiveJob(state: MeetingOneShotStatus | null) {
  return state?.phase === "summarizing" ? state.minutes : state?.phase === "transcribing" ? state.transcription : state?.phase === "processing" ? state.processing : null;
}

const TERMINAL_OR_LEAVABLE_PHASES = new Set<MeetingOneShotPhase>([
  "ready",
  "expired",
  "failed",
  "cancelled",
  "interrupted",
  "legacy-saved",
]);

const PIPELINE_BUSY_PHASES = new Set<MeetingOneShotPhase>([
  "finalizing",
  "processing",
  "transcribing",
  "summarizing",
  "cancelling",
]);

export function canLeaveMeetingOneShot(phase: MeetingOneShotPhase | null): boolean {
  return phase !== null && TERMINAL_OR_LEAVABLE_PHASES.has(phase);
}

export function isMeetingOneShotPipelineBusy(phase: MeetingOneShotPhase | null): boolean {
  return phase !== null && PIPELINE_BUSY_PHASES.has(phase);
}

export function isMeetingOneShotRecorderPhase(phase: MeetingOneShotPhase | null): boolean {
  return phase === "recording" || phase === "interrupted";
}

export function shouldShowMeetingOutputPanel(input: {
  hasSession: boolean;
  phase: MeetingOneShotPhase | null;
  localRecording: boolean;
  localPaused: boolean;
}): boolean {
  return input.hasSession &&
    !input.localRecording &&
    !input.localPaused &&
    input.phase !== null &&
    !isMeetingOneShotRecorderPhase(input.phase);
}

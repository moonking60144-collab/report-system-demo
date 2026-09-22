import { env } from "../../config/env";
import { LocalWhisperMeetingTranscriptionProvider } from "./localWhisperMeetingTranscriptionProvider";
import {
  DisabledMeetingTranscriptionProvider,
  type MeetingTranscriptionProviderLike,
} from "./meetingTranscriptionProvider";

export function createMeetingTranscriptionProvider(): MeetingTranscriptionProviderLike {
  if (env.MEETING_TRANSCRIPTION_PROVIDER === "local-whisper") {
    return new LocalWhisperMeetingTranscriptionProvider();
  }
  return new DisabledMeetingTranscriptionProvider();
}

export const meetingTranscriptionProvider = createMeetingTranscriptionProvider();

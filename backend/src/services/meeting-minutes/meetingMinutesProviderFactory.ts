import { env } from "../../config/env";
import { GoogleGeminiMeetingMinutesProvider } from "./googleGeminiMeetingMinutesProvider";
import { MiniMaxMeetingMinutesProvider } from "./minimaxMeetingMinutesProvider";
import {
  DisabledMeetingMinutesProvider,
  type MeetingMinutesProviderLike,
} from "./meetingMinutesProvider";

export function createMeetingMinutesProvider(): MeetingMinutesProviderLike {
  if (env.MEETING_MINUTES_PROVIDER === "minimax") {
    return new MiniMaxMeetingMinutesProvider();
  }
  if (env.MEETING_MINUTES_PROVIDER === "google-gemini") {
    return new GoogleGeminiMeetingMinutesProvider();
  }
  return new DisabledMeetingMinutesProvider();
}

export const meetingMinutesProvider = createMeetingMinutesProvider();

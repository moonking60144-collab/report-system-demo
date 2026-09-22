import type { MeetingMinutesProviderInput, MeetingRecord } from "./meetingMinutesSchema";

export class MeetingMinutesProviderError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "MeetingMinutesProviderError";
  }
}

export interface MeetingMinutesProviderLike {
  readonly enabled: boolean;
  readonly name: string;
  readonly model: string;
  summarize(
    input: MeetingMinutesProviderInput,
    options?: { signal?: AbortSignal }
  ): Promise<MeetingRecord>;
}

export class DisabledMeetingMinutesProvider implements MeetingMinutesProviderLike {
  readonly enabled = false;
  readonly name = "disabled";
  readonly model = "disabled";

  async summarize(): Promise<MeetingRecord> {
    throw new MeetingMinutesProviderError(
      "Meeting minutes provider 尚未啟用。",
      "MEETING_MINUTES_PROVIDER_DISABLED"
    );
  }
}

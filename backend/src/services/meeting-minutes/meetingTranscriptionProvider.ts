import type { MeetingTranscriptSourceId } from "../../storage/meeting-minutes/meetingTranscriptionJobRepository";

export interface MeetingProviderTranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
  speakerLabel: string | null;
  confidence: number | null;
}

export interface MeetingTranscriptionProviderInput {
  audioPath: string;
  mimeType: string;
  sourceId: MeetingTranscriptSourceId;
  language: string;
  durationMs: number;
  signal?: AbortSignal;
}

export interface MeetingTranscriptionProviderLike {
  readonly enabled: boolean;
  readonly name: string;
  readonly model: string;
  transcribe(
    input: MeetingTranscriptionProviderInput
  ): Promise<MeetingProviderTranscriptSegment[]>;
}

export class MeetingTranscriptionError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = "MeetingTranscriptionError";
  }
}

function readNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 200) : null;
}

function readNullableConfidence(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value >= 0 && value <= 1 ? value : null;
}

export function validateMeetingProviderTranscriptSegments(
  value: unknown,
  durationMs: number
): MeetingProviderTranscriptSegment[] {
  if (!Array.isArray(value) || value.length > 2_000) {
    throw new MeetingTranscriptionError(
      "轉錄 provider 回傳的 segments 格式不合法。",
      "MEETING_TRANSCRIPTION_PROVIDER_RESPONSE_INVALID"
    );
  }
  const maxDurationMs = Math.max(0, Math.trunc(durationMs));
  const segments: MeetingProviderTranscriptSegment[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") {
      throw new MeetingTranscriptionError(
        "轉錄 provider 回傳的 segment 格式不合法。",
        "MEETING_TRANSCRIPTION_PROVIDER_RESPONSE_INVALID"
      );
    }
    const candidate = raw as {
      startMs?: unknown;
      endMs?: unknown;
      text?: unknown;
      speakerLabel?: unknown;
      confidence?: unknown;
    };
    const startMs = Number(candidate.startMs);
    const endMs = Number(candidate.endMs);
    const text = typeof candidate.text === "string" ? candidate.text.trim() : "";
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      startMs < 0 ||
      endMs < startMs ||
      startMs > maxDurationMs + 1_000 ||
      endMs > maxDurationMs + 1_000 ||
      !text ||
      text.length > 10_000
    ) {
      throw new MeetingTranscriptionError(
        "轉錄 provider 回傳的 segment 範圍或文字不合法。",
        "MEETING_TRANSCRIPTION_PROVIDER_RESPONSE_INVALID"
      );
    }
    segments.push({
      startMs: Math.min(maxDurationMs, Math.max(0, Math.trunc(startMs))),
      endMs: Math.min(maxDurationMs, Math.max(0, Math.trunc(endMs))),
      text,
      speakerLabel: readNullableString(candidate.speakerLabel),
      confidence: readNullableConfidence(candidate.confidence),
    });
  }
  return segments.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
}

export class DisabledMeetingTranscriptionProvider
  implements MeetingTranscriptionProviderLike
{
  readonly enabled = false;
  readonly name = "disabled";
  readonly model = "disabled";

  async transcribe(): Promise<MeetingProviderTranscriptSegment[]> {
    throw new MeetingTranscriptionError(
      "逐字稿 provider 尚未啟用。",
      "MEETING_TRANSCRIPTION_PROVIDER_DISABLED"
    );
  }
}

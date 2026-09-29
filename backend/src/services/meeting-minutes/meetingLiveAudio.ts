import { createHash } from "node:crypto";
import type { MeetingProviderTranscriptSegment } from "./meetingTranscriptionProvider";

export const LIVE_WINDOW_MS = 60_000;
export const LIVE_CONTEXT_MS = 2_000;
export const PCM_BYTES_PER_MS = 32;

export function pcmWave(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(pcm.length + 36, 4);
  header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24); header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function wavePcm(wave: Buffer): Buffer {
  if (wave.toString("ascii", 0, 4) !== "RIFF" || wave.toString("ascii", 8, 12) !== "WAVE") throw new Error("Invalid PCM WAV");
  for (let offset = 12; offset + 8 <= wave.length;) {
    const size = wave.readUInt32LE(offset + 4);
    if (offset + 8 + size > wave.length) throw new Error("Truncated PCM WAV");
    if (wave.toString("ascii", offset, offset + 4) === "data") return wave.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  throw new Error("Missing PCM WAV data");
}

export function pcmHash(pcm: Buffer): string {
  return createHash("sha256").update(pcm).digest("hex");
}

export function liveWindow(index: number, durationMs: number) {
  const startMs = index * LIVE_WINDOW_MS;
  const endMs = Math.min(durationMs, startMs + LIVE_WINDOW_MS);
  return { startMs, endMs, windowStartMs: Math.max(0, startMs - LIVE_CONTEXT_MS),
    windowEndMs: Math.min(durationMs, endMs + LIVE_CONTEXT_MS) };
}

export function positionWindowSegments(segments: MeetingProviderTranscriptSegment[], window: ReturnType<typeof liveWindow>) {
  return segments.map(segment => ({ ...segment, startMs: window.windowStartMs + segment.startMs,
    endMs: window.windowStartMs + segment.endMs }));
}

export function appendWindowSegments<T extends { startMs: number; endMs: number; text: string; speakerLabel?: string | null }>(previous: T[], incoming: T[]): void {
  const normalize = (text: string) => text.replace(/[\s，。！？、；：「」『』]/gu, "").toLowerCase();
  const preceding = [...previous];
  for (const item of incoming) {
    const text = normalize(item.text);
    // Chunk-local speaker labels cannot establish identity across windows. Keep
    // drifted or regrouped speech rather than deleting an uncertain utterance.
    const duplicate = text.length >= 4 && preceding.some(earlier =>
      earlier.startMs === item.startMs && earlier.endMs === item.endMs &&
      (earlier.speakerLabel ?? null) === (item.speakerLabel ?? null) &&
      normalize(earlier.text) === text);
    if (!duplicate && item.text) previous.push({ ...item });
  }
}

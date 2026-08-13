import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env";
import {
  meetingTranscriptionJobRepository,
  type MeetingTranscriptSegment,
  type MeetingTranscriptSourceId,
  type MeetingTranscriptionArtifactRecord,
  type MeetingTranscriptionArtifactType,
  type MeetingTranscriptionJobRepository,
  type MeetingTranscriptionPhase,
} from "../../storage/meeting-minutes/meetingTranscriptionJobRepository";
import {
  meetingTranscriptionProvider,
} from "./meetingTranscriptionProviderFactory";
import {
  MeetingTranscriptionError,
  type MeetingTranscriptionProviderLike,
} from "./meetingTranscriptionProvider";

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface CommandOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export type MeetingTranscriptCommandRunner = (
  command: string,
  args: string[],
  options: CommandOptions
) => Promise<CommandResult>;

export interface MeetingTranscriptProcessingInput {
  jobId: string;
  sessionId: string;
  tracks: Array<{
    sourceId: MeetingTranscriptSourceId;
    filePath: string;
  }>;
}

export interface MeetingMergedTranscriptSegment {
  segmentId: string;
  startMs: number;
  endMs: number;
  text: string;
  primarySourceId: MeetingTranscriptSourceId;
  sourceSegmentIds: string[];
  speakerLabel: string | null;
}

export interface MeetingMergedTranscriptDocument {
  version: 1;
  sessionId: string;
  language: string;
  provider: string;
  model: string;
  generatedAt: string;
  segments: MeetingMergedTranscriptSegment[];
}

export interface MeetingTranscriptProcessorLike {
  readonly enabled: boolean;
  readonly providerName: string;
  readonly model: string;
  process(
    input: MeetingTranscriptProcessingInput,
    onPhase: (phase: MeetingTranscriptionPhase) => Promise<void>,
    options?: { signal?: AbortSignal }
  ): Promise<MeetingTranscriptionArtifactRecord[]>;
  resolveArtifactPath(relativePath: string): string;
}

interface MeetingTranscriptProcessorDeps {
  repository?: MeetingTranscriptionJobRepository;
  provider?: MeetingTranscriptionProviderLike;
  processingDir?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  timeoutMs?: number;
  chunkMs?: number;
  language?: string;
  runCommand?: MeetingTranscriptCommandRunner;
  idFactory?: () => string;
  now?: () => Date;
}

interface ProbePayload {
  format?: { duration?: string };
}

function defaultRunCommand(
  command: string,
  args: string[],
  options: CommandOptions
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: options.timeoutMs,
        signal: options.signal,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new MeetingTranscriptionError(
      "逐字稿處理已因 worker 關閉而中止。",
      "MEETING_TRANSCRIPTION_ABORTED"
    );
  }
}

async function sha256File(filePath: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    throwIfAborted(signal);
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function normalizeTranscriptText(value: string): string {
  return value
    .toLocaleLowerCase("zh-TW")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function levenshteinDistance(left: string, right: string): number {
  if (!left) return right.length;
  if (!right) return left.length;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}

function transcriptTextSimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeTranscriptText(left);
  const normalizedRight = normalizeTranscriptText(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  const longest = Math.max(normalizedLeft.length, normalizedRight.length);
  return 1 - levenshteinDistance(normalizedLeft, normalizedRight) / longest;
}

function intervalsOverlapEnough(
  left: Pick<MeetingTranscriptSegment, "startMs" | "endMs">,
  right: Pick<MeetingTranscriptSegment, "startMs" | "endMs">
): boolean {
  const overlap = Math.max(
    0,
    Math.min(left.endMs, right.endMs) - Math.max(left.startMs, right.startMs)
  );
  const shortest = Math.max(
    1,
    Math.min(left.endMs - left.startMs, right.endMs - right.startMs)
  );
  return overlap / shortest >= 0.5;
}

export function mergeMeetingTranscriptSegments(
  segments: MeetingTranscriptSegment[]
): MeetingMergedTranscriptSegment[] {
  const sourceRank: Record<MeetingTranscriptSourceId, number> = {
    "remote-tab": 0,
    "room-mic": 1,
  };
  const ordered = [...segments].sort(
    (left, right) =>
      left.startMs - right.startMs ||
      sourceRank[left.sourceId] - sourceRank[right.sourceId] ||
      left.endMs - right.endMs
  );
  const merged: MeetingMergedTranscriptSegment[] = [];
  for (const segment of ordered) {
    const duplicateIndex = merged.findIndex(
      (candidate) =>
        candidate.primarySourceId !== segment.sourceId &&
        intervalsOverlapEnough(candidate, segment) &&
        transcriptTextSimilarity(candidate.text, segment.text) >= 0.88
    );
    if (duplicateIndex === -1) {
      merged.push({
        segmentId: "",
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: segment.text,
        primarySourceId: segment.sourceId,
        sourceSegmentIds: [segment.segmentId],
        speakerLabel: segment.speakerLabel,
      });
      continue;
    }
    const existing = merged[duplicateIndex];
    const preferIncoming = segment.sourceId === "remote-tab";
    merged[duplicateIndex] = {
      segmentId: "",
      startMs: Math.min(existing.startMs, segment.startMs),
      endMs: Math.max(existing.endMs, segment.endMs),
      text: preferIncoming ? segment.text : existing.text,
      primarySourceId: preferIncoming ? segment.sourceId : existing.primarySourceId,
      sourceSegmentIds: preferIncoming
        ? [segment.segmentId, ...existing.sourceSegmentIds]
        : [...existing.sourceSegmentIds, segment.segmentId],
      speakerLabel: preferIncoming ? segment.speakerLabel : existing.speakerLabel,
    };
  }
  return merged
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
    .map((segment, index) => ({ ...segment, segmentId: `merged:${index}` }));
}

function formatTimestamp(milliseconds: number): string {
  const totalSeconds = Math.floor(Math.max(0, milliseconds) / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

export class MeetingTranscriptProcessor implements MeetingTranscriptProcessorLike {
  readonly enabled: boolean;
  readonly providerName: string;
  readonly model: string;
  private readonly repository: MeetingTranscriptionJobRepository;
  private readonly provider: MeetingTranscriptionProviderLike;
  private readonly processingDir: string;
  private readonly ffmpegPath: string;
  private readonly ffprobePath: string;
  private readonly timeoutMs: number;
  private readonly chunkMs: number;
  private readonly language: string;
  private readonly runCommand: MeetingTranscriptCommandRunner;
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(deps: MeetingTranscriptProcessorDeps = {}) {
    this.repository = deps.repository ?? meetingTranscriptionJobRepository;
    this.provider = deps.provider ?? meetingTranscriptionProvider;
    this.processingDir = path.resolve(deps.processingDir ?? env.MEETING_PROCESSING_DIR);
    this.ffmpegPath = deps.ffmpegPath ?? env.MEETING_FFMPEG_PATH;
    this.ffprobePath = deps.ffprobePath ?? env.MEETING_FFPROBE_PATH;
    this.timeoutMs = deps.timeoutMs ?? env.MEETING_PROCESS_TIMEOUT_MS;
    this.chunkMs = deps.chunkMs ?? env.MEETING_TRANSCRIPTION_CHUNK_MS;
    this.language = deps.language ?? env.MEETING_TRANSCRIPTION_LANGUAGE;
    this.runCommand = deps.runCommand ?? defaultRunCommand;
    this.idFactory = deps.idFactory ?? randomUUID;
    this.now = deps.now ?? (() => new Date());
    this.enabled = this.provider.enabled;
    this.providerName = this.provider.name;
    this.model = this.provider.model;
  }

  async process(
    input: MeetingTranscriptProcessingInput,
    onPhase: (phase: MeetingTranscriptionPhase) => Promise<void>,
    options: { signal?: AbortSignal } = {}
  ): Promise<MeetingTranscriptionArtifactRecord[]> {
    if (!this.enabled) {
      throw new MeetingTranscriptionError(
        "逐字稿 provider 尚未啟用。",
        "MEETING_TRANSCRIPTION_PROVIDER_DISABLED"
      );
    }
    if (!this.ffmpegPath || !this.ffprobePath) {
      throw new MeetingTranscriptionError(
        "尚未設定 FFmpeg/FFprobe 執行檔路徑。",
        "MEETING_TRANSCRIPTION_FFMPEG_NOT_CONFIGURED"
      );
    }
    if (input.tracks.length === 0) {
      throw new MeetingTranscriptionError(
        "沒有可轉錄的 canonical 音軌。",
        "MEETING_TRANSCRIPTION_TRACKS_EMPTY"
      );
    }
    throwIfAborted(options.signal);

    await mkdir(this.processingDir, { recursive: true });
    await this.removeStaleSessionTemp(input.sessionId);
    const tempDir = path.join(
      this.processingDir,
      `.transcript-tmp-${input.sessionId}-${randomUUID()}`
    );
    const chunksDir = path.join(tempDir, "chunks");
    const outputDir = path.join(tempDir, "output");
    const finalDir = path.join(this.processingDir, input.sessionId, "transcript");
    await Promise.all([
      mkdir(chunksDir, { recursive: true }),
      mkdir(outputDir, { recursive: true }),
    ]);

    try {
      const sourceSegments = new Map<MeetingTranscriptSourceId, MeetingTranscriptSegment[]>();
      const sourceRank: Record<MeetingTranscriptSourceId, number> = {
        "room-mic": 0,
        "remote-tab": 1,
      };
      for (const track of [...input.tracks].sort(
        (left, right) => sourceRank[left.sourceId] - sourceRank[right.sourceId]
      )) {
        await onPhase(
          track.sourceId === "room-mic"
            ? "transcribing-room-mic"
            : "transcribing-remote-tab"
        );
        const durationMs = await this.probeDurationMs(track.filePath, options.signal);
        const segments: MeetingTranscriptSegment[] = [];
        const chunkCount = Math.max(1, Math.ceil(durationMs / this.chunkMs));
        for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
          throwIfAborted(options.signal);
          const startMs = chunkIndex * this.chunkMs;
          const endMs = Math.min(durationMs, startMs + this.chunkMs);
          const chunkPath = path.join(
            chunksDir,
            `${track.sourceId}-${String(chunkIndex).padStart(5, "0")}.wav`
          );
          await this.createChunk({
            inputPath: track.filePath,
            outputPath: chunkPath,
            startMs,
            endMs,
            signal: options.signal,
          });
          const audioSha256 = await sha256File(chunkPath, options.signal);
          const checkpoint = await this.repository.getChunkCheckpoint(
            input.jobId,
            track.sourceId,
            chunkIndex,
            audioSha256
          );
          if (checkpoint) {
            segments.push(...checkpoint.segments);
            continue;
          }
          const providerSegments = await this.provider.transcribe({
            audioPath: chunkPath,
            mimeType: "audio/wav",
            sourceId: track.sourceId,
            language: this.language,
            durationMs: endMs - startMs,
            signal: options.signal,
          });
          const normalized = providerSegments.map((segment, segmentIndex) => ({
            segmentId: `${track.sourceId}:${chunkIndex}:${segmentIndex}`,
            sourceId: track.sourceId,
            startMs: startMs + segment.startMs,
            endMs: startMs + segment.endMs,
            text: segment.text,
            speakerLabel: segment.speakerLabel
              ? `${track.sourceId}:chunk-${String(chunkIndex).padStart(5, "0")}:${segment.speakerLabel}`
              : null,
            confidence: segment.confidence,
          }));
          await this.repository.saveChunkCheckpoint({
            jobId: input.jobId,
            sessionId: input.sessionId,
            sourceId: track.sourceId,
            chunkIndex,
            startMs,
            endMs,
            audioSha256,
            segments: normalized,
            now: this.now().toISOString(),
          });
          segments.push(...normalized);
        }
        sourceSegments.set(track.sourceId, segments);
      }

      await onPhase("merging-transcript");
      const allSegments = [...sourceSegments.values()].flat();
      const mergedSegments = mergeMeetingTranscriptSegments(allSegments);
      const generatedAt = this.now().toISOString();
      const artifacts: Array<{
        type: MeetingTranscriptionArtifactType;
        mimeType: string;
        filename: string;
        contents: string;
      }> = [];
      for (const sourceId of ["room-mic", "remote-tab"] as const) {
        const segments = sourceSegments.get(sourceId);
        if (!segments) continue;
        artifacts.push({
          type:
            sourceId === "room-mic"
              ? "transcript-room-mic-json"
              : "transcript-remote-tab-json",
          mimeType: "application/json; charset=utf-8",
          filename: `${sourceId}.json`,
          contents: JSON.stringify(
            {
              version: 1,
              sessionId: input.sessionId,
              sourceId,
              language: this.language,
              provider: this.providerName,
              model: this.model,
              generatedAt,
              segments,
            },
            null,
            2
          ),
        });
      }
      const mergedDocument: MeetingMergedTranscriptDocument = {
        version: 1,
        sessionId: input.sessionId,
        language: this.language,
        provider: this.providerName,
        model: this.model,
        generatedAt,
        segments: mergedSegments,
      };
      artifacts.push(
        {
          type: "transcript-merged-json",
          mimeType: "application/json; charset=utf-8",
          filename: "merged.json",
          contents: JSON.stringify(mergedDocument, null, 2),
        },
        {
          type: "transcript-text",
          mimeType: "text/plain; charset=utf-8",
          filename: "transcript.txt",
          contents: `${mergedSegments
            .map((segment) => {
              const source = segment.primarySourceId === "remote-tab" ? "遠端" : "現場";
              const speaker = segment.speakerLabel ? ` ${segment.speakerLabel}` : "";
              return `[${formatTimestamp(segment.startMs)}] [${source}${speaker}] ${segment.text}`;
            })
            .join("\n")}\n`,
        }
      );
      for (const artifact of artifacts) {
        await writeFile(path.join(outputDir, artifact.filename), artifact.contents, "utf8");
      }
      await mkdir(path.dirname(finalDir), { recursive: true });
      await rm(finalDir, { recursive: true, force: true });
      await rename(outputDir, finalDir);

      const records: MeetingTranscriptionArtifactRecord[] = [];
      for (const artifact of artifacts) {
        const filePath = path.join(finalDir, artifact.filename);
        const fileStat = await stat(filePath);
        records.push({
          artifactId: this.idFactory(),
          jobId: input.jobId,
          sessionId: input.sessionId,
          type: artifact.type,
          mimeType: artifact.mimeType,
          relativePath: path.relative(this.processingDir, filePath),
          sizeBytes: fileStat.size,
          sha256: await sha256File(filePath, options.signal),
          createdAt: generatedAt,
        });
      }
      return records;
    } catch (error) {
      if (error instanceof MeetingTranscriptionError) throw error;
      const code =
        error && typeof error === "object" && "code" in error && error.code
          ? String(error.code)
          : "MEETING_TRANSCRIPTION_FAILED";
      throw new MeetingTranscriptionError(
        error instanceof Error ? error.message : String(error),
        code
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  resolveArtifactPath(relativePath: string): string {
    const resolved = path.resolve(this.processingDir, relativePath);
    if (
      resolved !== this.processingDir &&
      !resolved.startsWith(`${this.processingDir}${path.sep}`)
    ) {
      throw new MeetingTranscriptionError(
        "逐字稿 artifact 路徑不合法。",
        "MEETING_TRANSCRIPTION_ARTIFACT_PATH_INVALID"
      );
    }
    return resolved;
  }

  private async probeDurationMs(filePath: string, signal?: AbortSignal): Promise<number> {
    const result = await this.runCommand(
      this.ffprobePath,
      ["-v", "error", "-show_entries", "format=duration", "-of", "json", filePath],
      { timeoutMs: this.timeoutMs, signal }
    );
    let payload: ProbePayload;
    try {
      payload = JSON.parse(result.stdout) as ProbePayload;
    } catch {
      throw new MeetingTranscriptionError(
        "FFprobe 回傳的音訊長度無法解析。",
        "MEETING_TRANSCRIPTION_FFPROBE_INVALID"
      );
    }
    const durationMs = Math.ceil(Number(payload.format?.duration) * 1_000);
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new MeetingTranscriptionError(
        "canonical 音軌沒有有效長度。",
        "MEETING_TRANSCRIPTION_AUDIO_INVALID"
      );
    }
    return durationMs;
  }

  private async createChunk(input: {
    inputPath: string;
    outputPath: string;
    startMs: number;
    endMs: number;
    signal?: AbortSignal;
  }): Promise<void> {
    await this.runCommand(
      this.ffmpegPath,
      [
        "-nostdin",
        "-v",
        "error",
        "-ss",
        (input.startMs / 1_000).toFixed(3),
        "-t",
        ((input.endMs - input.startMs) / 1_000).toFixed(3),
        "-i",
        input.inputPath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-y",
        input.outputPath,
      ],
      { timeoutMs: this.timeoutMs, signal: input.signal }
    );
    const output = await stat(input.outputPath).catch(() => null);
    if (!output || output.size <= 0) {
      throw new MeetingTranscriptionError(
        "FFmpeg 沒有產生有效的轉錄片段。",
        "MEETING_TRANSCRIPTION_CHUNK_MISSING"
      );
    }
  }

  private async removeStaleSessionTemp(sessionId: string): Promise<void> {
    const entries = await readdir(this.processingDir, { withFileTypes: true });
    const prefix = `.transcript-tmp-${sessionId}-`;
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
        .map((entry) =>
          rm(path.join(this.processingDir, entry.name), { recursive: true, force: true })
        )
    );
  }
}

export const meetingTranscriptProcessor = new MeetingTranscriptProcessor();

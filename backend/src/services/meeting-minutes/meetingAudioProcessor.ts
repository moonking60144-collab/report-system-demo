import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env";
import type {
  MeetingProcessingArtifactRecord,
  MeetingProcessingArtifactType,
  MeetingProcessingPhase,
} from "../../storage/meeting-minutes/meetingProcessingJobRepository";
import type {
  MeetingAudioSourceId,
  MeetingRecordingProcessingInput,
} from "./meetingRecordingStorageService";

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface CommandOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export type MeetingAudioCommandRunner = (
  command: string,
  args: string[],
  options: CommandOptions
) => Promise<CommandResult>;

export interface MeetingAudioProcessorLike {
  process(
    input: MeetingRecordingProcessingInput,
    onPhase: (phase: MeetingProcessingPhase) => Promise<void>,
    options?: { signal?: AbortSignal }
  ): Promise<MeetingProcessingArtifactRecord[]>;
  resolveArtifactPath(relativePath: string): string;
  cleanupTrash(): Promise<void>;
  removeSessionAudioArtifacts(sessionId: string): Promise<boolean>;
}

interface MeetingAudioProcessorDeps {
  processingDir?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  timeoutMs?: number;
  runCommand?: MeetingAudioCommandRunner;
  idFactory?: () => string;
  now?: () => Date;
}

interface ProbePayload {
  streams?: Array<{ codec_type?: string }>;
}

export class MeetingAudioProcessingError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = "MeetingAudioProcessingError";
  }
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

function canonicalArtifactType(sourceId: MeetingAudioSourceId): MeetingProcessingArtifactType {
  return sourceId === "room-mic" ? "canonical-room-mic" : "canonical-remote-tab";
}

async function sha256File(filePath: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    if (signal?.aborted) {
      throw new MeetingAudioProcessingError(
        "後處理已因 worker 關閉而中止。",
        "MEETING_PROCESSING_ABORTED"
      );
    }
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function isCommandTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (
    ("code" in error && error.code === "ETIMEDOUT") ||
    ("killed" in error && error.killed === true)
  );
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

export class MeetingAudioProcessor implements MeetingAudioProcessorLike {
  private readonly processingDir: string;
  private readonly trashDir: string;
  private readonly ffmpegPath: string;
  private readonly ffprobePath: string;
  private readonly timeoutMs: number;
  private readonly runCommand: MeetingAudioCommandRunner;
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(deps: MeetingAudioProcessorDeps = {}) {
    this.processingDir = path.resolve(deps.processingDir ?? env.MEETING_PROCESSING_DIR);
    this.trashDir = path.join(this.processingDir, ".trash");
    this.ffmpegPath = deps.ffmpegPath ?? env.MEETING_FFMPEG_PATH;
    this.ffprobePath = deps.ffprobePath ?? env.MEETING_FFPROBE_PATH;
    this.timeoutMs = deps.timeoutMs ?? env.MEETING_PROCESS_TIMEOUT_MS;
    this.runCommand = deps.runCommand ?? defaultRunCommand;
    this.idFactory = deps.idFactory ?? randomUUID;
    this.now = deps.now ?? (() => new Date());
  }

  async process(
    input: MeetingRecordingProcessingInput,
    onPhase: (phase: MeetingProcessingPhase) => Promise<void>,
    options: { signal?: AbortSignal } = {}
  ): Promise<MeetingProcessingArtifactRecord[]> {
    if (!this.ffmpegPath || !this.ffprobePath) {
      throw new MeetingAudioProcessingError(
        "尚未設定 FFmpeg/FFprobe 執行檔路徑。",
        "MEETING_PROCESSING_FFMPEG_NOT_CONFIGURED"
      );
    }
    if (input.tracks.length === 0) {
      throw new MeetingAudioProcessingError(
        "錄音沒有可處理的音軌。",
        "MEETING_PROCESSING_TRACKS_EMPTY"
      );
    }
    if (options.signal?.aborted) {
      throw new MeetingAudioProcessingError(
        "後處理已因 worker 關閉而中止。",
        "MEETING_PROCESSING_ABORTED"
      );
    }

    await mkdir(this.processingDir, { recursive: true });
    const tempDir = path.join(this.processingDir, `.tmp-${input.sessionId}-${randomUUID()}`);
    const finalDir = path.join(this.processingDir, input.sessionId);
    await mkdir(tempDir, { recursive: false });

    try {
      await onPhase("validating-audio");
      for (const track of input.tracks) {
        await this.assertAudioTrack(track.filePath, options.signal);
      }

      const canonicalFiles: Array<{
        sourceId: MeetingAudioSourceId;
        filePath: string;
        filename: string;
      }> = [];
      for (const track of input.tracks) {
        await onPhase(
          track.sourceId === "room-mic"
            ? "normalizing-room-mic"
            : "normalizing-remote-tab"
        );
        const filename = `${track.sourceId}.wav`;
        const outputPath = path.join(tempDir, filename);
        await this.runCommand(
          this.ffmpegPath,
          [
            "-nostdin",
            "-v",
            "error",
            "-i",
            track.filePath,
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            "-y",
            outputPath,
          ],
          { timeoutMs: this.timeoutMs, signal: options.signal }
        );
        await this.assertOutput(outputPath);
        canonicalFiles.push({ sourceId: track.sourceId, filePath: outputPath, filename });
      }

      await onPhase("generating-playback");
      const playbackFile = "playback.m4a";
      const playbackPath = path.join(tempDir, playbackFile);
      const playbackArgs = ["-nostdin", "-v", "error"];
      for (const canonical of canonicalFiles) {
        playbackArgs.push("-i", canonical.filePath);
      }
      if (canonicalFiles.length > 1) {
        playbackArgs.push(
          "-filter_complex",
          `[0:a][1:a]amix=inputs=${canonicalFiles.length}:duration=longest:normalize=0[a]`,
          "-map",
          "[a]"
        );
      }
      playbackArgs.push(
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        "-y",
        playbackPath
      );
      await this.runCommand(this.ffmpegPath, playbackArgs, {
        timeoutMs: this.timeoutMs,
        signal: options.signal,
      });
      await this.assertOutput(playbackPath);

      await mkdir(finalDir, { recursive: true });
      await this.removeSessionAudioArtifacts(input.sessionId);
      for (const filename of [
        ...canonicalFiles.map((item) => item.filename),
        playbackFile,
      ]) {
        await rename(path.join(tempDir, filename), path.join(finalDir, filename));
      }
      await rm(tempDir, { recursive: true, force: true });
      const createdAt = this.now().toISOString();
      const artifactInputs = [
        ...canonicalFiles.map((item) => ({
          type: canonicalArtifactType(item.sourceId),
          mimeType: "audio/wav",
          filename: item.filename,
        })),
        { type: "playback" as const, mimeType: "audio/mp4", filename: playbackFile },
      ];
      const artifacts: MeetingProcessingArtifactRecord[] = [];
      for (const artifact of artifactInputs) {
        const filePath = path.join(finalDir, artifact.filename);
        const fileStat = await stat(filePath);
        artifacts.push({
          artifactId: this.idFactory(),
          jobId: "",
          sessionId: input.sessionId,
          type: artifact.type,
          mimeType: artifact.mimeType,
          relativePath: path.relative(this.processingDir, filePath),
          sizeBytes: fileStat.size,
          sha256: await sha256File(filePath, options.signal),
          createdAt,
        });
      }
      return artifacts;
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true });
      if (error instanceof MeetingAudioProcessingError) throw error;
      const rawCode =
        error &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string" &&
        error.code
          ? String(error.code)
          : "MEETING_PROCESSING_COMMAND_FAILED";
      throw new MeetingAudioProcessingError(
        error instanceof Error ? error.message : String(error),
        isCommandTimeout(error) ? "MEETING_PROCESSING_TIMEOUT" : rawCode
      );
    }
  }

  resolveArtifactPath(relativePath: string): string {
    const resolved = path.resolve(this.processingDir, relativePath);
    if (resolved !== this.processingDir && !resolved.startsWith(`${this.processingDir}${path.sep}`)) {
      throw new MeetingAudioProcessingError(
        "後處理產物路徑不合法。",
        "MEETING_PROCESSING_ARTIFACT_PATH_INVALID"
      );
    }
    return resolved;
  }

  async cleanupTrash(): Promise<void> {
    await mkdir(this.trashDir, { recursive: true });
    const entries = await readdir(this.trashDir, { withFileTypes: true });
    await Promise.all(
      entries.map((entry) =>
        rm(path.join(this.trashDir, entry.name), { recursive: true, force: true })
      )
    );
  }

  async removeSessionAudioArtifacts(sessionId: string): Promise<boolean> {
    const sessionDir = path.resolve(this.processingDir, sessionId);
    if (!sessionDir.startsWith(`${this.processingDir}${path.sep}`)) {
      throw new MeetingAudioProcessingError(
        "後處理 session 路徑不合法。",
        "MEETING_PROCESSING_ARTIFACT_PATH_INVALID"
      );
    }
    let entries: string[];
    try {
      entries = await readdir(sessionDir);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return false;
      throw error;
    }
    const ownedFiles = new Set(["room-mic.wav", "remote-tab.wav", "playback.m4a"]);
    const removable = entries.filter((entry) => ownedFiles.has(entry));
    await Promise.all(
      removable.map((entry) => rm(path.join(sessionDir, entry), { force: true }))
    );
    return removable.length > 0;
  }

  private async assertAudioTrack(filePath: string, signal?: AbortSignal): Promise<void> {
    const result = await this.runCommand(
      this.ffprobePath,
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type",
        "-of",
        "json",
        filePath,
      ],
      { timeoutMs: this.timeoutMs, signal }
    );
    let payload: ProbePayload;
    try {
      payload = JSON.parse(result.stdout) as ProbePayload;
    } catch {
      throw new MeetingAudioProcessingError(
        "FFprobe 回傳格式無法解析。",
        "MEETING_PROCESSING_FFPROBE_INVALID"
      );
    }
    if (!payload.streams?.some((stream) => stream.codec_type === "audio")) {
      throw new MeetingAudioProcessingError(
        "錄音檔沒有可讀取的音訊內容。",
        "MEETING_PROCESSING_AUDIO_INVALID"
      );
    }
  }

  private async assertOutput(filePath: string): Promise<void> {
    try {
      const outputStat = await stat(filePath);
      if (outputStat.size > 0) return;
    } catch {
      // 統一轉成 typed processing error。
    }
    throw new MeetingAudioProcessingError(
      "FFmpeg 沒有產生有效音訊檔。",
      "MEETING_PROCESSING_OUTPUT_MISSING"
    );
  }
}

export const meetingAudioProcessor = new MeetingAudioProcessor();

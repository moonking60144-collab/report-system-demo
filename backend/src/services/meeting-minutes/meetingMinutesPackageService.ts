import { createHash, randomUUID } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import {
  access,
  link,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";
import { env } from "../../config/env";
import type {
  MeetingMinutesArtifactRecord,
  MeetingMinutesArtifactType,
  MeetingMinutesVersionRecord,
} from "../../storage/meeting-minutes/meetingMinutesJobRepository";
import {
  renderMeetingMinutesHtml,
  type MeetingMinutesAudioFile,
} from "./meetingMinutesHtmlRenderer";
import type { MeetingRecord } from "./meetingMinutesSchema";
import type { MeetingMergedTranscriptDocument } from "./meetingTranscriptProcessor";

export interface MeetingMinutesPackageInput {
  jobId: string;
  versionId: string;
  versionNumber: number;
  sessionId: string;
  record: MeetingRecord;
  generatedAt: string;
  transcript: MeetingMergedTranscriptDocument;
  transcriptText: string;
  playbackFilePath?: string;
}

export interface MeetingMinutesPackageResult {
  packageRelativePath: string;
  artifacts: MeetingMinutesArtifactRecord[];
}

interface MeetingMinutesPackageServiceDeps {
  processingDir?: string;
  idFactory?: () => string;
}

interface PackageFile {
  type: MeetingMinutesArtifactType;
  filename: string;
  mimeType: string;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export class MeetingMinutesPackageService {
  private readonly processingDir: string;
  private readonly idFactory: () => string;

  constructor(deps: MeetingMinutesPackageServiceDeps = {}) {
    this.processingDir = path.resolve(deps.processingDir ?? env.MEETING_PROCESSING_DIR);
    this.idFactory = deps.idFactory ?? randomUUID;
  }

  async build(input: MeetingMinutesPackageInput): Promise<MeetingMinutesPackageResult> {
    const relativeDirectory = path.join(
      input.sessionId,
      "minutes",
      `v${input.versionNumber}`
    );
    const finalDirectory = this.resolvePath(relativeDirectory);
    const tempDirectory = this.resolvePath(
      path.join(".tmp", `${input.sessionId}-${input.versionId}-${this.idFactory()}`)
    );
    const sourceDirectory = path.join(tempDirectory, "source");
    const audioFiles: MeetingMinutesAudioFile[] = input.playbackFilePath
      ? [{ filename: "audio-1.m4a", label: "會議錄音" }]
      : [];
    const packageFiles: PackageFile[] = [
      { type: "minutes-html", filename: "index.html", mimeType: "text/html; charset=utf-8" },
      {
        type: "minutes-record-json",
        filename: "meeting-record.json",
        mimeType: "application/json; charset=utf-8",
      },
      {
        type: "minutes-source-transcript-json",
        filename: "source/transcript.json",
        mimeType: "application/json; charset=utf-8",
      },
      {
        type: "minutes-source-transcript-text",
        filename: "source/transcript.txt",
        mimeType: "text/plain; charset=utf-8",
      },
    ];
    if (input.playbackFilePath) {
      packageFiles.push({
        type: "minutes-audio",
        filename: "audio-1.m4a",
        mimeType: "audio/mp4",
      });
    }

    try {
      await mkdir(sourceDirectory, { recursive: true });
      await writeFile(
        path.join(tempDirectory, "index.html"),
        renderMeetingMinutesHtml({
          record: input.record,
          versionNumber: input.versionNumber,
          generatedAt: input.generatedAt,
          audioFiles,
        }),
        "utf8"
      );
      await writeFile(
        path.join(tempDirectory, "meeting-record.json"),
        `${JSON.stringify(input.record, null, 2)}\n`,
        "utf8"
      );
      await writeFile(
        path.join(sourceDirectory, "transcript.json"),
        `${JSON.stringify(input.transcript, null, 2)}\n`,
        "utf8"
      );
      await writeFile(path.join(sourceDirectory, "transcript.txt"), input.transcriptText, "utf8");
      if (input.playbackFilePath) {
        await access(input.playbackFilePath);
        await link(input.playbackFilePath, path.join(tempDirectory, "audio-1.m4a"));
      }

      await mkdir(path.dirname(finalDirectory), { recursive: true });
      await rm(finalDirectory, { recursive: true, force: true });
      await rename(tempDirectory, finalDirectory);

      const artifacts: MeetingMinutesArtifactRecord[] = [];
      for (const packageFile of packageFiles) {
        const filePath = path.join(finalDirectory, packageFile.filename);
        const fileStat = await stat(filePath);
        artifacts.push({
          artifactId: this.idFactory(),
          versionId: input.versionId,
          jobId: input.jobId,
          sessionId: input.sessionId,
          type: packageFile.type,
          filename: path.basename(packageFile.filename),
          mimeType: packageFile.mimeType,
          relativePath: path.relative(this.processingDir, filePath),
          sizeBytes: fileStat.size,
          sha256: await sha256File(filePath),
          createdAt: input.generatedAt,
        });
      }
      return { packageRelativePath: relativeDirectory, artifacts };
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }

  async resolveArtifact(
    artifact: MeetingMinutesArtifactRecord
  ): Promise<{ filePath: string; mimeType: string; sizeBytes: number }> {
    const filePath = this.resolvePath(artifact.relativePath);
    try {
      await access(filePath);
    } catch {
      throw Object.assign(new Error("會議紀錄產物已不存在。"), {
        code: "MEETING_MINUTES_ARTIFACT_MISSING",
      });
    }
    return { filePath, mimeType: artifact.mimeType, sizeBytes: artifact.sizeBytes };
  }

  async streamVersionZip(
    version: MeetingMinutesVersionRecord,
    output: Writable
  ): Promise<void> {
    if (!version.packageRelativePath) {
      throw Object.assign(new Error("會議紀錄套件尚未完成。"), {
        code: "MEETING_MINUTES_PACKAGE_NOT_READY",
      });
    }
    const directory = this.resolvePath(version.packageRelativePath);
    await access(directory);
    const { ZipArchive } = await import("archiver");
    await new Promise<void>((resolve, reject) => {
      const archive = new ZipArchive({ zlib: { level: 6 } });
      let settled = false;
      const cleanup = () => {
        output.removeListener("error", onError);
        output.removeListener("finish", onFinish);
        output.removeListener("close", onClose);
        archive.removeListener("error", onError);
      };
      const onError = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onFinish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onClose = () => {
        if (settled || output.writableFinished) return;
        archive.abort();
        onError(
          Object.assign(new Error("會議紀錄 ZIP 下載已中止。"), {
            code: "MEETING_MINUTES_PACKAGE_STREAM_ABORTED",
          })
        );
      };
      output.once("error", onError);
      archive.once("error", onError);
      output.once("finish", onFinish);
      output.once("close", onClose);
      archive.pipe(output);
      archive.directory(directory, false);
      void archive.finalize().catch((error: unknown) =>
        onError(error instanceof Error ? error : new Error(String(error)))
      );
    });
  }

  createArtifactReadStream(artifact: MeetingMinutesArtifactRecord): ReadStream {
    return createReadStream(this.resolvePath(artifact.relativePath));
  }

  async readTranscriptDocument(filePath: string): Promise<MeetingMergedTranscriptDocument> {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<MeetingMergedTranscriptDocument>;
    if (
      parsed.version !== 1 ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.language !== "string" ||
      typeof parsed.provider !== "string" ||
      typeof parsed.model !== "string" ||
      typeof parsed.generatedAt !== "string" ||
      !Array.isArray(parsed.segments)
    ) {
      throw Object.assign(new Error("合併逐字稿格式不正確。"), {
        code: "MEETING_MINUTES_TRANSCRIPT_INVALID",
      });
    }
    return parsed as MeetingMergedTranscriptDocument;
  }

  private resolvePath(relativePath: string): string {
    const resolved = path.resolve(this.processingDir, relativePath);
    if (
      resolved !== this.processingDir &&
      !resolved.startsWith(`${this.processingDir}${path.sep}`)
    ) {
      throw Object.assign(new Error("會議紀錄產物路徑不合法。"), {
        code: "MEETING_MINUTES_ARTIFACT_PATH_INVALID",
      });
    }
    return resolved;
  }
}

export const meetingMinutesPackageService = new MeetingMinutesPackageService();

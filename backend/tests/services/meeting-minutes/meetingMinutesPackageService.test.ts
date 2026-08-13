import test from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import JSZip from "jszip";
import { MeetingMinutesPackageService } from "../../../src/services/meeting-minutes/meetingMinutesPackageService";
import type { MeetingRecord } from "../../../src/services/meeting-minutes/meetingMinutesSchema";
import type { MeetingMergedTranscriptDocument } from "../../../src/services/meeting-minutes/meetingTranscriptProcessor";

const record: MeetingRecord = {
  version: 1,
  title: "品管 <script>alert(1)</script>",
  subtitle: "會議摘要",
  date: "2026-07-16",
  attendees: [],
  executiveSummary: "摘要",
  discussionPoints: [],
  confirmedFacts: [],
  confirmedDecisions: [],
  systemRequirements: [],
  pendingItems: [],
  followUpActions: [],
  uncertainTerms: [],
};

const transcript: MeetingMergedTranscriptDocument = {
  version: 1,
  sessionId: "session-1",
  language: "zh-TW",
  provider: "fake",
  model: "fake-model",
  generatedAt: "2026-07-16T01:00:00.000Z",
  segments: [],
};

test("package 原子產出固定檔案並以 hard link 收錄 playback", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "meeting-minutes-package-"));
  try {
    const playback = path.join(root, "playback.m4a");
    await writeFile(playback, Buffer.from("audio-content"));
    let id = 0;
    const service = new MeetingMinutesPackageService({
      processingDir: root,
      idFactory: () => `id-${++id}`,
    });
    const result = await service.build({
      jobId: "minutes-1",
      versionId: "version-1",
      versionNumber: 1,
      sessionId: "session-1",
      record,
      generatedAt: "2026-07-16T02:00:00.000Z",
      transcript,
      transcriptText: "[00:00:00] 測試逐字稿\n",
      playbackFilePath: playback,
    });
    assert.equal(result.packageRelativePath, "session-1/minutes/v1");
    assert.deepEqual(
      result.artifacts.map((artifact) => artifact.type).sort(),
      [
        "minutes-audio",
        "minutes-html",
        "minutes-record-json",
        "minutes-source-transcript-json",
        "minutes-source-transcript-text",
      ]
    );
    const packageDir = path.join(root, result.packageRelativePath);
    const html = await readFile(path.join(packageDir, "index.html"), "utf8");
    assert.match(html, /audio-1\.m4a/);
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    const [sourceStat, linkedStat] = await Promise.all([
      stat(playback),
      stat(path.join(packageDir, "audio-1.m4a")),
    ]);
    assert.equal(sourceStat.ino, linkedStat.ino);
    assert.equal(
      await readFile(path.join(packageDir, "source", "transcript.txt"), "utf8"),
      "[00:00:00] 測試逐字稿\n"
    );

    const zipPath = path.join(root, "minutes.zip");
    await service.streamVersionZip(
      {
        versionId: "version-1",
        jobId: "minutes-1",
        sessionId: "session-1",
        ownerId: "owner-1",
        versionNumber: 1,
        record,
        packageRelativePath: result.packageRelativePath,
        generatedAt: "2026-07-16T02:00:00.000Z",
        artifacts: result.artifacts,
      },
      createWriteStream(zipPath)
    );
    const zip = await JSZip.loadAsync(await readFile(zipPath));
    assert.deepEqual(
      Object.keys(zip.files).filter((name) => !zip.files[name]?.dir).sort(),
      [
        "audio-1.m4a",
        "index.html",
        "meeting-record.json",
        "source/transcript.json",
        "source/transcript.txt",
      ]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact resolver 阻擋 traversal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "meeting-minutes-package-path-"));
  try {
    const service = new MeetingMinutesPackageService({ processingDir: root });
    await assert.rejects(
      service.resolveArtifact({
        artifactId: "artifact-1",
        versionId: "version-1",
        jobId: "minutes-1",
        sessionId: "session-1",
        type: "minutes-html",
        filename: "index.html",
        mimeType: "text/html",
        relativePath: "../../outside.html",
        sizeBytes: 1,
        sha256: "sha",
        createdAt: "2026-07-16T02:00:00.000Z",
      }),
      /路徑不合法/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("client 中止 ZIP 下載時會結束 archive stream，不留下懸掛 Promise", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "meeting-minutes-package-abort-"));
  const service = new MeetingMinutesPackageService({ processingDir: root });
  try {
    const packageDir = path.join(root, "session-1", "minutes", "v1");
    await mkdir(packageDir, { recursive: true });
    await writeFile(path.join(packageDir, "index.html"), "x".repeat(256_000));
    const output = new PassThrough();
    output.once("data", () => output.destroy());

    await assert.rejects(
      service.streamVersionZip(
        {
          versionId: "version-1",
          jobId: "job-1",
          sessionId: "session-1",
          ownerId: "owner-1",
          versionNumber: 1,
          record,
          packageRelativePath: path.join("session-1", "minutes", "v1"),
          generatedAt: "2026-07-16T00:00:00.000Z",
          artifacts: [],
        },
        output
      ),
      { code: "MEETING_MINUTES_PACKAGE_STREAM_ABORTED" }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

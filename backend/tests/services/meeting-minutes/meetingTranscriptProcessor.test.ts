import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MeetingTranscriptProcessor,
  mergeMeetingTranscriptSegments,
  type MeetingMergedTranscriptDocument,
  type MeetingTranscriptCommandRunner,
} from "../../../src/services/meeting-minutes/meetingTranscriptProcessor";
import type { MeetingTranscriptionProviderLike } from "../../../src/services/meeting-minutes/meetingTranscriptionProvider";
import {
  MeetingTranscriptionJobRepository,
  type MeetingTranscriptSegment,
} from "../../../src/storage/meeting-minutes/meetingTranscriptionJobRepository";

test("雙音軌分段轉錄會 checkpoint，retry 跳過已完成片段並優先遠端重複語句", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "meeting-transcript-processor-"));
  const processingDir = path.join(root, "artifacts");
  const repository = new MeetingTranscriptionJobRepository(path.join(root, "metadata.sqlite3"));
  await repository.initialize();
  await repository.enqueue({
    jobId: "transcription-1",
    processingJobId: "processing-1",
    sessionId: "session-1",
    ownerId: "owner-1",
    provider: "fake",
    model: "fake-model",
    maxAttempts: 3,
    now: "2026-07-16T01:00:00.000Z",
  });
  const roomPath = path.join(root, "room.wav");
  const remotePath = path.join(root, "remote.wav");
  await Promise.all([
    writeFile(roomPath, Buffer.from("room")),
    writeFile(remotePath, Buffer.from("remote")),
  ]);
  const runCommand: MeetingTranscriptCommandRunner = async (command, args) => {
    if (command === "ffprobe") {
      return { stdout: JSON.stringify({ format: { duration: "1.2" } }), stderr: "" };
    }
    const outputPath = args.at(-1);
    assert.equal(typeof outputPath, "string");
    await writeFile(outputPath as string, Buffer.from(path.basename(outputPath as string)));
    return { stdout: "", stderr: "" };
  };
  let providerCalls = 0;
  const provider: MeetingTranscriptionProviderLike = {
    enabled: true,
    name: "fake",
    model: "fake-model",
    async transcribe(input) {
      providerCalls += 1;
      return [
        {
          startMs: 0,
          endMs: Math.min(500, input.durationMs),
          text:
            input.sourceId === "remote-tab"
              ? "遠端報告測試結果"
              : "遠端報告測試結果。",
          speakerLabel: input.sourceId === "remote-tab" ? "遠端講者" : null,
          confidence: null,
        },
      ];
    },
  };
  let id = 0;
  let nowMs = Date.parse("2026-07-16T01:00:00.000Z");
  const processor = new MeetingTranscriptProcessor({
    repository,
    provider,
    processingDir,
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    chunkMs: 1_000,
    runCommand,
    idFactory: () => `artifact-${++id}`,
    now: () => new Date(nowMs++),
  });

  try {
    const phases: string[] = [];
    const first = await processor.process(
      {
        jobId: "transcription-1",
        sessionId: "session-1",
        tracks: [
          { sourceId: "remote-tab", filePath: remotePath },
          { sourceId: "room-mic", filePath: roomPath },
        ],
      },
      async (phase) => {
        phases.push(phase);
      }
    );
    assert.equal(providerCalls, 4);
    assert.deepEqual(phases, [
      "transcribing-room-mic",
      "transcribing-remote-tab",
      "merging-transcript",
    ]);
    assert.deepEqual(
      first.map((artifact) => artifact.type),
      [
        "transcript-room-mic-json",
        "transcript-remote-tab-json",
        "transcript-merged-json",
        "transcript-text",
      ]
    );
    const mergedArtifact = first.find(
      (artifact) => artifact.type === "transcript-merged-json"
    );
    assert.ok(mergedArtifact);
    const merged = JSON.parse(
      await readFile(processor.resolveArtifactPath(mergedArtifact.relativePath), "utf8")
    ) as MeetingMergedTranscriptDocument;
    assert.equal(merged.segments.length, 2);
    assert.equal(merged.segments[0]?.primarySourceId, "remote-tab");
    assert.equal(merged.segments[0]?.sourceSegmentIds.length, 2);
    assert.equal(
      merged.segments[0]?.speakerLabel,
      "remote-tab:chunk-00000:遠端講者"
    );
    assert.equal(
      merged.segments[1]?.speakerLabel,
      "remote-tab:chunk-00001:遠端講者"
    );
    assert.notEqual(
      merged.segments[0]?.speakerLabel,
      merged.segments[1]?.speakerLabel
    );

    await processor.process(
      {
        jobId: "transcription-1",
        sessionId: "session-1",
        tracks: [
          { sourceId: "room-mic", filePath: roomPath },
          { sourceId: "remote-tab", filePath: remotePath },
        ],
      },
      async () => undefined
    );
    assert.equal(providerCalls, 4);
    assert.equal((await repository.listChunkCheckpoints("transcription-1")).length, 4);
  } finally {
    await repository.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("merge 只去除時間重疊且跨來源高度相似的內容", () => {
  const segments: MeetingTranscriptSegment[] = [
    {
      segmentId: "room:0",
      sourceId: "room-mic",
      startMs: 0,
      endMs: 2_000,
      text: "今天確認交期",
      speakerLabel: null,
      confidence: null,
    },
    {
      segmentId: "remote:0",
      sourceId: "remote-tab",
      startMs: 100,
      endMs: 2_100,
      text: "今天確認交期。",
      speakerLabel: "遠端",
      confidence: null,
    },
    {
      segmentId: "room:1",
      sourceId: "room-mic",
      startMs: 5_000,
      endMs: 6_000,
      text: "這是另一句",
      speakerLabel: null,
      confidence: null,
    },
  ];

  const merged = mergeMeetingTranscriptSegments(segments);
  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.primarySourceId, "remote-tab");
  assert.deepEqual(merged[0]?.sourceSegmentIds, ["remote:0", "room:0"]);
  assert.equal(merged[1]?.text, "這是另一句");
});

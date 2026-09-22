import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MeetingAudioProcessor,
  MeetingAudioProcessingError,
  type MeetingAudioCommandRunner,
} from "../../../src/services/meeting-minutes/meetingAudioProcessor";
import type { MeetingRecordingProcessingInput } from "../../../src/services/meeting-minutes/meetingRecordingStorageService";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

async function createHarness() {
  const root = await mkdtemp(path.join(tmpdir(), "meeting-audio-processor-"));
  const sourceDir = path.join(root, "source");
  const processingDir = path.join(root, "processing");
  const roomPath = path.join(sourceDir, "room.webm");
  const remotePath = path.join(sourceDir, "remote.webm");
  await writeFile(roomPath, "room-source", { flag: "wx" }).catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const { mkdir } = await import("node:fs/promises");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(roomPath, "room-source");
  });
  await writeFile(remotePath, "remote-source");
  const commands: Array<{ command: string; args: string[]; signal?: AbortSignal }> = [];
  const runCommand: MeetingAudioCommandRunner = async (command, args, options) => {
    commands.push({ command, args: [...args], signal: options.signal });
    if (command === "fake-ffprobe") {
      return {
        stdout: JSON.stringify({ streams: [{ codec_type: "audio" }], format: {} }),
        stderr: "",
      };
    }
    const outputPath = args.at(-1)!;
    await writeFile(outputPath, `generated:${path.basename(outputPath)}`);
    return { stdout: "", stderr: "" };
  };
  const input: MeetingRecordingProcessingInput = {
    sessionId: SESSION_ID,
    ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    title: "品管會議",
    durationMs: 1_500,
    tracks: [
      { sourceId: "room-mic", mimeType: "audio/webm", filePath: roomPath, sizeBytes: 11 },
      { sourceId: "remote-tab", mimeType: "audio/webm", filePath: remotePath, sizeBytes: 13 },
    ],
  };
  let artifactSequence = 0;
  return {
    root,
    processingDir,
    input,
    commands,
    processor: new MeetingAudioProcessor({
      processingDir,
      ffmpegPath: "fake-ffmpeg",
      ffprobePath: "fake-ffprobe",
      runCommand,
      idFactory: () => `artifact-${++artifactSequence}`,
      now: () => new Date("2026-07-15T08:00:00.000Z"),
    }),
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("雙音軌分開正規化並產生 playback，所有命令皆不經 shell", async () => {
  const harness = await createHarness();
  try {
    const phases: string[] = [];
    const controller = new AbortController();
    const artifacts = await harness.processor.process(
      harness.input,
      async (phase) => {
        phases.push(phase);
      },
      { signal: controller.signal }
    );

    assert.deepEqual(phases, [
      "validating-audio",
      "normalizing-room-mic",
      "normalizing-remote-tab",
      "generating-playback",
    ]);
    assert.deepEqual(
      artifacts.map((artifact) => artifact.type),
      ["canonical-room-mic", "canonical-remote-tab", "playback"]
    );
    assert.equal(harness.commands.filter((item) => item.command === "fake-ffprobe").length, 2);
    assert.equal(
      harness.commands
        .filter((item) => item.command === "fake-ffprobe")
        .every((item) => !item.args.includes("format=duration")),
      true
    );
    assert.equal(
      harness.commands.every((item) => item.signal === controller.signal),
      true
    );
    const normalizeCommands = harness.commands.filter(
      (item) => item.command === "fake-ffmpeg" && item.args.includes("pcm_s16le")
    );
    assert.equal(normalizeCommands.length, 2);
    assert.equal(normalizeCommands.every((item) => item.args.includes("16000")), true);
    const playbackCommand = harness.commands.find((item) =>
      item.args.some((arg) => arg.includes("amix=inputs=2:duration=longest:normalize=0[a]"))
    );
    assert.ok(playbackCommand);
    const playback = await readFile(path.join(harness.processingDir, SESSION_ID, "playback.m4a"));
    assert.equal(playback.toString(), "generated:playback.m4a");
    assert.equal(
      artifacts.find((artifact) => artifact.type === "playback")?.sha256,
      createHash("sha256").update(playback).digest("hex")
    );
  } finally {
    await harness.close();
  }
});

test("audio artifact cleanup 與重新處理都保留逐字稿及會議紀錄目錄", async () => {
  const harness = await createHarness();
  try {
    await harness.processor.process(harness.input, async () => undefined);
    const transcriptPath = path.join(
      harness.processingDir,
      SESSION_ID,
      "transcript",
      "merged.json"
    );
    const minutesPath = path.join(
      harness.processingDir,
      SESSION_ID,
      "minutes",
      "v1",
      "index.html"
    );
    await Promise.all([
      mkdir(path.dirname(transcriptPath), { recursive: true }),
      mkdir(path.dirname(minutesPath), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(transcriptPath, "transcript"),
      writeFile(minutesPath, "minutes"),
    ]);

    await harness.processor.process(harness.input, async () => undefined);
    assert.equal((await readFile(transcriptPath)).toString(), "transcript");
    assert.equal((await readFile(minutesPath)).toString(), "minutes");

    assert.equal(
      await harness.processor.removeSessionAudioArtifacts(SESSION_ID),
      true
    );
    await assert.rejects(
      readFile(path.join(harness.processingDir, SESSION_ID, "playback.m4a"))
    );
    assert.equal((await readFile(transcriptPath)).toString(), "transcript");
    assert.equal((await readFile(minutesPath)).toString(), "minutes");
    assert.equal(await harness.processor.removeSessionAudioArtifacts(SESSION_ID), false);
  } finally {
    await harness.close();
  }
});

test("FFprobe 無音訊時停止處理且不留下 final artifacts", async () => {
  const harness = await createHarness();
  try {
    const processor = new MeetingAudioProcessor({
      processingDir: harness.processingDir,
      ffmpegPath: "fake-ffmpeg",
      ffprobePath: "fake-ffprobe",
      runCommand: async () => ({ stdout: JSON.stringify({ streams: [], format: {} }), stderr: "" }),
    });
    await assert.rejects(
      processor.process(harness.input, async () => undefined),
      (error: unknown) =>
        error instanceof MeetingAudioProcessingError &&
        error.code === "MEETING_PROCESSING_AUDIO_INVALID"
    );
    await assert.rejects(readFile(path.join(harness.processingDir, SESSION_ID, "playback.m4a")));
    assert.equal((await readFile(harness.input.tracks[0]!.filePath)).toString(), "room-source");
  } finally {
    await harness.close();
  }
});

test("未設定固定 binary path 時回 typed error", async () => {
  const harness = await createHarness();
  try {
    const processor = new MeetingAudioProcessor({
      processingDir: harness.processingDir,
      ffmpegPath: "",
      ffprobePath: "",
    });
    await assert.rejects(
      processor.process(harness.input, async () => undefined),
      (error: unknown) =>
        error instanceof MeetingAudioProcessingError &&
        error.code === "MEETING_PROCESSING_FFMPEG_NOT_CONFIGURED"
    );
  } finally {
    await harness.close();
  }
});

test("execFile timeout 的 code 為 null 時仍回 typed timeout", async () => {
  const harness = await createHarness();
  try {
    const processor = new MeetingAudioProcessor({
      processingDir: harness.processingDir,
      ffmpegPath: "fake-ffmpeg",
      ffprobePath: "fake-ffprobe",
      runCommand: async () => {
        throw Object.assign(new Error("Command failed after timeout"), {
          code: null,
          killed: true,
          signal: "SIGTERM",
        });
      },
    });
    await assert.rejects(
      processor.process(harness.input, async () => undefined),
      (error: unknown) =>
        error instanceof MeetingAudioProcessingError &&
        error.code === "MEETING_PROCESSING_TIMEOUT"
    );
  } finally {
    await harness.close();
  }
});

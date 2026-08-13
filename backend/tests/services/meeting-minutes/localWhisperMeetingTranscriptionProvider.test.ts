import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AxiosRequestConfig } from "axios";
import {
  LocalWhisperMeetingTranscriptionProvider,
  type MeetingLocalWhisperHttpClient,
} from "../../../src/services/meeting-minutes/localWhisperMeetingTranscriptionProvider";
import { MeetingTranscriptionError } from "../../../src/services/meeting-minutes/meetingTranscriptionProvider";

async function createAudioFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "meeting-local-whisper-"));
  const audioPath = path.join(root, "chunk.wav");
  await writeFile(audioPath, Buffer.from("audio"));
  return { root, audioPath };
}

test("local Whisper adapter 送出模型、zh-TW、來源與術語並驗證逐字稿 segments", async () => {
  const fixture = await createAudioFixture();
  const requests: AxiosRequestConfig[] = [];
  const client: MeetingLocalWhisperHttpClient = {
    async request<T>(config: AxiosRequestConfig) {
      requests.push(config);
      return {
        status: 200,
        headers: {},
        data: {
          model: "large-v3",
          segments: [
            {
              startMs: 100,
              endMs: 900,
              text: " 品管會議開始 ",
              speakerLabel: "spk_0",
              confidence: 0.91,
            },
          ],
        } as T,
      };
    },
  };
  const provider = new LocalWhisperMeetingTranscriptionProvider({
    url: "http://whisper.internal.test/v1/transcriptions",
    token: "local-token",
    model: "large-v3",
    phrases: ["螺帽", "Funda"],
    client,
  });

  try {
    const result = await provider.transcribe({
      audioPath: fixture.audioPath,
      mimeType: "audio/wav",
      sourceId: "room-mic",
      language: "zh-TW",
      durationMs: 1_000,
    });

    assert.deepEqual(result, [
      {
        startMs: 100,
        endMs: 900,
        text: "品管會議開始",
        speakerLabel: "spk_0",
        confidence: 0.91,
      },
    ]);
    const request = requests[0];
    assert.ok(request);
    assert.equal(request.url, "http://whisper.internal.test/v1/transcriptions");
    assert.equal((request.headers as Record<string, string>).Authorization, "Bearer local-token");
    assert.ok(request.data instanceof FormData);
    assert.equal(request.data.get("language"), "zh-TW");
    assert.equal(request.data.get("sourceId"), "room-mic");
    assert.equal(request.data.get("durationMs"), "1000");
    assert.equal(request.data.get("model"), "large-v3");
    assert.deepEqual(JSON.parse(String(request.data.get("phrases"))), ["螺帽", "Funda"]);
    const audio = request.data.get("audio");
    assert.ok(audio instanceof Blob);
    assert.equal(audio.type, "audio/wav");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("local Whisper adapter 將 service error 與 model mismatch 轉成 typed error", async () => {
  const fixture = await createAudioFixture();
  try {
    const mismatch = new LocalWhisperMeetingTranscriptionProvider({
      url: "http://whisper.internal.test/v1/transcriptions",
      token: "test-token",
      model: "large-v3",
      client: {
        async request<T>() {
          return {
            status: 200,
            headers: {},
            data: { model: "large-v3-turbo", segments: [] } as T,
          };
        },
      },
    });
    await assert.rejects(
      mismatch.transcribe({
        audioPath: fixture.audioPath,
        mimeType: "audio/wav",
        sourceId: "room-mic",
        language: "zh-TW",
        durationMs: 1_000,
      }),
      (error: unknown) =>
        error instanceof MeetingTranscriptionError &&
        error.code === "MEETING_TRANSCRIPTION_LOCAL_MODEL_MISMATCH"
    );

    const busy = new LocalWhisperMeetingTranscriptionProvider({
      url: "http://whisper.internal.test/v1/transcriptions",
      token: "test-token",
      model: "large-v3",
      client: {
        async request() {
          throw Object.assign(new Error("Request failed with status code 429"), {
            isAxiosError: true,
            response: { status: 429 },
          });
        },
      },
    });
    await assert.rejects(
      busy.transcribe({
        audioPath: fixture.audioPath,
        mimeType: "audio/wav",
        sourceId: "room-mic",
        language: "zh-TW",
        durationMs: 1_000,
      }),
      { code: "MEETING_TRANSCRIPTION_LOCAL_BUSY" }
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("local Whisper adapter 專有詞最多傳送 500 筆", async () => {
  const fixture = await createAudioFixture();
  let phrases: string[] = [];
  const provider = new LocalWhisperMeetingTranscriptionProvider({
    url: "http://whisper.internal.test/v1/transcriptions",
    token: "test-token",
    model: "large-v3",
    phrases: ["x".repeat(201), ...Array.from({ length: 500 }, (_, index) => `term-${index}`)],
    client: {
      async request<T>(config: AxiosRequestConfig) {
        assert.ok(config.data instanceof FormData);
        phrases = JSON.parse(String(config.data.get("phrases"))) as string[];
        return {
          status: 200,
          headers: {},
          data: { model: "large-v3", segments: [] } as T,
        };
      },
    },
  });

  try {
    await provider.transcribe({
      audioPath: fixture.audioPath,
      mimeType: "audio/wav",
      sourceId: "room-mic",
      language: "zh-TW",
      durationMs: 1_000,
    });
    assert.equal(phrases.length, 500);
    assert.equal(phrases[0]?.length, 200);
    assert.equal(phrases.at(-1), "term-498");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

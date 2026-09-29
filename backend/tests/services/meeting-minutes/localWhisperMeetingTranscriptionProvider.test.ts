import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import type { AxiosRequestConfig } from "axios";
import {
  LocalWhisperMeetingTranscriptionProvider,
  type MeetingLocalWhisperHttpClient,
} from "../../../src/services/meeting-minutes/localWhisperMeetingTranscriptionProvider";
import { MeetingTranscriptionError } from "../../../src/services/meeting-minutes/meetingTranscriptionProvider";
import { pcmWave } from "../../../src/services/meeting-minutes/meetingLiveAudio";

async function createAudioFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "meeting-local-whisper-"));
  const audioPath = path.join(root, "chunk.wav");
  await writeFile(audioPath, Buffer.from("audio"));
  return { root, audioPath };
}

test("STT readiness 以真實 health 核對 model 與 beam，busy inference 不影響 health", async () => {
  let model="large-v3",beam=1;
  const listener=createServer((_request,response)=>{response.setHeader("Content-Type","application/json");response.end(JSON.stringify({status:"ok",model,beamSize:beam}));});
  await new Promise<void>(resolve=>listener.listen(0,"127.0.0.1",resolve));
  const address=listener.address(); assert.ok(address&&typeof address==="object");
  const provider=new LocalWhisperMeetingTranscriptionProvider({url:`http://127.0.0.1:${address.port}/v1/transcriptions`,model:"large-v3",token:"",beamSize:1});
  try {
    assert.equal(await provider.checkReady(),true);
    model="small"; assert.equal(await provider.checkReady(),false);
    model="large-v3"; beam=2; assert.equal(await provider.checkReady(),false);
  } finally {await new Promise<void>((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));}
  assert.equal(await provider.checkReady(),false);
});

test("STT 沒有 listener 時，正式 HTTP 入口回報服務無法連線而非原始 ECONNREFUSED", async () => {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const fixture = await createAudioFixture();
  const provider = new LocalWhisperMeetingTranscriptionProvider({
    url: `http://127.0.0.1:${address.port}/v1/transcriptions`, model: "large-v3", token: "", timeoutMs: 1000,
  });
  try {
    await assert.rejects(provider.transcribe({ audioPath: fixture.audioPath, mimeType: "audio/wav",
      sourceId: "room-mic", language: "zh-TW", durationMs: 1000 }),
    { code: "MEETING_TRANSCRIPTION_LOCAL_UNAVAILABLE", message: "語音轉文字服務暫時無法連線。" }, "STT_OFFLINE_CLASSIFICATION");
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

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
          beamSize: 1,
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
    phrases: ["螺帽", "DemoCo"],
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
    assert.equal(request.data.get("expectedBeamSize"), "1");
    assert.deepEqual(JSON.parse(String(request.data.get("phrases"))), ["螺帽", "DemoCo"]);
    const audio = request.data.get("audio");
    assert.ok(audio instanceof Blob);
    assert.equal(audio.type, "audio/wav");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("local Whisper adapter rounds fractional milliseconds without trimming PCM samples", async () => {
  const fixture = await createAudioFixture();
  const wave = pcmWave(Buffer.alloc(128_002, 1));
  await writeFile(fixture.audioPath, wave);
  const provider = new LocalWhisperMeetingTranscriptionProvider({
    url: "http://whisper.internal.test/v1/transcriptions", token: "test", model: "large-v3",
    client: { async request<T>(config: AxiosRequestConfig) {
      const form = config.data as FormData;
      assert.equal(form.get("durationMs"), "4001");
      assert.deepEqual(Buffer.from(await (form.get("audio") as Blob).arrayBuffer()), wave);
      return { status: 200, headers: {}, data: { model: "large-v3", beamSize: 1, segments: [] } as T };
    } },
  });
  try {
    await provider.transcribe({ audioPath: fixture.audioPath, mimeType: "audio/wav",
      sourceId: "room-mic", language: "zh-TW", durationMs: 4000.0625 });
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
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
          data: { model: "large-v3", beamSize: 1, segments: [] } as T,
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

test("local Whisper adapter rejects missing or changed effective beam instead of reusing another profile", async()=>{
  const fixture=await createAudioFixture();
  try{
    for(const beamSize of [undefined,5]){
      const provider=new LocalWhisperMeetingTranscriptionProvider({url:"http://127.0.0.1:8010/v1/transcriptions",model:"large-v3",beamSize:1,
        client:{request:async<T>()=>({status:200,headers:{},data:{model:"large-v3",beamSize,segments:[]} as T})}});
      await assert.rejects(provider.transcribe({audioPath:fixture.audioPath,mimeType:"audio/wav",sourceId:"room-mic",language:"zh-TW",durationMs:1000}),{code:"MEETING_TRANSCRIPTION_LOCAL_PROFILE_MISMATCH"});
    }
  }finally{await rm(fixture.root,{recursive:true,force:true});}
});

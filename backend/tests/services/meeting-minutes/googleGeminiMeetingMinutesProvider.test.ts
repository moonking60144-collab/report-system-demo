import assert from "node:assert/strict";
import test from "node:test";
import type { AxiosRequestConfig } from "axios";
import {
  GoogleGeminiMeetingMinutesProvider,
  type MeetingMinutesGoogleHttpClient,
} from "../../../src/services/meeting-minutes/googleGeminiMeetingMinutesProvider";
import {
  MEETING_RECORD_JSON_SCHEMA,
  type MeetingRecord,
} from "../../../src/services/meeting-minutes/meetingMinutesSchema";

function collectObjectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectObjectKeys);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
    key,
    ...collectObjectKeys(child),
  ]);
}

function record(): MeetingRecord {
  return {
    version: 1,
    title: "模型標題",
    date: null,
    subtitle: "品質流程討論",
    attendees: [],
    executiveSummary: "討論品質流程。",
    discussionPoints: [],
    confirmedFacts: [],
    confirmedDecisions: [],
    systemRequirements: [],
    pendingItems: [],
    followUpActions: [],
    uncertainTerms: [],
    sourceEvidence: [],
  };
}

function input() {
  return {
    transcript: {
      version: 1 as const,
      sessionId: "session-1",
      language: "zh-TW",
      provider: "fake",
      model: "fake",
      generatedAt: "2026-07-16T01:00:00.000Z",
      segments: [
        {
          segmentId: "merged:0",
          startMs: 0,
          endMs: 1000,
          text: "門檻是五趴",
          primarySourceId: "room-mic" as const,
          sourceSegmentIds: ["room:0"],
          speakerLabel: null,
        },
      ],
    },
    human: {
      title: "品管會議",
      date: "2026/07/14",
      attendees: "品管：課長",
      confirmedFacts: "不良率門檻是 3%",
      confirmedDecisions: "達 3% 強制管控",
      termCorrections: "五趴 -> 3%",
      otherNotes: "",
    },
  };
}

test("Google 正式入口拒絕 schema 合法但沒有來源引用的決議", async () => {
  const provider = new GoogleGeminiMeetingMinutesProvider({ apiKey: "test", client: {
    async request<T>() { return { status: 200, headers: {}, data: { output_text: JSON.stringify({ ...record(), confirmedDecisions: [{ content: "已定案", sourceBasis: null }], sourceEvidence: [] }) } as T }; },
  } });
  await assert.rejects(() => provider.summarize(input()), { code: "MEETING_MINUTES_GOOGLE_FAILED", message: "record.confirmedDecisions[0] 缺少原文引用" }, "ADAPTER_SOURCE_GATE");
});

test("Google 修訂正式入口切換 prompt、分離指令並拒絕無法再次修訂的 metadata", async () => {
  const source = input();
  const revisionInput = { ...source, human: { ...source.human, revisionRequest: "只改標題。", revisionConfirmedFacts: "人工確認模具已交付。", previousSummary: "舊草稿" } };
  let generated = record();
  const provider = new GoogleGeminiMeetingMinutesProvider({ apiKey: "test", client: {
    async request<T>(config: AxiosRequestConfig) {
      const sent = config.data;
      assert.match(sent.system_instruction, /必須輸出 title、date、confirmedFacts/);
      const payload = JSON.parse(sent.input[0].text);
      assert.equal(payload.revisionRequest, revisionInput.human.revisionRequest);
      assert.equal(payload.humanConfirmedInput.revisionRequest, undefined);
      assert.equal(payload.humanConfirmedInput.previousSummary, undefined);
      return { status: 200, headers: {}, data: { output_text: JSON.stringify(generated) } as T };
    },
  } });
  assert.equal((await provider.summarize(revisionInput)).title, generated.title);
  for (const metadata of [{ title: "模".repeat(201) }, { date: "2".repeat(41) }]) {
    generated = { ...record(), ...metadata };
    await assert.rejects(() => provider.summarize(revisionInput), error => error instanceof Error && /超過修訂上限/.test(error.message), "GOOGLE_REVISION_METADATA_LIMIT");
  }
});

test("provider 使用 current Interactions structured output 並只回傳已驗證的模型資料", async () => {
  const requests: Record<string, unknown>[] = [];
  const client: MeetingMinutesGoogleHttpClient = {
    async request<T>(config: AxiosRequestConfig) {
      requests.push(config.data as Record<string, unknown>);
      return {
        status: 200,
        headers: {},
        data: { output_text: JSON.stringify(record()) } as T,
      };
    },
  };
  const provider = new GoogleGeminiMeetingMinutesProvider({
    apiKey: "test-key",
    model: "gemini-test",
    client,
  });

  const output = await provider.summarize(input());

  const sent = requests[0];
  assert.ok(sent);
  assert.equal(sent.store, false);
  assert.equal((sent.response_format as { type?: string }).type, "text");
  assert.equal(
    (sent.response_format as { mime_type?: string }).mime_type,
    "application/json"
  );
  const googleSchema = (sent.response_format as { schema?: unknown }).schema;
  const googleSchemaKeys = collectObjectKeys(googleSchema);
  assert.equal(googleSchemaKeys.includes("maxLength"), false);
  assert.equal(googleSchemaKeys.includes("minLength"), false);
  assert.equal(googleSchemaKeys.includes("pattern"), false);
  assert.equal(googleSchemaKeys.includes("description"), true);
  assert.equal(googleSchemaKeys.includes("maxItems"), false);
  assert.equal(googleSchemaKeys.includes("additionalProperties"), true);
  assert.equal(collectObjectKeys(MEETING_RECORD_JSON_SCHEMA).includes("maxLength"), true);
  assert.equal(collectObjectKeys(MEETING_RECORD_JSON_SCHEMA).includes("maxItems"), true);
  assert.equal(output.title, "模型標題");
  assert.deepEqual(output.confirmedFacts, []);
  assert.deepEqual(output.confirmedDecisions, []);
});

test("Google schema 不帶數量上限時，正式入口仍拒絕超量結果", async () => {
  const provider = new GoogleGeminiMeetingMinutesProvider({ apiKey: "test", client: {
    async request<T>() {
      return { status: 200, headers: {}, data: { output_text: JSON.stringify({ ...record(), uncertainTerms: Array.from({ length: 101 }, () => "待確認") }) } as T };
    },
  } });
  await assert.rejects(() => provider.summarize(input()), { code: "MEETING_MINUTES_GOOGLE_FAILED", message: "record.uncertainTerms 項目數超過上限" });
});

test("provider 將 malformed JSON 與輸入上限轉成 typed error", async () => {
  const client: MeetingMinutesGoogleHttpClient = {
    async request<T>() {
      return { status: 200, headers: {}, data: { output_text: "not-json" } as T };
    },
  };
  const provider = new GoogleGeminiMeetingMinutesProvider({
    apiKey: "test-key",
    client,
  });
  await assert.rejects(() => provider.summarize(input()), {
    code: "MEETING_MINUTES_GOOGLE_FAILED",
  });

  const limited = new GoogleGeminiMeetingMinutesProvider({
    apiKey: "test-key",
    client,
    maxInputCharacters: 10,
  });
  await assert.rejects(() => limited.summarize(input()), {
    code: "MEETING_MINUTES_INPUT_TOO_LARGE",
  });
});

test("provider 將 Google 400 轉成可辨識的請求格式錯誤", async () => {
  const client: MeetingMinutesGoogleHttpClient = {
    async request() {
      throw Object.assign(new Error("Request failed with status code 400"), {
        isAxiosError: true,
        response: { status: 400 },
      });
    },
  };
  const provider = new GoogleGeminiMeetingMinutesProvider({
    apiKey: "test-key",
    client,
  });

  await assert.rejects(() => provider.summarize(input()), {
    code: "MEETING_MINUTES_GOOGLE_INVALID_REQUEST",
    message: "Google 會議紀錄請求格式無效。",
  });
});

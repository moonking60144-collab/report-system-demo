import assert from "node:assert/strict";
import test from "node:test";
import type { AxiosRequestConfig } from "axios";
import {
  MiniMaxMeetingMinutesProvider,
  type MeetingMiniMaxHttpClient,
} from "../../../src/services/meeting-minutes/minimaxMeetingMinutesProvider";
import type { MeetingRecord } from "../../../src/services/meeting-minutes/meetingMinutesSchema";

function collectObjectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectObjectKeys);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
    key,
    ...collectObjectKeys(child),
  ]);
}

const immediateScheduler = {
  run<T>(worker: () => Promise<T>): Promise<T> {
    return worker();
  },
};

const meetingRecord: MeetingRecord = {
  version: 1,
  title: "品管會議",
  date: "2026-07-16",
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
};

function input() {
  return {
    transcript: {
      version: 1 as const,
      sessionId: "session-1",
      language: "zh-TW",
      provider: "azure-speech",
      model: "fast-transcription-2025-10-15",
      generatedAt: "2026-07-16T01:00:00.000Z",
      segments: [
        {
          segmentId: "merged:0",
          startMs: 0,
          endMs: 1_000,
          text: "不良率門檻是百分之三",
          primarySourceId: "room-mic" as const,
          sourceSegmentIds: ["room-mic:0"],
          speakerLabel: "spk_0",
        },
      ],
    },
    human: {
      title: "品管會議",
      date: "2026-07-16",
      attendees: "品管：課長",
      confirmedFacts: "不良率門檻是 3%",
      confirmedDecisions: "達 3% 強制管控",
      termCorrections: "百分之三 -> 3%",
      otherNotes: "",
    },
  };
}

test("MiniMax adapter 使用 Messages structured output 並驗證 MeetingRecord", async () => {
  const requests: AxiosRequestConfig[] = [];
  const client: MeetingMiniMaxHttpClient = {
    async request<T>(config: AxiosRequestConfig) {
      requests.push(config);
      return {
        status: 200,
        headers: {},
        data: {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              name: "submit_meeting_record",
              input: meetingRecord,
            },
          ],
        } as T,
      };
    },
  };
  const provider = new MiniMaxMeetingMinutesProvider({
    apiKey: "minimax-key",
    model: "MiniMax-M3",
    maxOutputTokens: 12_000,
    baseUrl: "https://minimax.example/anthropic/",
    client,
    scheduler: immediateScheduler,
  });

  const result = await provider.summarize(input());

  assert.equal(result.title, "品管會議");
  const request = requests[0];
  assert.ok(request);
  assert.equal(request.url, "https://minimax.example/anthropic/v1/messages");
  assert.equal((request.headers as Record<string, string>)["x-api-key"], "minimax-key");
  assert.equal(
    (request.headers as Record<string, string>)["anthropic-version"],
    "2023-06-01"
  );
  const data = request.data as {
    model: string;
    max_tokens: number;
    thinking: { type: string };
    messages: Array<{
      role: string;
      content: Array<{ type: string; text: string }>;
    }>;
    tools: Array<{ name: string; input_schema: unknown }>;
    tool_choice: { type: string; name: string };
  };
  assert.equal(data.model, "MiniMax-M3");
  assert.equal(data.max_tokens, 12_000);
  assert.deepEqual(data.thinking, { type: "adaptive" });
  assert.match(data.messages[0]?.content[0]?.text ?? "", /不良率門檻是百分之三/);
  assert.equal(data.tools[0]?.name, "submit_meeting_record");
  assert.deepEqual(data.tool_choice, {
    type: "tool",
    name: "submit_meeting_record",
  });
  assert.equal(
    collectObjectKeys(data.tools[0]?.input_schema).includes("maxLength"),
    true
  );
  assert.equal(
    collectObjectKeys(data.tools[0]?.input_schema).includes("maxItems"),
    true
  );
});

test("MiniMax adapter 將 token 截斷、400 與 429 轉成 typed error", async () => {
  const truncated = new MiniMaxMeetingMinutesProvider({
    apiKey: "minimax-key",
    scheduler: immediateScheduler,
    client: {
      async request<T>() {
        return {
          status: 200,
          headers: {},
          data: { stop_reason: "max_tokens", content: [] } as T,
        };
      },
    },
  });
  await assert.rejects(() => truncated.summarize(input()), {
    code: "MEETING_MINUTES_MINIMAX_OUTPUT_TRUNCATED",
  });

  const missingTool = new MiniMaxMeetingMinutesProvider({
    apiKey: "minimax-key",
    scheduler: immediateScheduler,
    client: {
      async request<T>() {
        return {
          status: 200,
          headers: {},
          data: {
            stop_reason: "end_turn",
            content: [{ type: "text", text: "not a tool result" }],
          } as T,
        };
      },
    },
  });
  await assert.rejects(() => missingTool.summarize(input()), {
    code: "MEETING_MINUTES_MINIMAX_BAD_RESPONSE",
  });

  for (const [status, code] of [
    [400, "MEETING_MINUTES_MINIMAX_INVALID_REQUEST"],
    [429, "MEETING_MINUTES_MINIMAX_RATE_LIMITED"],
  ] as const) {
    const provider = new MiniMaxMeetingMinutesProvider({
      apiKey: "minimax-key",
      scheduler: immediateScheduler,
      client: {
        async request() {
          throw Object.assign(new Error(`Request failed with status code ${status}`), {
            isAxiosError: true,
            response: { status },
          });
        },
      },
    });
    await assert.rejects(() => provider.summarize(input()), { code });
  }
});

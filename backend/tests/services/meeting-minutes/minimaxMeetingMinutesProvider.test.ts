import assert from "node:assert/strict";
import test from "node:test";
import type { AxiosRequestConfig } from "axios";
import {
  estimateMiniMaxRequestInputTokenUpperBound,
  MiniMaxMeetingMinutesProvider,
  type MeetingMiniMaxHttpClient,
} from "../../../src/services/meeting-minutes/minimaxMeetingMinutesProvider";
import type { MeetingRecord } from "../../../src/services/meeting-minutes/meetingMinutesSchema";
import { isMeetingMinutesFailureRetryable } from "../../../src/services/meeting-minutes/meetingMinutesRetryPolicy";

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
  sourceEvidence: [],
};

function wireRecord() {
  const { version, title, date, attendees, confirmedFacts, sourceEvidence, ...content } = meetingRecord;
  return { ...content, additionalSections: [] };
}

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
              input: wireRecord(),
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
  const schema = data.tools[0]?.input_schema as { properties: { subtitle: { minLength: number; pattern: string } } };
  assert.equal(schema.properties.subtitle.minLength, 1, "PROVIDER_NONEMPTY_SUBTITLE");
  assert.equal(new RegExp(schema.properties.subtitle.pattern).test("  "), false);
  assert.match((request.data as { system: string }).system, /錄音過短/);
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

test("MiniMax 不得回傳由程式負責的 attendees 欄位", async () => {
  const provider = new MiniMaxMeetingMinutesProvider({
    apiKey: "test-key",
    model: "MiniMax-M2.7-highspeed",
    scheduler: immediateScheduler,
    client: { async request<T>() {
      return { status: 200, headers: {}, data: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "submit_meeting_record", input: { ...wireRecord(), attendees: "" } }] } as T };
    } },
  });
  await assert.rejects(() => provider.summarize(input()), { code: "MEETING_MINUTES_MINIMAX_FAILED", message: "MiniMax.attendees 不是允許的生成欄位" });
});

test("MiniMax 正式入口拒絕 schema 合法但沒有來源引用的決議", async () => {
  const provider = new MiniMaxMeetingMinutesProvider({ apiKey: "test", scheduler: immediateScheduler,
    client: { async request<T>() { return { status: 200, headers: {}, data: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "submit_meeting_record", input: { ...wireRecord(), confirmedDecisions: [{ content: "已定案", sourceBasis: null, sourceSpanIds: [] }] } }] } as T }; } },
  });
  await assert.rejects(() => provider.summarize(input()), { code: "MEETING_MINUTES_MINIMAX_FAILED", message: "record.confirmedDecisions[0] 缺少原文引用" }, "ADAPTER_SOURCE_GATE");
});

test("MiniMax 誤報 tool_use 但耗盡輸出額度且 record 缺欄位時回報截斷", async () => {
  const provider = new MiniMaxMeetingMinutesProvider({ apiKey: "test", maxOutputTokens: 1000, scheduler: immediateScheduler,
    client: { async request<T>() { return { status: 200, headers: {}, data: { stop_reason: "tool_use", usage: { input_tokens: 2000, output_tokens: 1000 }, content: [{ type: "tool_use", name: "submit_meeting_record", input: { title: "未完成" } }] } as T }; } },
  });
  await assert.rejects(() => provider.summarize(input()), { code: "MEETING_MINUTES_MINIMAX_OUTPUT_TRUNCATED" });
});

test("MiniMax 修復請求限流不沿用前次輸出額度，仍允許自動重試", async () => {
  let calls = 0;
  const provider = new MiniMaxMeetingMinutesProvider({
    apiKey: "test", maxOutputTokens: 1000, scheduler: immediateScheduler,
    client: { async request<T>() {
      calls++;
      if (calls === 1) return {
        status: 200, headers: {}, data: {
          stop_reason: "tool_use", usage: { input_tokens: 2000, output_tokens: 1000 },
          content: [{ type: "tool_use", name: "submit_meeting_record", input: { title: "未完成" } }],
        } as T,
      };
      throw Object.assign(new Error("Request failed with status code 429"), {
        isAxiosError: true, response: { status: 429 },
      });
    } },
  });
  await assert.rejects(() => provider.summarize(input()), (error: unknown) => {
    const code = (error as { code: string }).code;
    assert.equal(code, "MEETING_MINUTES_MINIMAX_RATE_LIMITED");
    assert.equal(isMeetingMinutesFailureRetryable(code), true);
    return true;
  });
  assert.equal(calls, 2);
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

test("超 budget 才走分段，全部原文進入 chunk，合併仍引用原始證據並傳入跨段修正", async () => {
  const full=input(); full.human.confirmedDecisions="";
  full.transcript.segments=Array.from({length:4},(_,index)=>({...full.transcript.segments[0]!,segmentId:`merged:${index}`,startMs:index*1000,endMs:(index+1)*1000,text:`原始段落${index}：${"討論供應商交期尚未確認。".repeat(10)}`,sourceSegmentIds:[`room-mic:${index}`]}));
  full.transcript.segments[3]!.text+="撤回前面的交期決議，改為等待供應商確認。";
  const seen: Array<Record<string,unknown>>=[];
  const client:MeetingMiniMaxHttpClient={async request<T>(config:AxiosRequestConfig){
    const payload=JSON.parse(config.data.messages[0].content[0].text);
    seen.push(payload);
    const span=payload.sourceBlocks.find((b:{sourceId:string})=>!b.sourceId.startsWith("human.")).spans[0][0];
    return {status:200,headers:{},data:{stop_reason:"tool_use",content:[{type:"tool_use",name:"submit_meeting_record",input:{...wireRecord(),executiveSummary:payload.chunkDrafts?"整場仍待確認":JSON.stringify(payload).includes("撤回")?"後續撤回交期決議，仍待確認":"交期待確認",confirmedDecisions:[{content:"先確認交期",sourceBasis:null,sourceSpanIds:[span]}]}}]} as T};
  }};
  const provider=new MiniMaxMeetingMinutesProvider({apiKey:"test",scheduler:immediateScheduler,client,contextWindowTokens:100,maxOutputTokens:20,contextSafetyTokens:10,estimateInputTokens:request=>{
    const payload=JSON.parse((request as {messages:Array<{content:Array<{text:string}>}>}).messages[0]!.content[0]!.text);
    return payload.chunkDrafts?60:payload.sourceBlocks.flatMap((b:{spans:Array<[string,string]>})=>b.spans).map((s:[string,string])=>s[1]).join("").length>400?71:60;
  }});
  const result=await provider.summarize(full);
  const chunks=seen.filter(p=>!p.chunkDrafts);
  assert.equal(chunks.length,2); assert.equal(seen.length,3,"NORMAL_INPUT_USES_ONE_CALL_FALLBACK_ONLY_ON_BUDGET");
  const raw=chunks.flatMap(p=>(p.sourceBlocks as Array<{sourceId:string;spans:Array<[string,string]>}>).filter(b=>!b.sourceId.startsWith("human.")).flatMap(b=>b.spans.map(s=>s[1]))).join("");
  for(const segment of full.transcript.segments) assert.ok(raw.includes(segment.text),"ALL_RAW_TEXT_REACHES_CHUNKS");
  assert.equal((seen.at(-1)!.chunkDrafts as unknown[]).length,2);
  assert.ok(JSON.stringify(seen.at(-1)!.chunkDrafts).includes("後續撤回"),"LATER_CORRECTION_REACHES_FINAL_MERGE");
  assert.ok(result.sourceEvidence?.every(e=>e.segmentIds?.every(id=>full.transcript.segments.some(s=>s.segmentId===id))),"MERGED_EVIDENCE_TRACES_ORIGINAL");
});

test("MiniMax initial request 以完整 envelope 獨立檢查 context budget，超額時不發 API", async () => {
  let calls = 0;
  const provider = new MiniMaxMeetingMinutesProvider({
    apiKey: "test",
    contextWindowTokens: 100,
    maxOutputTokens: 20,
    contextSafetyTokens: 10,
    estimateInputTokens: () => 71,
    inputTokenEstimatorName: "fixture",
    scheduler: immediateScheduler,
    client: {
      async request<T>() {
        calls++;
        return { status: 200, headers: {}, data: {} as T };
      },
    },
  });
  await assert.rejects(() => provider.summarize(input()), {
    code: "MEETING_MINUTES_MINIMAX_CONTEXT_BUDGET_EXCEEDED",
  });
  assert.equal(calls, 0, "OVER_BUDGET_REQUEST_NEVER_REACHES_PROVIDER");
});

test("分段摘要收到中止後不再提交後續 chunk 或合併", async () => {
  const full = input();
  full.transcript.segments = [0, 1].map(index => ({ ...full.transcript.segments[0]!, segmentId: `merged:${index}`, startMs: index * 60000, endMs: index * 60000 + 1000 }));
  const controller = new AbortController();
  let calls = 0;
  const provider = new MiniMaxMeetingMinutesProvider({
    apiKey: "test", scheduler: immediateScheduler,
    contextWindowTokens: 100, maxOutputTokens: 20, contextSafetyTokens: 10,
    estimateInputTokens: request => JSON.parse((request as { messages: Array<{ content: Array<{ text: string }> }> }).messages[0]!.content[0]!.text).sourceBlocks.filter((block: { sourceId: string }) => !block.sourceId.startsWith("human.")).length > 1 ? 71 : 60,
    client: { async request<T>() {
      calls++;
      controller.abort();
      return { status: 200, headers: {}, data: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "submit_meeting_record", input: wireRecord() }] } as T };
    } },
  });
  await assert.rejects(provider.summarize(full, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 1, "CANCEL_STOPS_REMAINING_CHUNKS_AND_MERGE");
});

test("分段規劃超過上限時在任何 AI 呼叫前明確失敗", async () => {
  const full = input();
  full.transcript.segments = Array.from({ length: 33 }, (_, index) => ({ ...full.transcript.segments[0]!, segmentId: `merged:${index}`, startMs: index * 60000, endMs: index * 60000 + 1000 }));
  let calls = 0;
  const provider = new MiniMaxMeetingMinutesProvider({
    apiKey: "test", scheduler: immediateScheduler,
    contextWindowTokens: 100, maxOutputTokens: 20, contextSafetyTokens: 10,
    estimateInputTokens: request => JSON.parse((request as { messages: Array<{ content: Array<{ text: string }> }> }).messages[0]!.content[0]!.text).sourceBlocks.filter((block: { sourceId: string }) => !block.sourceId.startsWith("human.")).length > 1 ? 71 : 60,
    client: { async request<T>() { calls++; return { status: 200, headers: {}, data: {} as T }; } },
  });
  await assert.rejects(provider.summarize(full), { code: "MEETING_MINUTES_MINIMAX_CONTEXT_BUDGET_EXCEEDED" });
  assert.equal(calls, 0, "NO_PARTIAL_AI_WORK_WHEN_CHUNK_PLAN_EXCEEDS_LIMIT");
});

test("MiniMax repair request 重新計入原 evidence、validation error 與 draft，不沿用 initial budget", async () => {
  let calls = 0;
  const estimates: number[] = [];
  const provider = new MiniMaxMeetingMinutesProvider({
    apiKey: "test",
    contextWindowTokens: 100,
    maxOutputTokens: 20,
    contextSafetyTokens: 10,
    estimateInputTokens: (request) => {
      const messages = (request as { messages: unknown[] }).messages;
      const estimate = messages.length === 1 ? 70 : 71;
      estimates.push(estimate);
      return estimate;
    },
    inputTokenEstimatorName: "fixture",
    scheduler: immediateScheduler,
    client: {
      async request<T>() {
        calls++;
        return {
          status: 200,
          headers: {},
          data: {
            stop_reason: "tool_use",
            content: [{
              type: "tool_use",
              name: "submit_meeting_record",
              input: {
                ...wireRecord(),
                confirmedDecisions: [{
                  content: "來源錯誤",
                  sourceBasis: null,
                  sourceSpanIds: ["b999.s1"],
                }],
              },
            }],
          } as T,
        };
      },
    },
  });
  await assert.rejects(() => provider.summarize(input()), {
    code: "MEETING_MINUTES_MINIMAX_CONTEXT_BUDGET_EXCEEDED",
  });
  assert.deepEqual(estimates, [70, 71]);
  assert.equal(calls, 1, "REPAIR_BUDGET_FAILURE_STOPS_SECOND_API_CALL");
});

test("MiniMax payload character guard 檢查完整 request，與 token context guard 分開", async () => {
  let calls = 0;
  const provider = new MiniMaxMeetingMinutesProvider({
    apiKey: "test",
    maxInputCharacters: 100,
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 20,
    contextSafetyTokens: 10,
    scheduler: immediateScheduler,
    client: {
      async request<T>() {
        calls++;
        return { status: 200, headers: {}, data: {} as T };
      },
    },
  });
  await assert.rejects(() => provider.summarize(input()), {
    code: "MEETING_MINUTES_INPUT_TOO_LARGE",
  });
  assert.equal(calls, 0);
  assert.ok(
    estimateMiniMaxRequestInputTokenUpperBound({ text: "繁體中文" }) >
      JSON.stringify({ text: "繁體中文" }).length,
    "UTF8_BYTE_UPPER_BOUND_DIFFERS_FROM_CHARACTER_COUNT"
  );
});

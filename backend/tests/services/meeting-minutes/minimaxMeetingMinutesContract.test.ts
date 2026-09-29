import assert from "node:assert/strict";
import type { AxiosRequestConfig } from "axios";
import test from "node:test";
import { prepareMiniMaxMeetingMinutesRequest, MINIMAX_MEETING_RECORD_JSON_SCHEMA } from "../../../src/services/meeting-minutes/minimaxMeetingMinutesContract";
import { buildMeetingMinutesSourceBlocks } from "../../../src/services/meeting-minutes/meetingMinutesSources";
import { applyMeetingMinutesHumanOverrides, MEETING_RECORD_JSON_SCHEMA, normalizeMeetingMinutesHumanInput, type MeetingMinutesProviderInput } from "../../../src/services/meeting-minutes/meetingMinutesSchema";
import { MiniMaxMeetingMinutesProvider } from "../../../src/services/meeting-minutes/minimaxMeetingMinutesProvider";
import { renderMeetingMinutesHtml } from "../../../src/services/meeting-minutes/meetingMinutesHtmlRenderer";

function input(text = "原先提出先發布再簽核。最後改成先簽核再發布。") : MeetingMinutesProviderInput {
  return { human: normalizeMeetingMinutesHumanInput({ title: "人工標題", date: "2026-09-10", attendees: "行政：王明", confirmedFacts: "人工確認資料已齊全" }), transcript: {
    version: 1, sessionId: "mini-contract", language: "zh-TW", provider: "fixture", model: "fixture", generatedAt: "2026-09-10",
    segments: [{ segmentId: "s1", startMs: 0, endMs: 0, text, primarySourceId: "room-mic", sourceSegmentIds: ["s1"], speakerLabel: null }],
  } };
}

function wire() {
  return { subtitle: "發布流程", executiveSummary: "最後改為先簽核再發布。", discussionPoints: [], confirmedDecisions: [{ content: "先簽核再發布", sourceBasis: null, sourceSpanIds: ["b1.s1"] }],
    systemRequirements: [], pendingItems: [], followUpActions: [], uncertainTerms: [], additionalSections: [],
  };
}

test("修訂 schema 支援明確標題日期更正，人工事實只引用使用者且不被舊 overrides 蓋回", () => {
  const source = input();
  source.human = normalizeMeetingMinutesHumanInput({ ...source.human, confirmedFacts: "", confirmedDecisions: "舊決議",
    revisionRequest: "標題改為模具改善會議，日期改9/18。", revisionConfirmedFacts: "人工確認模具已交付。",
    previousSummary: JSON.stringify({ title: "人工標題", date: "2026-09-10" }) });
  const prepared = prepareMiniMaxMeetingMinutesRequest(source);
  assert.equal(prepared.schema.properties.title!.maxLength, 200);
  assert.equal(prepared.schema.properties.date!.maxLength, 40);
  const candidate = { ...wire(), title: "模具改善會議", date: "2026-09-18",
    confirmedFacts: [{ content: "模具已交付", sourceBasis: "錄音", sourceSpanIds: ["b2.s1"] }] };
  const resolved = applyMeetingMinutesHumanOverrides(prepared.resolve(candidate), source.human);
  assert.equal(resolved.title, candidate.title);
  assert.equal(resolved.date, candidate.date);
  assert.equal(resolved.confirmedDecisions[0].content, "先簽核再發布", "OLD_MANUAL_DECISION_NOT_REAPPLIED");
  assert.equal(resolved.confirmedFacts[0].sourceBasis, "使用者補充／確認");
  assert.equal(resolved.sourceEvidence!.find(row => row.section === "confirmedFacts")!.sourceId, "human.revisionConfirmedFacts");
  assert.throws(() => prepared.resolve({ ...candidate, confirmedFacts: [{ ...candidate.confirmedFacts[0], sourceSpanIds: ["b1.s1"] }] }), /人工確認事實只能引用明確/);
  assert.throws(() => prepared.resolve({ ...candidate, confirmedFacts: [{ ...candidate.confirmedFacts[0], sourceSpanIds: ["b999.s1"] }] }), /不存在於本次原文/);
  assert.throws(() => prepared.resolve({ ...candidate, attendees: [] }), /不是允許的生成欄位/);
  assert.throws(() => prepared.resolve({ ...candidate, title: "模".repeat(201) }), /超過修訂上限/);
  assert.throws(() => prepared.resolve({ ...candidate, date: "2".repeat(41) }), /超過修訂上限/);
});

for (const revision of [false, true]) {
  test(`正式 MiniMax request 的 system、schema、payload 一致（${revision ? "修訂" : "首次"}）`, async () => {
    const source = input();
    if (revision) source.human = normalizeMeetingMinutesHumanInput({ ...source.human, revisionRequest: "標題改模具會議，日期改9/18。",
      revisionConfirmedFacts: "供應商已確認模具交付。", otherNotes: "交期可能下週，尚未確認。", previousSummary: "原草稿" });
    let requests = 0;
    const provider = new MiniMaxMeetingMinutesProvider({ apiKey: "test", scheduler: { run: worker => worker() }, client: {
      async request<T>(config: AxiosRequestConfig) {
        requests++;
        const sent = config.data as { system: string; tools: Array<{ input_schema: { required: string[]; properties: Record<string, unknown> } }>; messages: Array<{ content: Array<{ text: string }> }> };
        const schema = sent.tools[0]!.input_schema;
        const payload = JSON.parse(sent.messages[0]!.content[0]!.text);
        for (const key of ["title", "date", "confirmedFacts"]) assert.equal(schema.required.includes(key), revision, "REQUEST_SCHEMA_MODE");
        if (revision) {
          assert.match(sent.system, /必須輸出 title、date、confirmedFacts/, "REVISION_SYSTEM_REQUIRES_SCHEMA_FIELDS");
          assert.doesNotMatch(sent.system, /不要輸出這些欄位/, "NO_INITIAL_PROTECTED_FIELD_RULE");
          assert.equal(payload.revisionRequest, source.human.revisionRequest);
          assert.equal(payload.humanConfirmedInput.revisionRequest, undefined, "INSTRUCTION_NOT_CONFIRMED_INPUT");
          assert.equal(payload.humanConfirmedInput.otherNotes, undefined);
          assert.equal(payload.otherNotes, source.human.otherNotes);
          assert.equal(payload.humanConfirmedInput.revisionConfirmedFacts, source.human.revisionConfirmedFacts);
          assert.ok(!payload.sourceBlocks.some((block: { sourceId: string }) => block.sourceId === "human.revisionRequest"), "NO_INSTRUCTION_EVIDENCE");
        } else {
          assert.match(sent.system, /version、title、date、attendees、confirmedFacts.*不要輸出這些欄位/, "INITIAL_PROTECTED_RULE");
          assert.doesNotMatch(sent.system, /必須輸出 title、date、confirmedFacts/);
        }
        const candidate = revision ? { ...wire(), title: "模具會議", date: "2026-09-18",
          confirmedFacts: [{ content: "模具交付已確認", sourceBasis: null, sourceSpanIds: ["b3.s1"] }] } : wire();
        return { status: 200, headers: {}, data: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "submit_meeting_record", input: candidate }] } as T };
      },
    } });
    const result = await provider.summarize(source);
    assert.equal(requests, 1, "NO_SCHEMA_REPAIR_NEEDED");
    assert.equal(result.title, revision ? "模具會議" : "人工標題");
  });
}

test("備註與修訂指令不能被升格為人工確認事實", () => {
  const source = input();
  source.human = normalizeMeetingMinutesHumanInput({ ...source.human, confirmedFacts: "", revisionRequest: "請把交期移到待確認，不要新增已確認事實。",
    otherNotes: "供應商說下週可能交貨，尚未確認。", previousSummary: "原草稿" });
  const blocks = buildMeetingMinutesSourceBlocks(source);
  assert.ok(blocks.every(block => !block.text.includes(source.human.revisionRequest!)), "REVISION_DIRECTIVE_NOT_EVIDENCE");
  const prepared = prepareMiniMaxMeetingMinutesRequest(source);
  assert.equal(prepared.schema.properties.confirmedFacts?.maxItems, 0, "NO_EXPLICIT_FACT_INPUT");
  assert.throws(() => prepared.resolve({ ...wire(), title: source.human.title, date: source.human.date,
    confirmedFacts: [{ content: "下週交貨已確認", sourceBasis: null, sourceSpanIds: ["b2.s1"] }] }), /人工確認事實只能引用明確/, "NOTES_ARE_NOT_CONFIRMED_FACTS");
});

test("MiniMax 短片段逐來源無損重組，保留字形、空白、順序與 emoji", () => {
  for (const text of ["", " ", "原文\n繁體和简体保持原樣。", "字".repeat(199) + "😀" + "文".repeat(1800), "甲".repeat(201), "甲。乙？丙\n".repeat(200), "甲".repeat(200) + "後天交件。\n", "甲".repeat(190) + " ".repeat(400) + "尾段\n"]) {
    const source = input(text);
    source.transcript.segments.push({ ...source.transcript.segments[0], segmentId: "s2", text: "第二路來源" });
    const prepared = prepareMiniMaxMeetingMinutesRequest(source);
    const parsed = JSON.parse(prepared.serializedInput);
    const blocks = parsed.sourceBlocks as Array<{ id: string; sourceId: string; spans: Array<[string | null, string]> }>;
    assert.equal(blocks.filter(b => b.sourceId === "room-mic").flatMap(b => b.spans.map(s => s[1])).join(""), text + "第二路來源", "MINIMAX_TRANSCRIPT_SPAN_LOSSLESS");
    assert.equal(blocks.filter(b => b.sourceId === "human.confirmedFacts").flatMap(b => b.spans.map(s => s[1])).join(""), source.human.confirmedFacts, "MINIMAX_HUMAN_SPAN_LOSSLESS");
    assert.deepEqual([...new Set(buildMeetingMinutesSourceBlocks(source).flatMap(block => block.segmentSpans.map(span => span.segmentId)))], text.length > 0 ? ["s1", "s2"] : ["s2"], "SERVER_TRACE_PRESERVES_NONEMPTY_SEGMENTS");
    const spans = blocks.flatMap(b => b.spans);
    const selectable = spans.filter(s => s[0] !== null);
    assert.equal(new Set(selectable.map(s => s[0])).size, selectable.length);
    for (const [id, value] of spans) {
      if (id) assert.doesNotThrow(() => prepared.resolve({ ...wire(), confirmedDecisions: [{ ...wire().confirmedDecisions[0], sourceSpanIds: [id] }] }), "SELECTABLE_SPAN_VALIDATES");
      assert.ok(value.length <= 200);
      assert.doesNotMatch(value, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
  }
});

test("模型只選片段，程式填入完整原句及人工欄位，既有 HTML 可使用", () => {
  const source = input();
  const prepared = prepareMiniMaxMeetingMinutesRequest(source);
  const result = prepared.resolve(wire());
  assert.equal(result.title, "人工標題");
  assert.equal(result.date, "2026-09-10");
  assert.deepEqual(result.attendees, [{ department: "行政", names: ["王明"] }]);
  assert.deepEqual(result.confirmedFacts, [{ content: "人工確認資料已齊全", sourceBasis: "使用者確認" }]);
  assert.equal(result.sourceEvidence![0].quote, source.transcript.segments[0].text, "SPAN_RESOLVES_ORIGINAL");
  assert.equal(result.sourceEvidence![0].blockId, "b1");
  assert.deepEqual(result.sourceEvidence![0].segmentIds, ["s1"]);
  assert.deepEqual(result.sourceEvidence![0].sourceSegmentIds, ["s1"]);
  assert.equal(result.sourceEvidence![0].sourceId, "room-mic");
  assert.equal(result.sourceEvidence![0].blockStart, 0);
  assert.equal(result.sourceEvidence![0].blockEnd, source.transcript.segments[0].text.length);
  const html = renderMeetingMinutesHtml({ record: result, versionNumber: 1, generatedAt: "2026-09-10", audioFiles: [], includeAudio: false });
  assert.ok(html.includes("人工標題") && html.includes("先簽核再發布"));
  assert.ok(!html.includes("spanId"));
  assert.deepEqual(applyMeetingMinutesHumanOverrides(result, { ...source.human, confirmedDecisions: "人工確認的最終決議" }).sourceEvidence, []);
});

test("人工決議只有空編號時保留 AI 決議及原文引用", () => {
  const source = input();
  const result = prepareMiniMaxMeetingMinutesRequest(source).resolve(wire());
  const overridden = applyMeetingMinutesHumanOverrides(result, { ...source.human, confirmedDecisions: "1.\n2." });
  assert.deepEqual(overridden.confirmedDecisions, result.confirmedDecisions);
  assert.deepEqual(overridden.sourceEvidence, result.sourceEvidence, "EMPTY_HUMAN_DECISIONS_KEEP_EVIDENCE");
});

test("新 MiniMax 契約拒絕偽造來源、人工欄位、額外引用欄位與不完整輸出", () => {
  const prepared = prepareMiniMaxMeetingMinutesRequest(input());
  for (const key of ["version", "title", "date", "attendees", "confirmedFacts"]) {
    assert.throws(() => prepared.resolve({ ...wire(), [key]: "模型自行填入" }), /不是允許的生成欄位/, "HUMAN_FIELDS_OWNED_BY_CODE");
    assert.equal(Object.hasOwn(MINIMAX_MEETING_RECORD_JSON_SCHEMA.properties, key), false);
    assert.equal(Object.hasOwn(MEETING_RECORD_JSON_SCHEMA.properties as object, key), true);
  }
  for (const sourceSpanIds of [["b999.s1"], [null], [], Array(11).fill("b1.s1")]) {
    assert.throws(() => prepared.resolve({ ...wire(), confirmedDecisions: [{ ...wire().confirmedDecisions[0], sourceSpanIds }] }), /sourceSpanIds|缺少原文引用/);
  }
  assert.throws(() => prepared.resolve({ ...wire(), confirmedDecisions: [{ ...wire().confirmedDecisions[0], quote: "自行改寫" }] }), /quote 不是允許的欄位/);
  assert.throws(() => prepared.resolve({ ...wire(), sourceEvidence: [] }), /不是允許的生成欄位/);
  assert.throws(() => prepared.resolve({ ...wire(), uncertainTerms: [{ content: "錯誤型別" }] }), /必須是字串/);
  const { additionalSections, ...missing } = wire();
  assert.throws(() => prepared.resolve(missing), /additionalSections 為必填/);
  assert.throws(() => prepareMiniMaxMeetingMinutesRequest(input("   ")).resolve(wire()), /sourceSpanIds 含不存在/);
});

test("引用隨決議與工作建立索引，不接受省略或跨項目手填索引", () => {
  const source = input();
  source.transcript.segments.push({ ...source.transcript.segments[0], segmentId: "s2", startMs: 60_000, endMs: 61_000, text: "請行政整理檔案清單，下週三交付。" });
  const prepared = prepareMiniMaxMeetingMinutesRequest(source);
  const candidate = { ...wire(), followUpActions: [
    { content: "整理清單", owner: "行政", dueDate: "下週三", sourceSpanIds: ["b2.s1"] },
    { content: "按簽核流程發布", owner: null, dueDate: null, sourceSpanIds: ["b1.s1"] },
  ] };
  const result = prepared.resolve(candidate);
  assert.deepEqual(result.sourceEvidence?.map(e => [e.section, e.itemIndex, e.blockId, e.quote]), [
    ["confirmedDecisions", 0, "b1", source.transcript.segments[0].text],
    ["followUpActions", 0, "b2", source.transcript.segments[1].text],
    ["followUpActions", 1, "b1", source.transcript.segments[0].text],
  ], "INLINE_EVIDENCE_MAPPING");
  assert.throws(() => prepared.resolve({ ...candidate, followUpActions: [candidate.followUpActions[0], { content: "缺引用", owner: null, dueDate: null }] }), /followUpActions\[1\] 缺少原文引用/);
  assert.throws(() => prepared.resolve({ ...candidate, followUpActions: [{ ...candidate.followUpActions[0], itemIndex: 5 }] }), /itemIndex 不是允許的欄位/);
});

test("正式 adapter 用發送時的原文與人工資料解析，原物件後續異動不污染結果", async () => {
  const source = input();
  const original = source.transcript.segments[0].text;
  const provider = new MiniMaxMeetingMinutesProvider({ apiKey: "test", scheduler: { run: worker => worker() }, client: {
    async request<T>() {
      source.transcript.segments[0].text = "已被外部替换的來源";
      source.human.title = "新標題";
      source.human.confirmedFacts = "新的人工事實";
      return { status: 200, headers: {}, data: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "submit_meeting_record", input: wire() }] } as T };
    },
  } });
  const result = await provider.summarize(source);
  assert.equal(result.title, "人工標題", "CAPTURED_HUMAN_INPUT");
  assert.equal(result.confirmedFacts[0].content, "人工確認資料已齊全");
  assert.equal(result.sourceEvidence![0].quote, original, "CAPTURED_SOURCE_INPUT");
});

test("正式 adapter 拒絕未知片段編號，不會替換成其他來源", async () => {
  let calls = 0;
  const provider = new MiniMaxMeetingMinutesProvider({ apiKey: "test", scheduler: { run: worker => worker() }, client: {
    async request<T>() { calls++; return { status: 200, headers: {}, data: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "submit_meeting_record", input: { ...wire(), confirmedDecisions: [{ ...wire().confirmedDecisions[0], sourceSpanIds: ["b999.s1"] }] } }] } as T }; },
  } });
  await assert.rejects(() => provider.summarize(input()), { code: "MEETING_MINUTES_MINIMAX_FAILED", message: "MiniMax.sourceSpanIds 含不存在於本次原文的片段" }, "ADAPTER_SPAN_GATE");
  assert.equal(calls,2,"ONLY_ONE_VALIDATION_REPAIR");
});

test("未知引用以原始資料加錯誤原因修正一次，仍須通過同一來源驗證", async () => {
  const requests: unknown[]=[];
  const provider=new MiniMaxMeetingMinutesProvider({apiKey:"test",scheduler:{run:worker=>worker()},client:{
    async request<T>(config: AxiosRequestConfig) {
      requests.push(config.data);
      const record=requests.length===1 ? {...wire(),confirmedDecisions:[{...wire().confirmedDecisions[0],sourceSpanIds:["b999.s1"]}]} : wire();
      return {status:200,headers:{},data:{stop_reason:"tool_use",content:[{type:"tool_use",name:"submit_meeting_record",input:record}]} as T};
    }
  }});
  const result=await provider.summarize(input());
  assert.equal(requests.length,2);
  const second=requests[1] as {messages:Array<{content:Array<{text:string}>}>};
  const repair=JSON.parse(second.messages[1].content[0].text);
  assert.match(repair.validationError,/sourceSpanIds/);
  assert.deepEqual(repair.draft.confirmedDecisions[0].sourceSpanIds,["b999.s1"]);
  assert.equal(result.sourceEvidence![0].blockId,"b1");
});

test("小型原文 schema 列出有效引用，長原文不無限制複製 enum", () => {
  const source=input();
  const prepared=prepareMiniMaxMeetingMinutesRequest(source);
  const ids=prepared.schema.properties.confirmedDecisions.items.properties.sourceSpanIds.items.enum;
  assert.ok(ids?.includes("b1.s1"));assert.ok(!ids?.includes("b999.s1"));
  source.transcript.segments=Array.from({length:3000},(_,i)=>({...source.transcript.segments[0],segmentId:`source-${i}`}));
  assert.equal(prepareMiniMaxMeetingMinutesRequest(source).schema.properties.confirmedDecisions.items.properties.sourceSpanIds.items.enum,undefined);
});

test("46,290 字短 segments 合併 evidence blocks 後保留全文與 trace，並降低 serialized overhead", () => {
  const text = "甲乙丙丁戊己庚辛壬癸".repeat(4_629).slice(0, 46_290);
  const source = input("");
  source.human.confirmedFacts = "";
  source.transcript.segments = [];
  for (let offset = 0; offset < text.length; offset += 20) {
    const index = source.transcript.segments.length;
    source.transcript.segments.push({
      segmentId: `merged:${index}`,
      startMs: index * 5_000,
      endMs: (index + 1) * 5_000,
      text: text.slice(offset, offset + 20),
      primarySourceId: "room-mic",
      sourceSegmentIds: [`room-mic:0:${index}`],
      speakerLabel: null,
    });
  }
  const prepared = prepareMiniMaxMeetingMinutesRequest(source);
  const parsed = JSON.parse(prepared.serializedInput) as {
    sourceBlocks: Array<{ sourceId: string; spans: Array<[string | null, string]> }>;
  };
  assert.equal(parsed.sourceBlocks.flatMap(block => block.spans.map(span => span[1])).join(""), text, "COMPACTED_WIRE_KEEPS_RAW_TEXT");
  for (const block of parsed.sourceBlocks) {
    assert.deepEqual(
      Object.keys(block).sort(),
      ["endMs", "id", "sourceId", "spans", "startMs"],
      "MINIMAX_WIRE_EXCLUDES_INTERNAL_SEGMENT_METADATA"
    );
  }
  assert.equal(prepared.metrics.transcriptCharacters, 46_290);
  assert.equal(prepared.metrics.transcriptSegmentCount, 2_315);
  assert.ok(prepared.metrics.evidenceBlockCount <= 40);
  assert.ok(prepared.metrics.serializedCharacters < 65_000, "SERIALIZED_REPRESENTATION_OVERHEAD_IS_BOUNDED");
  const blocks = buildMeetingMinutesSourceBlocks(source);
  assert.equal(blocks.flatMap(block => block.segmentSpans).length, source.transcript.segments.length);
  assert.deepEqual(blocks[0].segmentSpans[0], {
    segmentId: "merged:0",
    sourceSegmentIds: ["room-mic:0:0"],
    sourceId: "room-mic",
    speakerLabel: null,
    startMs: 0,
    endMs: 5_000,
    blockStart: 0,
    blockEnd: 20,
  });
});

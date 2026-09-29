import assert from "node:assert/strict";
import test from "node:test";
import { buildMeetingMinutesSourceBlocks, resolveMeetingMinutesSourceRange, validateMeetingMinutesProviderRecord } from "../../../src/services/meeting-minutes/meetingMinutesSources";
import { applyMeetingMinutesHumanOverrides, normalizeMeetingMinutesHumanInput, type MeetingMinutesProviderInput, type MeetingRecord } from "../../../src/services/meeting-minutes/meetingMinutesSchema";
import { buildMeetingMinutesProviderInput } from "../../../src/services/meeting-minutes/meetingMinutesProviderPrompt";

function input(text = "原提案：檢查後才入帳。後續修正：收貨先入帳，再檢查與分類。") : MeetingMinutesProviderInput {
  return { human: normalizeMeetingMinutesHumanInput({ title: "合成流程會議" }), transcript: {
    version: 1, sessionId: "source-contract", language: "zh-TW", provider: "fixture", model: "fixture", generatedAt: "2026-09-10",
    segments: [{ segmentId: "s1", startMs: 0, endMs: 0, text, primarySourceId: "room-mic", sourceSegmentIds: ["s1"], speakerLabel: null }],
  } };
}

function record(): MeetingRecord {
  return { version: 1, title: "流程會議", date: null, subtitle: "收貨流程", executiveSummary: "依後段修正辦理。", attendees: [],
    discussionPoints: [], confirmedFacts: [], confirmedDecisions: [{ content: "收貨先入帳，再檢查與分類。", sourceBasis: null }],
    systemRequirements: [], pendingItems: [], followUpActions: [], uncertainTerms: [], additionalSections: [],
    sourceEvidence: [{ section: "confirmedDecisions", itemIndex: 0, blockId: "b1", quote: "後續修正：收貨先入帳，再檢查與分類。" }],
  };
}

test("來源分段保留每一字元、順序與原始 offset，不切斷 emoji", () => {
  for (const text of ["", " ", "字".repeat(1199) + "😀" + "文".repeat(2500), ("甲。乙？丙\n".repeat(900))]) {
    const source = input(text);
    const blocks = buildMeetingMinutesSourceBlocks(source);
    assert.equal(blocks.map(block => block.text).join(""), text, "LOSSLESS_SOURCE_TEXT");
    let offset = 0;
    for (const [index, block] of blocks.entries()) {
      assert.equal(block.id, `b${index + 1}`);
      assert.equal(block.offset, offset);
      assert.ok(block.text.length <= 1200);
      assert.doesNotMatch(block.text, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
      offset += block.text.length;
    }
    const serialized = JSON.parse(buildMeetingMinutesProviderInput(source));
    assert.equal(serialized.sourceBlocks.map((block: { text: string }) => block.text).join(""), text);
    for (const block of serialized.sourceBlocks) {
      assert.deepEqual(
        Object.keys(block).sort(),
        ["endMs", "id", "sourceId", "startMs", "text"],
        "GENERIC_WIRE_EXCLUDES_INTERNAL_SEGMENT_METADATA"
      );
    }
  }
});

test("引用時間依區塊內的實際字元範圍換算", () => {
  const source = input("甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉");
  source.transcript.segments[0].startMs = 1_000;
  source.transcript.segments[0].endMs = 21_000;
  const block = buildMeetingMinutesSourceBlocks(source)[0];
  assert.deepEqual(resolveMeetingMinutesSourceRange(block, 4, 12), {
    sourceId: "room-mic",
    segmentIds: ["s1"],
    sourceSegmentIds: ["s1"],
    startMs: 5_000,
    endMs: 13_000,
    blockStart: 4,
    blockEnd: 12,
  });
});

test("多路逐字稿與人工資料分別保留來源、順序、offset，區塊 id 不重複", () => {
  const source = input("上午。".repeat(450));
  source.transcript.segments.push({ ...source.transcript.segments[0], segmentId: "s2", text: "下午的新結論。".repeat(250) });
  source.human.confirmedFacts = "人工確認的現況";
  source.human.confirmedDecisions = "人工確認的決議";
  source.human.otherNotes = "人工提供的補充";
  const blocks = buildMeetingMinutesSourceBlocks(source);
  assert.equal(new Set(blocks.map(block => block.id)).size, blocks.length);
  const transcriptText = source.transcript.segments.map(segment => segment.text).join("");
  assert.deepEqual([...new Set(blocks.map(block => block.sourceId))], ["room-mic", "human.confirmedFacts", "human.confirmedDecisions", "human.otherNotes"], "ORDERED_SOURCE_IDENTITY");
  assert.equal(blocks.filter(block => block.sourceId === "room-mic").map(block => block.text).join(""), transcriptText, "TRANSCRIPT_TEXT_STAYS_LOSSLESS");
  assert.deepEqual([...new Set(blocks.flatMap(block => block.segmentSpans.map(span => span.segmentId)))], ["s1", "s2"], "BLOCK_TRACES_RAW_SEGMENTS");
  const expected = [["human.confirmedFacts", source.human.confirmedFacts], ["human.confirmedDecisions", source.human.confirmedDecisions], ["human.otherNotes", source.human.otherNotes]];
  for (const [id, text] of expected) {
    const group = blocks.filter(block => block.sourceId === id);
    assert.equal(group[0].offset, 0);
    assert.equal(group.map(block => block.text).join(""), text, "MULTI_SOURCE_LOSSLESS");
  }
});

test("引用必須存在、指向有效項目，所有決議與工作都要有來源", () => {
  const validated = validateMeetingMinutesProviderRecord(record(), input());
  assert.deepEqual({ ...validated, sourceEvidence: record().sourceEvidence }, record());
  assert.deepEqual(validated.sourceEvidence?.[0], {
    ...record().sourceEvidence![0],
    sourceId: "room-mic",
    segmentIds: ["s1"],
    sourceSegmentIds: ["s1"],
    startMs: 0,
    endMs: 0,
    blockStart: 11,
    blockEnd: 29,
  }, "CANONICAL_TRACE_IS_DERIVED_FROM_CAPTURED_SOURCE");
  const forged = record();
  Object.assign(forged.sourceEvidence![0], {
    sourceId: "remote-tab",
    segmentIds: ["fake-segment"],
    sourceSegmentIds: ["fake-source-segment"],
    startMs: 999_999,
    endMs: 1_000_000,
    blockStart: 11,
    blockEnd: 29,
  });
  assert.deepEqual(
    validateMeetingMinutesProviderRecord(forged, input()).sourceEvidence?.[0],
    validated.sourceEvidence?.[0],
    "PROVIDER_TRACE_METADATA_IS_NEVER_AUTHORITATIVE"
  );
  for (const sourceEvidence of [undefined, [], [{ section: "confirmedDecisions", itemIndex: 1, blockId: "b1", quote: "收貨先入帳" }],
    [{ section: "confirmedDecisions", itemIndex: 0, blockId: "b999", quote: "收貨先入帳" }],
    [{ section: "confirmedDecisions", itemIndex: 0, blockId: "b1", quote: "不存在的原文" }]]) {
    const candidate = { ...record(), sourceEvidence };
    assert.throws(() => validateMeetingMinutesProviderRecord(candidate, input()), /sourceEvidence|缺少原文引用/, "SOURCE_EVIDENCE_REQUIRED");
  }
  assert.throws(() => validateMeetingMinutesProviderRecord({ ...record(), confirmedFacts: "[]" }, input()), /confirmedFacts 必須是陣列/);
  assert.throws(() => validateMeetingMinutesProviderRecord({ ...record(), confirmedFacts: [{ content: "AI 自行確認", sourceBasis: null }] }, input()), /未提供人工確認事實/);
  assert.throws(() => validateMeetingMinutesProviderRecord({ ...record(), sourceEvidence: [{ section: "confirmedDecisions", itemIndex: 0, blockId: "b1", quote: "。" }] }, input()), /sourceEvidence 引句/);
  assert.throws(() => validateMeetingMinutesProviderRecord({ ...record(), followUpActions: [{ content: "檢查", owner: null, dueDate: null }] }, input()), /followUpActions.*缺少原文引用/);
});

test("人工覆寫不留下指向舊決議的引用，詞彙修正不改寫原文引句", () => {
  const human = normalizeMeetingMinutesHumanInput({ title: "正式", termCorrections: "收貨 -> 收件" });
  const result = applyMeetingMinutesHumanOverrides(record(), human);
  assert.match(result.confirmedDecisions[0].content, /收件/);
  assert.equal(result.sourceEvidence?.[0].quote, record().sourceEvidence![0].quote, "QUOTE_STAYS_ORIGINAL");
  assert.deepEqual(applyMeetingMinutesHumanOverrides(record(), { ...human, confirmedDecisions: "人工確認的其他決議" }).sourceEvidence, []);
});

test("通用修訂驗證只接受獨立確認事實來源，操作指令與備註不能作為確認依據", () => {
  const source = input();
  source.human = normalizeMeetingMinutesHumanInput({ ...source.human, revisionRequest: "請把交期移到待確認。",
    revisionHistory: "上一版請改標題。", previousSummary: "上一版 AI 草稿。", revisionConfirmedFacts: "人工確認模具已交付。",
    otherNotes: "供應商說下週可能交貨，尚未確認。" });
  const blocks = buildMeetingMinutesSourceBlocks(source);
  const factual = blocks.find(block => block.sourceId === "human.revisionConfirmedFacts")!;
  const notes = blocks.find(block => block.sourceId === "human.otherNotes")!;
  assert.ok(!blocks.some(block => /待確認。|改標題。|AI 草稿/.test(block.text)), "INSTRUCTIONS_AND_DRAFT_NOT_EVIDENCE");
  const candidate = { ...record(), confirmedFacts: [{ content: "模具已交付", sourceBasis: null }], sourceEvidence: [
    ...record().sourceEvidence!, { section: "confirmedFacts" as const, itemIndex: 0, blockId: factual.id, quote: factual.text },
  ] };
  const validated = validateMeetingMinutesProviderRecord(candidate, source);
  assert.equal(validated.confirmedFacts[0]!.sourceBasis, "使用者補充／確認");
  assert.equal(validated.sourceEvidence![1]!.sourceId, "human.revisionConfirmedFacts");
  for (const metadata of [{ title: "模".repeat(201) }, { date: "2".repeat(41) }]) {
    assert.throws(() => validateMeetingMinutesProviderRecord({ ...candidate, ...metadata }, source), /超過修訂上限/, "REVISION_METADATA_CAN_REENTER_PIPELINE");
  }
  assert.throws(() => validateMeetingMinutesProviderRecord({ ...candidate, sourceEvidence: [record().sourceEvidence![0]!,
    { section: "confirmedFacts", itemIndex: 0, blockId: notes.id, quote: notes.text },
  ] }, source), /人工確認事實只能引用明確/, "GENERIC_NOTES_NOT_CONFIRMED_FACTS");
});

test("引句存在不代表語意正確；後段修正仍由獨立案例 oracle 驗收", () => {
  const candidate = record();
  candidate.confirmedDecisions[0].content = "檢查後才入帳。";
  candidate.sourceEvidence![0].quote = "原提案：檢查後才入帳。";
  assert.doesNotThrow(() => validateMeetingMinutesProviderRecord(candidate, input()));
  const followsFinalDecision = (item: MeetingRecord) => item.confirmedDecisions.some(row => row.content.includes("收貨先入帳"));
  assert.equal(followsFinalDecision(record()), true);
  assert.equal(followsFinalDecision(candidate), false, "LATE_CORRECTION_ORACLE");
});

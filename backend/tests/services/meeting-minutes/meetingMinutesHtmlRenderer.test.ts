import assert from "node:assert/strict";
import test from "node:test";
import {
  renderMeetingMinutesHtml,
} from "../../../src/services/meeting-minutes/meetingMinutesHtmlRenderer";
import type { MeetingRecord } from "../../../src/services/meeting-minutes/meetingMinutesSchema";
import { restyleMeetingMinutesHtml } from "../../../src/services/meeting-minutes/meetingMinutesDocumentStyles";
import { meetingMinutesParagraphs } from "../../../src/services/meeting-minutes/meetingMinutesParagraphs";

function record(): MeetingRecord {
  return {
    version: 1,
    title: '品管 <script>alert("x")</script>',
    date: null,
    subtitle: "全檢與複判流程",
    attendees: [{ department: "品管", names: ["課長"] }],
    executiveSummary: "討論現況與後續方向。",
    discussionPoints: [
      {
        title: "流程問題",
        currentProblem: "資料未分流",
        discussion: "討論改善方式",
        direction: "先建立正式流程",
      },
    ],
    confirmedFacts: [{ content: "門檻是 3%", sourceBasis: "使用者確認" }],
    confirmedDecisions: [{ content: "達門檻強制管控", sourceBasis: null }],
    systemRequirements: [{ content: "新增欄位", owner: null }],
    pendingItems: [{ content: "確認單號", requiredConfirmation: null }],
    followUpActions: [{ content: "建立測試", owner: "IT", dueDate: null }],
    uncertainTerms: ["表單編號"],
  };
}

test("固定版型取消責任欄，保留期限並以簽名區取代出席名冊", () => {
  const input = record();
  input.systemRequirements = [{ content: "新增欄位", owner: "品管" }];
  input.followUpActions = [{ content: "建立測試", owner: "IT", dueDate: "2026-09-30" }];
  const html = renderMeetingMinutesHtml({ record: input, versionNumber: 1, generatedAt: "2026-09-10", audioFiles: [], includeAudio: false });
  assert.doesNotMatch(html, /責任單位：|負責：/);
  assert.match(html, /<small>期限：2026-09-30<\/small>/);
  assert.equal(html.match(/class="signature-line"/g)?.length, 1);
  assert.ok(html.indexOf('id="signatures"') < html.indexOf('id="topics"'));
  assert.doesNotMatch(html, /<h2>出席人員<\/h2>|課長/);
  const legacy = html.replace(/<section id="signatures" class="section">[\s\S]*?<\/section>/, '<section id="attendees" class="section"><h2>出席人員</h2><dl><dt>品管</dt><dd>課長</dd></dl></section>')
    .replace('<p>新增欄位</p>', '<p>新增欄位</p><small>責任單位：品管</small>')
    .replace('<small>期限：2026-09-30</small>', '<small>負責：IT<br>期限：2026-09-30</small>');
  const updated = restyleMeetingMinutesHtml(legacy);
  assert.doesNotMatch(updated, /責任單位：|負責：|課長|<h2>出席人員<\/h2>/);
  assert.match(updated, /<small>期限：2026-09-30<\/small>/);
  assert.equal(updated.match(/class="signature-line"/g)?.length, 1);
  assert.equal(restyleMeetingMinutesHtml(updated), updated);
  assert.equal(input.followUpActions[0].owner, "IT");
});

test("閱讀分段只在句尾或既有換行處切分，保留數字、引文與所有文字", () => {
  const text = '現場回報：「不良率為 3.5%，請先保留 DEMO-ORDER-1 的原始紀錄。」' +
    "先由品管確認判定基準，再請生產安排複判人力。".repeat(8) +
    "後續處理需保留時間與責任單位，不可直接視為已定案。";
  const parts = meetingMinutesParagraphs(text);
  assert.ok(parts.length > 1, "LONG_DISCUSSION_HAS_PARAGRAPHS");
  assert.equal(parts.join(""), text, "DISCUSSION_TEXT_PRESERVED");
  assert.ok(parts.every(part => /[。！？!?][」』”’]?$/.test(part)));
  assert.deepEqual(meetingMinutesParagraphs("第一段\n第二段"), ["第一段", "第二段"]);
  assert.deepEqual(meetingMinutesParagraphs("！？"), ["！？"]);
  assert.deepEqual(meetingMinutesParagraphs("沒有句尾標點".repeat(40)), ["沒有句尾標點".repeat(40)]);
});

test("既有討論段落套用閱讀分段時保留 escape，重複處理不改變結果", () => {
  const content = '原文含 &lt;script&gt;alert(1)&lt;/script&gt;，不應執行。' + "保留原始敘述與責任單位，確認後再處理。".repeat(9);
  const old = `<html><head><style>body{color:white}</style></head><body><header class="document-header"></header><section id="topics"><p><span class="topic-label">討論內容</span>${content}</p></section></body></html>`;
  const updated = restyleMeetingMinutesHtml(old);
  assert.match(updated, /<h4 class="topic-label">討論內容<\/h4>/);
  const text = [...updated.matchAll(/<p>([^<]*)<\/p>/g)].map(match => match[1]).join("");
  assert.equal(text, content, "ARCHIVED_DISCUSSION_TEXT_PRESERVED");
  assert.doesNotMatch(updated, /<script\b/);
  assert.equal(restyleMeetingMinutesHtml(updated), updated);
});

test("既有摘要套用 A4 樣式保留原文與 CSP，不改寫非固定版型", () => {
  const html = renderMeetingMinutesHtml({ record: record(), versionNumber: 1, generatedAt: "2026-09-10", audioFiles: [], includeAudio: false });
  const old = html.replace(/<style>[\s\S]*?<\/style>/, '<style>body{background:black}</style>');
  const updated = restyleMeetingMinutesHtml(old);
  assert.match(updated, /@page\{size:A4 portrait/);
  assert.equal(updated.slice(updated.indexOf("<body>")), old.slice(old.indexOf("<body>")), "ARCHIVE_CONTENT_UNCHANGED");
  assert.match(updated, /default-src 'none'/);
  assert.doesNotMatch(updated, /<script\b/);
  assert.equal(restyleMeetingMinutesHtml("<p>other document</p>"), "<p>other document</p>");
});

test("額外章節附於固定章節之後，標題與段落皆 escape", () => {
  const html = renderMeetingMinutesHtml({ record: { ...record(), additionalSections: [{ title: '<img src=x onerror="alert(1)">', content: '<script>alert(2)</script>\n建議：先確認。' }] }, versionNumber: 1, generatedAt: "2026-09-10", audioFiles: [], includeAudio: false });
  assert.ok(html.indexOf('<section id="additional-1"') > html.indexOf('<section id="actions"'), "ADDITIONAL_SECTION_ORDER");
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script|<img/);
});

test("renderer 固定 escape 所有內容並產生相對音訊與本機選檔 fallback", () => {
  const html = renderMeetingMinutesHtml({
    record: record(),
    versionNumber: 2,
    generatedAt: "2026-07-16T01:00:00.000Z",
    audioFiles: [{ filename: "audio-1.m4a", label: "會議錄音" }],
  });

  assert.match(html, /品管 &lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /品管 <script>alert/);
  assert.match(html, /<source src="\.\/audio-1\.m4a">/);
  assert.match(html, /data-audio-target="audio-1"/);
  assert.match(html, /@page\{size:A4 portrait/);
  assert.doesNotMatch(html, /prefers-color-scheme:dark/);
  assert.match(html, /v2/);
});

test("renderer 拒絕非固定 ASCII audio filename，無音訊仍可產生", () => {
  assert.throws(
    () =>
      renderMeetingMinutesHtml({
        record: record(),
        versionNumber: 1,
        generatedAt: "2026-07-16T01:00:00.000Z",
        audioFiles: [{ filename: "../audio.m4a", label: "錯誤" }],
      }),
    /filename is invalid/
  );
  assert.match(
    renderMeetingMinutesHtml({
      record: record(),
      versionNumber: 1,
      generatedAt: "2026-07-16T01:00:00.000Z",
      audioFiles: [],
    }),
    /未附錄音/
  );
});

test("純摘要歸檔可獨立閱讀，不包含錄音連結、外部資源或 script", () => {
  const html = renderMeetingMinutesHtml({
    record: record(), versionNumber: 3, generatedAt: "2026-09-09T01:00:00.000Z",
    audioFiles: [{ filename: "audio-1.m4a", label: "會議錄音" }], includeAudio: false,
  });
  assert.match(html, /討論現況與後續方向/);
  assert.match(html, /品管 &lt;script&gt;/);
  assert.doesNotMatch(html, /<audio\b|<script\b|<source\b|href="#audio"|id="audio"|\bsrc=/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /v3/);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  renderMeetingMinutesHtml,
} from "../../../src/services/meeting-minutes/meetingMinutesHtmlRenderer";
import type { MeetingRecord } from "../../../src/services/meeting-minutes/meetingMinutesSchema";

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
  assert.match(html, /prefers-color-scheme:dark/);
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

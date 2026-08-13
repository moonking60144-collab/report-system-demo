import assert from "node:assert/strict";
import test from "node:test";
import {
  applyMeetingMinutesHumanOverrides,
  normalizeMeetingMinutesHumanInput,
  type MeetingRecord,
  validateMeetingRecord,
} from "../../../src/services/meeting-minutes/meetingMinutesSchema";

function record(): MeetingRecord {
  return {
    version: 1,
    title: "AI 猜的標題",
    date: "2026/01/01",
    subtitle: "不聯與三管流程",
    attendees: [{ department: "AI", names: ["猜測人名"] }],
    executiveSummary: "不聯率 5% 時處理。",
    discussionPoints: [
      {
        title: "不聯流程",
        currentProblem: "三管資料不完整",
        discussion: "討論 5% 門檻",
        direction: "可能調整",
      },
    ],
    confirmedFacts: [],
    confirmedDecisions: [],
    systemRequirements: [],
    pendingItems: [],
    followUpActions: [],
    uncertainTerms: ["不聯"],
  };
}

test("人工 title/date/attendees/facts/decisions 會覆寫 AI 並保留 3% 數字", () => {
  const human = normalizeMeetingMinutesHumanInput({
    title: "0714 品管討論",
    date: "2026/07/14",
    attendees: "品管：課長、慧賢\nIT：3 位人員",
    confirmedFacts: "不良率強制管控門檻是 3%",
    confirmedDecisions: "客退先待判，再分流",
    termCorrections: "不聯 -> 不良\n三管 -> 生管",
    otherNotes: "",
  });

  const output = applyMeetingMinutesHumanOverrides(record(), human);

  assert.equal(output.title, "0714 品管討論");
  assert.equal(output.date, "2026/07/14");
  assert.deepEqual(output.attendees, [
    { department: "品管", names: ["課長", "慧賢"] },
    { department: "IT", names: ["3 位人員"] },
  ]);
  assert.equal(output.confirmedFacts[0]?.content, "不良率強制管控門檻是 3%");
  assert.equal(output.confirmedDecisions[0]?.content, "客退先待判，再分流");
  assert.equal(output.confirmedFacts.length, 1);
  assert.equal(output.confirmedDecisions.length, 1);
  assert.match(output.executiveSummary, /不良率/);
  assert.match(output.discussionPoints[0]?.currentProblem ?? "", /生管/);
});

test("人工空白出席者不保留 AI 猜測，無部門名單支援中英文逗號", () => {
  const emptyAttendees = applyMeetingMinutesHumanOverrides(
    record(),
    normalizeMeetingMinutesHumanInput({ title: "品管會議", attendees: "" })
  );
  assert.deepEqual(emptyAttendees.attendees, []);

  const commaSeparated = applyMeetingMinutesHumanOverrides(
    record(),
    normalizeMeetingMinutesHumanInput({
      title: "品管會議",
      attendees: "王小明, 陳小華，林小美",
    })
  );
  assert.deepEqual(commaSeparated.attendees, [
    { department: null, names: ["王小明", "陳小華", "林小美"] },
  ]);
});

test("人工詞彙更正可重複套用且不會擴張已更正詞彙", () => {
  const human = normalizeMeetingMinutesHumanInput({
    title: "製程會議",
    termCorrections: "G6 -> G6P",
  });
  const source = record();
  source.executiveSummary = "G6 與 G6P 都需要確認";

  const once = applyMeetingMinutesHumanOverrides(source, human);
  const twice = applyMeetingMinutesHumanOverrides(once, human);

  assert.equal(once.executiveSummary, "G6P 與 G6P 都需要確認");
  assert.deepEqual(twice, once);
});

test("schema 拒絕額外欄位、空白內容與錯誤 nullable 型別", () => {
  assert.throws(
    () => validateMeetingRecord({ ...record(), rawHtml: "<script>" }),
    /不是允許的欄位/
  );
  assert.throws(
    () => validateMeetingRecord({ ...record(), executiveSummary: " " }),
    /不可為空/
  );
  assert.throws(
    () => validateMeetingRecord({ ...record(), date: 20260714 }),
    /必須是字串/
  );
});

test("schema 本地驗證仍限制模型輸出的字串長度與陣列筆數", () => {
  assert.throws(
    () => validateMeetingRecord({ ...record(), title: "a".repeat(501) }),
    /長度超過上限/
  );
  assert.throws(
    () =>
      validateMeetingRecord({
        ...record(),
        uncertainTerms: Array.from({ length: 101 }, (_, index) => `詞彙-${index}`),
      }),
    /項目數超過上限/
  );
});

test("input normalization 限制型別與長度", () => {
  assert.throws(
    () => normalizeMeetingMinutesHumanInput({ title: "" }),
    /title 不可為空/
  );
  assert.throws(
    () => normalizeMeetingMinutesHumanInput({ title: "a".repeat(201) }),
    /長度超過 200/
  );
});

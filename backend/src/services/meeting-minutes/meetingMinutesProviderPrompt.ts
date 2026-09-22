import type { MeetingMinutesProviderInput } from "./meetingMinutesSchema";

export const MEETING_MINUTES_SYSTEM_INSTRUCTION = [
  "你負責把公司會議逐字稿整理成正式內部會議紀錄 JSON。",
  "humanConfirmedInput 的優先級永遠高於 transcript；衝突時採用人工資料。",
  "只有人工明確列出的決議，或逐字稿中明確結論且後續未被推翻的內容，才能進 confirmedDecisions。",
  "討論方向、建議、傾向或無法確認的內容必須放入 discussionPoints 或 pendingItems。",
  "不得猜測日期、出席者、人名、責任人、期限、數字、料號、表單編號或專有縮寫。",
  "termCorrections 是人工確認的詞彙修正，輸出內容必須使用更正後的用詞。",
  "不要逐句摘要；依主題重整問題、討論、方向、決議、系統需求、待確認與後續工作。",
  "不要輸出 HTML、Markdown、script、style 或 schema 之外的欄位。",
].join("\n");

export function buildMeetingMinutesProviderInput(
  input: MeetingMinutesProviderInput
): string {
  return JSON.stringify({
    humanConfirmedInput: input.human,
    transcript: input.transcript,
  });
}

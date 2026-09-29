import { createHash } from "node:crypto";
import type { MeetingRecord } from "./meetingMinutesSchema";

const fields = ["title", "date", "subtitle", "executiveSummary", "discussionPoints", "confirmedFacts", "confirmedDecisions",
  "systemRequirements", "pendingItems", "followUpActions", "uncertainTerms", "additionalSections"] as const;
type Field = typeof fields[number];

export interface MeetingSummaryRevisionChanges {
  baseVersionId: string;
  candidateVersionId: string;
  entries: Array<{ field: Field; removed: string[]; added: string[]; requiresAcknowledgement: boolean }>;
  requiresAcknowledgement: boolean;
  acknowledgementToken: string;
}

function values(record: MeetingRecord, field: Field): Array<{ key: string; text: string }> {
  const value = record[field];
  const items = Array.isArray(value) ? value : value == null ? [] : [value];
  return items.map(item => {
    if (typeof item === "string") return { key: JSON.stringify(item), text: item };
    // 引用標記的變動不等同於會議內容被改寫。
    const content = Object.fromEntries(Object.entries(item).filter(([key]) => key !== "sourceBasis"));
    return { key: JSON.stringify(content), text: Object.values(content).filter(value => value != null).join(" · ") };
  });
}

export function compareMeetingSummaryRevision(baseVersionId: string, candidateVersionId: string,
  base: MeetingRecord, candidate: MeetingRecord): MeetingSummaryRevisionChanges {
  const entries: MeetingSummaryRevisionChanges["entries"] = [];
  for (const field of fields) {
    const before = values(base, field);
    const after = values(candidate, field);
    const remaining = [...after];
    const removed: string[] = [];
    for (const item of before) {
      const index = remaining.findIndex(other => other.key === item.key);
      if (index < 0) removed.push(item.text);
      else remaining.splice(index, 1);
    }
    if (!removed.length && !remaining.length) continue;
    const protectedField = field === "confirmedFacts" || field === "confirmedDecisions" || field === "followUpActions";
    entries.push({ field, removed, added: remaining.map(item => item.text),
      requiresAcknowledgement: removed.length > 0 && (protectedField || (Array.isArray(base[field]) && !after.length)) });
  }
  return { baseVersionId, candidateVersionId, entries,
    requiresAcknowledgement: entries.some(entry => entry.requiresAcknowledgement),
    acknowledgementToken: createHash("sha256").update(JSON.stringify({ baseVersionId, candidateVersionId, base, candidate })).digest("hex") };
}

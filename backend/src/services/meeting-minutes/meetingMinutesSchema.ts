import type { MeetingMergedTranscriptDocument } from "./meetingTranscriptProcessor";

export const MEETING_MINUTES_INPUT_LIMITS = {
  title: 200,
  date: 40,
  attendees: 8_000,
  confirmedFacts: 20_000,
  confirmedDecisions: 20_000,
  termCorrections: 12_000,
  otherNotes: 30_000,
  revisionRequest: 2_000,
  revisionConfirmedFacts: 2_000,
  revisionHistory: 30_000,
  previousSummary: 100_000,
  additionalSectionRequest: 2_000,
} as const;

const RECORD_LIMITS = {
  shortText: 500,
  paragraph: 8_000,
  list: 100,
  attendees: 50,
  names: 100,
} as const;

export interface MeetingMinutesHumanInput {
  title: string;
  date: string | null;
  attendees: string;
  confirmedFacts: string;
  confirmedDecisions: string;
  termCorrections: string;
  otherNotes: string;
  revisionRequest?: string;
  revisionConfirmedFacts?: string;
  revisionHistory?: string;
  previousSummary?: string;
  additionalSectionRequest?: string;
}

export interface MeetingMinutesProviderInput {
  transcript: MeetingMergedTranscriptDocument;
  human: MeetingMinutesHumanInput;
}

export interface MeetingMinutesAttendeeGroup {
  department: string | null;
  names: string[];
}

export interface MeetingMinutesDiscussionPoint {
  title: string;
  currentProblem: string | null;
  discussion: string;
  direction: string | null;
}

export interface MeetingMinutesConfirmedItem {
  content: string;
  sourceBasis: string | null;
}

export interface MeetingMinutesSystemRequirement {
  content: string;
  owner: string | null;
}

export interface MeetingMinutesPendingItem {
  content: string;
  requiredConfirmation: string | null;
}

export interface MeetingMinutesFollowUpAction {
  content: string;
  owner: string | null;
  dueDate: string | null;
}

export interface MeetingMinutesSourceEvidence {
  section: "confirmedFacts" | "confirmedDecisions" | "followUpActions";
  itemIndex: number;
  blockId: string;
  quote: string;
  sourceId?: string;
  segmentIds?: string[];
  sourceSegmentIds?: string[];
  startMs?: number | null;
  endMs?: number | null;
  blockStart?: number;
  blockEnd?: number;
}

export interface MeetingRecord {
  version: 1;
  title: string;
  date: string | null;
  subtitle: string;
  attendees: MeetingMinutesAttendeeGroup[];
  executiveSummary: string;
  discussionPoints: MeetingMinutesDiscussionPoint[];
  confirmedFacts: MeetingMinutesConfirmedItem[];
  confirmedDecisions: MeetingMinutesConfirmedItem[];
  systemRequirements: MeetingMinutesSystemRequirement[];
  pendingItems: MeetingMinutesPendingItem[];
  followUpActions: MeetingMinutesFollowUpAction[];
  uncertainTerms: string[];
  additionalSections?: Array<{ title: string; content: string }>;
  sourceEvidence?: MeetingMinutesSourceEvidence[];
}

export class MeetingMinutesValidationError extends Error {
  readonly code = "MEETING_MINUTES_SCHEMA_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "MeetingMinutesValidationError";
  }
}

type JsonSchema = Record<string, unknown>;

const stringSchema = (maxLength: number): JsonSchema => ({
  type: "string", minLength: 1, maxLength, pattern: "\\S",
  description: "必須包含非空白文字，不可使用空字串。",
});

const nullableStringSchema = (maxLength: number): JsonSchema => ({
  ...stringSchema(maxLength),
  type: ["string", "null"],
  description: "資料未知時填 null；有資料時必須包含非空白文字，不可使用空字串。",
});

export const MEETING_RECORD_JSON_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    version: { type: "integer", enum: [1] },
    title: stringSchema(RECORD_LIMITS.shortText),
    date: nullableStringSchema(RECORD_LIMITS.shortText),
    subtitle: stringSchema(RECORD_LIMITS.paragraph),
    attendees: {
      type: "array",
      maxItems: RECORD_LIMITS.attendees,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          department: nullableStringSchema(RECORD_LIMITS.shortText),
          names: {
            type: "array",
            maxItems: RECORD_LIMITS.names,
            items: stringSchema(RECORD_LIMITS.shortText),
          },
        },
        required: ["department", "names"],
      },
    },
    executiveSummary: stringSchema(RECORD_LIMITS.paragraph),
    discussionPoints: {
      type: "array",
      maxItems: RECORD_LIMITS.list,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: stringSchema(RECORD_LIMITS.shortText),
          currentProblem: nullableStringSchema(RECORD_LIMITS.paragraph),
          discussion: stringSchema(RECORD_LIMITS.paragraph),
          direction: nullableStringSchema(RECORD_LIMITS.paragraph),
        },
        required: ["title", "currentProblem", "discussion", "direction"],
      },
    },
    confirmedFacts: {
      type: "array",
      description: "僅列 confirmedFacts 或獨立 revisionConfirmedFacts 明確確認的事實；不得引用一般 otherNotes、修訂指令或舊草稿。首次產出未提供 confirmedFacts 時填 []；修訂每項只接受 human.confirmedFacts 或 human.revisionConfirmedFacts 引用。必須是真正陣列，不能把 JSON 序列化成字串。",
      maxItems: RECORD_LIMITS.list,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          content: stringSchema(RECORD_LIMITS.paragraph),
          sourceBasis: nullableStringSchema(RECORD_LIMITS.shortText),
        },
        required: ["content", "sourceBasis"],
      },
    },
    confirmedDecisions: {
      type: "array",
      maxItems: RECORD_LIMITS.list,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          content: stringSchema(RECORD_LIMITS.paragraph),
          sourceBasis: nullableStringSchema(RECORD_LIMITS.shortText),
        },
        required: ["content", "sourceBasis"],
      },
    },
    systemRequirements: {
      type: "array",
      maxItems: RECORD_LIMITS.list,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          content: stringSchema(RECORD_LIMITS.paragraph),
          owner: nullableStringSchema(RECORD_LIMITS.shortText),
        },
        required: ["content", "owner"],
      },
    },
    pendingItems: {
      type: "array",
      maxItems: RECORD_LIMITS.list,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          content: stringSchema(RECORD_LIMITS.paragraph),
          requiredConfirmation: nullableStringSchema(RECORD_LIMITS.paragraph),
        },
        required: ["content", "requiredConfirmation"],
      },
    },
    followUpActions: {
      type: "array",
      maxItems: RECORD_LIMITS.list,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          content: stringSchema(RECORD_LIMITS.paragraph),
          owner: nullableStringSchema(RECORD_LIMITS.shortText),
          dueDate: nullableStringSchema(RECORD_LIMITS.shortText),
        },
        required: ["content", "owner", "dueDate"],
      },
    },
    uncertainTerms: {
      type: "array",
      maxItems: RECORD_LIMITS.list,
      items: stringSchema(RECORD_LIMITS.shortText),
    },
    additionalSections: {
      type: "array",
      maxItems: 6,
      description: "僅依 additionalSectionRequest 新增段落；沒有要求時填 []。保留所有固定章節。",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { title: stringSchema(RECORD_LIMITS.shortText), content: stringSchema(RECORD_LIMITS.paragraph) },
        required: ["title", "content"],
      },
    },
    sourceEvidence: {
      type: "array", maxItems: 300,
      description: "每一項 confirmedDecisions 與 followUpActions 至少一筆引用；修訂 confirmedFacts 只可引用 human.confirmedFacts 或 human.revisionConfirmedFacts。quote 必須逐字複製指定 sourceBlocks 區塊中連續的短句，不能改字或加省略號。",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          section: { ...stringSchema(40), enum: ["confirmedFacts", "confirmedDecisions", "followUpActions"] },
          itemIndex: { type: "integer", minimum: 0, maximum: 99 },
          blockId: stringSchema(40), quote: stringSchema(200),
          sourceId: stringSchema(100),
          segmentIds: {
            type: "array", maxItems: 256, items: stringSchema(200),
          },
          sourceSegmentIds: {
            type: "array", maxItems: 512, items: stringSchema(200),
          },
          startMs: { type: ["integer", "null"], minimum: 0 },
          endMs: { type: ["integer", "null"], minimum: 0 },
          blockStart: { type: "integer", minimum: 0 },
          blockEnd: { type: "integer", minimum: 0 },
        },
        required: ["section", "itemIndex", "blockId", "quote"],
      },
    },
  },
  required: [
    "version",
    "title",
    "date",
    "subtitle",
    "attendees",
    "executiveSummary",
    "discussionPoints",
    "confirmedFacts",
    "confirmedDecisions",
    "systemRequirements",
    "pendingItems",
    "followUpActions",
    "uncertainTerms",
    "additionalSections",
    "sourceEvidence",
  ],
};

function validationError(path: string, message: string): never {
  throw new MeetingMinutesValidationError(`${path} ${message}`);
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return validationError(path, "必須是物件");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[], path: string): void {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) validationError(`${path}.${key}`, "不是允許的欄位");
  }
  for (const key of keys) {
    if (!(key in value)) validationError(`${path}.${key}`, "為必填欄位");
  }
}

function asString(
  value: unknown,
  path: string,
  maxLength: number = RECORD_LIMITS.paragraph
): string {
  if (typeof value !== "string") return validationError(path, "必須是字串");
  const normalized = value.trim();
  if (!normalized) return validationError(path, "不可為空");
  if (normalized.length > maxLength) return validationError(path, "長度超過上限");
  return normalized;
}

function asNullableString(
  value: unknown,
  path: string,
  maxLength: number = RECORD_LIMITS.paragraph
): string | null {
  if (value === null) return null;
  return asString(value, path, maxLength);
}

function asArray(
  value: unknown,
  path: string,
  maxItems: number = RECORD_LIMITS.list
): unknown[] {
  if (!Array.isArray(value)) return validationError(path, "必須是陣列");
  if (value.length > maxItems) return validationError(path, "項目數超過上限");
  return value;
}

function parseAttendee(value: unknown, path: string): MeetingMinutesAttendeeGroup {
  const object = asObject(value, path);
  exactKeys(object, ["department", "names"], path);
  return {
    department: asNullableString(object.department, `${path}.department`, RECORD_LIMITS.shortText),
    names: asArray(object.names, `${path}.names`, RECORD_LIMITS.names).map((name, index) =>
      asString(name, `${path}.names[${index}]`, RECORD_LIMITS.shortText)
    ),
  };
}

function parseConfirmedItem(value: unknown, path: string): MeetingMinutesConfirmedItem {
  const object = asObject(value, path);
  exactKeys(object, ["content", "sourceBasis"], path);
  return {
    content: asString(object.content, `${path}.content`),
    sourceBasis: asNullableString(
      object.sourceBasis,
      `${path}.sourceBasis`,
      RECORD_LIMITS.shortText
    ),
  };
}

export function validateMeetingRecord(value: unknown): MeetingRecord {
  const object = asObject(value, "record");
  const keys = [
    "version",
    "title",
    "date",
    "subtitle",
    "attendees",
    "executiveSummary",
    "discussionPoints",
    "confirmedFacts",
    "confirmedDecisions",
    "systemRequirements",
    "pendingItems",
    "followUpActions",
    "uncertainTerms",
  ];
  // 已保存的 v1 紀錄沒有額外章節，仍沿用原有格式讀取。
  if ("additionalSections" in object) keys.push("additionalSections");
  if ("sourceEvidence" in object) keys.push("sourceEvidence");
  exactKeys(object, keys, "record");
  if (object.version !== 1) validationError("record.version", "必須為 1");

  const discussionPoints = asArray(object.discussionPoints, "record.discussionPoints").map(
    (item, index): MeetingMinutesDiscussionPoint => {
      const path = `record.discussionPoints[${index}]`;
      const row = asObject(item, path);
      exactKeys(row, ["title", "currentProblem", "discussion", "direction"], path);
      return {
        title: asString(row.title, `${path}.title`, RECORD_LIMITS.shortText),
        currentProblem: asNullableString(row.currentProblem, `${path}.currentProblem`),
        discussion: asString(row.discussion, `${path}.discussion`),
        direction: asNullableString(row.direction, `${path}.direction`),
      };
    }
  );
  const systemRequirements = asArray(
    object.systemRequirements,
    "record.systemRequirements"
  ).map((item, index): MeetingMinutesSystemRequirement => {
    const path = `record.systemRequirements[${index}]`;
    const row = asObject(item, path);
    exactKeys(row, ["content", "owner"], path);
    return {
      content: asString(row.content, `${path}.content`),
      owner: asNullableString(row.owner, `${path}.owner`, RECORD_LIMITS.shortText),
    };
  });
  const pendingItems = asArray(object.pendingItems, "record.pendingItems").map(
    (item, index): MeetingMinutesPendingItem => {
      const path = `record.pendingItems[${index}]`;
      const row = asObject(item, path);
      exactKeys(row, ["content", "requiredConfirmation"], path);
      return {
        content: asString(row.content, `${path}.content`),
        requiredConfirmation: asNullableString(
          row.requiredConfirmation,
          `${path}.requiredConfirmation`
        ),
      };
    }
  );
  const followUpActions = asArray(object.followUpActions, "record.followUpActions").map(
    (item, index): MeetingMinutesFollowUpAction => {
      const path = `record.followUpActions[${index}]`;
      const row = asObject(item, path);
      exactKeys(row, ["content", "owner", "dueDate"], path);
      return {
        content: asString(row.content, `${path}.content`),
        owner: asNullableString(row.owner, `${path}.owner`, RECORD_LIMITS.shortText),
        dueDate: asNullableString(row.dueDate, `${path}.dueDate`, RECORD_LIMITS.shortText),
      };
    }
  );

  return {
    version: 1,
    title: asString(object.title, "record.title", RECORD_LIMITS.shortText),
    date: asNullableString(object.date, "record.date", RECORD_LIMITS.shortText),
    subtitle: asString(object.subtitle, "record.subtitle"),
    attendees: asArray(object.attendees, "record.attendees", RECORD_LIMITS.attendees).map(
      (item, index) => parseAttendee(item, `record.attendees[${index}]`)
    ),
    executiveSummary: asString(object.executiveSummary, "record.executiveSummary"),
    discussionPoints,
    confirmedFacts: asArray(object.confirmedFacts, "record.confirmedFacts").map(
      (item, index) => parseConfirmedItem(item, `record.confirmedFacts[${index}]`)
    ),
    confirmedDecisions: asArray(
      object.confirmedDecisions,
      "record.confirmedDecisions"
    ).map((item, index) =>
      parseConfirmedItem(item, `record.confirmedDecisions[${index}]`)
    ),
    systemRequirements,
    pendingItems,
    followUpActions,
    ...(object.sourceEvidence === undefined ? {} : {
      sourceEvidence: asArray(object.sourceEvidence, "record.sourceEvidence", 300).map((item, index) => {
        const path = `record.sourceEvidence[${index}]`;
        const row = asObject(item, path);
        const keys = ["section", "itemIndex", "blockId", "quote"];
        for (const key of ["sourceId", "segmentIds", "sourceSegmentIds", "startMs", "endMs", "blockStart", "blockEnd"]) {
          if (key in row) keys.push(key);
        }
        exactKeys(row, keys, path);
        if (row.section !== "confirmedFacts" && row.section !== "confirmedDecisions" && row.section !== "followUpActions") validationError(`${path}.section`, "不是允許的引用章節");
        if (!Number.isInteger(row.itemIndex) || Number(row.itemIndex) < 0 || Number(row.itemIndex) > 99) validationError(`${path}.itemIndex`, "必須是 0 到 99 的整數");
        for (const key of ["startMs", "endMs"] as const) {
          if (row[key] !== undefined && row[key] !== null && (!Number.isInteger(row[key]) || Number(row[key]) < 0)) {
            validationError(`${path}.${key}`, "必須是非負整數或 null");
          }
        }
        for (const key of ["blockStart", "blockEnd"] as const) {
          if (row[key] !== undefined && (!Number.isInteger(row[key]) || Number(row[key]) < 0)) {
            validationError(`${path}.${key}`, "必須是非負整數");
          }
        }
        return { section: row.section as "confirmedFacts" | "confirmedDecisions" | "followUpActions", itemIndex: row.itemIndex as number,
          blockId: asString(row.blockId, `${path}.blockId`, 40), quote: asString(row.quote, `${path}.quote`, 200),
          ...(row.sourceId === undefined ? {} : { sourceId: asString(row.sourceId, `${path}.sourceId`, 100) }),
          ...(row.segmentIds === undefined ? {} : { segmentIds: asArray(row.segmentIds, `${path}.segmentIds`, 256).map((value, valueIndex) => asString(value, `${path}.segmentIds[${valueIndex}]`, 200)) }),
          ...(row.sourceSegmentIds === undefined ? {} : { sourceSegmentIds: asArray(row.sourceSegmentIds, `${path}.sourceSegmentIds`, 512).map((value, valueIndex) => asString(value, `${path}.sourceSegmentIds[${valueIndex}]`, 200)) }),
          ...(row.startMs === undefined ? {} : { startMs: row.startMs === null ? null : Number(row.startMs) }),
          ...(row.endMs === undefined ? {} : { endMs: row.endMs === null ? null : Number(row.endMs) }),
          ...(row.blockStart === undefined ? {} : { blockStart: Number(row.blockStart) }),
          ...(row.blockEnd === undefined ? {} : { blockEnd: Number(row.blockEnd) }) };
      }),
    }),
    ...(object.additionalSections === undefined ? {} : {
      additionalSections: asArray(object.additionalSections, "record.additionalSections", 6).map((item, index) => {
        const path = `record.additionalSections[${index}]`;
        const row = asObject(item, path);
        exactKeys(row, ["title", "content"], path);
        return { title: asString(row.title, `${path}.title`, RECORD_LIMITS.shortText), content: asString(row.content, `${path}.content`) };
      }),
    }),
    uncertainTerms: asArray(object.uncertainTerms, "record.uncertainTerms").map(
      (item, index) =>
        asString(item, `record.uncertainTerms[${index}]`, RECORD_LIMITS.shortText)
    ),
  };
}

function splitHumanLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]\s+|\d+[.)、]\s*)/, "").trim())
    .filter(Boolean);
}

function parseAttendees(value: string): MeetingMinutesAttendeeGroup[] {
  return splitHumanLines(value).map((line) => {
    const match = line.match(/^([^：:]{1,100})[：:]\s*(.+)$/);
    const namesText = match ? match[2] : line;
    const names = namesText
      .split(/[、,，]/)
      .map((name) => name.trim())
      .filter(Boolean);
    return {
      department: match ? match[1].trim() : null,
      names: names.length > 0 ? names : [namesText.trim()],
    };
  });
}

function parseCorrections(value: string): Array<{ from: string; to: string }> {
  return splitHumanLines(value).flatMap((line) => {
    const match = line.match(/^(.+?)\s*(?:->|→|=>|＝>|改為|更正為)\s*(.+)$/);
    if (!match) return [];
    const from = match[1].trim();
    const to = match[2].trim();
    return from && to && from !== to ? [{ from, to }] : [];
  });
}

function applyCorrectionsToValue<T>(value: T, corrections: Array<{ from: string; to: string }>): T {
  if (typeof value === "string") {
    let text: string = value;
    for (const item of corrections) {
      text = text
        .split(item.to)
        .map((part) => part.split(item.from).join(item.to))
        .join(item.to);
    }
    return text as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => applyCorrectionsToValue(item, corrections)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, applyCorrectionsToValue(item, corrections)])
    ) as T;
  }
  return value;
}

function normalizeForDedupe(value: string): string {
  return value.toLocaleLowerCase("zh-TW").replace(/[\s\p{P}\p{S}]+/gu, "");
}

function overrideConfirmedItems(
  items: MeetingMinutesConfirmedItem[],
  humanLines: string[]
): MeetingMinutesConfirmedItem[] {
  if (humanLines.length === 0) return items;
  const seen = new Set<string>();
  return humanLines.flatMap((content) => {
    const normalized = normalizeForDedupe(content);
    if (seen.has(normalized)) return [];
    seen.add(normalized);
    return [{ content, sourceBasis: "使用者確認" }];
  });
}

export function buildMeetingMinutesHumanFields(human: MeetingMinutesHumanInput) {
  return {
    version: 1 as const,
    title: human.title.trim(),
    date: human.date?.trim() || null,
    attendees: parseAttendees(human.attendees),
    confirmedFacts: overrideConfirmedItems([], splitHumanLines(human.confirmedFacts)),
  };
}

export function applyMeetingMinutesHumanOverrides(
  record: MeetingRecord,
  human: MeetingMinutesHumanInput
): MeetingRecord {
  if (human.revisionRequest) return validateMeetingRecord({ ...record, attendees: parseAttendees(human.attendees) });
  const { sourceEvidence, ...content } = record;
  const corrected = applyCorrectionsToValue(content, parseCorrections(human.termCorrections));
  const attendees = parseAttendees(human.attendees);
  const confirmedDecisions = splitHumanLines(human.confirmedDecisions);
  if (human.additionalSectionRequest?.trim() && !corrected.additionalSections?.length) {
    throw new MeetingMinutesValidationError("未產生要求的額外段落。");
  }
  return validateMeetingRecord({
    ...corrected,
    ...(sourceEvidence ? { sourceEvidence: sourceEvidence.filter(evidence => evidence.section !== "confirmedDecisions" || confirmedDecisions.length === 0) } : {}),
    title: human.title.trim(),
    date: human.date?.trim() || null,
    attendees,
    ...(human.additionalSectionRequest?.trim() ? {} : { additionalSections: [] }),
    confirmedFacts: overrideConfirmedItems(
      corrected.confirmedFacts,
      splitHumanLines(human.confirmedFacts)
    ),
    confirmedDecisions: overrideConfirmedItems(
      corrected.confirmedDecisions,
      confirmedDecisions
    ),
  });
}

export function normalizeMeetingMinutesHumanInput(
  value: Partial<MeetingMinutesHumanInput>
): MeetingMinutesHumanInput {
  const read = (key: keyof MeetingMinutesHumanInput): string => {
    const raw = value[key];
    if (raw === null || raw === undefined) return "";
    if (typeof raw !== "string") {
      throw new MeetingMinutesValidationError(`${key} 必須是字串`);
    }
    return raw.trim();
  };
  const title = read("title");
  if (!title) throw new MeetingMinutesValidationError("title 不可為空");
  const date = read("date");
  const normalized: MeetingMinutesHumanInput = {
    title,
    date: date || null,
    attendees: read("attendees"),
    confirmedFacts: read("confirmedFacts"),
    confirmedDecisions: read("confirmedDecisions"),
    termCorrections: read("termCorrections"),
    otherNotes: read("otherNotes"),
    ...(read("revisionRequest") ? { revisionRequest: read("revisionRequest") } : {}),
    ...(read("revisionConfirmedFacts") ? { revisionConfirmedFacts: read("revisionConfirmedFacts") } : {}),
    ...(read("revisionHistory") ? { revisionHistory: read("revisionHistory") } : {}),
    ...(read("previousSummary") ? { previousSummary: read("previousSummary") } : {}),
    ...(read("additionalSectionRequest") ? { additionalSectionRequest: read("additionalSectionRequest") } : {}),
  };
  for (const [key, maxLength] of Object.entries(MEETING_MINUTES_INPUT_LIMITS) as Array<
    [keyof typeof MEETING_MINUTES_INPUT_LIMITS, number]
  >) {
    const text = normalized[key] ?? "";
    if (text.length > maxLength) {
      throw new MeetingMinutesValidationError(`${key} 長度超過 ${maxLength} 字元`);
    }
  }
  return normalized;
}

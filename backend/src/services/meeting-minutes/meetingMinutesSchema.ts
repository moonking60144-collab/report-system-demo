import type { MeetingMergedTranscriptDocument } from "./meetingTranscriptProcessor";

export const MEETING_MINUTES_INPUT_LIMITS = {
  title: 200,
  date: 40,
  attendees: 8_000,
  confirmedFacts: 20_000,
  confirmedDecisions: 20_000,
  termCorrections: 12_000,
  otherNotes: 30_000,
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
}

export class MeetingMinutesValidationError extends Error {
  readonly code = "MEETING_MINUTES_SCHEMA_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "MeetingMinutesValidationError";
  }
}

type JsonSchema = Record<string, unknown>;

const nullableStringSchema = (maxLength: number): JsonSchema => ({
  type: ["string", "null"],
  maxLength,
});

const stringSchema = (maxLength: number): JsonSchema => ({ type: "string", maxLength });

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

export function applyMeetingMinutesHumanOverrides(
  record: MeetingRecord,
  human: MeetingMinutesHumanInput
): MeetingRecord {
  const corrected = applyCorrectionsToValue(record, parseCorrections(human.termCorrections));
  const attendees = parseAttendees(human.attendees);
  return validateMeetingRecord({
    ...corrected,
    title: human.title.trim(),
    date: human.date?.trim() || null,
    attendees,
    confirmedFacts: overrideConfirmedItems(
      corrected.confirmedFacts,
      splitHumanLines(human.confirmedFacts)
    ),
    confirmedDecisions: overrideConfirmedItems(
      corrected.confirmedDecisions,
      splitHumanLines(human.confirmedDecisions)
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

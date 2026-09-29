import {
  MEETING_RECORD_JSON_SCHEMA,
  MEETING_MINUTES_INPUT_LIMITS,
  MeetingMinutesValidationError,
  buildMeetingMinutesHumanFields,
  type MeetingMinutesProviderInput,
  type MeetingMinutesSourceEvidence,
} from "./meetingMinutesSchema";
import {
  buildMeetingMinutesSourceBlocks,
  resolveMeetingMinutesSourceRange,
  validateMeetingMinutesProviderRecord,
  type MeetingMinutesResolvedSourceTrace,
} from "./meetingMinutesSources";
import { buildMeetingMinutesHumanPayload } from "./meetingMinutesProviderPrompt";

const serverFields = new Set(["version", "title", "date", "attendees", "confirmedFacts", "sourceEvidence"]);
const recordProperties = MEETING_RECORD_JSON_SCHEMA.properties as Record<string, unknown>;
const properties = Object.fromEntries(Object.entries(recordProperties)
  .filter(([key]) => !serverFields.has(key)));

function withSourceSpans(section: "confirmedFacts" | "confirmedDecisions" | "followUpActions", validIds?: string[]) {
  const schema = recordProperties[section] as { items: { properties: Record<string, unknown>; required: string[] } };
  return { ...schema, items: { ...schema.items,
    properties: { ...schema.items.properties, sourceSpanIds: { type: "array", minItems: 1, maxItems: 10,
      items: { type: "string", minLength: 1, maxLength: 40, pattern: "\\S",
        ...(validIds?.length ? { enum: validIds } : {}) } } },
    required: [...schema.items.required, "sourceSpanIds"],
  } };
}

export const MINIMAX_MEETING_RECORD_JSON_SCHEMA = {
  ...MEETING_RECORD_JSON_SCHEMA,
  properties: {
    ...properties,
    confirmedDecisions: withSourceSpans("confirmedDecisions"),
    followUpActions: withSourceSpans("followUpActions"),
  },
  required: (MEETING_RECORD_JSON_SCHEMA.required as string[]).filter(key => !serverFields.has(key)),
};

export function prepareMiniMaxMeetingMinutesRequest(input: MeetingMinutesProviderInput, selection?: {
  segmentIds: ReadonlySet<string>;
  overviews: Array<Record<string, unknown>>;
}, providerLabel = "MiniMax") {
  // Keep the source used for validation identical to the one sent before awaiting the provider.
  const captured = {
    human: { ...input.human },
    transcript: { ...input.transcript, segments: input.transcript.segments.map(segment => ({ ...segment })) },
  };
  const spans = new Map<
    string,
    { blockId: string; text: string; trace: MeetingMinutesResolvedSourceTrace }
  >();
  const sourceBlocks = buildMeetingMinutesSourceBlocks(captured).map(block => {
    const entries: Array<[string | null, string]> = [];
    let spanIndex = 0;
    for (let offset = 0; offset < block.text.length;) {
      let end = Math.min(offset + 200, block.text.length);
      if (end < block.text.length) {
        const prefix = block.text.slice(offset, end);
        const boundary = Math.max(prefix.lastIndexOf("。"), prefix.lastIndexOf("！"), prefix.lastIndexOf("？"), prefix.lastIndexOf("\n"));
        if (boundary >= 100) end = offset + boundary + 1;
        if (block.text.length - end < 8) end = block.text.length - 8;
        while (end > offset + 100 && block.text.length - end < 200 && block.text.slice(end).trim().length > 0 && block.text.slice(end).trim().length < 8) end--;
        if (/[\uD800-\uDBFF]/.test(block.text[end - 1])) end--;
      }
      const id = `${block.id}.s${++spanIndex}`;
      const text = block.text.slice(offset, end);
      const trace = resolveMeetingMinutesSourceRange(block, offset, end);
      if (selection && !block.sourceId.startsWith("human.") &&
        !trace.segmentIds?.some(id => selection.segmentIds.has(id))) {
        offset = end;
        continue;
      }
      const selectable = text.trim().length > 0 && text.trim().length >= Math.min(8, block.text.trim().length);
      if (selectable) {
        spans.set(id, {
          blockId: block.id,
          text,
          trace,
        });
      }
      entries.push([selectable ? id : null, text]);
      offset = end;
    }
    return {
      id: block.id,
      sourceId: block.sourceId,
      startMs: block.startMs,
      endMs: block.endMs,
      spans: entries,
    };
  }).filter(block => block.spans.length > 0);
  const serializedInput = JSON.stringify({ ...buildMeetingMinutesHumanPayload(captured.human), sourceBlocks,
    ...(selection ? { chunkDrafts: selection.overviews,
      mergeTask: "chunkDrafts 是依時間順序的 AI 擷取草稿，不是原始證據或人工確認事實。請合併全部主題並檢查跨段修正與撤回；提案與待確認內容不可升格成決議。決議與工作只能引用本次 sourceBlocks.spans 中的原文，不可引用草稿來源編號；人工欄位以原始 human 輸入為準。" } : {}),
    task: "請忠實整理全部原文，保留提案與後續修正。spans 每一組是 [spanId, 原文]，編號為 null 的片段仍是原文但不可單獨引用，來源編號不是時間。每項決議與工作在自己的 sourceSpanIds 列出依據片段，不另外輸出 sourceEvidence；原句、項目索引與人工欄位由程式填入。" });

  const validIds = [...spans.keys()];
  // Bound duplicated schema tokens for long transcripts; the resolver remains
  // authoritative for every input, including those too large for an enum.
  const boundedIds = validIds.length <= 256 ? validIds : undefined;
  const revision = Boolean(captured.human.revisionRequest);
  const factIds = validIds.filter(id => ["human.confirmedFacts", "human.revisionConfirmedFacts"].includes(spans.get(id)!.trace.sourceId));
  const revisionFields = revision ? {
    title: { ...recordProperties.title as Record<string, unknown>, maxLength: MEETING_MINUTES_INPUT_LIMITS.title },
    date: { ...recordProperties.date as Record<string, unknown>, maxLength: MEETING_MINUTES_INPUT_LIMITS.date },
    confirmedFacts: { ...withSourceSpans("confirmedFacts", factIds), ...(factIds.length ? {} : { maxItems: 0 }) },
  } : {};
  const schema = { ...MINIMAX_MEETING_RECORD_JSON_SCHEMA, properties: {
    ...MINIMAX_MEETING_RECORD_JSON_SCHEMA.properties,
    ...revisionFields,
    confirmedDecisions: { ...withSourceSpans("confirmedDecisions", boundedIds), ...(validIds.length ? {} : { maxItems: 0 }) },
    followUpActions: { ...withSourceSpans("followUpActions", boundedIds), ...(validIds.length ? {} : { maxItems: 0 }) },
  }, required: [...MINIMAX_MEETING_RECORD_JSON_SCHEMA.required, ...(revision ? ["title", "date", "confirmedFacts"] : [])] };
  return {
    revision,
    schema,
    serializedInput,
    metrics: {
      strategy: selection ? "chunk-merge" as const : "single-pass" as const,
      transcriptCharacters: captured.transcript.segments.reduce(
        (total, segment) => total + segment.text.length,
        0
      ),
      transcriptSegmentCount: captured.transcript.segments.length,
      evidenceBlockCount: sourceBlocks.length,
      evidenceSpanCount: validIds.length,
      serializedCharacters: serializedInput.length,
    },
    resolve(value: unknown) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new MeetingMinutesValidationError(`${providerLabel} 紀錄必須是物件`);
      const raw = value as Record<string, unknown>;
      for (const key of Object.keys(raw)) {
        if (!Object.hasOwn(schema.properties, key)) throw new MeetingMinutesValidationError(`${providerLabel}.${key} 不是允許的生成欄位`);
      }
      for (const key of schema.required) {
        if (!Object.hasOwn(raw, key)) throw new MeetingMinutesValidationError(`${providerLabel}.${key} 為必填欄位`);
      }
      const content = { ...raw };
      const sourceEvidence: MeetingMinutesSourceEvidence[] = [];
      const sections = revision ? ["confirmedFacts", "confirmedDecisions", "followUpActions"] as const
        : ["confirmedDecisions", "followUpActions"] as const;
      for (const section of sections) {
        const items = raw[section];
        if (!Array.isArray(items) || items.length > 100) throw new MeetingMinutesValidationError(`${providerLabel}.${section} 必須是最多100項的陣列`);
        content[section] = items.map((value, itemIndex) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new MeetingMinutesValidationError(`${providerLabel}.${section}[${itemIndex}] 必須是物件`);
          const { sourceSpanIds, ...item } = value as Record<string, unknown>;
          if (!Array.isArray(sourceSpanIds) || sourceSpanIds.length === 0) throw new MeetingMinutesValidationError(`record.${section}[${itemIndex}] 缺少原文引用`);
          if (sourceSpanIds.length > 10 || sourceEvidence.length + sourceSpanIds.length > 300) throw new MeetingMinutesValidationError(`${providerLabel}.sourceSpanIds 超過引用數量上限`);
          for (const spanId of sourceSpanIds) {
            const span = typeof spanId === "string" ? spans.get(spanId) : undefined;
            if (!span) throw new MeetingMinutesValidationError(`${providerLabel}.sourceSpanIds 含不存在於本次原文的片段`);
            sourceEvidence.push({
              section,
              itemIndex,
              blockId: span.blockId,
              quote: span.text,
              ...span.trace,
            });
          }
          return item;
        });
      }
      const humanFields = buildMeetingMinutesHumanFields(captured.human);
      return validateMeetingMinutesProviderRecord(revision ? { ...humanFields, ...content, sourceEvidence }
        : { ...content, ...humanFields, sourceEvidence }, captured);
    },
  };
}

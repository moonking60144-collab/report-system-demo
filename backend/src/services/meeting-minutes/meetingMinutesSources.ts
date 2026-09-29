import {
  MEETING_MINUTES_INPUT_LIMITS,
  MeetingMinutesValidationError,
  validateMeetingRecord,
  type MeetingMinutesProviderInput,
  type MeetingRecord,
} from "./meetingMinutesSchema";

export interface MeetingMinutesSourceBlock {
  id: string;
  sourceId: string;
  offset: number;
  startMs: number | null;
  endMs: number | null;
  text: string;
  segmentSpans: MeetingMinutesSourceSegmentSpan[];
}

export interface MeetingMinutesSourceSegmentSpan {
  segmentId: string;
  sourceSegmentIds: string[];
  sourceId: string;
  speakerLabel: string | null;
  startMs: number;
  endMs: number;
  blockStart: number;
  blockEnd: number;
}

export interface MeetingMinutesResolvedSourceTrace {
  sourceId: string;
  segmentIds: string[];
  sourceSegmentIds: string[];
  startMs: number | null;
  endMs: number | null;
  blockStart: number;
  blockEnd: number;
}

export interface MeetingMinutesSourceBlockWire {
  id: string;
  sourceId: string;
  startMs: number | null;
  endMs: number | null;
  text: string;
}

const SOURCE_BLOCK_MAX_CHARACTERS = 1_200;
const SOURCE_BLOCK_MAX_GAP_MS = 30_000;

function splitEnd(text: string, offset: number, limit: number): number {
  let end = Math.min(offset + limit, text.length);
  if (end < text.length) {
    const prefix = text.slice(offset, end);
    const boundary = Math.max(
      prefix.lastIndexOf("。"),
      prefix.lastIndexOf("！"),
      prefix.lastIndexOf("？"),
      prefix.lastIndexOf("\n")
    );
    if (boundary >= Math.floor(limit / 2)) end = offset + boundary + 1;
    if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  }
  return end;
}

function segmentSliceTime(
  segment: MeetingMinutesProviderInput["transcript"]["segments"][number],
  offset: number,
  end: number
): { startMs: number; endMs: number } {
  if (segment.text.length === 0 || segment.endMs <= segment.startMs) {
    return { startMs: segment.startMs, endMs: segment.endMs };
  }
  const duration = segment.endMs - segment.startMs;
  return {
    startMs: segment.startMs + Math.floor((duration * offset) / segment.text.length),
    endMs: segment.startMs + Math.ceil((duration * end) / segment.text.length),
  };
}

export function buildMeetingMinutesSourceBlocks(input: MeetingMinutesProviderInput): MeetingMinutesSourceBlock[] {
  const blocks: MeetingMinutesSourceBlock[] = [];
  let transcriptOffset = 0;
  let current: MeetingMinutesSourceBlock | null = null;
  const flush = () => {
    if (!current || current.text.length === 0) return;
    current.id = `b${blocks.length + 1}`;
    blocks.push(current);
    current = null;
  };

  for (const segment of input.transcript.segments) {
    let segmentOffset = 0;
    while (segmentOffset < segment.text.length) {
      const gapMs = current?.endMs == null ? Number.POSITIVE_INFINITY : segment.startMs - current.endMs;
      if (
        current &&
        (current.sourceId !== segment.primarySourceId || gapMs > SOURCE_BLOCK_MAX_GAP_MS)
      ) {
        flush();
      }
      current ??= {
        id: "",
        sourceId: segment.primarySourceId,
        offset: transcriptOffset + segmentOffset,
        startMs: null,
        endMs: null,
        text: "",
        segmentSpans: [],
      };
      const remaining = SOURCE_BLOCK_MAX_CHARACTERS - current.text.length;
      if (remaining === 0) {
        flush();
        continue;
      }
      const end = splitEnd(segment.text, segmentOffset, remaining);
      if (end === segmentOffset) {
        flush();
        continue;
      }
      const text = segment.text.slice(segmentOffset, end);
      const blockStart = current.text.length;
      const time = segmentSliceTime(segment, segmentOffset, end);
      current.text += text;
      current.startMs = current.startMs === null ? time.startMs : Math.min(current.startMs, time.startMs);
      current.endMs = current.endMs === null ? time.endMs : Math.max(current.endMs, time.endMs);
      current.segmentSpans.push({
        segmentId: segment.segmentId,
        sourceSegmentIds: [...segment.sourceSegmentIds],
        sourceId: segment.primarySourceId,
        speakerLabel: segment.speakerLabel,
        startMs: time.startMs,
        endMs: time.endMs,
        blockStart,
        blockEnd: current.text.length,
      });
      segmentOffset = end;
      if (current.text.length === SOURCE_BLOCK_MAX_CHARACTERS || segmentOffset < segment.text.length) {
        flush();
      }
    }
    transcriptOffset += segment.text.length;
  }
  flush();

  for (const key of ["confirmedFacts", "revisionConfirmedFacts", "confirmedDecisions", "otherNotes"] as const) {
    const text = input.human[key] ?? "";
    for (let offset = 0; offset < text.length;) {
      const end = splitEnd(text, offset, SOURCE_BLOCK_MAX_CHARACTERS);
      blocks.push({
        id: `b${blocks.length + 1}`,
        sourceId: `human.${key}`,
        offset,
        startMs: null,
        endMs: null,
        text: text.slice(offset, end),
        segmentSpans: [],
      });
      offset = end;
    }
  }
  return blocks;
}

export function toMeetingMinutesSourceBlockWire(
  block: MeetingMinutesSourceBlock
): MeetingMinutesSourceBlockWire {
  return {
    id: block.id,
    sourceId: block.sourceId,
    startMs: block.startMs,
    endMs: block.endMs,
    text: block.text,
  };
}

export function resolveMeetingMinutesSourceRange(
  block: MeetingMinutesSourceBlock,
  blockStart: number,
  blockEnd: number
): MeetingMinutesResolvedSourceTrace {
  const spans = block.segmentSpans.filter(
    (span) => span.blockStart < blockEnd && span.blockEnd > blockStart
  );
  const ranges = spans.map((span) => {
    const overlapStart = Math.max(blockStart, span.blockStart);
    const overlapEnd = Math.min(blockEnd, span.blockEnd);
    const spanCharacters = span.blockEnd - span.blockStart;
    const duration = span.endMs - span.startMs;
    if (spanCharacters <= 0 || duration <= 0) {
      return { startMs: span.startMs, endMs: span.endMs };
    }
    return {
      startMs:
        span.startMs +
        Math.floor(
          (duration * (overlapStart - span.blockStart)) / spanCharacters
        ),
      endMs:
        span.startMs +
        Math.ceil(
          (duration * (overlapEnd - span.blockStart)) / spanCharacters
        ),
    };
  });
  return {
    sourceId: block.sourceId,
    segmentIds: [...new Set(spans.map((span) => span.segmentId))],
    sourceSegmentIds: [
      ...new Set(spans.flatMap((span) => span.sourceSegmentIds)),
    ],
    startMs:
      ranges.length === 0
        ? null
        : Math.min(...ranges.map((range) => range.startMs)),
    endMs:
      ranges.length === 0
        ? null
        : Math.max(...ranges.map((range) => range.endMs)),
    blockStart,
    blockEnd,
  };
}

export function validateMeetingMinutesProviderRecord(value: unknown, input: MeetingMinutesProviderInput): MeetingRecord {
  const record = validateMeetingRecord(value);
  if (input.human.revisionRequest) {
    for (const field of ["title", "date"] as const) {
      if ((record[field]?.length ?? 0) > MEETING_MINUTES_INPUT_LIMITS[field]) {
        throw new MeetingMinutesValidationError(`record.${field} 超過修訂上限 ${MEETING_MINUTES_INPUT_LIMITS[field]} 字元`);
      }
    }
  }
  if (!input.human.revisionRequest && !input.human.confirmedFacts.trim() && record.confirmedFacts.length) {
    throw new MeetingMinutesValidationError("未提供人工確認事實，record.confirmedFacts 必須為空陣列");
  }
  if (!record.sourceEvidence) throw new MeetingMinutesValidationError("record.sourceEvidence 為新生成紀錄的必填欄位");
  const blocks = new Map(buildMeetingMinutesSourceBlocks(input).map(block => [block.id, block]));
  const sourceEvidence = record.sourceEvidence.map((evidence) => {
    if (!record[evidence.section][evidence.itemIndex]) throw new MeetingMinutesValidationError("record.sourceEvidence 指向不存在的項目");
    const block = blocks.get(evidence.blockId);
    if (evidence.section === "confirmedFacts" && block?.sourceId !== "human.confirmedFacts" && block?.sourceId !== "human.revisionConfirmedFacts") {
      throw new MeetingMinutesValidationError("人工確認事實只能引用明確的人工確認事實欄位，不能引用備註、指令、錄音或舊草稿");
    }
    const requestedStart = evidence.blockStart;
    const blockStart =
      block &&
      requestedStart !== undefined &&
      block.text.slice(requestedStart, requestedStart + evidence.quote.length) === evidence.quote
        ? requestedStart
        : block?.text.indexOf(evidence.quote) ?? -1;
    if (!block || blockStart < 0 || evidence.quote.length < Math.min(8, block.text.trim().length)) {
      throw new MeetingMinutesValidationError("record.sourceEvidence 引句不在指定原文區塊內");
    }
    return {
      section: evidence.section,
      itemIndex: evidence.itemIndex,
      blockId: evidence.blockId,
      quote: evidence.quote,
      ...resolveMeetingMinutesSourceRange(
        block,
        blockStart,
        blockStart + evidence.quote.length
      ),
    };
  });
  const requiredSections = input.human.revisionRequest
    ? ["confirmedFacts", "confirmedDecisions", "followUpActions"] as const
    : ["confirmedDecisions", "followUpActions"] as const;
  for (const section of requiredSections) {
    record[section].forEach((_item, itemIndex) => {
      if (!sourceEvidence.some(evidence => evidence.section === section && evidence.itemIndex === itemIndex)) {
        throw new MeetingMinutesValidationError(`record.${section}[${itemIndex}] 缺少原文引用`);
      }
    });
  }
  return { ...record, sourceEvidence,
    ...(input.human.revisionRequest ? {
      confirmedFacts: record.confirmedFacts.map(item => ({ ...item, sourceBasis: "使用者補充／確認" })),
      confirmedDecisions: record.confirmedDecisions.map((item, itemIndex) => {
        const evidence = sourceEvidence.filter(row => row.section === "confirmedDecisions" && row.itemIndex === itemIndex);
        return evidence.every(row => row.sourceId.startsWith("human.")) ? { ...item, sourceBasis: "使用者補充／確認" } : item;
      }),
    } : {}),
  };
}

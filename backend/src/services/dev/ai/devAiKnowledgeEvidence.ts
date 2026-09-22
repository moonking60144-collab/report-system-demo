import { createHash } from "node:crypto";
import type { DevAiKnowledgeSource } from "@shared-types/ragicDefinitions";
import { DEV_AI_IPV4_TOKEN, findDevAiNetworkAddressOccurrences } from "./devAiNetworkAddress";

const WINDOW_CHARS = 360;
const MAX_SPANS = 3;

function contentHash(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

export function knowledgeEvidenceForRanges(content: string, ranges: { start: number; end: number }[]): Pick<DevAiKnowledgeSource, "excerpt" | "sourceVersion" | "evidenceSpans"> {
  let excerpt = "";
  const evidenceSpans: NonNullable<DevAiKnowledgeSource["evidenceSpans"]> = [];
  const merged: { start: number; end: number }[] = [];
  for (const range of ranges) {
    const overlapping = merged.find((existing) => range.start < existing.end && existing.start < range.end);
    if (overlapping) {
      overlapping.start = Math.min(overlapping.start, range.start);
      overlapping.end = Math.max(overlapping.end, range.end);
    } else merged.push({ ...range });
  }
  for (const range of merged) {
    if (excerpt) excerpt += "\n…\n";
    const excerptStart = excerpt.length;
    const text = content.slice(range.start, range.end);
    excerpt += text;
    const hash = contentHash(text);
    evidenceSpans.push({ spanId: `${range.start}-${range.end}:${hash}`, sourceStart: range.start, sourceEnd: range.end, excerptStart, excerptEnd: excerpt.length, contentHash: hash });
  }
  return { excerpt, sourceVersion: contentHash(content), evidenceSpans };
}

export function selectKnowledgeEvidence(
  content: string,
  queryTokens: Set<string>
): Pick<DevAiKnowledgeSource, "excerpt" | "sourceVersion" | "evidenceSpans"> {
  const ranges = new Map<number, { start: number; end: number; text: string; matches: Set<string> }>();
  const tokens = [...queryTokens].sort((a, b) => b.length - a.length).slice(0, 32);
  const lower = content.toLowerCase();
  if (content.length > WINDOW_CHARS) {
    const addWindow = (found: number, token: string) => {
      const start = Math.max(0, Math.min(found - 90, content.length - WINDOW_CHARS));
      const existing = ranges.get(start);
      if (existing) { existing.matches.add(token); return; }
      const end = Math.min(content.length, start + WINDOW_CHARS);
      ranges.set(start, { start, end, text: content.slice(start, end), matches: new Set([token]) });
    };
    const endpointTokens = tokens.filter((token) => DEV_AI_IPV4_TOKEN.test(token));
    for (const occurrence of findDevAiNetworkAddressOccurrences(content)) {
      for (const token of endpointTokens) {
        if (occurrence.token === token || (!token.includes(":") && occurrence.token.startsWith(`${token}:`))) addWindow(occurrence.start, token);
      }
    }
    for (const token of tokens) {
      if (DEV_AI_IPV4_TOKEN.test(token)) continue;
      let found = lower.indexOf(token);
      for (let count = 0; found >= 0 && count < 12; count += 1) {
        addWindow(found, token);
        found = lower.indexOf(token, found + token.length);
      }
    }
  }
  if (!ranges.size) {
    const end = Math.min(content.length, WINDOW_CHARS);
    ranges.set(0, { start: 0, end, text: content.slice(0, end), matches: new Set() });
  }
  const candidates = [...ranges.values()];
  const frequencies = new Map(tokens.map((token) => [token, candidates.filter((range) => range.matches.has(token) || range.text.toLowerCase().includes(token)).length]));
  const ranked = candidates.map((range) => ({
    ...range,
    score: tokens.reduce((sum, token) => sum + (range.matches.has(token) || range.text.toLowerCase().includes(token)
      ? (token.length > 1 ? 4 : 1) / Math.max(1, frequencies.get(token) ?? 1)
      : 0), 0),
  })).sort((a, b) => b.score - a.score || a.start - b.start);
  const selected: typeof candidates = [];
  for (const range of ranked) {
    if (selected.some((other) => Math.min(other.end, range.end) - Math.max(other.start, range.start) > 90)) continue;
    selected.push(range);
    if (selected.length === MAX_SPANS) break;
  }
  return knowledgeEvidenceForRanges(content, selected);
}

export function trimKnowledgeEvidence(source: DevAiKnowledgeSource, maxChars: number): DevAiKnowledgeSource {
  const limit = Math.max(0, Math.trunc(maxChars));
  if (source.excerpt.length <= limit) return source;

  const spans = source.evidenceSpans?.filter((span) =>
    span.excerptStart >= 0 &&
    span.excerptEnd > span.excerptStart &&
    span.excerptEnd <= source.excerpt.length
  );
  if (!spans?.length) return { ...source, excerpt: source.excerpt.slice(0, limit) };

  const separator = "\n…\n";
  const spanCount = Math.max(
    1,
    Math.min(spans.length, Math.floor((limit + separator.length) / (80 + separator.length)))
  );
  const retained = spans.slice(0, spanCount);
  const allocations = retained.map(() => 0);
  let remaining = Math.max(0, limit - separator.length * (retained.length - 1));
  let pending = retained.map((_, index) => index);
  while (remaining > 0 && pending.length > 0) {
    const share = Math.max(1, Math.floor(remaining / pending.length));
    const next: number[] = [];
    for (const index of pending) {
      const span = retained[index];
      const capacity = span.excerptEnd - span.excerptStart - allocations[index];
      const take = Math.min(capacity, share, remaining);
      allocations[index] += take;
      remaining -= take;
      if (take < capacity) next.push(index);
    }
    pending = next;
  }

  let excerpt = "";
  const evidenceSpans: NonNullable<DevAiKnowledgeSource["evidenceSpans"]> = [];
  const appendMappedText = (
    span: NonNullable<DevAiKnowledgeSource["evidenceSpans"]>[number],
    sourceOffset: number,
    text: string
  ) => {
    const excerptStart = excerpt.length;
    excerpt += text;
    const sourceStart = span.sourceStart + sourceOffset;
    const sourceEnd = sourceStart + text.length;
    const hash = contentHash(text);
    evidenceSpans.push({
      ...span,
      spanId: `${sourceStart}-${sourceEnd}:${hash}`,
      sourceStart,
      sourceEnd,
      excerptStart,
      excerptEnd: excerpt.length,
      contentHash: hash,
    });
  };
  retained.forEach((span, index) => {
    const budget = allocations[index];
    if (budget <= 0) return;
    if (excerpt) excerpt += separator;
    const fullLength = span.excerptEnd - span.excerptStart;
    if (budget >= fullLength || budget < 3) {
      appendMappedText(
        span,
        0,
        source.excerpt.slice(span.excerptStart, span.excerptStart + Math.min(budget, fullLength))
      );
      return;
    }

    const innerSeparator = "…";
    const retainedChars = budget - innerSeparator.length;
    const headLength = Math.ceil(retainedChars / 2);
    const tailLength = retainedChars - headLength;
    appendMappedText(span, 0, source.excerpt.slice(span.excerptStart, span.excerptStart + headLength));
    excerpt += innerSeparator;
    appendMappedText(
      span,
      fullLength - tailLength,
      source.excerpt.slice(span.excerptEnd - tailLength, span.excerptEnd)
    );
  });

  return {
    ...source,
    excerpt,
    evidenceSpans,
  };
}

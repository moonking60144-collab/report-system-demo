import type { ReactNode } from "react";
import { normalizeText, parseSemanticBoolean, toSortableDate, toSortableNumber } from "../utils";

export function createHighlightedTextRenderer(globalSearchKeyword: string) {
  const normalizedGlobalSearchKeyword = normalizeText(globalSearchKeyword);

  return (value: unknown): ReactNode => {
    if (value === null || value === undefined || value === "") {
      return "-";
    }

    const rawText = String(value);
    if (!normalizedGlobalSearchKeyword) {
      return rawText;
    }

    const haystack = rawText.toLowerCase();
    if (!haystack.includes(normalizedGlobalSearchKeyword)) {
      return rawText;
    }

    const parts: ReactNode[] = [];
    let cursor = 0;

    while (cursor < rawText.length) {
      const matchIndex = haystack.indexOf(normalizedGlobalSearchKeyword, cursor);
      if (matchIndex < 0) {
        if (cursor < rawText.length) {
          parts.push(rawText.slice(cursor));
        }
        break;
      }

      if (matchIndex > cursor) {
        parts.push(rawText.slice(cursor, matchIndex));
      }

      const endIndex = matchIndex + normalizedGlobalSearchKeyword.length;
      parts.push(
        <span key={`match-${matchIndex}-${endIndex}`} className="table-match-highlight">
          {rawText.slice(matchIndex, endIndex)}
        </span>
      );
      cursor = endIndex;
    }

    return parts;
  };
}

export function toColumnSortableNumber(value: unknown): number {
  return toSortableNumber(value) ?? 0;
}

export function toColumnSortableDate(value: unknown): number {
  return toSortableDate(value) ?? 0;
}

export function renderSemanticCheck(value: unknown): string {
  return parseSemanticBoolean(value) === true ? "✓" : "";
}

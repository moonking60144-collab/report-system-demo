export { parseSemanticBoolean } from "../../../utils/semanticBoolean";

const LEGACY_HYPHENATED_DATE_PREFIX = /^(\d{4})-(\d{1,2})-(\d{1,2})(?=\s|$)/;
const ALPHA_NUMERIC_COLLATOR = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

export function compareAlphaNumeric(a: string, b: string): number {
  return ALPHA_NUMERIC_COLLATOR.compare(a, b);
}

export function toSortableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const normalized = String(value).replace(/,/g, "").trim();
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toSortableDate(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const normalized = String(value).trim();
  const legacyNormalized = normalized.replace(
    LEGACY_HYPHENATED_DATE_PREFIX,
    "$1/$2/$3"
  );
  const candidates =
    legacyNormalized === normalized
      ? [normalized]
      : [legacyNormalized, normalized];

  for (const candidate of candidates) {
    const timestamp = new Date(candidate).getTime();
    if (!Number.isNaN(timestamp)) {
      return timestamp;
    }
  }
  return null;
}

export function normalizeColumnText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim();
}

export function normalizeText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim().toLowerCase();
}

export { parseSemanticBoolean } from "../../../utils/semanticBoolean";

export function compareAlphaNumeric(a: string, b: string): number {
  return a.localeCompare(b, "en", {
    numeric: true,
    sensitivity: "base",
  });
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
  const parsed = new Date(String(value).replace(/-/g, "/"));
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
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

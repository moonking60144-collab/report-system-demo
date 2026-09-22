export function normalizeDateOnly(value: unknown): string | null {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T].*)?$/);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function toRagicDateOnly(value: string): string {
  const normalized = normalizeDateOnly(value);
  if (!normalized) {
    throw new Error(`無效的日期：${value}`);
  }
  return normalized.replaceAll("-", "/");
}

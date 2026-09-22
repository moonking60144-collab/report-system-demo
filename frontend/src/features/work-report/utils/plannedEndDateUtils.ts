export function normalizePlannedEndDate(value: unknown): string | null {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!match) return null;
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
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

export function formatPlannedEndDateDisplay(value: unknown): string {
  const normalized = normalizePlannedEndDate(value);
  return normalized ? normalized.replaceAll("-", "/") : String(value ?? "").trim();
}

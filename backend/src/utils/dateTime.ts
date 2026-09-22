const LEGACY_HYPHENATED_DATE_PREFIX = /^(\d{4})-(\d{1,2})-(\d{1,2})(?=\s|$)/;

export function parseDateTimeTimestamp(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = String(value).trim();
  if (!normalized) {
    return null;
  }

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

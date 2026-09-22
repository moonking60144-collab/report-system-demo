export function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === "";
}

export function normalizeComparableValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

export function parseHourMinuteValue(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = String(value).trim();
  if (!normalized) {
    return null;
  }

  const parseParts = (
    hourText: string,
    minuteText: string
  ): { hour: number; minute: number } | null => {
    const hour = Number.parseInt(hourText, 10);
    const minute = Number.parseInt(minuteText, 10);
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute < 0 || minute >= 60) {
      return null;
    }
    return { hour, minute };
  };

  const plainMatch = normalized.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (plainMatch) {
    const parsed = parseParts(plainMatch[1], plainMatch[2]);
    const second = plainMatch[3] ? Number.parseInt(plainMatch[3], 10) : 0;
    if (!Number.isFinite(second) || second < 0 || second >= 60) {
      return null;
    }
    if (!parsed || parsed.hour < 0 || parsed.hour >= 24) {
      return null;
    }
    return parsed.hour * 60 + parsed.minute;
  }

  const prefixedMatch = normalized.match(
    /^(上午|下午|am|pm)\s*(\d{1,2}):(\d{2})(?::(\d{2}))?$/i
  );
  const suffixedMatch = normalized.match(/^((?:\d{1,2})):(\d{2})(?::(\d{2}))?\s*(am|pm)$/i);
  const marker = prefixedMatch ? prefixedMatch[1] : suffixedMatch ? suffixedMatch[4] : null;
  const hourText = prefixedMatch ? prefixedMatch[2] : suffixedMatch ? suffixedMatch[1] : null;
  const minuteText = prefixedMatch ? prefixedMatch[3] : suffixedMatch ? suffixedMatch[2] : null;
  const secondText = prefixedMatch ? prefixedMatch[4] : suffixedMatch ? suffixedMatch[3] : null;

  if (!marker || !hourText || !minuteText) {
    return null;
  }

  if (secondText) {
    const second = Number.parseInt(secondText, 10);
    if (!Number.isFinite(second) || second < 0 || second >= 60) {
      return null;
    }
  }

  const parsed = parseParts(hourText, minuteText);
  if (!parsed || parsed.hour < 1 || parsed.hour > 12) {
    return null;
  }

  const normalizedMarker = marker.toLowerCase();
  const isPm = normalizedMarker === "pm" || marker === "下午";
  let hour = parsed.hour % 12;
  if (isPm) {
    hour += 12;
  }
  return hour * 60 + parsed.minute;
}

export function parseNumericValue(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = String(value).trim();
  if (!normalized) {
    return null;
  }
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

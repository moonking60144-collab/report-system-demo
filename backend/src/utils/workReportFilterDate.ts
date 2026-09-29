export function getWorkReportFilterDateKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{4})[/-](\d{2})[/-](\d{2})(?:[ Tt](.+))?$/);
  if (!match) return null;
  const time = (match[4] ?? "00:00:00").toUpperCase();
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(time);
  const timestamp = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${time}${hasTimezone ? "" : "+08:00"}`);
  if (!Number.isFinite(timestamp)) return null;
  // 報工日曆日期固定使用 UTC+08:00，避免瀏覽器與 Server 時區不同。
  return new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function formatMeetingLibraryCodeInput(value: string): string {
  const normalized = value
    .toUpperCase()
    .replace(/[^2-9A-HJ-NP-Z]/g, "")
    .slice(0, 6);
  return normalized.length > 3
    ? `${normalized.slice(0, 3)}-${normalized.slice(3)}`
    : normalized;
}

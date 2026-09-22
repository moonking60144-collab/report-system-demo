export function isSupportedMeetingTranscriptionLocalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function isLoopbackMeetingTranscriptionLocalUrl(value: string): boolean {
  if (!isSupportedMeetingTranscriptionLocalUrl(value)) return false;
  const hostname = new URL(value).hostname.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname.startsWith("127.") ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

export function isLocalWhisperConfigurationEnabled(
  url: string,
  model: string,
  token: string
): boolean {
  return (
    isSupportedMeetingTranscriptionLocalUrl(url) &&
    Boolean(model.trim()) &&
    (isLoopbackMeetingTranscriptionLocalUrl(url) || Boolean(token.trim()))
  );
}

const URL_IPV4 = /(https?):\/\/((?:\d{1,3}\.){3}\d{1,3})(?::(\d{1,5}))?/gi;
const BARE_IPV4 = /(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?/g;

export const DEV_AI_IPV4_TOKEN = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?$/;

export interface DevAiNetworkAddressOccurrence {
  token: string;
  start: number;
  end: number;
}

export function findDevAiNetworkAddressOccurrences(text: string): DevAiNetworkAddressOccurrence[] {
  const occurrences: DevAiNetworkAddressOccurrence[] = [];
  for (const match of text.matchAll(URL_IPV4)) {
    const start = match.index;
    const scheme = match[1]!.toLowerCase();
    const host = match[2]!;
    const port = match[3] ? Number(match[3]) : scheme === "https" ? 443 : 80;
    occurrences.push({ token: `${host}:${port}`, start, end: start + match[0].length });
  }
  for (const match of text.matchAll(BARE_IPV4)) {
    const start = match.index;
    const end = start + match[0].length;
    if (occurrences.some((occurrence) => start < occurrence.end && occurrence.start < end)) continue;
    const [host, port] = match[0].split(":");
    occurrences.push({ token: port ? `${host}:${Number(port)}` : host!, start, end });
  }
  return occurrences.sort((a, b) => a.start - b.start);
}

export function stripDevAiNetworkAddresses(text: string, occurrences = findDevAiNetworkAddressOccurrences(text)): string {
  let result = "";
  let offset = 0;
  for (const occurrence of occurrences) {
    result += text.slice(offset, occurrence.start) + " ";
    offset = occurrence.end;
  }
  return result + text.slice(offset);
}

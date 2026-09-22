export const MEETING_AUDIO_CHECK_ROUTE = "/meetings/audio-check";
export const MEETING_LIBRARY_ROUTE = "/meetings/library";

export function isMeetingMinutesPath(pathname: string): boolean {
  return pathname === "/meetings" || pathname.startsWith("/meetings/");
}

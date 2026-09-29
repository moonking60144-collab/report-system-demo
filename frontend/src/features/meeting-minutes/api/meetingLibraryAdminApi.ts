import { createApiClient } from "../../../api/apiClient";
import type { MeetingRecordingSession, MeetingMinutesVersion } from "./meetingRecordingApi";

const api = createApiClient({ withCredentials: true });

export interface MeetingSummaryItem {
  sessionId: string; versionNumber: number; title: string; meetingDate: string | null;
  generatedAt: string; archivedAt: string; sizeBytes: number;
}

export type MeetingAdminPhase = "recording" | "interrupted" | "finalizing" | "processing" | "transcribing" | "summarizing" | "cancelling" | "cancelled" | "ready" | "failed" | "expired" | "unknown";

export interface MeetingAdminMeeting {
  sessionId: string;
  title: string;
  createdAt: string;
  phase: MeetingAdminPhase;
  occupiesSlot: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  source: { displayName: string; userAgent: string | null; ip: string | null };
  actions: { canCancel: boolean; canRetry: boolean };
}

export interface MeetingAdminState {
  meetings: MeetingAdminMeeting[];
  stats: { activeMeetings: number; maxMeetings: number };
}

export async function fetchAdminMeetings(token: string): Promise<MeetingAdminState> {
  return (await api.get<{ data: MeetingAdminState }>("/meetings/admin/meetings", { headers: adminHeaders(token) })).data.data;
}

export async function cancelAdminMeeting(token: string, sessionId: string): Promise<MeetingAdminMeeting> {
  return (await api.post<{ data: MeetingAdminMeeting }>(`/meetings/admin/meetings/${encodeURIComponent(sessionId)}/cancel`,
    undefined, { headers: adminHeaders(token) })).data.data;
}

export async function retryAdminMeeting(token: string, sessionId: string): Promise<MeetingAdminMeeting> {
  return (await api.post<{ data: MeetingAdminMeeting }>(`/meetings/admin/meetings/${encodeURIComponent(sessionId)}/retry`,
    undefined, { headers: adminHeaders(token) })).data.data;
}

export async function fetchMeetingSummaryArchive(token: string, query: string, offset: number) {
  return (await api.get<{ data: { items: MeetingSummaryItem[]; stats: { count: number; bytes: number; maxBytes: number }; admission: { available: boolean; reason: string | null } | null } }>(
    "/meetings/admin/summaries", { headers: adminHeaders(token), params: { q: query, offset } }
  )).data.data;
}

export async function fetchMeetingSummaryHtml(token: string, sessionId: string): Promise<string> {
  return (await api.get<string>(`/meetings/admin/summaries/${encodeURIComponent(sessionId)}/html`,
    { headers: adminHeaders(token), responseType: "text" })).data;
}

export async function downloadMeetingSummaryHtml(token: string, sessionId: string): Promise<void> {
  const response = await api.get<Blob>(`/meetings/admin/summaries/${encodeURIComponent(sessionId)}/html`, {
    headers: adminHeaders(token), responseType: "blob", params: { download: "1" },
  });
  const url = URL.createObjectURL(response.data);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `meeting-summary-${sessionId}.html`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}


function adminHeaders(token: string) { return { Authorization: `Bearer ${token}` }; }
export async function fetchLegacyRecordings(token: string, offset: number) {
  return (await api.get<{ data: MeetingRecordingSession[] }>("/meetings/admin/legacy-recordings", { headers: adminHeaders(token), params: { offset } })).data.data;
}
export async function fetchLegacyMinutesVersions(token: string, sessionId: string) {
  return (await api.get<{ data: MeetingMinutesVersion[] }>(`/meetings/admin/legacy-recordings/${encodeURIComponent(sessionId)}/minutes/versions`, { headers: adminHeaders(token) })).data.data;
}
export async function downloadLegacyRecordingFile(token: string, sessionId: string, suffix: string, filename: string) {
  const response = await api.get<Blob>(`/meetings/admin/legacy-recordings/${encodeURIComponent(sessionId)}/${suffix}`, { headers: adminHeaders(token), responseType: "blob" });
  const url = URL.createObjectURL(response.data);
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

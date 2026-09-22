import { createApiClient } from "../../../api/apiClient";
import type {
  MeetingLibraryCodeResult,
  MeetingLibraryInfo,
  MeetingRecordingSession,
} from "./meetingRecordingApi";

const api = createApiClient({ withCredentials: true });

export interface MeetingAdminLibrary extends MeetingLibraryInfo {
  recordingCount: number;
  latestRecording: MeetingRecordingSession | null;
}

export interface MeetingAdminLibrariesPage {
  items: MeetingAdminLibrary[];
  nextCursor: string | null;
  hasMore: boolean;
  totalCount: number;
  totalRecordingCount: number;
}

function adminHeaders(token: string, mutation = false): Record<string, string> {
  return mutation
    ? { Authorization: `Bearer ${token}`, "X-Meeting-Request": "1" }
    : { Authorization: `Bearer ${token}` };
}

export async function fetchMeetingAdminLibraries(
  token: string,
  query = "",
  limit = 100,
  cursor: string | null = null
): Promise<MeetingAdminLibrariesPage> {
  const response = await api.get<{
    data: MeetingAdminLibrary[];
    meta: {
      nextCursor: string | null;
      hasMore: boolean;
      totalCount: number;
      totalRecordingCount: number;
    };
  }>(
    "/meetings/admin/libraries",
    {
      headers: adminHeaders(token),
      params: { query: query.trim(), limit, ...(cursor ? { cursor } : {}) },
    }
  );
  return {
    items: response.data.data,
    nextCursor: response.data.meta.nextCursor,
    hasMore: response.data.meta.hasMore,
    totalCount: response.data.meta.totalCount,
    totalRecordingCount: response.data.meta.totalRecordingCount,
  };
}

export async function openMeetingAdminLibrary(
  token: string,
  libraryId: string
): Promise<MeetingLibraryInfo> {
  const response = await api.post<{ data: MeetingLibraryInfo }>(
    `/meetings/admin/libraries/${encodeURIComponent(libraryId)}/open`,
    undefined,
    { headers: adminHeaders(token, true) }
  );
  return response.data.data;
}

export async function rotateMeetingAdminLibraryCode(
  token: string,
  libraryId: string
): Promise<MeetingLibraryCodeResult> {
  const response = await api.post<{
    data: { library: MeetingLibraryInfo; code: string };
  }>(
    `/meetings/admin/libraries/${encodeURIComponent(libraryId)}/rotate-code`,
    undefined,
    { headers: adminHeaders(token, true) }
  );
  return {
    enabled: true,
    library: response.data.data.library,
    code: response.data.data.code,
  };
}

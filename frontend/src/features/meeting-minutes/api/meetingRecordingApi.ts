import axios from "axios";
import { createApiClient } from "../../../api/apiClient";
import { getOrCreateClientId, getOrCreateTabId } from "../../../utils/clientIdentity";
import type { MeetingAudioSourceId } from "../audio/useMeetingAudioCheck";

export interface MeetingRecordingTrack {
  sourceId: MeetingAudioSourceId;
  mimeType: string;
  chunkCount: number;
  sizeBytes: number;
  available: boolean;
}

export interface MeetingRecordingSession {
  deliveryMode?: "one-shot";
  sessionId: string;
  title: string;
  status: "recording" | "finalized";
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  durationMs: number | null;
  totalSizeBytes: number;
  tracks: MeetingRecordingTrack[];
  recoveryUntil?: string | null;
}




export interface MeetingRecordingCreateResult {
  session: MeetingRecordingSession;
  sessionCapability: string | null;
  reusedSession: boolean;
}



export type MeetingProcessingStatus = "pending" | "running" | "ready" | "failed";

export type MeetingProcessingPhase =
  | "queued"
  | "validating-audio"
  | "normalizing-room-mic"
  | "normalizing-remote-tab"
  | "generating-playback"
  | "ready";

export type MeetingProcessingArtifactType =
  | "canonical-room-mic"
  | "canonical-remote-tab"
  | "playback";

export interface MeetingProcessingArtifact {
  artifactId: string;
  jobId: string;
  sessionId: string;
  type: MeetingProcessingArtifactType;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  downloadUrl: string;
}

export interface MeetingProcessingJob {
  jobId: string;
  sessionId: string;
  status: MeetingProcessingStatus;
  phase: MeetingProcessingPhase;
  attemptCount: number;
  maxAttempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  artifacts: MeetingProcessingArtifact[];
}


export type MeetingTranscriptionStatus = "pending" | "running" | "ready" | "failed";

export type MeetingTranscriptionPhase =
  | "queued"
  | "preparing"
  | "transcribing-room-mic"
  | "transcribing-remote-tab"
  | "merging-transcript"
  | "ready";

export type MeetingTranscriptionArtifactType =
  | "transcript-room-mic-json"
  | "transcript-remote-tab-json"
  | "transcript-merged-json"
  | "transcript-text";

export interface MeetingTranscriptionArtifact {
  artifactId: string;
  jobId: string;
  sessionId: string;
  type: MeetingTranscriptionArtifactType;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  downloadUrl: string;
}

export interface MeetingTranscriptionJob {
  jobId: string;
  processingJobId: string;
  sessionId: string;
  provider: string;
  model: string;
  status: MeetingTranscriptionStatus;
  phase: MeetingTranscriptionPhase;
  attemptCount: number;
  maxAttempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  artifacts: MeetingTranscriptionArtifact[];
}




export interface MeetingMinutesHumanInput {
  title: string;
  date: string | null;
  attendees: string;
  confirmedFacts: string;
  confirmedDecisions: string;
  termCorrections: string;
  otherNotes: string;
  revisionRequest?: string;
  revisionConfirmedFacts?: string;
}

export interface MeetingMinutesRecord {
  version: 1;
  title: string;
  date: string | null;
  subtitle: string;
  attendees: Array<{ department: string | null; names: string[] }>;
  executiveSummary: string;
  discussionPoints: Array<{
    title: string;
    currentProblem: string | null;
    discussion: string;
    direction: string | null;
  }>;
  confirmedFacts: Array<{ content: string; sourceBasis: string | null }>;
  confirmedDecisions: Array<{ content: string; sourceBasis: string | null }>;
  systemRequirements: Array<{ content: string; owner: string | null }>;
  pendingItems: Array<{ content: string; requiredConfirmation: string | null }>;
  followUpActions: Array<{ content: string; owner: string | null; dueDate: string | null }>;
  uncertainTerms: string[];
  additionalSections?: Array<{ title: string; content: string }>;
}

export type MeetingMinutesStatus = "pending" | "running" | "ready" | "failed";
export type MeetingMinutesPhase = "queued" | "generating" | "packaging" | "ready";
export type MeetingMinutesArtifactType =
  | "minutes-html"
  | "minutes-record-json"
  | "minutes-source-transcript-json"
  | "minutes-source-transcript-text"
  | "minutes-audio";

export interface MeetingMinutesArtifact {
  artifactId: string;
  versionId: string;
  jobId: string;
  sessionId: string;
  type: MeetingMinutesArtifactType;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  downloadUrl: string;
}

export interface MeetingMinutesVersion {
  versionId: string;
  jobId: string;
  sessionId: string;
  versionNumber: number;
  record: MeetingMinutesRecord;
  generatedAt: string;
  artifacts: MeetingMinutesArtifact[];
  packageUrl: string;
}

export interface MeetingMinutesJob {
  jobId: string;
  sessionId: string;
  clientRequestKey: string;
  input: MeetingMinutesHumanInput;
  provider: string;
  model: string;
  status: MeetingMinutesStatus;
  phase: MeetingMinutesPhase;
  attemptCount: number;
  maxAttempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  version: MeetingMinutesVersion | null;
  revisionChanges?: {
    baseVersionId: string;
    candidateVersionId: string;
    entries: Array<{ field: string; removed: string[]; added: string[]; requiresAcknowledgement: boolean }>;
    requiresAcknowledgement: boolean;
    acknowledgementToken: string;
  } | null;
  revisionComparisonError?: string;
}


const api = createApiClient({ withCredentials: true });
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "/api").replace(/\/$/, "");
const MEETING_MUTATION_HEADERS = {
  "X-Meeting-Request": "1",
  "x-debug-client-id": getOrCreateClientId(),
  "X-Meeting-Recorder-Id": getOrCreateTabId(),
};
const MEETING_SESSION_CAPABILITY_HEADER = "X-Meeting-Session-Capability";
const MEETING_SESSION_CAPABILITY_STORAGE_PREFIX =
  "meeting-minutes:session-capability:v1:";
const meetingSessionCapabilities = new Map<string, string>();
const TERMINAL_MEETING_SESSION_ACCESS_ERROR_CODES = new Set([
  "MEETING_RECORDING_OWNER_REQUIRED",
  "MEETING_RECORDING_SESSION_CAPABILITY_EXPIRED",
  "MEETING_RECORDING_SESSION_CAPABILITY_REVOKED",
  "MEETING_RECORDING_SESSION_CAPABILITY_INVALID",
  "MEETING_RECORDING_SESSION_CAPABILITY_REQUIRED",
  "MEETING_LIBRARY_RECORDER_EXPIRED",
  "MEETING_LIBRARY_RECORDER_REQUIRED",
]);

type MeetingSessionCapabilityStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

function resolveMeetingSessionCapabilityStorage(
  storage?: MeetingSessionCapabilityStorage
): MeetingSessionCapabilityStorage | null {
  if (storage) return storage;
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function sessionCapabilityStorageKey(sessionId: string): string {
  return `${MEETING_SESSION_CAPABILITY_STORAGE_PREFIX}${sessionId}`;
}

export function persistMeetingSessionCapability(
  sessionId: string,
  capability: string | null,
  storage?: MeetingSessionCapabilityStorage
): void {
  const key = sessionCapabilityStorageKey(sessionId);
  if (capability) meetingSessionCapabilities.set(sessionId, capability);
  else meetingSessionCapabilities.delete(sessionId);
  const target = resolveMeetingSessionCapabilityStorage(storage);
  if (!target) return;
  try {
    if (capability) target.setItem(key, capability);
    else target.removeItem(key);
  } catch {
    // 目前分頁仍可透過記憶體 capability 完成既有錄音。
  }
}

export function readMeetingSessionCapability(
  sessionId: string,
  storage?: MeetingSessionCapabilityStorage
): string | null {
  const fallback = meetingSessionCapabilities.get(sessionId) ?? null;
  const target = resolveMeetingSessionCapabilityStorage(storage);
  if (!target) return fallback;
  try {
    const capability = target.getItem(sessionCapabilityStorageKey(sessionId));
    if (capability) meetingSessionCapabilities.set(sessionId, capability);
    return capability ?? fallback;
  } catch {
    return fallback;
  }
}

export function isMeetingSessionAccessTerminalErrorCode(
  code: string | null
): boolean {
  return code !== null && TERMINAL_MEETING_SESSION_ACCESS_ERROR_CODES.has(code);
}


function meetingSessionHeaders(
  sessionId: string,
  mutation = false
): Record<string, string> {
  const capability = readMeetingSessionCapability(sessionId);
  return {
    ...(mutation ? MEETING_MUTATION_HEADERS : {}),
    ...(capability
      ? { [MEETING_SESSION_CAPABILITY_HEADER]: capability }
      : {}),
  };
}

export async function createMeetingRecordingSession(input: {
  deliveryMode?: "one-shot";
  additionalSectionRequest?: string;
  title: string;
  sourceIds: MeetingAudioSourceId[];
}): Promise<MeetingRecordingCreateResult> {
  const response = await api.post<{
    data: MeetingRecordingSession;
    meta?: {
      sessionCapability?: string | null;
      reusedSession?: boolean;
    };
  }>(
    "/meetings/recordings",
    input,
    { headers: MEETING_MUTATION_HEADERS }
  );
  const sessionCapability = response.data.meta?.sessionCapability ?? null;
  if (input.deliveryMode === "one-shot") {
    try { sessionStorage.setItem("meeting-one-shot-session", response.data.data.sessionId); } catch { /* Recording recovery remains in IndexedDB. */ }
  }
  persistMeetingSessionCapability(response.data.data.sessionId, sessionCapability);
  return {
    session: response.data.data,
    sessionCapability,
    reusedSession: response.data.meta?.reusedSession === true,
  };
}

export async function heartbeatMeetingRecordingSession(sessionId: string): Promise<void> {
  await api.post(
    `/meetings/recordings/${encodeURIComponent(sessionId)}/heartbeat`,
    undefined,
    { headers: MEETING_MUTATION_HEADERS }
  );
}

export interface MeetingCurrentSource {
  displayName: string;
  lastSeenAt: string;
}

export interface MeetingCurrentContext {
  source: MeetingCurrentSource | null;
  sessionId: string | null;
}

export async function fetchCurrentMeetingContext(): Promise<MeetingCurrentContext> {
  return (await api.get<{ data: MeetingCurrentContext }>("/meetings/recordings/current", {
    headers: { "X-Meeting-Recorder-Id": MEETING_MUTATION_HEADERS["X-Meeting-Recorder-Id"] },
  })).data.data;
}

export async function releaseCurrentMeeting(sessionId: string): Promise<void> {
  await api.post(`/meetings/recordings/${encodeURIComponent(sessionId)}/release-current`, undefined, {
    headers: MEETING_MUTATION_HEADERS,
  });
}

export interface MeetingOneShotAvailability {
  mode: "one-shot";
  available: boolean;
  reason: string | null;
  deliveryMs: number;
  admission: { activeMeetings: number; maxMeetings: number };
}

export interface MeetingOneShotStatus {
  admission?: { activeMeetings: number; maxMeetings: number };
  liveTranscription?: Array<{ sourceId: string; decodedMs: number; processedMs: number; complete: boolean; failed: boolean; deferred?: boolean }>;
  additionalSectionRequest?: string;
  phase: "recording" | "interrupted" | "finalizing" | "processing" | "transcribing" | "summarizing" | "cancelling" | "cancelled" | "ready" | "failed" | "expired" | "legacy-saved";
  retryAvailable?: boolean;
  session?: MeetingRecordingSession;
  expiresAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  processing: MeetingProcessingJob | null;
  transcription: MeetingTranscriptionJob | null;
  minutes: MeetingMinutesJob | null;
  revision?: MeetingMinutesJob | null;
}

export async function requestMeetingSummaryRevision(sessionId: string, baseVersionId: string, request: string, clientRequestKey: string, confirmedFacts = ""): Promise<MeetingMinutesJob> {
  return (await api.post<{ data: MeetingMinutesJob }>(`/meetings/recordings/${encodeURIComponent(sessionId)}/delivery/revisions`,
    { baseVersionId, request, clientRequestKey, confirmedFacts }, { headers: meetingSessionHeaders(sessionId, true) })).data.data;
}

export async function adoptMeetingSummaryRevision(sessionId: string, jobId: string, expectedVersionId: string, acknowledgementToken?: string): Promise<void> {
  await api.post(`/meetings/recordings/${encodeURIComponent(sessionId)}/delivery/revisions/${encodeURIComponent(jobId)}/adopt`,
    { expectedVersionId, acknowledgementToken }, { headers: meetingSessionHeaders(sessionId, true) });
}

export async function discardMeetingSummaryRevision(sessionId: string, jobId: string): Promise<void> {
  await api.post(`/meetings/recordings/${encodeURIComponent(sessionId)}/delivery/revisions/${encodeURIComponent(jobId)}/discard`, {},
    { headers: meetingSessionHeaders(sessionId, true) });
}

export function meetingRevisionHtmlUrl(sessionId: string, jobId: string): string {
  return `${api.defaults.baseURL}/meetings/recordings/${encodeURIComponent(sessionId)}/delivery/revisions/${encodeURIComponent(jobId)}/html`;
}

export async function fetchMeetingOneShotAvailability(): Promise<MeetingOneShotAvailability | null> {
  try { return (await api.get<{ data: MeetingOneShotAvailability }>("/meetings/one-shot")).data.data; }
  catch (error) { if (axios.isAxiosError(error) && error.response?.status === 404) return null; throw error; }
}

export async function fetchMeetingOneShotStatus(sessionId: string): Promise<MeetingOneShotStatus> {
  return (await api.get<{ data: MeetingOneShotStatus }>(`/meetings/recordings/${encodeURIComponent(sessionId)}/delivery`, { headers: meetingSessionHeaders(sessionId) })).data.data;
}

export async function downloadMeetingRecordingTrack(sessionId: string, sourceId: MeetingAudioSourceId): Promise<void> {
  const response = await api.get<Blob>(`/meetings/recordings/${encodeURIComponent(sessionId)}/tracks/${sourceId}`, {
    headers: meetingSessionHeaders(sessionId), responseType: "blob",
  });
  const url = URL.createObjectURL(response.data);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${sessionId}-${sourceId}.${response.data.type.includes("ogg") ? "ogg" : "webm"}`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function meetingOneShotHtmlUrl(sessionId: string, download = false): string {
  return `${api.defaults.baseURL}/meetings/recordings/${encodeURIComponent(sessionId)}/delivery/html${download ? "?download=1" : ""}`;
}

export async function fetchMeetingOneShotHtml(sessionId: string, signal: AbortSignal): Promise<string> {
  const response = await api.get<string>(`/meetings/recordings/${encodeURIComponent(sessionId)}/delivery/html`, { responseType: "text", signal });
  return response.data;
}












export async function fetchMeetingRecordingSession(sessionId: string): Promise<MeetingRecordingSession> {
  const response = await api.get<{ data: MeetingRecordingSession }>(
    `/meetings/recordings/${encodeURIComponent(sessionId)}`,
    { headers: meetingSessionHeaders(sessionId), timeout: 20_000 }
  );
  return response.data.data;
}

export async function uploadMeetingRecordingChunk(input: {
  sessionId: string;
  sourceId: MeetingAudioSourceId;
  sequence: number;
  blob: Blob;
  mimeType: string;
  signal?: AbortSignal;
}): Promise<void> {
  await api.put(
    `/meetings/recordings/${encodeURIComponent(input.sessionId)}/tracks/${encodeURIComponent(
      input.sourceId
    )}/chunks/${input.sequence}`,
    input.blob,
    {
      headers: {
        ...meetingSessionHeaders(input.sessionId, true),
        "Content-Type": input.mimeType,
      },
      timeout: 60_000,
      signal: input.signal,
    }
  );
}

export async function finalizeMeetingRecordingSession(input: {
  sessionId: string;
  durationMs: number;
  tracks: Array<{ sourceId: MeetingAudioSourceId; chunkCount: number }>;
}): Promise<MeetingRecordingSession> {
  const response = await api.post<{ data: MeetingRecordingSession }>(
    `/meetings/recordings/${encodeURIComponent(input.sessionId)}/finalize`,
    { durationMs: input.durationMs, tracks: input.tracks },
    { headers: meetingSessionHeaders(input.sessionId, true), timeout: 120_000 }
  );
  return response.data.data;
}

export async function abortMeetingRecordingSession(sessionId: string): Promise<void> {
  await api.post(`/meetings/recordings/${encodeURIComponent(sessionId)}/abort`, undefined, {
    headers: meetingSessionHeaders(sessionId, true),
    timeout: 15_000,
  });
}



export async function retryMeetingProcessingJob(
  sessionId: string,
  jobId: string
): Promise<MeetingProcessingJob> {
  const response = await api.post<{ data: MeetingProcessingJob }>(
    `/meetings/recordings/${encodeURIComponent(
      sessionId
    )}/processing-jobs/${encodeURIComponent(jobId)}/retry`,
    undefined,
    { headers: meetingSessionHeaders(sessionId, true) }
  );
  return response.data.data;
}



export async function retryMeetingTranscriptionJob(
  sessionId: string,
  jobId: string
): Promise<MeetingTranscriptionJob> {
  const response = await api.post<{ data: MeetingTranscriptionJob }>(
    `/meetings/recordings/${encodeURIComponent(
      sessionId
    )}/transcription-jobs/${encodeURIComponent(jobId)}/retry`,
    undefined,
    { headers: meetingSessionHeaders(sessionId, true) }
  );
  return response.data.data;
}






export function resolveMeetingArtifactRequestUrl(rawUrl: string): string {
  return rawUrl.startsWith("/api/") ? rawUrl.slice(4) : rawUrl;
}





export async function retryMeetingMinutesJob(
  sessionId: string,
  jobId: string
): Promise<MeetingMinutesJob> {
  const response = await api.post<{ data: MeetingMinutesJob }>(
    `/meetings/recordings/${encodeURIComponent(
      sessionId
    )}/minutes-jobs/${encodeURIComponent(jobId)}/retry`,
    undefined,
    { headers: meetingSessionHeaders(sessionId, true) }
  );
  return response.data.data;
}


function resolveMeetingDownloadUrl(rawUrl: string): string {
  return rawUrl.startsWith("/api/") ? `${API_BASE_URL}${rawUrl.slice(4)}` : rawUrl;
}

export function meetingMinutesArtifactUrl(
  artifact: Pick<MeetingMinutesArtifact, "downloadUrl">,
  download = false
): string {
  const url = resolveMeetingDownloadUrl(artifact.downloadUrl);
  if (!download) return url;
  return `${url}${url.includes("?") ? "&" : "?"}download=1`;
}

export function meetingMinutesPackageUrl(
  version: Pick<MeetingMinutesVersion, "packageUrl">
): string {
  return resolveMeetingDownloadUrl(version.packageUrl);
}

export function resolveMeetingRecordingApiError(error: unknown): string | null {
  if (!axios.isAxiosError(error)) return null;
  const payload = error.response?.data as { error?: { message?: unknown } } | undefined;
  return typeof payload?.error?.message === "string" ? payload.error.message : null;
}

export function resolveMeetingRecordingApiErrorCode(error: unknown): string | null {
  if (!axios.isAxiosError(error)) return null;
  const payload = error.response?.data as { error?: { code?: unknown } } | undefined;
  return typeof payload?.error?.code === "string" ? payload.error.code : null;
}

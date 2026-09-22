import axios from "axios";
import { createApiClient } from "../../../api/apiClient";
import { getOrCreateClientId } from "../../../utils/clientIdentity";
import type { MeetingAudioSourceId } from "../audio/useMeetingAudioCheck";

export interface MeetingRecordingTrack {
  sourceId: MeetingAudioSourceId;
  mimeType: string;
  chunkCount: number;
  sizeBytes: number;
  available: boolean;
}

export interface MeetingRecordingSession {
  sessionId: string;
  title: string;
  status: "recording" | "finalized";
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  durationMs: number | null;
  totalSizeBytes: number;
  tracks: MeetingRecordingTrack[];
}

export interface MeetingLibraryInfo {
  libraryId: string;
  displayName: string | null;
  codeHint: string | null;
  setupState: "incomplete" | "ready";
  missingFields: Array<"displayName" | "codeHint">;
  accessVersion: number;
  createdAt: string;
  codeRotatedAt: string;
}

export interface MeetingLibraryOwnerState {
  enabled: boolean;
  library: MeetingLibraryInfo | null;
  ownedLibrary?: MeetingLibraryInfo | null;
  accessMode?: "owner" | "recorder" | "selection";
}

export interface MeetingLibraryCodeResult extends MeetingLibraryOwnerState {
  code: string | null;
}

export interface MeetingRecordingCreateResult {
  session: MeetingRecordingSession;
  libraryAccess: MeetingLibraryCodeResult;
  sessionCapability: string | null;
}

export interface MeetingLibraryRecordingDetail {
  session: MeetingRecordingSession;
  processingJob: MeetingProcessingJob | null;
  transcriptionJob: MeetingTranscriptionJob | null;
  minutesVersions: MeetingMinutesVersion[];
}

export interface MeetingCursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
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

export interface MeetingProcessingAcceptedResult {
  job: MeetingProcessingJob;
  reused: boolean;
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

export interface MeetingTranscriptionAcceptedResult {
  job: MeetingTranscriptionJob;
  reused: boolean;
}

export interface MeetingMergedTranscriptSegment {
  segmentId: string;
  startMs: number;
  endMs: number;
  text: string;
  primarySourceId: MeetingAudioSourceId;
  sourceSegmentIds: string[];
  speakerLabel: string | null;
}

export interface MeetingMergedTranscriptDocument {
  version: 1;
  sessionId: string;
  language: string;
  provider: string;
  model: string;
  generatedAt: string;
  segments: MeetingMergedTranscriptSegment[];
}

export interface MeetingMinutesHumanInput {
  title: string;
  date: string | null;
  attendees: string;
  confirmedFacts: string;
  confirmedDecisions: string;
  termCorrections: string;
  otherNotes: string;
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
}

export interface MeetingMinutesAcceptedResult {
  job: MeetingMinutesJob;
  reused: boolean;
}

const api = createApiClient({ withCredentials: true });
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "/api").replace(/\/$/, "");
const MEETING_MUTATION_HEADERS = {
  "X-Meeting-Request": "1",
  "x-debug-client-id": getOrCreateClientId(),
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
const TERMINAL_MEETING_LIBRARY_VIEWER_ERROR_CODES = new Set([
  "MEETING_LIBRARY_VIEWER_REQUIRED",
  "MEETING_LIBRARY_VIEWER_EXPIRED",
  "MEETING_LIBRARY_ACCESS_NOT_CONFIGURED",
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

export function isMeetingLibraryViewerAccessTerminalErrorCode(
  code: string | null
): boolean {
  return code !== null && TERMINAL_MEETING_LIBRARY_VIEWER_ERROR_CODES.has(code);
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
  title: string;
  sourceIds: MeetingAudioSourceId[];
  libraryId?: string | null;
}): Promise<MeetingRecordingCreateResult> {
  const response = await api.post<{
    data: MeetingRecordingSession;
    meta?: {
      libraryAccessEnabled?: boolean;
      library?: MeetingLibraryInfo | null;
      libraryCode?: string | null;
      sessionCapability?: string | null;
      accessMode?: "owner" | "recorder";
    };
  }>(
    "/meetings/recordings",
    input,
    { headers: MEETING_MUTATION_HEADERS }
  );
  const sessionCapability = response.data.meta?.sessionCapability ?? null;
  persistMeetingSessionCapability(response.data.data.sessionId, sessionCapability);
  return {
    session: response.data.data,
    sessionCapability,
    libraryAccess: {
      enabled: response.data.meta?.libraryAccessEnabled ?? false,
      library: response.data.meta?.library ?? null,
      code: response.data.meta?.libraryCode ?? null,
      accessMode: response.data.meta?.accessMode,
    },
  };
}

export async function fetchOwnerMeetingLibrary(): Promise<MeetingLibraryOwnerState> {
  const response = await api.get<{ data: MeetingLibraryOwnerState }>(
    "/meetings/recordings/library"
  );
  return response.data.data;
}

export async function createOwnerMeetingLibrary(
  displayName: string
): Promise<MeetingLibraryCodeResult> {
  const response = await api.post<{ data: MeetingLibraryCodeResult }>(
    "/meetings/recordings/library",
    { displayName },
    { headers: MEETING_MUTATION_HEADERS }
  );
  return response.data.data;
}

export async function renameOwnerMeetingLibrary(
  displayName: string
): Promise<MeetingLibraryCodeResult> {
  const response = await api.patch<{ data: MeetingLibraryCodeResult }>(
    "/meetings/recordings/library",
    { displayName },
    { headers: MEETING_MUTATION_HEADERS }
  );
  return response.data.data;
}

export async function confirmOwnerMeetingLibraryCode(
  code: string
): Promise<MeetingLibraryCodeResult> {
  const response = await api.post<{ data: MeetingLibraryCodeResult }>(
    "/meetings/recordings/library/confirm-code",
    { code },
    { headers: MEETING_MUTATION_HEADERS }
  );
  return response.data.data;
}

export async function authorizeMeetingRecordingLibrary(
  code: string
): Promise<MeetingLibraryCodeResult> {
  const response = await api.post<{ data: MeetingLibraryCodeResult }>(
    "/meetings/recordings/library-access",
    { code },
    { headers: MEETING_MUTATION_HEADERS }
  );
  return response.data.data;
}

export async function rotateOwnerMeetingLibraryCode(): Promise<MeetingLibraryCodeResult> {
  const response = await api.post<{ data: MeetingLibraryCodeResult }>(
    "/meetings/recordings/library/rotate-code",
    undefined,
    {
    headers: MEETING_MUTATION_HEADERS,
    }
  );
  return response.data.data;
}

export async function authorizeMeetingLibrary(code: string): Promise<MeetingLibraryInfo> {
  const response = await api.post<{ data: MeetingLibraryInfo }>(
    "/meetings/library-access",
    { code },
    { headers: MEETING_MUTATION_HEADERS }
  );
  return response.data.data;
}

export async function logoutMeetingLibrary(): Promise<void> {
  await api.post("/meetings/library/logout", undefined, {
    headers: MEETING_MUTATION_HEADERS,
  });
}

export async function fetchMeetingLibrary(): Promise<MeetingLibraryInfo> {
  const response = await api.get<{ data: MeetingLibraryInfo }>("/meetings/library");
  return response.data.data;
}

export async function fetchMeetingLibraryRecordings(
  limit = 50,
  cursor: string | null = null
): Promise<MeetingCursorPage<MeetingRecordingSession>> {
  const response = await api.get<{
    data: MeetingRecordingSession[];
    meta: { nextCursor: string | null; hasMore: boolean };
  }>(
    "/meetings/library/recordings",
    { params: { limit, ...(cursor ? { cursor } : {}) } }
  );
  return {
    items: response.data.data,
    nextCursor: response.data.meta.nextCursor,
    hasMore: response.data.meta.hasMore,
  };
}

export async function fetchMeetingLibraryRecording(
  sessionId: string
): Promise<MeetingLibraryRecordingDetail> {
  const response = await api.get<{ data: MeetingLibraryRecordingDetail }>(
    `/meetings/library/recordings/${encodeURIComponent(sessionId)}`
  );
  return response.data.data;
}

export async function uploadMeetingRecordingChunk(input: {
  sessionId: string;
  sourceId: MeetingAudioSourceId;
  sequence: number;
  blob: Blob;
  mimeType: string;
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

export async function enqueueMeetingRecordingProcessing(
  sessionId: string
): Promise<MeetingProcessingAcceptedResult> {
  const response = await api.post<{
    data: MeetingProcessingJob;
    meta: { accepted: boolean; reused: boolean };
  }>(
    `/meetings/recordings/${encodeURIComponent(sessionId)}/process`,
    undefined,
    { headers: meetingSessionHeaders(sessionId, true) }
  );
  return { job: response.data.data, reused: response.data.meta.reused };
}

export async function fetchMeetingProcessingJob(
  sessionId: string,
  jobId: string
): Promise<MeetingProcessingJob> {
  const response = await api.get<{ data: MeetingProcessingJob }>(
    `/meetings/recordings/${encodeURIComponent(
      sessionId
    )}/processing-jobs/${encodeURIComponent(jobId)}`,
    { headers: meetingSessionHeaders(sessionId), timeout: 20_000 }
  );
  return response.data.data;
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

export async function enqueueMeetingTranscription(
  sessionId: string
): Promise<MeetingTranscriptionAcceptedResult> {
  const response = await api.post<{
    data: MeetingTranscriptionJob;
    meta: { accepted: boolean; reused: boolean };
  }>(
    `/meetings/recordings/${encodeURIComponent(sessionId)}/transcriptions`,
    undefined,
    { headers: meetingSessionHeaders(sessionId, true) }
  );
  return { job: response.data.data, reused: response.data.meta.reused };
}

export async function fetchMeetingTranscriptionJob(
  sessionId: string,
  jobId: string
): Promise<MeetingTranscriptionJob> {
  const response = await api.get<{ data: MeetingTranscriptionJob }>(
    `/meetings/recordings/${encodeURIComponent(
      sessionId
    )}/transcription-jobs/${encodeURIComponent(jobId)}`,
    { headers: meetingSessionHeaders(sessionId), timeout: 20_000 }
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

export function meetingRecordingTrackUrl(
  sessionId: string,
  sourceId: MeetingAudioSourceId
): string {
  return `${API_BASE_URL}/meetings/recordings/${encodeURIComponent(
    sessionId
  )}/tracks/${encodeURIComponent(sourceId)}`;
}

export function meetingRecordingDownloadUrl(
  sessionId: string,
  sourceId: MeetingAudioSourceId
): string {
  return `${meetingRecordingTrackUrl(sessionId, sourceId)}?download=1`;
}

export function meetingLibraryTrackUrl(
  sessionId: string,
  sourceId: MeetingAudioSourceId,
  download = false
): string {
  const url = `${API_BASE_URL}/meetings/library/recordings/${encodeURIComponent(
    sessionId
  )}/tracks/${encodeURIComponent(sourceId)}`;
  return download ? `${url}?download=1` : url;
}

export function meetingProcessingArtifactUrl(
  artifact: Pick<MeetingProcessingArtifact, "downloadUrl">,
  download = false
): string {
  const rawUrl = artifact.downloadUrl;
  const url = rawUrl.startsWith("/api/")
    ? `${API_BASE_URL}${rawUrl.slice(4)}`
    : rawUrl;
  if (!download) return url;
  return `${url}${url.includes("?") ? "&" : "?"}download=1`;
}

export function meetingTranscriptionArtifactUrl(
  artifact: Pick<MeetingTranscriptionArtifact, "downloadUrl">,
  download = false
): string {
  const rawUrl = artifact.downloadUrl;
  const url = rawUrl.startsWith("/api/")
    ? `${API_BASE_URL}${rawUrl.slice(4)}`
    : rawUrl;
  if (!download) return url;
  return `${url}${url.includes("?") ? "&" : "?"}download=1`;
}

export function resolveMeetingArtifactRequestUrl(rawUrl: string): string {
  return rawUrl.startsWith("/api/") ? rawUrl.slice(4) : rawUrl;
}

export async function fetchMeetingMergedTranscript(
  artifact: Pick<MeetingTranscriptionArtifact, "downloadUrl" | "sessionId">,
  options: { signal?: AbortSignal } = {}
): Promise<MeetingMergedTranscriptDocument> {
  const response = await api.get<MeetingMergedTranscriptDocument>(
    resolveMeetingArtifactRequestUrl(artifact.downloadUrl),
    {
      headers: meetingSessionHeaders(artifact.sessionId),
      signal: options.signal,
      timeout: 30_000,
    }
  );
  return response.data;
}

export async function downloadMeetingTranscriptionArtifact(
  artifact: Pick<MeetingTranscriptionArtifact, "downloadUrl" | "sessionId">,
  filename: string
): Promise<void> {
  const response = await api.get<Blob>(
    resolveMeetingArtifactRequestUrl(artifact.downloadUrl),
    {
      headers: meetingSessionHeaders(artifact.sessionId),
      params: { download: 1 },
      responseType: "blob",
      timeout: 30_000,
    }
  );
  const blobUrl = URL.createObjectURL(response.data);
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
}

export async function enqueueMeetingMinutes(input: {
  sessionId: string;
  clientRequestKey: string;
  humanInput: MeetingMinutesHumanInput;
}): Promise<MeetingMinutesAcceptedResult> {
  const response = await api.post<{
    data: MeetingMinutesJob;
    meta: { accepted: boolean; reused: boolean };
  }>(
    `/meetings/recordings/${encodeURIComponent(input.sessionId)}/minutes`,
    { clientRequestKey: input.clientRequestKey, ...input.humanInput },
    { headers: meetingSessionHeaders(input.sessionId, true) }
  );
  return { job: response.data.data, reused: response.data.meta.reused };
}

export async function fetchMeetingMinutesJob(
  sessionId: string,
  jobId: string
): Promise<MeetingMinutesJob> {
  const response = await api.get<{ data: MeetingMinutesJob }>(
    `/meetings/recordings/${encodeURIComponent(
      sessionId
    )}/minutes-jobs/${encodeURIComponent(jobId)}`,
    { headers: meetingSessionHeaders(sessionId), timeout: 20_000 }
  );
  return response.data.data;
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

export async function fetchMeetingMinutesVersions(
  sessionId: string
): Promise<MeetingMinutesVersion[]> {
  const response = await api.get<{ data: MeetingMinutesVersion[] }>(
    `/meetings/recordings/${encodeURIComponent(sessionId)}/minutes/versions`,
    { headers: meetingSessionHeaders(sessionId), timeout: 20_000 }
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

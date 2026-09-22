import axios from "axios";
import { useEffect, useRef, useState } from "react";
import {
  fetchMeetingMergedTranscript,
  isMeetingLibraryViewerAccessTerminalErrorCode,
  isMeetingSessionAccessTerminalErrorCode,
  resolveMeetingRecordingApiError,
  resolveMeetingRecordingApiErrorCode,
  type MeetingMergedTranscriptDocument,
  type MeetingTranscriptionArtifact,
} from "./api/meetingRecordingApi";

type TranscriptArtifactIdentity = Pick<
  MeetingTranscriptionArtifact,
  "artifactId" | "sessionId" | "sha256" | "createdAt" | "downloadUrl"
>;

const TRANSCRIPT_DOCUMENT_CACHE_LIMIT = 6;
const transcriptDocumentCache = new Map<string, MeetingMergedTranscriptDocument>();

export function createMeetingTranscriptCacheKey(
  artifact: TranscriptArtifactIdentity
): string {
  return [
    artifact.sessionId,
    artifact.artifactId,
    artifact.sha256,
    artifact.createdAt,
  ].join(":");
}

export function cacheMeetingTranscriptDocument(
  artifact: TranscriptArtifactIdentity,
  document: MeetingMergedTranscriptDocument
): void {
  const key = createMeetingTranscriptCacheKey(artifact);
  transcriptDocumentCache.delete(key);
  transcriptDocumentCache.set(key, document);
  while (transcriptDocumentCache.size > TRANSCRIPT_DOCUMENT_CACHE_LIMIT) {
    const oldestKey = transcriptDocumentCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    transcriptDocumentCache.delete(oldestKey);
  }
}

export function getCachedMeetingTranscriptDocument(
  artifact: TranscriptArtifactIdentity
): MeetingMergedTranscriptDocument | null {
  const key = createMeetingTranscriptCacheKey(artifact);
  const cached = transcriptDocumentCache.get(key) ?? null;
  if (cached) {
    transcriptDocumentCache.delete(key);
    transcriptDocumentCache.set(key, cached);
  }
  return cached;
}

export function clearMeetingTranscriptDocumentCache(): void {
  transcriptDocumentCache.clear();
}

interface MeetingTranscriptDocumentState {
  key: string;
  document: MeetingMergedTranscriptDocument | null;
  loading: boolean;
  errorCode: string | null;
  errorMessage: string | null;
}

export function useMeetingTranscriptDocument(input: {
  artifact: TranscriptArtifactIdentity | null;
  open: boolean;
  onTerminalAccessError?: (error: unknown) => void;
}) {
  const { artifact, open, onTerminalAccessError } = input;
  const artifactKey = artifact ? createMeetingTranscriptCacheKey(artifact) : "";
  const cachedDocument = artifact
    ? transcriptDocumentCache.get(artifactKey) ?? null
    : null;
  const requestRevisionRef = useRef(0);
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const [state, setState] = useState<MeetingTranscriptDocumentState>({
    key: "",
    document: null,
    loading: false,
    errorCode: null,
    errorMessage: null,
  });

  useEffect(() => {
    if (!open || !artifact) return;
    const revision = requestRevisionRef.current + 1;
    requestRevisionRef.current = revision;
    const cached = getCachedMeetingTranscriptDocument(artifact);
    if (cached) return;

    const controller = new AbortController();
    const loadDocument = async () => {
      setState({
        key: artifactKey,
        document: null,
        loading: true,
        errorCode: null,
        errorMessage: null,
      });
      try {
        const document = await fetchMeetingMergedTranscript(artifact, {
          signal: controller.signal,
        });
        if (
          controller.signal.aborted ||
          requestRevisionRef.current !== revision ||
          createMeetingTranscriptCacheKey(artifact) !== artifactKey
        ) {
          return;
        }
        cacheMeetingTranscriptDocument(artifact, document);
        setState({
          key: artifactKey,
          document,
          loading: false,
          errorCode: null,
          errorMessage: null,
        });
      } catch (error) {
        if (
          controller.signal.aborted ||
          axios.isCancel(error) ||
          requestRevisionRef.current !== revision
        ) {
          return;
        }
        const errorCode = resolveMeetingRecordingApiErrorCode(error);
        if (
          isMeetingSessionAccessTerminalErrorCode(errorCode) ||
          isMeetingLibraryViewerAccessTerminalErrorCode(errorCode)
        ) {
          onTerminalAccessError?.(error);
        }
        setState({
          key: artifactKey,
          document: null,
          loading: false,
          errorCode,
          errorMessage: resolveMeetingRecordingApiError(error) ?? "",
        });
      }
    };
    void loadDocument();

    return () => {
      controller.abort();
      if (requestRevisionRef.current === revision) {
        requestRevisionRef.current += 1;
      }
    };
  }, [artifact, artifactKey, onTerminalAccessError, open, reloadGeneration]);

  const currentState = state.key === artifactKey ? state : null;
  return {
    artifactKey,
    document: cachedDocument ?? currentState?.document ?? null,
    loading: Boolean(
      open && artifact && !cachedDocument && (!currentState || currentState.loading)
    ),
    errorCode: currentState?.errorCode ?? null,
    errorMessage: currentState?.errorMessage ?? null,
    retry: () => setReloadGeneration((current) => current + 1),
  };
}

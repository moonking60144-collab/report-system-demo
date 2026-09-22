import { beforeEach, describe, expect, it } from "vitest";
import type {
  MeetingMergedTranscriptDocument,
  MeetingTranscriptionArtifact,
} from "./api/meetingRecordingApi";
import {
  cacheMeetingTranscriptDocument,
  clearMeetingTranscriptDocumentCache,
  createMeetingTranscriptCacheKey,
  getCachedMeetingTranscriptDocument,
} from "./useMeetingTranscriptDocument";

function artifact(overrides: Partial<MeetingTranscriptionArtifact> = {}) {
  return {
    artifactId: "artifact-1",
    jobId: "job-1",
    sessionId: "session-1",
    type: "transcript-merged-json" as const,
    mimeType: "application/json",
    sizeBytes: 100,
    sha256: "sha-v1",
    createdAt: "2026-07-17T00:00:00.000Z",
    downloadUrl: "/api/meetings/recordings/session-1/transcription-artifacts/artifact-1",
    ...overrides,
  };
}

const document: MeetingMergedTranscriptDocument = {
  version: 1,
  sessionId: "session-1",
  language: "zh-TW",
  provider: "test",
  model: "test-model",
  generatedAt: "2026-07-17T00:00:00.000Z",
  segments: [],
};

describe("Meeting transcript document cache", () => {
  beforeEach(clearMeetingTranscriptDocumentCache);

  it("cache key 綁定 artifact 與內容版本，不只綁 session", () => {
    const first = artifact();
    const replaced = artifact({
      sha256: "sha-v2",
      createdAt: "2026-07-17T01:00:00.000Z",
    });
    expect(createMeetingTranscriptCacheKey(first)).not.toBe(
      createMeetingTranscriptCacheKey(replaced)
    );

    cacheMeetingTranscriptDocument(first, document);
    expect(getCachedMeetingTranscriptDocument(first)).toBe(document);
    expect(getCachedMeetingTranscriptDocument(replaced)).toBeNull();
  });

  it("只保留最近六份逐字稿，避免長時間瀏覽讓記憶體無界成長", () => {
    for (let index = 0; index < 7; index += 1) {
      cacheMeetingTranscriptDocument(
        artifact({ artifactId: `artifact-${index}`, sha256: `sha-${index}` }),
        { ...document, generatedAt: `2026-07-17T0${index}:00:00.000Z` }
      );
    }
    expect(
      getCachedMeetingTranscriptDocument(
        artifact({ artifactId: "artifact-0", sha256: "sha-0" })
      )
    ).toBeNull();
    expect(
      getCachedMeetingTranscriptDocument(
        artifact({ artifactId: "artifact-6", sha256: "sha-6" })
      )
    ).not.toBeNull();
  });
});

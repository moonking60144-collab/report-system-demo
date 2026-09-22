import { useDeferredValue, useMemo, useState } from "react";
import type { MeetingMergedTranscriptSegment } from "./api/meetingRecordingApi";

export const MEETING_TRANSCRIPT_INITIAL_SEGMENT_LIMIT = 200;
export const MEETING_TRANSCRIPT_SEGMENT_PAGE_SIZE = 200;
export const MEETING_TRANSCRIPT_MAX_RENDERED_SEGMENTS = 1_000;

export function normalizeMeetingTranscriptSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().trim();
}

export function createMeetingTranscriptSearchIndex(
  segments: MeetingMergedTranscriptSegment[]
) {
  return segments.map((segment) => ({
    segment,
    normalizedText: normalizeMeetingTranscriptSearchText(
      `${segment.speakerLabel ?? ""} ${segment.text}`
    ),
  }));
}

export function filterMeetingTranscriptSegments(
  searchIndex: ReturnType<typeof createMeetingTranscriptSearchIndex>,
  normalizedQuery: string
): MeetingMergedTranscriptSegment[] {
  return normalizedQuery
    ? searchIndex
        .filter((entry) => entry.normalizedText.includes(normalizedQuery))
        .map((entry) => entry.segment)
    : searchIndex.map((entry) => entry.segment);
}

export function useMeetingTranscriptSearch(
  segments: MeetingMergedTranscriptSegment[],
  transcriptKey: string
) {
  const [queryState, setQueryState] = useState({ transcriptKey, value: "" });
  const query = queryState.transcriptKey === transcriptKey ? queryState.value : "";
  const deferredQuery = useDeferredValue(query);
  const normalizedQuery =
    queryState.transcriptKey === transcriptKey
      ? normalizeMeetingTranscriptSearchText(deferredQuery)
      : "";
  const searchIndex = useMemo(
    () => createMeetingTranscriptSearchIndex(segments),
    [segments]
  );
  const matchingSegments = useMemo(
    () => filterMeetingTranscriptSegments(searchIndex, normalizedQuery),
    [normalizedQuery, searchIndex]
  );
  const limitKey = `${transcriptKey}:${normalizedQuery}`;
  const [limitState, setLimitState] = useState({
    limitKey,
    value: MEETING_TRANSCRIPT_INITIAL_SEGMENT_LIMIT,
  });
  const visibleLimit =
    limitState.limitKey === limitKey
      ? limitState.value
      : MEETING_TRANSCRIPT_INITIAL_SEGMENT_LIMIT;
  const maximumVisibleCount = Math.min(
    matchingSegments.length,
    MEETING_TRANSCRIPT_MAX_RENDERED_SEGMENTS
  );
  const visibleSegments = matchingSegments.slice(0, visibleLimit);

  return {
    query,
    setQuery: (value: string) => setQueryState({ transcriptKey, value }),
    deferred: query !== deferredQuery,
    matchingCount: matchingSegments.length,
    visibleSegments,
    canLoadMore: visibleSegments.length < maximumVisibleCount,
    renderLimitReached:
      matchingSegments.length > MEETING_TRANSCRIPT_MAX_RENDERED_SEGMENTS &&
      visibleSegments.length >= MEETING_TRANSCRIPT_MAX_RENDERED_SEGMENTS,
    loadMore: () =>
      setLimitState({
        limitKey,
        value: Math.min(
          visibleLimit + MEETING_TRANSCRIPT_SEGMENT_PAGE_SIZE,
          MEETING_TRANSCRIPT_MAX_RENDERED_SEGMENTS
        ),
      }),
  };
}

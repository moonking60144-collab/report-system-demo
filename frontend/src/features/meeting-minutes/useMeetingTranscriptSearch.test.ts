import { describe, expect, it } from "vitest";
import type { MeetingMergedTranscriptSegment } from "./api/meetingRecordingApi";
import {
  createMeetingTranscriptSearchIndex,
  filterMeetingTranscriptSegments,
  normalizeMeetingTranscriptSearchText,
} from "./useMeetingTranscriptSearch";

const segments: MeetingMergedTranscriptSegment[] = [
  {
    segmentId: "segment-1",
    startMs: 0,
    endMs: 1_000,
    text: "確認Ａ線品質",
    primarySourceId: "room-mic",
    sourceSegmentIds: ["source-1"],
    speakerLabel: "品保主管",
  },
  {
    segmentId: "segment-2",
    startMs: 1_000,
    endMs: 2_000,
    text: "安排改善排程",
    primarySourceId: "remote-tab",
    sourceSegmentIds: ["source-2"],
    speakerLabel: null,
  },
];

describe("Meeting transcript search index", () => {
  it("在建立索引時一次完成 Unicode 與大小寫正規化", () => {
    expect(normalizeMeetingTranscriptSearchText("  ＡＢＣ 品保  ")).toBe("abc 品保");
    const index = createMeetingTranscriptSearchIndex(segments);
    expect(index[0]?.normalizedText).toContain("a線品質");
  });

  it("可同時搜尋講者與內容，且空查詢維持原順序", () => {
    const index = createMeetingTranscriptSearchIndex(segments);
    expect(filterMeetingTranscriptSegments(index, "品保").map((item) => item.segmentId))
      .toEqual(["segment-1"]);
    expect(filterMeetingTranscriptSegments(index, "改善").map((item) => item.segmentId))
      .toEqual(["segment-2"]);
    expect(filterMeetingTranscriptSegments(index, "").map((item) => item.segmentId))
      .toEqual(["segment-1", "segment-2"]);
  });
});

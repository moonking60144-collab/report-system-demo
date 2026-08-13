import { describe, expect, it } from "vitest";
import { parseRealtimeEventPayload } from "./useWorkReportRealtime";

describe("parseRealtimeEventPayload", () => {
  it("解析同步 replay 的批次 entry 更新事件", () => {
    const payload = parseRealtimeEventPayload(
      JSON.stringify({
        id: "event-1",
        type: "work-report-entries-updated",
        occurredAt: "2026-08-13T00:00:00.000Z",
        formId: "105",
        entryIds: [" E-1 ", "", 42, "E-2"],
      })
    );

    expect(payload).toEqual({
      id: "event-1",
      type: "work-report-entries-updated",
      occurredAt: "2026-08-13T00:00:00.000Z",
      formId: "105",
      entryId: undefined,
      entryIds: ["E-1", "E-2"],
      forceRefreshToken: undefined,
      noticeRevision: undefined,
    });
  });
});

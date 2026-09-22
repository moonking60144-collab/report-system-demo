import { describe, expect, it } from "vitest";
import { formatMeetingLibraryCodeInput } from "../utils/meetingLibraryCode";

describe("formatMeetingLibraryCodeInput", () => {
  it("只保留 human-safe Base32 並在第三碼後加入連字號", () => {
    expect(formatMeetingLibraryCodeInput("ab-c 234")).toBe("ABC-234");
    expect(formatMeetingLibraryCodeInput("oi10-abc234xyz")).toBe("ABC-234");
  });

  it("最多接受六個有效字元", () => {
    expect(formatMeetingLibraryCodeInput("ABC23456789")).toBe("ABC-234");
  });
});

import { describe, expect, it } from "vitest";
import {
  canLeaveMeetingOneShot,
  isMeetingOneShotPipelineBusy,
  isMeetingOneShotRecorderPhase,
  shouldShowMeetingOutputPanel,
} from "./meetingOneShotPresentation";

describe("meeting one-shot phase presentation", () => {
  it("Server 仍是 recording 時維持錄音畫面，不顯示會議產出", () => {
    expect(isMeetingOneShotRecorderPhase("recording")).toBe(true);
    expect(isMeetingOneShotPipelineBusy("recording")).toBe(false);
    expect(shouldShowMeetingOutputPanel({
      hasSession: true,
      phase: "recording",
      localRecording: false,
      localPaused: false,
    })).toBe(false);
  });

  it("lease 到期的 interrupted 會議可離開且不冒充背景產出", () => {
    expect(isMeetingOneShotRecorderPhase("interrupted")).toBe(true);
    expect(canLeaveMeetingOneShot("interrupted")).toBe(true);
    expect(shouldShowMeetingOutputPanel({
      hasSession: true,
      phase: "interrupted",
      localRecording: false,
      localPaused: false,
    })).toBe(false);
  });

  it("processing 之後才顯示會議產出與處理中狀態", () => {
    expect(isMeetingOneShotPipelineBusy("processing")).toBe(true);
    expect(shouldShowMeetingOutputPanel({
      hasSession: true,
      phase: "processing",
      localRecording: false,
      localPaused: false,
    })).toBe(true);
  });

  it("Server 正在 finalize 時顯示收尾進度並禁止離開", () => {
    expect(isMeetingOneShotPipelineBusy("finalizing")).toBe(true);
    expect(canLeaveMeetingOneShot("finalizing")).toBe(false);
    expect(shouldShowMeetingOutputPanel({ hasSession: true, phase: "finalizing", localRecording: false, localPaused: false })).toBe(true);
  });
});

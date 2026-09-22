import { describe, expect, it } from "vitest";
import {
  evaluateMeetingAudioCapabilities,
  selectMeetingRecordingMimeType,
} from "./meetingAudioSupport";

describe("meeting audio capability contract", () => {
  it("麥克風與錄音能力足夠時即可開始，遠端音訊維持選用", () => {
    expect(
      evaluateMeetingAudioCapabilities({
        secureContext: true,
        hasMediaDevices: true,
        hasGetUserMedia: true,
        hasGetDisplayMedia: true,
        hasMediaRecorder: true,
        hasAudioContext: true,
      }).ready
    ).toBe(true);

    expect(
      evaluateMeetingAudioCapabilities({
        secureContext: true,
        hasMediaDevices: true,
        hasGetUserMedia: true,
        hasGetDisplayMedia: false,
        hasMediaRecorder: true,
        hasAudioContext: true,
      })
    ).toMatchObject({
      canCaptureMicrophone: true,
      canCaptureRemoteTab: false,
      canRecord: true,
      ready: true,
    });
  });

  it("錄音格式依瀏覽器實際支援結果選擇，不依賴 UA", () => {
    const checked: string[] = [];
    const selected = selectMeetingRecordingMimeType((mimeType) => {
      checked.push(mimeType);
      return mimeType === "audio/webm";
    });

    expect(selected).toBe("audio/webm");
    expect(checked).toEqual(["audio/webm;codecs=opus", "audio/webm"]);
  });
});

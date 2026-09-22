import axios from "axios";
import { describe, expect, it } from "vitest";
import {
  isMeetingLibraryViewerAccessTerminalErrorCode,
  isMeetingSessionAccessTerminalErrorCode,
  persistMeetingSessionCapability,
  readMeetingSessionCapability,
  resolveMeetingArtifactRequestUrl,
} from "./meetingRecordingApi";

describe("Meeting artifact request URL", () => {
  it("production /api base 不會組成重複的 /api/api path", () => {
    const requestUrl = resolveMeetingArtifactRequestUrl(
      "/api/meetings/library/recordings/session-1/transcription-artifacts/artifact-1"
    );

    expect(requestUrl).toBe(
      "/meetings/library/recordings/session-1/transcription-artifacts/artifact-1"
    );
    expect(axios.getUri({ baseURL: "/api", url: requestUrl })).toBe(
      "/api/meetings/library/recordings/session-1/transcription-artifacts/artifact-1"
    );
  });

  it("absolute artifact URL 保持原值", () => {
    const url = "https://api.example.test/api/meetings/recordings/session-1/artifact";
    expect(resolveMeetingArtifactRequestUrl(url)).toBe(url);
  });
});

describe("Meeting session capability storage", () => {
  it("capability 只寫入指定的 tab storage，並可按 session 清除", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    const sessionId = "11111111-1111-4111-8111-111111111111";
    persistMeetingSessionCapability(sessionId, "a".repeat(43), storage);
    expect(readMeetingSessionCapability(sessionId, storage)).toBe("a".repeat(43));
    persistMeetingSessionCapability(sessionId, null, storage);
    expect(readMeetingSessionCapability(sessionId, storage)).toBeNull();
  });

  it("sessionStorage 不可用時改存目前分頁記憶體，不讓已建立 session 變成 create-failed", () => {
    const storage = {
      getItem: () => {
        throw new DOMException("storage disabled", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("storage disabled", "SecurityError");
      },
      removeItem: () => {
        throw new DOMException("storage disabled", "SecurityError");
      },
    };
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const capability = "b".repeat(43);

    expect(() => persistMeetingSessionCapability(sessionId, capability, storage)).not.toThrow();
    expect(readMeetingSessionCapability(sessionId, storage)).toBe(capability);
    expect(() => persistMeetingSessionCapability(sessionId, null, storage)).not.toThrow();
    expect(readMeetingSessionCapability(sessionId, storage)).toBeNull();
  });
});

describe("Meeting session access terminal errors", () => {
  it("capability 與 recorder 權限失效都不可當成暫時性 polling 錯誤", () => {
    expect(
      [
        "MEETING_RECORDING_OWNER_REQUIRED",
        "MEETING_RECORDING_SESSION_CAPABILITY_EXPIRED",
        "MEETING_RECORDING_SESSION_CAPABILITY_REVOKED",
        "MEETING_RECORDING_SESSION_CAPABILITY_INVALID",
        "MEETING_RECORDING_SESSION_CAPABILITY_REQUIRED",
        "MEETING_LIBRARY_RECORDER_EXPIRED",
        "MEETING_LIBRARY_RECORDER_REQUIRED",
      ].every(isMeetingSessionAccessTerminalErrorCode)
    ).toBe(true);
    expect(isMeetingSessionAccessTerminalErrorCode("TEMPORARY_NETWORK_ERROR")).toBe(false);
  });

  it("錄音庫 viewer cookie 失效會要求回到存取碼入口", () => {
    expect(
      [
        "MEETING_LIBRARY_VIEWER_REQUIRED",
        "MEETING_LIBRARY_VIEWER_EXPIRED",
        "MEETING_LIBRARY_ACCESS_NOT_CONFIGURED",
      ].every(isMeetingLibraryViewerAccessTerminalErrorCode)
    ).toBe(true);
    expect(isMeetingLibraryViewerAccessTerminalErrorCode("TEMPORARY_NETWORK_ERROR"))
      .toBe(false);
  });
});

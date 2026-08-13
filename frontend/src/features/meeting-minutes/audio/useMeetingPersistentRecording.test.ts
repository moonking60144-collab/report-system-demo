import { describe, expect, it, vi } from "vitest";
import {
  isMeetingSessionCapabilityTerminalErrorCode,
  mergeMeetingLibraryAccessAfterCreate,
  uploadMeetingChunkWithRetry,
} from "./useMeetingPersistentRecording";

describe("meeting persistent chunk upload", () => {
  it("暫時性上傳失敗會以相同 session/source/sequence 重送", async () => {
    const upload = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue(undefined);
    const wait = vi.fn(async () => undefined);
    const input = {
      sessionId: "11111111-1111-4111-8111-111111111111",
      sourceId: "room-mic" as const,
      sequence: 7,
      blob: new Blob(["audio"], { type: "audio/webm" }),
      mimeType: "audio/webm",
    };

    await uploadMeetingChunkWithRetry(input, {
      upload,
      wait,
      retryDelaysMs: [10],
    });

    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload).toHaveBeenNthCalledWith(1, input);
    expect(upload).toHaveBeenNthCalledWith(2, input);
    expect(wait).toHaveBeenCalledWith(10);
  });

  it("超過重送次數後保留最後錯誤", async () => {
    const finalError = new Error("still offline");
    const upload = vi.fn<() => Promise<void>>().mockRejectedValue(finalError);

    await expect(
      uploadMeetingChunkWithRetry(
        {
          sessionId: "11111111-1111-4111-8111-111111111111",
          sourceId: "remote-tab",
          sequence: 0,
          blob: new Blob(["audio"], { type: "audio/webm" }),
          mimeType: "audio/webm",
        },
        { upload, wait: async () => undefined, retryDelaysMs: [1, 2] }
      )
    ).rejects.toBe(finalError);
    expect(upload).toHaveBeenCalledTimes(3);
  });
});

describe("meeting recording library access merge", () => {
  const readyLibraryFields = {
    displayName: "品管錄音庫",
    codeHint: "A**-**4",
    setupState: "ready" as const,
    missingFields: [],
  };

  it("同一錄音庫建立 session 回 code null 時保留尚未確認的一次性 Code", () => {
    const library = {
      ...readyLibraryFields,
      libraryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      accessVersion: 1,
      createdAt: "2026-07-17T00:00:00.000Z",
      codeRotatedAt: "2026-07-17T00:00:00.000Z",
    };
    expect(
      mergeMeetingLibraryAccessAfterCreate(
        { enabled: true, library, code: "ABC-234", accessMode: "owner" },
        { enabled: true, library, code: null, accessMode: "owner" }
      ).code
    ).toBe("ABC-234");
  });

  it("切換到不同錄音庫時不攜帶上一庫的一次性 Code", () => {
    expect(
      mergeMeetingLibraryAccessAfterCreate(
        {
          enabled: true,
          library: {
            ...readyLibraryFields,
            libraryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            accessVersion: 1,
            createdAt: "2026-07-17T00:00:00.000Z",
            codeRotatedAt: "2026-07-17T00:00:00.000Z",
          },
          code: "ABC-234",
        },
        {
          enabled: true,
          library: {
            ...readyLibraryFields,
            libraryId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            accessVersion: 1,
            createdAt: "2026-07-17T00:00:00.000Z",
            codeRotatedAt: "2026-07-17T00:00:00.000Z",
          },
          code: null,
        }
      ).code
    ).toBeNull();
  });

  it("同一錄音庫 accessVersion 已變更時不保留舊的一次性 Code", () => {
    const libraryId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    expect(
      mergeMeetingLibraryAccessAfterCreate(
        {
          enabled: true,
          library: {
            ...readyLibraryFields,
            libraryId,
            accessVersion: 1,
            createdAt: "2026-07-17T00:00:00.000Z",
            codeRotatedAt: "2026-07-17T00:00:00.000Z",
          },
          code: "ABC-234",
        },
        {
          enabled: true,
          library: {
            ...readyLibraryFields,
            libraryId,
            accessVersion: 2,
            createdAt: "2026-07-17T00:00:00.000Z",
            codeRotatedAt: "2026-07-17T01:00:00.000Z",
          },
          code: null,
        }
      ).code
    ).toBeNull();
  });
});

describe("meeting recording terminal capability errors", () => {
  it("expired/revoked/invalid/required 都不可再用同一 capability 重送", () => {
    expect(
      [
        "MEETING_RECORDING_OWNER_REQUIRED",
        "MEETING_RECORDING_SESSION_CAPABILITY_EXPIRED",
        "MEETING_RECORDING_SESSION_CAPABILITY_REVOKED",
        "MEETING_RECORDING_SESSION_CAPABILITY_INVALID",
        "MEETING_RECORDING_SESSION_CAPABILITY_REQUIRED",
      ].every(isMeetingSessionCapabilityTerminalErrorCode)
    ).toBe(true);
    expect(isMeetingSessionCapabilityTerminalErrorCode("TEMPORARY_NETWORK_ERROR")).toBe(
      false
    );
  });
});

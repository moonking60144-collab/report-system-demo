import { describe, expect, it, vi } from "vitest";
import type { MeetingTranscriptionJob } from "../api/meetingRecordingApi";
import { canRetryMeetingAiJob } from "./meetingJobTracking";
import {
  clearMeetingTranscriptionCursor,
  parseMeetingTranscriptionCursor,
  persistMeetingTranscriptionCursor,
  pollMeetingTranscriptionJob,
  readMeetingTranscriptionCursor,
} from "./useMeetingTranscriptionJob";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  entries() {
    return [...this.values.entries()];
  }
}

function job(
  status: MeetingTranscriptionJob["status"],
  phase: MeetingTranscriptionJob["phase"] = "queued"
): MeetingTranscriptionJob {
  return {
    jobId: "33333333-3333-4333-8333-333333333333",
    processingJobId: "22222222-2222-4222-8222-222222222222",
    sessionId: "11111111-1111-4111-8111-111111111111",
    provider: "fake",
    model: "fake-model",
    status,
    phase,
    attemptCount: 1,
    maxAttempts: 3,
    errorCode: status === "failed" ? "TRANSCRIPTION_FAILED" : null,
    errorMessage: status === "failed" ? "transcription failed" : null,
    createdAt: "2026-07-16T00:00:00.000Z",
    startedAt: status === "pending" ? null : "2026-07-16T00:00:01.000Z",
    updatedAt: "2026-07-16T00:00:02.000Z",
    completedAt:
      status === "ready" || status === "failed"
        ? "2026-07-16T00:00:03.000Z"
        : null,
    artifacts: [],
  };
}

const cursor = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  jobId: "33333333-3333-4333-8333-333333333333",
};

describe("meeting transcription polling", () => {
  it("以 backend 狀態從 pending 追到 running 再到 ready", async () => {
    const updates: MeetingTranscriptionJob[] = [];
    const fetchJob = vi
      .fn<() => Promise<MeetingTranscriptionJob>>()
      .mockResolvedValueOnce(job("pending"))
      .mockResolvedValueOnce(job("running", "transcribing-room-mic"))
      .mockResolvedValueOnce(job("ready", "ready"));

    const result = await pollMeetingTranscriptionJob(cursor, {
      fetchJob,
      wait: async () => undefined,
      onJob: (value) => updates.push(value),
    });

    expect(result.kind).toBe("ready");
    expect(updates.map((value) => value.status)).toEqual([
      "pending",
      "running",
      "ready",
    ]);
    expect(fetchJob).toHaveBeenCalledTimes(3);
  });

  it("單次網路錯誤不會自判 failed，下一輪仍可取得 ready", async () => {
    const networkError = new Error("temporary network failure");
    const transientErrors: Array<unknown | null> = [];
    const fetchJob = vi
      .fn<() => Promise<MeetingTranscriptionJob>>()
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce(job("ready", "ready"));

    const result = await pollMeetingTranscriptionJob(cursor, {
      fetchJob,
      wait: async () => undefined,
      onTransientError: (error) => transientErrors.push(error),
    });

    expect(result.kind).toBe("ready");
    expect(transientErrors).toEqual([networkError, null]);
    expect(fetchJob).toHaveBeenCalledTimes(2);
  });

  it("尚有重試次數的 backend failed 會繼續追到自動重排後的 ready", async () => {
    const updates: MeetingTranscriptionJob[] = [];
    const retryableFailed = job("failed", "transcribing-remote-tab");
    const running = { ...job("running", "transcribing-remote-tab"), attemptCount: 2 };
    const ready = { ...job("ready", "ready"), attemptCount: 2 };
    const fetchJob = vi
      .fn<() => Promise<MeetingTranscriptionJob>>()
      .mockResolvedValueOnce(retryableFailed)
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(ready);

    const result = await pollMeetingTranscriptionJob(cursor, {
      fetchJob,
      wait: async () => undefined,
      onJob: (value) => updates.push(value),
    });

    expect(result).toEqual({ kind: "ready", job: ready });
    expect(updates.map((value) => value.status)).toEqual([
      "failed",
      "running",
      "ready",
    ]);
  });

  it("backend failed 達重試上限才回傳 terminal result", async () => {
    const failed = { ...job("failed", "transcribing-remote-tab"), attemptCount: 3 };
    const result = await pollMeetingTranscriptionJob(cursor, {
      fetchJob: async () => failed,
      wait: async () => undefined,
    });

    expect(result).toEqual({ kind: "failed", job: failed });
  });

  it("provider 變更是 terminal failure，且即使舊嘗試數耗盡仍可人工重送", async () => {
    const failed = {
      ...job("failed", "transcribing-room-mic"),
      attemptCount: 3,
      errorCode: "MEETING_TRANSCRIPTION_PROVIDER_CHANGED",
    };
    const fetchJob = vi.fn(async () => failed);

    const result = await pollMeetingTranscriptionJob(cursor, {
      fetchJob,
      wait: async () => undefined,
    });

    expect(result).toEqual({ kind: "failed", job: failed });
    expect(fetchJob).toHaveBeenCalledTimes(1);
    expect(canRetryMeetingAiJob(failed)).toBe(true);
  });

  it("provider migration grace 過期後不可再人工重送", () => {
    const expired = {
      ...job("failed", "transcribing-room-mic"),
      attemptCount: 3,
      errorCode: "MEETING_TRANSCRIPTION_PROVIDER_MIGRATION_EXPIRED",
    };

    expect(canRetryMeetingAiJob(expired)).toBe(false);
  });

  it("backend 明確回報任務不存在時停止 polling 並標成 unknown", async () => {
    const result = await pollMeetingTranscriptionJob(cursor, {
      fetchJob: async () => {
        throw {
          isAxiosError: true,
          response: {
            data: { error: { code: "MEETING_TRANSCRIPTION_JOB_NOT_FOUND" } },
          },
        };
      },
      wait: async () => undefined,
    });

    expect(result).toEqual({
      kind: "unknown",
      errorCode: "MEETING_TRANSCRIPTION_JOB_NOT_FOUND",
    });
  });

  it("新分頁缺少 session capability 時停止 polling，不會無限重送", async () => {
    const fetchJob = vi.fn(async () => {
      throw {
        isAxiosError: true,
        response: {
          data: {
            error: { code: "MEETING_RECORDING_SESSION_CAPABILITY_REQUIRED" },
          },
        },
      };
    });
    const wait = vi.fn(async () => undefined);

    const result = await pollMeetingTranscriptionJob(cursor, { fetchJob, wait });

    expect(result).toEqual({
      kind: "unknown",
      errorCode: "MEETING_RECORDING_SESSION_CAPABILITY_REQUIRED",
    });
    expect(fetchJob).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });
});

describe("meeting transcription reload cursor", () => {
  it("只保存 sessionId 與 jobId，且可由相同分頁恢復與清除", () => {
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();

    persistMeetingTranscriptionCursor(cursor, localStorage, sessionStorage);

    expect(localStorage.entries()).toHaveLength(1);
    expect(JSON.parse(localStorage.entries()[0][1])).toEqual(cursor);
    expect(readMeetingTranscriptionCursor(localStorage, sessionStorage)).toEqual(cursor);

    clearMeetingTranscriptionCursor(cursor, localStorage, sessionStorage);
    expect(readMeetingTranscriptionCursor(localStorage, sessionStorage)).toBeNull();
  });

  it("拒絕缺少識別欄位或損壞的 cursor", () => {
    expect(parseMeetingTranscriptionCursor("not-json")).toBeNull();
    expect(
      parseMeetingTranscriptionCursor(JSON.stringify({ sessionId: cursor.sessionId }))
    ).toBeNull();
  });
});

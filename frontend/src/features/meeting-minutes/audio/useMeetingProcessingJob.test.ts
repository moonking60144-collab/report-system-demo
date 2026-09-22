import { describe, expect, it, vi } from "vitest";
import type { MeetingProcessingJob } from "../api/meetingRecordingApi";
import {
  clearMeetingProcessingCursor,
  parseMeetingProcessingCursor,
  persistMeetingProcessingAwaitingEnqueue,
  persistMeetingProcessingCursor,
  pollMeetingProcessingJob,
  readMeetingProcessingCursor,
} from "./useMeetingProcessingJob";

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

function job(status: MeetingProcessingJob["status"], phase: MeetingProcessingJob["phase"] = "queued") {
  return {
    jobId: "22222222-2222-4222-8222-222222222222",
    sessionId: "11111111-1111-4111-8111-111111111111",
    status,
    phase,
    attemptCount: 1,
    maxAttempts: 3,
    errorCode: status === "failed" ? "FFMPEG_FAILED" : null,
    errorMessage: status === "failed" ? "ffmpeg failed" : null,
    createdAt: "2026-07-15T00:00:00.000Z",
    startedAt: status === "pending" ? null : "2026-07-15T00:00:01.000Z",
    updatedAt: "2026-07-15T00:00:02.000Z",
    completedAt: status === "ready" || status === "failed" ? "2026-07-15T00:00:03.000Z" : null,
    artifacts: [],
  } satisfies MeetingProcessingJob;
}

const cursor = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  jobId: "22222222-2222-4222-8222-222222222222",
};

describe("meeting processing polling", () => {
  it("以 backend 狀態從 pending 追到 running 再到 ready", async () => {
    const updates: MeetingProcessingJob[] = [];
    const fetchJob = vi
      .fn<() => Promise<MeetingProcessingJob>>()
      .mockResolvedValueOnce(job("pending"))
      .mockResolvedValueOnce(job("running", "validating-audio"))
      .mockResolvedValueOnce(job("ready", "ready"));

    const result = await pollMeetingProcessingJob(cursor, {
      fetchJob,
      wait: async () => undefined,
      onJob: (value) => updates.push(value),
    });

    expect(result.kind).toBe("ready");
    expect(updates.map((value) => value.status)).toEqual(["pending", "running", "ready"]);
    expect(fetchJob).toHaveBeenCalledTimes(3);
  });

  it("單次網路錯誤不會自判 failed，下一輪仍可取得 ready", async () => {
    const networkError = new Error("temporary network failure");
    const transientErrors: Array<unknown | null> = [];
    const updates: MeetingProcessingJob[] = [];
    const fetchJob = vi
      .fn<() => Promise<MeetingProcessingJob>>()
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce(job("ready", "ready"));

    const result = await pollMeetingProcessingJob(cursor, {
      fetchJob,
      wait: async () => undefined,
      onJob: (value) => updates.push(value),
      onTransientError: (error) => transientErrors.push(error),
    });

    expect(result.kind).toBe("ready");
    expect(updates.map((value) => value.status)).toEqual(["ready"]);
    expect(transientErrors).toEqual([networkError, null]);
  });

  it("尚有重試次數的 backend failed 會繼續追到自動重排後的 ready", async () => {
    const updates: MeetingProcessingJob[] = [];
    const retryableFailed = job("failed", "generating-playback");
    const running = { ...job("running", "generating-playback"), attemptCount: 2 };
    const ready = { ...job("ready", "ready"), attemptCount: 2 };
    const fetchJob = vi
      .fn<() => Promise<MeetingProcessingJob>>()
      .mockResolvedValueOnce(retryableFailed)
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(ready);

    const result = await pollMeetingProcessingJob(cursor, {
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
    const failed = { ...job("failed", "generating-playback"), attemptCount: 3 };
    const result = await pollMeetingProcessingJob(cursor, {
      fetchJob: async () => failed,
      wait: async () => undefined,
    });

    expect(result).toEqual({ kind: "failed", job: failed });
  });

  it("processing artifact eviction 停止 polling 並保留手動 retry 狀態", async () => {
    const evicted = {
      ...job("failed", "queued"),
      attemptCount: 0,
      errorCode: "MEETING_PROCESSING_ARTIFACT_EVICTED",
      errorMessage: "後處理音訊已依容量上限淘汰，可重新處理。",
    };
    const fetchJob = vi.fn(async () => evicted);
    const wait = vi.fn(async () => undefined);

    const result = await pollMeetingProcessingJob(cursor, { fetchJob, wait });

    expect(result).toEqual({ kind: "failed", job: evicted });
    expect(fetchJob).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("backend 明確回報任務不存在時停止 polling 並標成 unknown", async () => {
    const result = await pollMeetingProcessingJob(cursor, {
      fetchJob: async () => {
        throw {
          isAxiosError: true,
          response: {
            data: { error: { code: "MEETING_PROCESSING_JOB_NOT_FOUND" } },
          },
        };
      },
      wait: async () => undefined,
    });

    expect(result).toEqual({
      kind: "unknown",
      errorCode: "MEETING_PROCESSING_JOB_NOT_FOUND",
    });
  });

  it("session capability 失效時停止 polling，不會每三秒重送", async () => {
    const fetchJob = vi.fn(async () => {
      throw {
        isAxiosError: true,
        response: {
          data: {
            error: { code: "MEETING_RECORDING_SESSION_CAPABILITY_REVOKED" },
          },
        },
      };
    });
    const wait = vi.fn(async () => undefined);

    const result = await pollMeetingProcessingJob(cursor, { fetchJob, wait });

    expect(result).toEqual({
      kind: "unknown",
      errorCode: "MEETING_RECORDING_SESSION_CAPABILITY_REVOKED",
    });
    expect(fetchJob).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("route unmount 只停止前端 polling，不改寫 backend job", async () => {
    let cancelled = false;
    const fetchJob = vi.fn(async () => job("running", "normalizing-room-mic"));
    const result = await pollMeetingProcessingJob(cursor, {
      fetchJob,
      wait: async () => {
        cancelled = true;
      },
      isCancelled: () => cancelled,
    });

    expect(result).toEqual({ kind: "cancelled" });
    expect(fetchJob).toHaveBeenCalledTimes(1);
  });
});

describe("meeting processing reload cursor", () => {
  it("只保存 sessionId 與 jobId，且可由相同分頁恢復與清除", () => {
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();

    persistMeetingProcessingCursor(cursor, localStorage, sessionStorage);

    expect(localStorage.entries()).toHaveLength(1);
    expect(JSON.parse(localStorage.entries()[0][1])).toEqual(cursor);
    expect(readMeetingProcessingCursor(localStorage, sessionStorage)).toEqual(cursor);

    clearMeetingProcessingCursor(cursor, localStorage, sessionStorage);
    expect(readMeetingProcessingCursor(localStorage, sessionStorage)).toBeNull();
  });

  it("拒絕缺少識別欄位或損壞的 cursor", () => {
    expect(parseMeetingProcessingCursor("not-json")).toBeNull();
    expect(parseMeetingProcessingCursor(JSON.stringify({ sessionId: cursor.sessionId }))).toBeNull();
  });

  it("finalize 後可先保存 awaiting-enqueue，reload 時不需要 savedSession 也能恢復", () => {
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();

    persistMeetingProcessingAwaitingEnqueue(
      cursor.sessionId,
      localStorage,
      sessionStorage
    );

    expect(readMeetingProcessingCursor(localStorage, sessionStorage)).toEqual({
      sessionId: cursor.sessionId,
      jobId: null,
    });
  });
});

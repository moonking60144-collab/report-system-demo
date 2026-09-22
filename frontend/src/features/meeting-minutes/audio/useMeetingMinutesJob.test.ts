import { describe, expect, it, vi } from "vitest";
import type {
  MeetingMinutesHumanInput,
  MeetingMinutesJob,
} from "../api/meetingRecordingApi";
import {
  clearMeetingMinutesCursor,
  createMeetingMinutesEnqueueGate,
  parseMeetingMinutesCursor,
  persistMeetingMinutesCursor,
  pollMeetingMinutesJob,
  readMeetingMinutesCursor,
  type MeetingMinutesCursor,
} from "./useMeetingMinutesJob";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
}

const humanInput: MeetingMinutesHumanInput = {
  title: "品管會議",
  date: "2026-07-16",
  attendees: "品管：王小明",
  confirmedFacts: "不良率 3%",
  confirmedDecisions: "下週開始抽驗",
  termCorrections: "",
  otherNotes: "",
};

const cursor: MeetingMinutesCursor = {
  sessionId: "session-1",
  jobId: "minutes-1",
  clientRequestKey: "request-1",
  humanInput,
};

function job(status: MeetingMinutesJob["status"]): MeetingMinutesJob {
  return {
    jobId: "minutes-1",
    sessionId: "session-1",
    clientRequestKey: "request-1",
    input: humanInput,
    provider: "fake",
    model: "fake-model",
    status,
    phase: status === "ready" ? "ready" : "generating",
    attemptCount: 1,
    maxAttempts: 3,
    errorCode: status === "failed" ? "MINUTES_FAILED" : null,
    errorMessage: status === "failed" ? "failed" : null,
    createdAt: "2026-07-16T00:00:00.000Z",
    startedAt: status === "pending" ? null : "2026-07-16T00:00:01.000Z",
    updatedAt: "2026-07-16T00:00:02.000Z",
    completedAt: status === "ready" || status === "failed" ? "2026-07-16T00:00:03.000Z" : null,
    version: null,
  };
}

describe("meeting minutes polling", () => {
  it("單次網路錯誤不中斷，backend ready 才結束", async () => {
    const networkError = new Error("temporary");
    const errors: Array<unknown | null> = [];
    const fetchJob = vi
      .fn<() => Promise<MeetingMinutesJob>>()
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce(job("running"))
      .mockResolvedValueOnce(job("ready"));
    const result = await pollMeetingMinutesJob(
      { sessionId: cursor.sessionId, jobId: cursor.jobId! },
      {
        fetchJob,
        wait: async () => undefined,
        onTransientError: (error) => errors.push(error),
      }
    );
    expect(result.kind).toBe("ready");
    expect(errors).toEqual([networkError, null, null]);
    expect(fetchJob).toHaveBeenCalledTimes(3);
  });

  it("retryable failed 繼續輪詢，達上限才回 terminal failed", async () => {
    const retryable = job("failed");
    const exhausted = { ...job("failed"), attemptCount: 3 };
    const fetchJob = vi
      .fn<() => Promise<MeetingMinutesJob>>()
      .mockResolvedValueOnce(retryable)
      .mockResolvedValueOnce(exhausted);
    const result = await pollMeetingMinutesJob(
      { sessionId: cursor.sessionId, jobId: cursor.jobId! },
      { fetchJob, wait: async () => undefined }
    );
    expect(result).toEqual({ kind: "failed", job: exhausted });
  });

  it("provider 變更不等待自動重排，立即交回 UI 供人工重送", async () => {
    const changed = {
      ...job("failed"),
      errorCode: "MEETING_MINUTES_PROVIDER_CHANGED",
    };
    const fetchJob = vi.fn(async () => changed);

    const result = await pollMeetingMinutesJob(
      { sessionId: cursor.sessionId, jobId: cursor.jobId! },
      { fetchJob, wait: async () => undefined }
    );

    expect(result).toEqual({ kind: "failed", job: changed });
    expect(fetchJob).toHaveBeenCalledTimes(1);
  });

  it("recorder grant 過期時停止 polling，不會持續當成暫時性錯誤", async () => {
    const fetchJob = vi.fn(async () => {
      throw {
        isAxiosError: true,
        response: {
          data: { error: { code: "MEETING_LIBRARY_RECORDER_EXPIRED" } },
        },
      };
    });
    const wait = vi.fn(async () => undefined);

    const result = await pollMeetingMinutesJob(
      { sessionId: cursor.sessionId, jobId: cursor.jobId! },
      { fetchJob, wait }
    );

    expect(result).toEqual({
      kind: "unknown",
      errorCode: "MEETING_LIBRARY_RECORDER_EXPIRED",
    });
    expect(fetchJob).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });
});

describe("meeting minutes durable submission", () => {
  it("cursor 保存 request key 與人工輸入，reload 可恢復並清除", () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    persistMeetingMinutesCursor(cursor, local, session);
    expect(readMeetingMinutesCursor(local, session)).toEqual(cursor);
    clearMeetingMinutesCursor(cursor, local, session);
    expect(readMeetingMinutesCursor(local, session)).toBeNull();
    expect(parseMeetingMinutesCursor("broken")).toBeNull();
  });

  it("快速連點同一 request key 共用一個 POST promise", async () => {
    let release!: (value: { job: MeetingMinutesJob; reused: boolean }) => void;
    const pending = new Promise<{ job: MeetingMinutesJob; reused: boolean }>((resolve) => {
      release = resolve;
    });
    const enqueue = vi.fn(() => pending);
    const gate = createMeetingMinutesEnqueueGate(enqueue);
    const input = {
      sessionId: "session-1",
      clientRequestKey: "request-1",
      humanInput,
    };
    const first = gate(input);
    const second = gate(input);
    expect(first).toBe(second);
    expect(enqueue).toHaveBeenCalledTimes(1);
    release({ job: job("pending"), reused: false });
    await first;
  });
});

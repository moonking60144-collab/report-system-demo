import test from "node:test";
import assert from "node:assert/strict";
import type { MeetingProcessingJobRecord } from "../../src/storage/meeting-minutes/meetingProcessingJobRepository";
import type { MeetingTranscriptionJobRecord } from "../../src/storage/meeting-minutes/meetingTranscriptionJobRepository";
import type { MeetingMinutesJobRecord } from "../../src/storage/meeting-minutes/meetingMinutesJobRepository";
import { MeetingWorkerRuntime } from "../../src/workers/meetingWorkerRuntime";

const job: MeetingProcessingJobRecord = {
  jobId: "job-1",
  sessionId: "session-1",
  ownerId: "owner-1",
  status: "running",
  phase: "validating-audio",
  attemptCount: 1,
  maxAttempts: 3,
  errorCode: null,
  errorMessage: null,
  createdAt: "2026-07-15T08:00:00.000Z",
  startedAt: "2026-07-15T08:00:00.000Z",
  updatedAt: "2026-07-15T08:00:00.000Z",
  completedAt: null,
  artifacts: [],
};

const transcriptionJob: MeetingTranscriptionJobRecord = {
  jobId: "transcription-1",
  processingJobId: "job-1",
  sessionId: "session-1",
  ownerId: "owner-1",
  provider: "fake",
  model: "fake-model",
  status: "running",
  phase: "preparing",
  attemptCount: 1,
  maxAttempts: 3,
  errorCode: null,
  errorMessage: null,
  createdAt: "2026-07-15T08:00:00.000Z",
  startedAt: "2026-07-15T08:00:00.000Z",
  updatedAt: "2026-07-15T08:00:00.000Z",
  completedAt: null,
  artifacts: [],
};

const minutesJob: MeetingMinutesJobRecord = {
  jobId: "minutes-1",
  transcriptionJobId: "transcription-1",
  sessionId: "session-1",
  ownerId: "owner-1",
  clientRequestKey: "request-1",
  inputSha256: "input-sha",
  input: {
    title: "品管會議",
    date: null,
    attendees: "",
    confirmedFacts: "",
    confirmedDecisions: "",
    termCorrections: "",
    otherNotes: "",
  },
  provider: "fake",
  model: "fake-model",
  status: "running",
  phase: "generating",
  attemptCount: 1,
  maxAttempts: 3,
  errorCode: null,
  errorMessage: null,
  createdAt: "2026-07-15T08:00:00.000Z",
  startedAt: "2026-07-15T08:00:00.000Z",
  updatedAt: "2026-07-15T08:00:00.000Z",
  completedAt: null,
  version: null,
};

test("runOnce 只 claim 一筆並等待 processing 完成", async () => {
  let claimCount = 0;
  let processCount = 0;
  const runtime = new MeetingWorkerRuntime({
    repository: {
      claimNext: async () => {
        claimCount += 1;
        return claimCount === 1 ? job : null;
      },
    } as never,
    processingService: {
      processClaimedJob: async () => {
        processCount += 1;
        return { ...job, status: "ready" };
      },
    } as never,
    workerId: "worker-1",
    leaseMs: 60_000,
  });

  assert.equal(await runtime.runOnce(), true);
  assert.equal(await runtime.runOnce(), false);
  assert.equal(claimCount, 2);
  assert.equal(processCount, 1);
});

test("同時觸發 runOnce 共用同一輪，不會重複 claim", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let claimCount = 0;
  const runtime = new MeetingWorkerRuntime({
    repository: {
      claimNext: async () => {
        claimCount += 1;
        return job;
      },
    } as never,
    processingService: {
      processClaimedJob: async () => {
        await gate;
        return { ...job, status: "ready" };
      },
    } as never,
    workerId: "worker-1",
    leaseMs: 60_000,
  });

  const first = runtime.runOnce();
  const second = runtime.runOnce();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(claimCount, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
});

test("worker 持續運行時會週期性回收啟動當下尚未過期的 running lease", async () => {
  let nowMs = Date.parse("2026-07-15T08:00:00.000Z");
  let recoverCount = 0;
  const runtime = new MeetingWorkerRuntime({
    repository: {
      claimNext: async () => null,
    } as never,
    processingService: {
      recoverExpiredJobs: async () => {
        recoverCount += 1;
        return {
          requeued: 1,
          exhausted: 0,
          autoRetried: 0,
          releasedLocks: 0,
          lockReleaseFailures: 0,
        };
      },
    } as never,
    workerId: "worker-1",
    leaseMs: 60_000,
    now: () => new Date(nowMs),
  });

  assert.equal(await runtime.runOnce(), false);
  assert.equal(recoverCount, 0);
  nowMs += 20_001;
  assert.equal(await runtime.runOnce(), false);
  assert.equal(recoverCount, 1);
});

test("worker 會依獨立 interval 重試 artifact 容量清理", async () => {
  let nowMs = Date.parse("2026-07-15T08:00:00.000Z");
  let cleanupCount = 0;
  const runtime = new MeetingWorkerRuntime({
    repository: {
      claimNext: async () => null,
    } as never,
    processingService: {
      cleanupArtifacts: async () => {
        cleanupCount += 1;
        return { deletedJobIds: [], retainedBytes: 0, maxTotalBytes: 100 };
      },
    } as never,
    workerId: "worker-1",
    leaseMs: 60_000,
    cleanupIntervalMs: 1_000,
    now: () => new Date(nowMs),
  });

  assert.equal(await runtime.runOnce(), false);
  assert.equal(cleanupCount, 0);
  nowMs += 1_001;
  assert.equal(await runtime.runOnce(), false);
  assert.equal(cleanupCount, 1);
});

test("stop 會 abort 目前 processor，等待 job 重新排隊後再關閉 repository", async () => {
  let started!: () => void;
  const processingStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let closed = false;
  let observedSignal: AbortSignal | undefined;
  const runtime = new MeetingWorkerRuntime({
    repository: {
      claimNext: async () => job,
    } as never,
    processingService: {
      processClaimedJob: async (
        _job: MeetingProcessingJobRecord,
        _workerId: string,
        signal?: AbortSignal
      ) => {
        observedSignal = signal;
        started();
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { ...job, status: "pending" as const, phase: "queued" as const };
      },
      close: async () => {
        closed = true;
      },
    } as never,
    workerId: "worker-1",
    leaseMs: 60_000,
  });

  const running = runtime.runOnce();
  await processingStarted;
  await runtime.stop();

  assert.equal(observedSignal?.aborted, true);
  assert.equal(await running, true);
  assert.equal(closed, true);
});

test("heartbeat 確認 lease 已遺失時會中止舊 processor", async () => {
  let observedSignal: AbortSignal | undefined;
  let heartbeatCount = 0;
  let notifyHeartbeat!: () => void;
  const heartbeatObserved = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("heartbeat 未在 1 秒內執行")),
      1_000
    );
    notifyHeartbeat = () => {
      clearTimeout(timeout);
      resolve();
    };
  });
  const runtime = new MeetingWorkerRuntime({
    repository: {
      claimNext: async () => job,
    } as never,
    processingService: {
      heartbeat: async () => {
        heartbeatCount += 1;
        notifyHeartbeat();
        return false;
      },
      processClaimedJob: async (
        _job: MeetingProcessingJobRecord,
        _workerId: string,
        signal?: AbortSignal
      ) => {
        observedSignal = signal;
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { ...job, status: "pending" as const, phase: "queued" as const };
      },
    } as never,
    workerId: "worker-1",
    leaseMs: 60_000,
    heartbeatIntervalMs: 5,
  });

  const running = runtime.runOnce();
  await heartbeatObserved;
  assert.equal(await running, true);
  assert.equal(heartbeatCount, 1);
  assert.equal(observedSignal?.aborted, true);
});

test("worker 優先處理 audio job，ready 後冪等送出 transcription", async () => {
  let transcriptionClaimCount = 0;
  let autoEnqueueCount = 0;
  const runtime = new MeetingWorkerRuntime({
    repository: {
      claimNext: async () => job,
    } as never,
    processingService: {
      processClaimedJob: async () => ({ ...job, status: "ready" as const, phase: "ready" as const }),
    } as never,
    transcriptionRepository: {
      claimNext: async () => {
        transcriptionClaimCount += 1;
        return transcriptionJob;
      },
    } as never,
    transcriptionService: {
      providerEnabled: true,
      enqueueFromProcessingJob: async () => {
        autoEnqueueCount += 1;
        return { job: transcriptionJob, created: true };
      },
    } as never,
    workerId: "worker-1",
    leaseMs: 60_000,
  });

  assert.equal(await runtime.runOnce(), true);
  assert.equal(autoEnqueueCount, 1);
  assert.equal(transcriptionClaimCount, 0);
});

test("沒有 audio job 時 worker 會 claim 並等待 transcription 完成", async () => {
  let transcriptionProcessCount = 0;
  const runtime = new MeetingWorkerRuntime({
    repository: {
      claimNext: async () => null,
    } as never,
    processingService: {} as never,
    transcriptionRepository: {
      claimNext: async () => transcriptionJob,
    } as never,
    transcriptionService: {
      providerEnabled: true,
      processClaimedJob: async () => {
        transcriptionProcessCount += 1;
        return { ...transcriptionJob, status: "ready" as const, phase: "ready" as const };
      },
    } as never,
    workerId: "worker-1",
    leaseMs: 60_000,
  });

  assert.equal(await runtime.runOnce(), true);
  assert.equal(transcriptionProcessCount, 1);
});

test("provider disabled 時保留既有 transcription pending，不 claim 也不消耗 attempt", async () => {
  let transcriptionClaimCount = 0;
  const runtime = new MeetingWorkerRuntime({
    repository: {
      claimNext: async () => null,
    } as never,
    processingService: {} as never,
    transcriptionRepository: {
      claimNext: async () => {
        transcriptionClaimCount += 1;
        return transcriptionJob;
      },
    } as never,
    transcriptionService: {
      providerEnabled: false,
    } as never,
    workerId: "worker-1",
    leaseMs: 60_000,
  });

  assert.equal(await runtime.runOnce(), false);
  assert.equal(transcriptionClaimCount, 0);
});

test("沒有 audio/transcription job 時才處理 minutes，順序不互相污染", async () => {
  let transcriptionClaimCount = 0;
  let minutesClaimCount = 0;
  let minutesProcessCount = 0;
  const runtime = new MeetingWorkerRuntime({
    repository: { claimNext: async () => null } as never,
    processingService: {} as never,
    transcriptionRepository: {
      claimNext: async () => {
        transcriptionClaimCount += 1;
        return null;
      },
    } as never,
    transcriptionService: { providerEnabled: true } as never,
    minutesRepository: {
      claimNext: async () => {
        minutesClaimCount += 1;
        return minutesJob;
      },
    } as never,
    minutesService: {
      providerEnabled: true,
      processClaimedJob: async () => {
        minutesProcessCount += 1;
        return { ...minutesJob, status: "ready" as const, phase: "ready" as const };
      },
    } as never,
    workerId: "worker-1",
    leaseMs: 60_000,
  });

  assert.equal(await runtime.runOnce(), true);
  assert.equal(transcriptionClaimCount, 1);
  assert.equal(minutesClaimCount, 1);
  assert.equal(minutesProcessCount, 1);
});

test("minutes provider disabled 時不 claim pending minutes job", async () => {
  let minutesClaimCount = 0;
  const runtime = new MeetingWorkerRuntime({
    repository: { claimNext: async () => null } as never,
    processingService: {} as never,
    minutesRepository: {
      claimNext: async () => {
        minutesClaimCount += 1;
        return minutesJob;
      },
    } as never,
    minutesService: { providerEnabled: false } as never,
    workerId: "worker-1",
    leaseMs: 60_000,
  });

  assert.equal(await runtime.runOnce(), false);
  assert.equal(minutesClaimCount, 0);
});

test("artifact cleanup 會保留 active session，且不連鎖刪除逐字稿與會議紀錄 metadata", async () => {
  let nowMs = Date.parse("2026-07-15T08:00:00.000Z");
  let protectedSessions: string[] = [];
  let cleanedProcessingJobIds: string[] = [];
  let cleanedTranscriptionJobIds: string[] = [];
  const runtime = new MeetingWorkerRuntime({
    repository: {
      claimNext: async () => null,
      listTerminalJobIdsWithoutArtifacts: async () => ["processing-orphan"],
    } as never,
    processingService: {
      cleanupArtifacts: async (protectedIds: ReadonlySet<string>) => {
        protectedSessions = [...protectedIds];
        return {
          deletedJobIds: ["processing-old"],
          retainedBytes: 100,
          maxTotalBytes: 100,
        };
      },
    } as never,
    transcriptionRepository: {
      claimNext: async () => null,
    } as never,
    transcriptionService: {
      listActiveSessionIds: async () => ["session-active"],
      deleteTerminalJobsForProcessingJobs: async (jobIds: string[]) => {
        cleanedProcessingJobIds = jobIds;
        return ["transcription-old"];
      },
    } as never,
    minutesService: {
      providerEnabled: true,
      listActiveSessionIds: async () => ["session-minutes-active"],
      deleteTerminalJobsForTranscriptionJobs: async (jobIds: string[]) => {
        cleanedTranscriptionJobIds = jobIds;
        return ["minutes-old"];
      },
    } as never,
    workerId: "worker-1",
    leaseMs: 60_000,
    cleanupIntervalMs: 1_000,
    now: () => new Date(nowMs),
  });

  nowMs += 1_001;
  assert.equal(await runtime.runOnce(), false);
  assert.deepEqual(protectedSessions.sort(), ["session-active", "session-minutes-active"]);
  assert.deepEqual(cleanedProcessingJobIds, []);
  assert.deepEqual(cleanedTranscriptionJobIds, []);
});

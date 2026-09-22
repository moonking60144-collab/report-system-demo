import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MeetingAudioProcessorLike } from "../../../src/services/meeting-minutes/meetingAudioProcessor";
import { MeetingProcessingService } from "../../../src/services/meeting-minutes/meetingProcessingService";
import { MeetingRecordingStorageService } from "../../../src/services/meeting-minutes/meetingRecordingStorageService";
import { MeetingProcessingJobRepository } from "../../../src/storage/meeting-minutes/meetingProcessingJobRepository";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "99999999-9999-4999-8999-999999999999";
const ORPHAN_JOB_ID = "88888888-8888-4888-8888-888888888888";
const OWNER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function createHarness(options: {
  maxAttempts?: number;
  retryDelayMs?: number;
  maxArtifactBytes?: number;
  now?: () => Date;
  process?: MeetingAudioProcessorLike["process"];
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "meeting-processing-service-"));
  const repository = new MeetingProcessingJobRepository(path.join(root, "jobs.sqlite3"));
  const recordingStorage = new MeetingRecordingStorageService({
    storageDir: path.join(root, "recordings"),
    maxTotalBytes: 1024,
    maxSessionBytes: 1024,
    maxChunkBytes: 128,
    staleSessionMs: 60_000,
    idFactory: () => SESSION_ID,
    now: () => new Date("2026-07-15T08:00:00.000Z"),
  });
  const audioProcessor: MeetingAudioProcessorLike = {
    process:
      options.process ??
      (async (input, onPhase) => {
        await onPhase("normalizing-room-mic");
        await onPhase("generating-playback");
        return [
          {
            artifactId: "artifact-1",
            jobId: "",
            sessionId: input.sessionId,
            type: "playback",
            mimeType: "audio/mp4",
            relativePath: `${input.sessionId}/playback.m4a`,
            sizeBytes: 100,
            sha256: "abc123",
            createdAt: "2026-07-15T08:00:00.000Z",
          },
        ];
      }),
    resolveArtifactPath: (relativePath) => path.join(root, "artifacts", relativePath),
    cleanupTrash: async () => undefined,
    removeSessionAudioArtifacts: async () => false,
  };
  const service = new MeetingProcessingService({
    repository,
    recordingStorage,
    audioProcessor,
    idFactory: () => JOB_ID,
    now: options.now ?? (() => new Date("2026-07-15T08:00:00.000Z")),
    maxAttempts: options.maxAttempts ?? 3,
    retryDelayMs: options.retryDelayMs,
    maxArtifactBytes: options.maxArtifactBytes,
    leaseMs: 60_000,
    workerEnabled: true,
  });
  await service.initialize();
  const session = await recordingStorage.createSession({
    ownerId: OWNER_ID,
    sourceIds: ["room-mic"],
  });
  await recordingStorage.uploadChunk({
    ownerId: OWNER_ID,
    sessionId: session.sessionId,
    sourceId: "room-mic",
    sequence: 0,
    mimeType: "audio/webm",
    body: Buffer.from("room-audio"),
  });
  await recordingStorage.finalizeSession({
    ownerId: OWNER_ID,
    sessionId: session.sessionId,
    durationMs: 1_000,
    tracks: [{ sourceId: "room-mic", chunkCount: 1 }],
  });
  return {
    root,
    repository,
    recordingStorage,
    audioProcessor,
    service,
    async claim(workerId = "worker-1") {
      return repository.claimNext({
        workerId,
        now: "2026-07-15T08:00:00.000Z",
        leaseExpiresAt: "2026-07-15T08:01:00.000Z",
      });
    },
    async close() {
      await service.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("enqueue 對同一 session 去重，worker ready 後寫 artifacts 並解除 source lock", async () => {
  const harness = await createHarness();
  try {
    const first = await harness.service.enqueue(SESSION_ID, OWNER_ID);
    const second = await harness.service.enqueue(SESSION_ID, OWNER_ID);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.job.jobId, JOB_ID);

    const claimed = await harness.claim();
    assert.ok(claimed);
    const ready = await harness.service.processClaimedJob(claimed, "worker-1");
    assert.equal(ready.status, "ready");
    assert.equal(ready.artifacts[0]?.jobId, JOB_ID);
    assert.equal(await harness.recordingStorage.releaseProcessingLock(SESSION_ID, JOB_ID), false);
  } finally {
    await harness.close();
  }
});

test("可重試失敗保留 source lock，retry 只重排既有 job", async () => {
  const failure = Object.assign(new Error("ffmpeg transient failure"), {
    code: "FFMPEG_TRANSIENT",
  });
  const harness = await createHarness({
    maxAttempts: 2,
    process: async () => {
      throw failure;
    },
  });
  try {
    await harness.service.enqueue(SESSION_ID, OWNER_ID);
    const claimed = await harness.claim();
    assert.ok(claimed);
    const failed = await harness.service.processClaimedJob(claimed, "worker-1");
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, "FFMPEG_TRANSIENT");
    assert.equal((await harness.recordingStorage.resolveProcessingInput(SESSION_ID, JOB_ID)).sessionId, SESSION_ID);

    const retried = await harness.service.retry(JOB_ID, OWNER_ID);
    assert.equal(retried.status, "pending");
    assert.equal(retried.attemptCount, 1);
  } finally {
    await harness.close();
  }
});

test("可重試失敗在 delay 到期後自動重排，達上限後解除 source lock", async () => {
  let nowMs = Date.parse("2026-07-15T08:00:00.000Z");
  const harness = await createHarness({
    maxAttempts: 2,
    retryDelayMs: 60_000,
    now: () => new Date(nowMs),
    process: async () => {
      throw new Error("persistent ffmpeg failure");
    },
  });
  try {
    await harness.service.enqueue(SESSION_ID, OWNER_ID);
    const firstClaim = await harness.claim();
    assert.ok(firstClaim);
    assert.equal(
      (await harness.service.processClaimedJob(firstClaim, "worker-1")).status,
      "failed"
    );

    nowMs += 60_000;
    const recovered = await harness.service.recoverExpiredJobs();
    assert.equal(recovered.autoRetried, 1);
    assert.equal((await harness.repository.getJob(JOB_ID))?.status, "pending");
    assert.equal(await harness.recordingStorage.getProcessingLockJobId(SESSION_ID), JOB_ID);

    const secondClaim = await harness.claim();
    assert.ok(secondClaim);
    const exhausted = await harness.service.processClaimedJob(secondClaim, "worker-1");
    assert.equal(exhausted.status, "failed");
    assert.equal(exhausted.attemptCount, 2);
    assert.equal(await harness.recordingStorage.getProcessingLockJobId(SESSION_ID), null);
  } finally {
    await harness.close();
  }
});

test("容量淘汰不會自動重試，使用者重試會重建 source lock 與 audio", async () => {
  let nowMs = Date.parse("2026-07-15T08:00:00.000Z");
  const harness = await createHarness({
    retryDelayMs: 0,
    maxArtifactBytes: 0,
    now: () => new Date(nowMs),
  });
  try {
    await harness.service.enqueue(SESSION_ID, OWNER_ID);
    const firstClaim = await harness.claim();
    assert.ok(firstClaim);
    assert.equal(
      (await harness.service.processClaimedJob(firstClaim, "worker-1")).status,
      "ready"
    );
    assert.equal(await harness.recordingStorage.getProcessingLockJobId(SESSION_ID), null);

    assert.deepEqual(await harness.service.cleanupArtifacts(), {
      deletedJobIds: [JOB_ID],
      retainedBytes: 0,
      maxTotalBytes: 0,
    });
    assert.equal(
      (await harness.repository.getJob(JOB_ID))?.errorCode,
      "MEETING_PROCESSING_ARTIFACT_EVICTED"
    );

    nowMs += 60_000;
    const recovered = await harness.service.recoverExpiredJobs();
    assert.equal(recovered.autoRetried, 0);
    assert.equal((await harness.repository.getJob(JOB_ID))?.status, "failed");
    assert.equal(await harness.recordingStorage.getProcessingLockJobId(SESSION_ID), null);

    const retried = await harness.service.retry(JOB_ID, OWNER_ID);
    assert.equal(retried.status, "pending");
    assert.equal(await harness.recordingStorage.getProcessingLockJobId(SESSION_ID), JOB_ID);
    const secondClaim = await harness.claim("worker-2");
    assert.ok(secondClaim);
    assert.equal(
      (await harness.service.processClaimedJob(secondClaim, "worker-2")).status,
      "ready"
    );
  } finally {
    await harness.close();
  }
});

test("pending eviction snapshot 不會刪除 retry 後重新 ready 的 audio", async () => {
  const harness = await createHarness({ maxArtifactBytes: 100 });
  try {
    await harness.service.enqueue(SESSION_ID, OWNER_ID);
    const firstClaim = await harness.claim();
    assert.ok(firstClaim);
    assert.equal(
      (await harness.service.processClaimedJob(firstClaim, "worker-1")).status,
      "ready"
    );
    assert.equal(
      await harness.repository.beginArtifactEvictionForReadyJob(
        JOB_ID,
        "2026-07-15T08:01:00.000Z"
      ),
      true
    );

    let releaseSnapshot!: () => void;
    const snapshotBlocked = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    let snapshotRead!: () => void;
    const snapshotReady = new Promise<void>((resolve) => {
      snapshotRead = resolve;
    });
    const originalList =
      harness.repository.listArtifactEvictionJobsWithArtifacts.bind(
        harness.repository
      );
    harness.repository.listArtifactEvictionJobsWithArtifacts = async () => {
      const jobs = await originalList();
      snapshotRead();
      await snapshotBlocked;
      return jobs;
    };
    let removeCalls = 0;
    harness.audioProcessor.removeSessionAudioArtifacts = async () => {
      removeCalls += 1;
      return true;
    };

    const cleanupPromise = harness.service.cleanupArtifacts();
    await snapshotReady;
    assert.equal((await harness.service.retry(JOB_ID, OWNER_ID)).status, "pending");
    const secondClaim = await harness.claim("worker-2");
    assert.ok(secondClaim);
    assert.equal(
      (await harness.service.processClaimedJob(secondClaim, "worker-2")).status,
      "ready"
    );
    releaseSnapshot();

    assert.deepEqual(await cleanupPromise, {
      deletedJobIds: [],
      retainedBytes: 100,
      maxTotalBytes: 100,
    });
    assert.equal(removeCalls, 0);
    assert.equal((await harness.repository.getJob(JOB_ID))?.status, "ready");
    assert.equal((await harness.repository.getJob(JOB_ID))?.artifacts.length, 1);
  } finally {
    await harness.close();
  }
});

test("重試次數耗盡後標 failed 並解除 source lock", async () => {
  const harness = await createHarness({
    maxAttempts: 1,
    process: async () => {
      throw new Error("permanent failure");
    },
  });
  try {
    await harness.service.enqueue(SESSION_ID, OWNER_ID);
    const claimed = await harness.claim();
    assert.ok(claimed);
    const failed = await harness.service.processClaimedJob(claimed, "worker-1");
    assert.equal(failed.status, "failed");
    assert.equal(failed.attemptCount, 1);
    assert.equal(await harness.recordingStorage.releaseProcessingLock(SESSION_ID, JOB_ID), false);
    await assert.rejects(
      harness.service.retry(JOB_ID, OWNER_ID),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "MEETING_PROCESSING_RETRY_EXHAUSTED"
    );
  } finally {
    await harness.close();
  }
});

test("artifact 容量超過上限時只淘汰最舊 ready job", async () => {
  const deletedMetadata: string[] = [];
  const removedSessions: string[] = [];
  const readyJobs = [
    {
      jobId: "job-old",
      sessionId: "session-old",
      ownerId: OWNER_ID,
      status: "ready" as const,
      phase: "ready" as const,
      attemptCount: 1,
      maxAttempts: 3,
      errorCode: null,
      errorMessage: null,
      createdAt: "2026-07-15T07:00:00.000Z",
      startedAt: "2026-07-15T07:01:00.000Z",
      updatedAt: "2026-07-15T07:02:00.000Z",
      completedAt: "2026-07-15T07:02:00.000Z",
      artifacts: [
        {
          artifactId: "artifact-old",
          jobId: "job-old",
          sessionId: "session-old",
          type: "playback" as const,
          mimeType: "audio/mp4",
          relativePath: "session-old/playback.m4a",
          sizeBytes: 100,
          sha256: "old",
          createdAt: "2026-07-15T07:02:00.000Z",
        },
      ],
    },
    {
      jobId: "job-new",
      sessionId: "session-new",
      ownerId: OWNER_ID,
      status: "ready" as const,
      phase: "ready" as const,
      attemptCount: 1,
      maxAttempts: 3,
      errorCode: null,
      errorMessage: null,
      createdAt: "2026-07-15T08:00:00.000Z",
      startedAt: "2026-07-15T08:01:00.000Z",
      updatedAt: "2026-07-15T08:02:00.000Z",
      completedAt: "2026-07-15T08:02:00.000Z",
      artifacts: [
        {
          artifactId: "artifact-new",
          jobId: "job-new",
          sessionId: "session-new",
          type: "playback" as const,
          mimeType: "audio/mp4",
          relativePath: "session-new/playback.m4a",
          sizeBytes: 100,
          sha256: "new",
          createdAt: "2026-07-15T08:02:00.000Z",
        },
      ],
    },
  ];
  const cleanupEvents: string[] = [];
  const service = new MeetingProcessingService({
    repository: {
      listArtifactEvictionJobsWithArtifacts: async () => [],
      listReadyJobsWithArtifacts: async () => readyJobs,
      getJob: async (jobId: string) =>
        readyJobs.find((job) => job.jobId === jobId) ?? null,
      beginArtifactEvictionForReadyJob: async (jobId: string) => {
        cleanupEvents.push(`metadata-begin:${jobId}`);
        return true;
      },
      completeArtifactEviction: async (jobId: string) => {
        cleanupEvents.push(`metadata-complete:${jobId}`);
        deletedMetadata.push(jobId);
        return true;
      },
    } as never,
    recordingStorage: {} as never,
    audioProcessor: {
      cleanupTrash: async () => undefined,
      removeSessionAudioArtifacts: async (sessionId: string) => {
        cleanupEvents.push(`files:${sessionId}`);
        removedSessions.push(sessionId);
        return true;
      },
    } as never,
    maxArtifactBytes: 150,
  });

  const result = await service.cleanupArtifacts();

  assert.deepEqual(removedSessions, ["session-old"]);
  assert.deepEqual(deletedMetadata, ["job-old"]);
  assert.deepEqual(cleanupEvents, [
    "metadata-begin:job-old",
    "files:session-old",
    "metadata-complete:job-old",
  ]);
  assert.deepEqual(result, {
    deletedJobIds: ["job-old"],
    retainedBytes: 100,
    maxTotalBytes: 150,
  });
});

test("artifact 刪檔失敗時保留容量帳與 eviction metadata，下一輪可重試", async () => {
  const artifact = {
    artifactId: "artifact-old",
    jobId: "job-old",
    sessionId: "session-old",
    type: "playback" as const,
    mimeType: "audio/mp4",
    relativePath: "session-old/playback.m4a",
    sizeBytes: 100,
    sha256: "old",
    createdAt: "2026-07-15T07:02:00.000Z",
  };
  const baseJob = {
    jobId: "job-old",
    sessionId: "session-old",
    ownerId: OWNER_ID,
    phase: "queued" as const,
    attemptCount: 0,
    maxAttempts: 3,
    errorCode: "MEETING_PROCESSING_ARTIFACT_EVICTED",
    errorMessage: "後處理音訊已依容量上限淘汰，可重新處理。",
    createdAt: "2026-07-15T07:00:00.000Z",
    startedAt: null,
    updatedAt: "2026-07-15T07:02:00.000Z",
    completedAt: null,
    artifacts: [artifact],
  };
  let pendingEviction = false;
  let removeAttempts = 0;
  const service = new MeetingProcessingService({
    repository: {
      listArtifactEvictionJobsWithArtifacts: async () =>
        pendingEviction ? [{ ...baseJob, status: "failed" as const }] : [],
      listReadyJobsWithArtifacts: async () =>
        pendingEviction
          ? []
          : [
              {
                ...baseJob,
                status: "ready" as const,
                phase: "ready" as const,
                attemptCount: 1,
                errorCode: null,
                errorMessage: null,
                completedAt: "2026-07-15T07:02:00.000Z",
              },
            ],
      getJob: async () =>
        pendingEviction
          ? { ...baseJob, status: "failed" as const }
          : {
              ...baseJob,
              status: "ready" as const,
              phase: "ready" as const,
              attemptCount: 1,
              errorCode: null,
              errorMessage: null,
              completedAt: "2026-07-15T07:02:00.000Z",
            },
      beginArtifactEvictionForReadyJob: async () => {
        pendingEviction = true;
        return true;
      },
      completeArtifactEviction: async () => {
        pendingEviction = false;
        return true;
      },
    } as never,
    recordingStorage: {} as never,
    audioProcessor: {
      cleanupTrash: async () => undefined,
      removeSessionAudioArtifacts: async () => {
        removeAttempts += 1;
        if (removeAttempts === 1) throw new Error("EACCES");
        return true;
      },
    } as never,
    maxArtifactBytes: 0,
  });

  await assert.rejects(service.cleanupArtifacts(), /EACCES/);
  assert.equal(pendingEviction, true);
  assert.deepEqual(await service.cleanupArtifacts(), {
    deletedJobIds: ["job-old"],
    retainedBytes: 0,
    maxTotalBytes: 0,
  });
  assert.equal(removeAttempts, 2);
});

test("DB 不存在對應任務時會回收中斷留下的孤兒 processing lock", async () => {
  const harness = await createHarness();
  try {
    await harness.recordingStorage.acquireProcessingLock({
      sessionId: SESSION_ID,
      ownerId: OWNER_ID,
      jobId: ORPHAN_JOB_ID,
    });

    const accepted = await harness.service.enqueue(SESSION_ID, OWNER_ID);

    assert.equal(accepted.created, true);
    assert.equal(accepted.job.jobId, JOB_ID);
    assert.equal(
      await harness.recordingStorage.getProcessingLockJobId(SESSION_ID),
      JOB_ID
    );
  } finally {
    await harness.close();
  }
});

test("ready 後 lock 解除暫時失敗不會把成功任務改成 failed，重啟對帳會清掉 lock", async () => {
  const harness = await createHarness();
  const releaseProcessingLock = harness.recordingStorage.releaseProcessingLock.bind(
    harness.recordingStorage
  );
  try {
    await harness.service.enqueue(SESSION_ID, OWNER_ID);
    const claimed = await harness.claim();
    assert.ok(claimed);
    harness.recordingStorage.releaseProcessingLock = async () => {
      throw new Error("temporary lock cleanup failure");
    };

    const ready = await harness.service.processClaimedJob(claimed, "worker-1");

    assert.equal(ready.status, "ready");
    assert.equal((await harness.repository.getJob(JOB_ID))?.status, "ready");
    harness.recordingStorage.releaseProcessingLock = releaseProcessingLock;
    const recovered = await harness.service.recoverExpiredJobs();
    assert.equal(recovered.releasedLocks, 1);
    assert.equal(recovered.lockReleaseFailures, 0);
    assert.equal(await harness.recordingStorage.getProcessingLockJobId(SESSION_ID), null);
  } finally {
    harness.recordingStorage.releaseProcessingLock = releaseProcessingLock;
    await harness.close();
  }
});

test("worker shutdown 會中止 processor 並把 job 放回 pending，source lock 繼續保護原始音訊", async () => {
  let started!: () => void;
  const processingStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const harness = await createHarness({
    process: async (_input, _onPhase, options) => {
      started();
      await new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("worker shutdown"), { code: "ABORT_ERR" })),
          { once: true }
        );
      });
      return [];
    },
  });
  try {
    await harness.service.enqueue(SESSION_ID, OWNER_ID);
    const claimed = await harness.claim();
    assert.ok(claimed);
    const controller = new AbortController();
    const processing = harness.service.processClaimedJob(
      claimed,
      "worker-1",
      controller.signal
    );
    await processingStarted;
    controller.abort();

    const requeued = await processing;

    assert.equal(requeued.status, "pending");
    assert.equal(requeued.attemptCount, 0);
    assert.equal(
      (await harness.recordingStorage.resolveProcessingInput(SESSION_ID, JOB_ID)).sessionId,
      SESSION_ID
    );
  } finally {
    await harness.close();
  }
});

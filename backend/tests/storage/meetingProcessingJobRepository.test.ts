import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MeetingProcessingJobRepository,
  type MeetingProcessingArtifactRecord,
} from "../../src/storage/meeting-minutes/meetingProcessingJobRepository";

async function createHarness() {
  const root = await mkdtemp(path.join(tmpdir(), "meeting-processing-repository-"));
  const dbFile = path.join(root, "metadata.sqlite3");
  const first = new MeetingProcessingJobRepository(dbFile);
  const second = new MeetingProcessingJobRepository(dbFile);
  await first.initialize();
  await second.initialize();
  return {
    first,
    second,
    async close() {
      await Promise.all([first.close(), second.close()]);
      await rm(root, { recursive: true, force: true });
    },
  };
}

const createdAt = "2026-07-15T08:00:00.000Z";

test("同一 session 重複 enqueue 回傳原 job，且 owner 不可跨 session job", async () => {
  const harness = await createHarness();
  try {
    const first = await harness.first.enqueue({
      jobId: "job-1",
      sessionId: "session-1",
      ownerId: "owner-1",
      maxAttempts: 3,
      now: createdAt,
    });
    const second = await harness.first.enqueue({
      jobId: "job-2",
      sessionId: "session-1",
      ownerId: "owner-1",
      maxAttempts: 3,
      now: "2026-07-15T08:01:00.000Z",
    });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.job.jobId, "job-1");
    assert.equal(await harness.first.getJobForOwner("job-1", "owner-2"), null);
    await assert.rejects(
      harness.first.enqueue({
        jobId: "job-3",
        sessionId: "session-1",
        ownerId: "owner-2",
        maxAttempts: 3,
        now: createdAt,
      }),
      /owner mismatch/
    );
  } finally {
    await harness.close();
  }
});

test("兩個 repository instance 只能原子 claim 同一筆 pending job 一次", async () => {
  const harness = await createHarness();
  try {
    await harness.first.enqueue({
      jobId: "job-claim",
      sessionId: "session-claim",
      ownerId: "owner-1",
      maxAttempts: 3,
      now: createdAt,
    });
    const results = await Promise.all([
      harness.first.claimNext({
        workerId: "worker-a",
        now: "2026-07-15T08:01:00.000Z",
        leaseExpiresAt: "2026-07-15T08:11:00.000Z",
      }),
      harness.second.claimNext({
        workerId: "worker-b",
        now: "2026-07-15T08:01:00.000Z",
        leaseExpiresAt: "2026-07-15T08:11:00.000Z",
      }),
    ]);

    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(results.find(Boolean)?.jobId, "job-claim");
    assert.equal(results.find(Boolean)?.attemptCount, 1);
    assert.equal((await harness.first.getJob("job-claim"))?.status, "running");
  } finally {
    await harness.close();
  }
});

test("running job 可更新 phase 並原子寫入 ready artifacts", async () => {
  const harness = await createHarness();
  try {
    await harness.first.enqueue({
      jobId: "job-ready",
      sessionId: "session-ready",
      ownerId: "owner-1",
      maxAttempts: 3,
      now: createdAt,
    });
    await harness.first.claimNext({
      workerId: "worker-a",
      now: "2026-07-15T08:01:00.000Z",
      leaseExpiresAt: "2026-07-15T08:11:00.000Z",
    });
    assert.equal(
      await harness.first.updatePhase({
        jobId: "job-ready",
        workerId: "worker-a",
        phase: "normalizing-room-mic",
        now: "2026-07-15T08:02:00.000Z",
        leaseExpiresAt: "2026-07-15T08:12:00.000Z",
      }),
      true
    );

    const artifact: MeetingProcessingArtifactRecord = {
      artifactId: "artifact-1",
      jobId: "job-ready",
      sessionId: "session-ready",
      type: "canonical-room-mic",
      mimeType: "audio/wav",
      relativePath: "session-ready/room-mic.wav",
      sizeBytes: 100,
      sha256: "abc123",
      createdAt: "2026-07-15T08:03:00.000Z",
    };
    const ready = await harness.first.markReady({
      jobId: "job-ready",
      workerId: "worker-a",
      artifacts: [artifact],
      now: "2026-07-15T08:03:00.000Z",
    });

    assert.equal(ready.status, "ready");
    assert.equal(ready.phase, "ready");
    assert.equal(ready.completedAt, "2026-07-15T08:03:00.000Z");
    assert.deepEqual(ready.artifacts, [artifact]);
  } finally {
    await harness.close();
  }
});

test("failed job 在未達上限時可重排，達上限後不可 retry", async () => {
  const harness = await createHarness();
  try {
    await harness.first.enqueue({
      jobId: "job-retry",
      sessionId: "session-retry",
      ownerId: "owner-1",
      maxAttempts: 2,
      now: createdAt,
    });
    await harness.first.claimNext({
      workerId: "worker-a",
      now: "2026-07-15T08:01:00.000Z",
      leaseExpiresAt: "2026-07-15T08:11:00.000Z",
    });
    await harness.first.markFailed({
      jobId: "job-retry",
      workerId: "worker-a",
      errorCode: "FFMPEG_FAILED",
      errorMessage: "first failure",
      now: "2026-07-15T08:02:00.000Z",
    });
    assert.equal(
      (await harness.first.retry("job-retry", "owner-1", "2026-07-15T08:03:00.000Z"))
        ?.status,
      "pending"
    );
    await harness.first.claimNext({
      workerId: "worker-a",
      now: "2026-07-15T08:04:00.000Z",
      leaseExpiresAt: "2026-07-15T08:14:00.000Z",
    });
    const failed = await harness.first.markFailed({
      jobId: "job-retry",
      workerId: "worker-a",
      errorCode: "FFMPEG_FAILED",
      errorMessage: "second failure",
      now: "2026-07-15T08:05:00.000Z",
    });

    assert.equal(failed.attemptCount, 2);
    assert.equal(
      await harness.first.retry("job-retry", "owner-1", "2026-07-15T08:06:00.000Z"),
      null
    );
  } finally {
    await harness.close();
  }
});

test("可重試 failed job 只在 retry delay 到期後自動回到 pending", async () => {
  const harness = await createHarness();
  try {
    await harness.first.enqueue({
      jobId: "job-auto-retry",
      sessionId: "session-auto-retry",
      ownerId: "owner-1",
      maxAttempts: 3,
      now: createdAt,
    });
    await harness.first.claimNext({
      workerId: "worker-a",
      now: "2026-07-15T08:01:00.000Z",
      leaseExpiresAt: "2026-07-15T08:11:00.000Z",
    });
    await harness.first.markFailed({
      jobId: "job-auto-retry",
      workerId: "worker-a",
      errorCode: "FFMPEG_TRANSIENT",
      errorMessage: "temporary failure",
      now: "2026-07-15T08:02:00.000Z",
    });

    assert.deepEqual(
      await harness.first.requeueRetryableFailed(
        "2026-07-15T08:02:30.000Z",
        "2026-07-15T08:01:30.000Z"
      ),
      []
    );
    assert.deepEqual(
      await harness.first.requeueRetryableFailed(
        "2026-07-15T08:03:00.000Z",
        "2026-07-15T08:02:00.000Z"
      ),
      ["job-auto-retry"]
    );
    assert.equal((await harness.first.getJob("job-auto-retry"))?.status, "pending");
  } finally {
    await harness.close();
  }
});

test("ready artifact 淘汰後 job 轉為可重試 failed 並移除 metadata", async () => {
  const harness = await createHarness();
  try {
    await harness.first.enqueue({
      jobId: "job-artifact",
      sessionId: "session-artifact",
      ownerId: "owner-1",
      maxAttempts: 3,
      now: createdAt,
    });
    await harness.first.claimNext({
      workerId: "worker-a",
      now: "2026-07-15T08:01:00.000Z",
      leaseExpiresAt: "2026-07-15T08:11:00.000Z",
    });
    await harness.first.markReady({
      jobId: "job-artifact",
      workerId: "worker-a",
      artifacts: [
        {
          artifactId: "artifact-cleanup",
          jobId: "job-artifact",
          sessionId: "session-artifact",
          type: "playback",
          mimeType: "audio/mp4",
          relativePath: "session-artifact/playback.m4a",
          sizeBytes: 120,
          sha256: "artifact-hash",
          createdAt: "2026-07-15T08:02:00.000Z",
        },
      ],
      now: "2026-07-15T08:02:00.000Z",
    });

    const candidates = await harness.first.listReadyJobsWithArtifacts();
    assert.deepEqual(candidates.map((job) => job.jobId), ["job-artifact"]);
    assert.equal(candidates[0]?.artifacts[0]?.sizeBytes, 120);
    assert.equal(
      await harness.first.beginArtifactEvictionForReadyJob(
        "job-artifact",
        "2026-07-15T08:03:00.000Z"
      ),
      true
    );
    const evicted = await harness.first.getJob("job-artifact");
    assert.equal(evicted?.status, "failed");
    assert.equal(evicted?.phase, "queued");
    assert.equal(evicted?.attemptCount, 0);
    assert.equal(evicted?.errorCode, "MEETING_PROCESSING_ARTIFACT_EVICTED");
    assert.equal(evicted?.artifacts.length, 1);
    assert.deepEqual(
      (await harness.first.listArtifactEvictionJobsWithArtifacts()).map(
        (job) => job.jobId
      ),
      ["job-artifact"]
    );
    assert.deepEqual(
      await harness.first.requeueRetryableFailed(
        "2026-07-15T08:04:00.000Z",
        "2026-07-15T08:04:00.000Z"
      ),
      []
    );
    assert.equal(await harness.first.completeArtifactEviction("job-artifact"), true);
    const completedEviction = await harness.first.getJob("job-artifact");
    assert.equal(completedEviction?.status, "failed");
    assert.equal(completedEviction?.errorCode, "MEETING_PROCESSING_ARTIFACT_EVICTED");
    assert.deepEqual(completedEviction?.artifacts, []);
    assert.deepEqual(
      await harness.first.listTerminalJobIdsWithoutArtifacts(),
      []
    );
  } finally {
    await harness.close();
  }
});

test("worker 主動關閉時可把自己持有的 running job 放回 pending 且不消耗 attempt", async () => {
  const harness = await createHarness();
  try {
    await harness.first.enqueue({
      jobId: "job-shutdown",
      sessionId: "session-shutdown",
      ownerId: "owner-1",
      maxAttempts: 3,
      now: createdAt,
    });
    await harness.first.claimNext({
      workerId: "worker-a",
      now: "2026-07-15T08:01:00.000Z",
      leaseExpiresAt: "2026-07-15T08:11:00.000Z",
    });

    const requeued = await harness.first.requeueClaimed({
      jobId: "job-shutdown",
      workerId: "worker-a",
      now: "2026-07-15T08:02:00.000Z",
    });

    assert.equal(requeued?.status, "pending");
    assert.equal(requeued?.phase, "queued");
    assert.equal(requeued?.attemptCount, 0);
    assert.equal(requeued?.errorCode, "WORKER_SHUTDOWN");
    assert.equal(
      await harness.first.requeueClaimed({
        jobId: "job-shutdown",
        workerId: "worker-b",
        now: "2026-07-15T08:03:00.000Z",
      }),
      null
    );
  } finally {
    await harness.close();
  }
});

test("啟動 reconcile 會重排未達上限的 stale running，耗盡者標 failed", async () => {
  const harness = await createHarness();
  try {
    await harness.first.enqueue({
      jobId: "job-stale-requeue",
      sessionId: "session-stale-requeue",
      ownerId: "owner-1",
      maxAttempts: 2,
      now: "2026-07-15T07:00:00.000Z",
    });
    await harness.first.claimNext({
      workerId: "worker-a",
      now: "2026-07-15T07:01:00.000Z",
      leaseExpiresAt: "2026-07-15T07:11:00.000Z",
    });
    await harness.first.enqueue({
      jobId: "job-stale-exhausted",
      sessionId: "session-stale-exhausted",
      ownerId: "owner-1",
      maxAttempts: 1,
      now: "2026-07-15T07:02:00.000Z",
    });
    await harness.first.claimNext({
      workerId: "worker-a",
      now: "2026-07-15T07:03:00.000Z",
      leaseExpiresAt: "2026-07-15T07:13:00.000Z",
    });

    const result = await harness.second.recoverExpiredRunning(
      "2026-07-15T08:00:00.000Z"
    );

    assert.deepEqual(result, {
      requeued: 1,
      exhausted: 1,
      requeuedJobIds: ["job-stale-requeue"],
      exhaustedJobIds: ["job-stale-exhausted"],
    });
    assert.equal((await harness.first.getJob("job-stale-requeue"))?.status, "pending");
    const exhausted = await harness.first.getJob("job-stale-exhausted");
    assert.equal(exhausted?.status, "failed");
    assert.equal(exhausted?.errorCode, "PROCESSING_ATTEMPTS_EXHAUSTED");
  } finally {
    await harness.close();
  }
});

test("失去 lease 的舊 worker 不可更新 phase 或寫入 ready", async () => {
  const harness = await createHarness();
  try {
    await harness.first.enqueue({
      jobId: "job-lease",
      sessionId: "session-lease",
      ownerId: "owner-1",
      maxAttempts: 3,
      now: createdAt,
    });
    await harness.first.claimNext({
      workerId: "worker-old",
      now: "2026-07-15T08:01:00.000Z",
      leaseExpiresAt: "2026-07-15T08:02:00.000Z",
    });
    await harness.second.recoverExpiredRunning("2026-07-15T08:03:00.000Z");
    await harness.second.claimNext({
      workerId: "worker-new",
      now: "2026-07-15T08:04:00.000Z",
      leaseExpiresAt: "2026-07-15T08:14:00.000Z",
    });

    assert.equal(
      await harness.first.updatePhase({
        jobId: "job-lease",
        workerId: "worker-old",
        phase: "generating-playback",
        now: "2026-07-15T08:05:00.000Z",
        leaseExpiresAt: "2026-07-15T08:15:00.000Z",
      }),
      false
    );
    await assert.rejects(
      harness.first.markReady({
        jobId: "job-lease",
        workerId: "worker-old",
        artifacts: [],
        now: "2026-07-15T08:05:00.000Z",
      }),
      /lease lost/
    );
  } finally {
    await harness.close();
  }
});

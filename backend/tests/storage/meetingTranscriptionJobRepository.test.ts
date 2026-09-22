import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MeetingTranscriptionJobRepository,
  type MeetingTranscriptionArtifactRecord,
  type MeetingTranscriptSegment,
} from "../../src/storage/meeting-minutes/meetingTranscriptionJobRepository";

async function createHarness() {
  const root = await mkdtemp(path.join(tmpdir(), "meeting-transcription-repository-"));
  const dbFile = path.join(root, "metadata.sqlite3");
  const first = new MeetingTranscriptionJobRepository(dbFile);
  const second = new MeetingTranscriptionJobRepository(dbFile);
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

const createdAt = "2026-07-16T01:00:00.000Z";

async function enqueue(
  repository: MeetingTranscriptionJobRepository,
  overrides: Partial<Parameters<MeetingTranscriptionJobRepository["enqueue"]>[0]> = {}
) {
  return repository.enqueue({
    jobId: "transcription-1",
    processingJobId: "processing-1",
    sessionId: "session-1",
    ownerId: "owner-1",
    provider: "google-gemini",
    model: "gemini-test",
    maxAttempts: 3,
    now: createdAt,
    ...overrides,
  });
}

test("同一 session 與 processing job 只建立一筆 transcription job", async () => {
  const harness = await createHarness();
  try {
    const first = await enqueue(harness.first);
    const duplicate = await enqueue(harness.first, { jobId: "transcription-2" });

    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.job.jobId, "transcription-1");
    assert.equal(await harness.first.getJobForOwner("transcription-1", "owner-2"), null);
    await assert.rejects(
      enqueue(harness.first, {
        jobId: "transcription-3",
        ownerId: "owner-2",
      }),
      /owner mismatch/
    );
  } finally {
    await harness.close();
  }
});

test("兩個 repository instance 只會原子 claim 同一筆 pending job 一次", async () => {
  const harness = await createHarness();
  try {
    await enqueue(harness.first);
    const claimed = await Promise.all([
      harness.first.claimNext({
        workerId: "worker-a",
        now: "2026-07-16T01:01:00.000Z",
        leaseExpiresAt: "2026-07-16T01:11:00.000Z",
      }),
      harness.second.claimNext({
        workerId: "worker-b",
        now: "2026-07-16T01:01:00.000Z",
        leaseExpiresAt: "2026-07-16T01:11:00.000Z",
      }),
    ]);

    assert.equal(claimed.filter(Boolean).length, 1);
    assert.equal(claimed.find(Boolean)?.attemptCount, 1);
    assert.equal(
      await harness.first.updatePhase({
        jobId: "transcription-1",
        workerId: claimed[0] ? "worker-a" : "worker-b",
        phase: "transcribing-room-mic",
        now: "2026-07-16T01:02:00.000Z",
        leaseExpiresAt: "2026-07-16T01:12:00.000Z",
      }),
      true
    );
  } finally {
    await harness.close();
  }
});

test("成功 chunk 依 source/index/SHA checkpoint，retry 可直接續跑", async () => {
  const harness = await createHarness();
  try {
    await enqueue(harness.first);
    const segments: MeetingTranscriptSegment[] = [
      {
        segmentId: "room-mic:0:0",
        sourceId: "room-mic",
        startMs: 1_000,
        endMs: 2_500,
        text: "測試逐字稿",
        speakerLabel: "講者 1",
        confidence: null,
      },
    ];
    await harness.first.saveChunkCheckpoint({
      jobId: "transcription-1",
      sessionId: "session-1",
      sourceId: "room-mic",
      chunkIndex: 0,
      startMs: 0,
      endMs: 600_000,
      audioSha256: "sha-a",
      segments,
      now: "2026-07-16T01:03:00.000Z",
    });

    assert.deepEqual(
      await harness.second.getChunkCheckpoint(
        "transcription-1",
        "room-mic",
        0,
        "sha-a"
      ),
      {
        jobId: "transcription-1",
        sessionId: "session-1",
        sourceId: "room-mic",
        chunkIndex: 0,
        startMs: 0,
        endMs: 600_000,
        audioSha256: "sha-a",
        segments,
        createdAt: "2026-07-16T01:03:00.000Z",
        updatedAt: "2026-07-16T01:03:00.000Z",
      }
    );
    assert.equal(
      await harness.second.getChunkCheckpoint(
        "transcription-1",
        "room-mic",
        0,
        "sha-b"
      ),
      null
    );
  } finally {
    await harness.close();
  }
});

test("running job 會以 transaction 寫入 transcript artifacts 並標 ready", async () => {
  const harness = await createHarness();
  try {
    await enqueue(harness.first);
    await harness.first.claimNext({
      workerId: "worker-a",
      now: "2026-07-16T01:01:00.000Z",
      leaseExpiresAt: "2026-07-16T01:11:00.000Z",
    });
    const artifact: MeetingTranscriptionArtifactRecord = {
      artifactId: "artifact-1",
      jobId: "transcription-1",
      sessionId: "session-1",
      type: "transcript-merged-json",
      mimeType: "application/json",
      relativePath: "session-1/transcript/merged.json",
      sizeBytes: 300,
      sha256: "artifact-sha",
      createdAt: "2026-07-16T01:04:00.000Z",
    };

    const ready = await harness.first.markReady({
      jobId: "transcription-1",
      workerId: "worker-a",
      artifacts: [artifact],
      now: "2026-07-16T01:04:00.000Z",
    });

    assert.equal(ready.status, "ready");
    assert.equal(ready.phase, "ready");
    assert.deepEqual(ready.artifacts, [artifact]);
    assert.deepEqual(
      await harness.first.listActiveSessionIds({
        provider: "google-gemini",
        model: "gemini-test",
        providerChangedAfter: "2026-07-09T01:04:00.000Z",
      }),
      []
    );
    await harness.first.saveChunkCheckpoint({
      jobId: "transcription-1",
      sessionId: "session-1",
      sourceId: "room-mic",
      chunkIndex: 0,
      startMs: 0,
      endMs: 60_000,
      audioSha256: "cleanup-sha",
      segments: [],
      now: "2026-07-16T01:04:01.000Z",
    });
    assert.deepEqual(
      await harness.first.deleteTerminalJobsByProcessingJobIds(["processing-1"]),
      ["transcription-1"]
    );
    assert.equal(await harness.first.getJob("transcription-1"), null);
    assert.equal(
      await harness.first.getChunkCheckpoint(
        "transcription-1",
        "room-mic",
        0,
        "cleanup-sha"
      ),
      null
    );
  } finally {
    await harness.close();
  }
});

test("failed job 可延遲重排，stale running 依 attempt ceiling 回復或耗盡", async () => {
  const harness = await createHarness();
  try {
    await enqueue(harness.first, { maxAttempts: 2 });
    await harness.first.claimNext({
      workerId: "worker-a",
      now: "2026-07-16T01:01:00.000Z",
      leaseExpiresAt: "2026-07-16T01:11:00.000Z",
    });
    await harness.first.markFailed({
      jobId: "transcription-1",
      workerId: "worker-a",
      errorCode: "TRANSIENT",
      errorMessage: "temporary",
      now: "2026-07-16T01:02:00.000Z",
    });
    assert.deepEqual(
      await harness.first.requeueRetryableFailed(
        "2026-07-16T01:03:00.000Z",
        "2026-07-16T01:02:00.000Z"
      ),
      ["transcription-1"]
    );
    await harness.first.claimNext({
      workerId: "worker-b",
      now: "2026-07-16T01:04:00.000Z",
      leaseExpiresAt: "2026-07-16T01:05:00.000Z",
    });

    const recovered = await harness.second.recoverExpiredRunning(
      "2026-07-16T01:06:00.000Z"
    );
    assert.deepEqual(recovered, {
      requeued: 0,
      exhausted: 1,
      requeuedJobIds: [],
      exhaustedJobIds: ["transcription-1"],
    });
    assert.equal((await harness.first.getJob("transcription-1"))?.status, "failed");
  } finally {
    await harness.close();
  }
});

test("provider 變更後重送會清除舊 chunk checkpoint 並重設嘗試次數", async () => {
  const harness = await createHarness();
  try {
    await enqueue(harness.first, { maxAttempts: 1 });
    await harness.first.saveChunkCheckpoint({
      jobId: "transcription-1",
      sessionId: "session-1",
      sourceId: "room-mic",
      chunkIndex: 0,
      startMs: 0,
      endMs: 60_000,
      audioSha256: "old-provider-sha",
      segments: [],
      now: "2026-07-16T01:00:30.000Z",
    });
    await harness.first.claimNext({
      workerId: "worker-a",
      now: "2026-07-16T01:01:00.000Z",
      leaseExpiresAt: "2026-07-16T01:11:00.000Z",
    });
    await harness.first.markFailed({
      jobId: "transcription-1",
      workerId: "worker-a",
      errorCode: "MEETING_TRANSCRIPTION_PROVIDER_CHANGED",
      errorMessage: "provider changed",
      now: "2026-07-16T01:02:00.000Z",
    });

    assert.deepEqual(
      await harness.first.requeueRetryableFailed(
        "2026-07-16T01:03:00.000Z",
        "2026-07-16T01:02:00.000Z"
      ),
      []
    );
    const retried = await harness.first.retry({
      jobId: "transcription-1",
      ownerId: "owner-1",
      provider: "azure-speech",
      model: "fast-transcription-2025-10-15",
      now: "2026-07-16T01:04:00.000Z",
      providerChangedAfter: "2026-07-09T01:04:00.000Z",
    });

    assert.equal(retried?.status, "pending");
    assert.equal(retried?.provider, "azure-speech");
    assert.equal(retried?.model, "fast-transcription-2025-10-15");
    assert.equal(retried?.attemptCount, 0);
    assert.equal(
      await harness.first.getChunkCheckpoint(
        "transcription-1",
        "room-mic",
        0,
        "old-provider-sha"
      ),
      null
    );
  } finally {
    await harness.close();
  }
});

test("provider migration 只在 grace 內保護來源音訊，逾期後不可重送", async () => {
  const harness = await createHarness();
  try {
    await enqueue(harness.first, { maxAttempts: 1 });
    await harness.first.claimNext({
      workerId: "worker-a",
      now: "2026-07-16T01:01:00.000Z",
      leaseExpiresAt: "2026-07-16T01:11:00.000Z",
    });
    await harness.first.markFailed({
      jobId: "transcription-1",
      workerId: "worker-a",
      errorCode: "MEETING_TRANSCRIPTION_PROVIDER_CHANGED",
      errorMessage: "provider changed",
      now: "2026-07-16T01:02:00.000Z",
    });

    const providerContext = {
      provider: "azure-speech",
      model: "fast-transcription-2025-10-15",
      providerChangedAfter: "2026-07-15T01:02:00.000Z",
    };
    assert.deepEqual(
      await harness.first.listActiveSessionIds(providerContext),
      ["session-1"]
    );

    assert.deepEqual(
      await harness.first.expireProviderMigrationFailures({
        provider: providerContext.provider,
        model: providerContext.model,
        now: "2026-07-24T01:02:00.000Z",
        retryBefore: "2026-07-17T01:02:00.000Z",
      }),
      ["transcription-1"]
    );
    assert.deepEqual(await harness.first.listActiveSessionIds(providerContext), []);
    assert.equal(
      (await harness.first.getJob("transcription-1"))?.errorCode,
      "MEETING_TRANSCRIPTION_PROVIDER_MIGRATION_EXPIRED"
    );
    assert.equal(
      await harness.first.retry({
        jobId: "transcription-1",
        ownerId: "owner-1",
        provider: providerContext.provider,
        model: providerContext.model,
        now: "2026-07-24T01:03:00.000Z",
        providerChangedAfter: "2026-07-17T01:03:00.000Z",
      }),
      null
    );
  } finally {
    await harness.close();
  }
});

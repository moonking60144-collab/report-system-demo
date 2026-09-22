import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MeetingTranscriptionService } from "../../../src/services/meeting-minutes/meetingTranscriptionService";
import type { MeetingTranscriptProcessorLike } from "../../../src/services/meeting-minutes/meetingTranscriptProcessor";
import type { MeetingProcessingJobRecord } from "../../../src/storage/meeting-minutes/meetingProcessingJobRepository";
import { MeetingTranscriptionJobRepository } from "../../../src/storage/meeting-minutes/meetingTranscriptionJobRepository";

const processingJob: MeetingProcessingJobRecord = {
  jobId: "processing-1",
  sessionId: "session-1",
  ownerId: "owner-1",
  status: "ready",
  phase: "ready",
  attemptCount: 1,
  maxAttempts: 3,
  errorCode: null,
  errorMessage: null,
  createdAt: "2026-07-16T01:00:00.000Z",
  startedAt: "2026-07-16T01:01:00.000Z",
  updatedAt: "2026-07-16T01:02:00.000Z",
  completedAt: "2026-07-16T01:02:00.000Z",
  artifacts: [
    {
      artifactId: "canonical-1",
      jobId: "processing-1",
      sessionId: "session-1",
      type: "canonical-room-mic",
      mimeType: "audio/wav",
      relativePath: "session-1/room-mic.wav",
      sizeBytes: 100,
      sha256: "audio-sha",
      createdAt: "2026-07-16T01:02:00.000Z",
    },
  ],
};

async function createHarness(options: {
  processor?: MeetingTranscriptProcessorLike;
  now?: () => Date;
  providerMigrationRetryGraceMs?: number;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "meeting-transcription-service-"));
  const repository = new MeetingTranscriptionJobRepository(path.join(root, "metadata.sqlite3"));
  const canonicalPath = path.join(root, "room-mic.wav");
  await writeFile(canonicalPath, Buffer.from("audio"));
  const processor: MeetingTranscriptProcessorLike = options.processor ?? {
    enabled: true,
    providerName: "fake",
    model: "fake-model",
    async process(input, onPhase) {
      await onPhase("transcribing-room-mic");
      return [
        {
          artifactId: "transcript-artifact",
          jobId: input.jobId,
          sessionId: input.sessionId,
          type: "transcript-merged-json",
          mimeType: "application/json",
          relativePath: "session-1/transcript/merged.json",
          sizeBytes: 200,
          sha256: "transcript-sha",
          createdAt: "2026-07-16T01:04:00.000Z",
        },
      ];
    },
    resolveArtifactPath: (relativePath) => path.join(root, relativePath),
  };
  let nowMs = Date.parse("2026-07-16T01:03:00.000Z");
  const service = new MeetingTranscriptionService({
    repository,
    processingRepository: {
      getJob: async (jobId: string) => (jobId === processingJob.jobId ? processingJob : null),
    } as never,
    processingService: {
      initialize: async () => undefined,
      getJobForSession: async (sessionId: string, ownerId: string) =>
        sessionId === processingJob.sessionId && ownerId === processingJob.ownerId
          ? processingJob
          : null,
      resolveArtifact: async () => ({
        filePath: canonicalPath,
        mimeType: "audio/wav",
        sizeBytes: 100,
      }),
    } as never,
    transcriptProcessor: processor,
    idFactory: () => "transcription-1",
    now: options.now ?? (() => new Date(nowMs++)),
    providerMigrationRetryGraceMs: options.providerMigrationRetryGraceMs,
    workerEnabled: true,
  });
  await service.initialize();
  return {
    repository,
    service,
    async close() {
      await service.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("processing ready 後 enqueue 冪等，worker success 不改變 audio ready", async () => {
  const harness = await createHarness();
  try {
    const accepted = await harness.service.enqueue("session-1", "owner-1");
    const duplicate = await harness.service.enqueue("session-1", "owner-1");
    assert.equal(accepted.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.job.jobId, accepted.job.jobId);

    const claimed = await harness.repository.claimNext({
      workerId: "worker-1",
      now: "2026-07-16T01:05:00.000Z",
      leaseExpiresAt: "2026-07-16T01:15:00.000Z",
    });
    assert.ok(claimed);
    const ready = await harness.service.processClaimedJob(claimed, "worker-1");
    assert.equal(ready.status, "ready");
    assert.equal(ready.artifacts[0]?.type, "transcript-merged-json");
    assert.equal(processingJob.status, "ready");
  } finally {
    await harness.close();
  }
});

test("transcription provider 失敗只標 transcript failed，playback processing 保持 ready", async () => {
  const harness = await createHarness({
    processor: {
      enabled: true,
      providerName: "fake",
      model: "fake-model",
      async process() {
        throw Object.assign(new Error("provider timeout"), {
          code: "MEETING_TRANSCRIPTION_PROVIDER_TIMEOUT",
        });
      },
      resolveArtifactPath: (relativePath) => relativePath,
    },
  });
  try {
    await harness.service.enqueue("session-1", "owner-1");
    const claimed = await harness.repository.claimNext({
      workerId: "worker-1",
      now: "2026-07-16T01:05:00.000Z",
      leaseExpiresAt: "2026-07-16T01:15:00.000Z",
    });
    assert.ok(claimed);
    const failed = await harness.service.processClaimedJob(claimed, "worker-1");
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, "MEETING_TRANSCRIPTION_PROVIDER_TIMEOUT");
    assert.equal(processingJob.status, "ready");
  } finally {
    await harness.close();
  }
});

test("provider disabled 時拒絕 enqueue，但不需要修改既有 processing job", async () => {
  const harness = await createHarness({
    processor: {
      enabled: false,
      providerName: "disabled",
      model: "disabled",
      async process() {
        return [];
      },
      resolveArtifactPath: (relativePath) => relativePath,
    },
  });
  try {
    await assert.rejects(
      harness.service.enqueue("session-1", "owner-1"),
      (error: unknown) =>
        Boolean(
          error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "MEETING_TRANSCRIPTION_PROVIDER_DISABLED"
        )
    );
    await harness.repository.enqueue({
      jobId: "transcription-disabled",
      processingJobId: "processing-disabled",
      sessionId: "session-disabled",
      ownerId: "owner-1",
      provider: "google-gemini",
      model: "fake-model",
      maxAttempts: 3,
      now: "2026-07-16T00:00:00.000Z",
    });
    const claimed = await harness.repository.claimNext({
      workerId: "worker-1",
      now: "2026-07-16T00:00:01.000Z",
      leaseExpiresAt: "2026-07-16T00:10:01.000Z",
    });
    assert.ok(claimed);
    await harness.repository.markFailed({
      jobId: claimed.jobId,
      workerId: "worker-1",
      errorCode: "TRANSIENT_FAILURE",
      errorMessage: "temporary failure",
      now: "2026-07-16T00:00:02.000Z",
    });

    const recovered = await harness.service.recoverExpiredJobs();
    assert.equal(recovered.autoRetried, 0);
    assert.equal(
      (await harness.repository.getJob("transcription-disabled"))?.status,
      "failed"
    );
    assert.equal(processingJob.status, "ready");
  } finally {
    await harness.close();
  }
});

test("worker 不混跑舊 provider 任務，人工重送會升級到目前 provider", async () => {
  const harness = await createHarness();
  try {
    await harness.repository.enqueue({
      jobId: "transcription-old-provider",
      processingJobId: "processing-1",
      sessionId: "session-1",
      ownerId: "owner-1",
      provider: "google-gemini",
      model: "gemini-old",
      maxAttempts: 1,
      now: "2026-07-16T01:00:00.000Z",
    });
    const claimed = await harness.repository.claimNext({
      workerId: "worker-1",
      now: "2026-07-16T01:05:00.000Z",
      leaseExpiresAt: "2026-07-16T01:15:00.000Z",
    });
    assert.ok(claimed);

    const failed = await harness.service.processClaimedJob(claimed, "worker-1");
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, "MEETING_TRANSCRIPTION_PROVIDER_CHANGED");

    const retried = await harness.service.retry(claimed.jobId, "owner-1");
    assert.equal(retried.status, "pending");
    assert.equal(retried.provider, "fake");
    assert.equal(retried.model, "fake-model");
    assert.equal(retried.attemptCount, 0);
  } finally {
    await harness.close();
  }
});

test("過期 provider migration 會停止保護來源音訊並拒絕人工重送", async () => {
  let now = "2026-07-24T01:02:00.000Z";
  const harness = await createHarness({
    now: () => new Date(now),
    providerMigrationRetryGraceMs: 7 * 24 * 60 * 60 * 1000,
  });
  try {
    await harness.repository.enqueue({
      jobId: "transcription-old-provider",
      processingJobId: "processing-1",
      sessionId: "session-1",
      ownerId: "owner-1",
      provider: "google-gemini",
      model: "gemini-old",
      maxAttempts: 1,
      now: "2026-07-16T01:00:00.000Z",
    });
    await harness.repository.claimNext({
      workerId: "worker-1",
      now: "2026-07-16T01:01:00.000Z",
      leaseExpiresAt: "2026-07-16T01:11:00.000Z",
    });
    await harness.repository.markFailed({
      jobId: "transcription-old-provider",
      workerId: "worker-1",
      errorCode: "TRANSIENT_FAILURE",
      errorMessage: "temporary failure before provider migration",
      now: "2026-07-16T01:02:00.000Z",
    });

    const detected = await harness.service.recoverExpiredJobs();
    assert.equal(detected.providerMigrationsDetected, 1);
    assert.equal(detected.providerMigrationsExpired, 0);
    assert.deepEqual(await harness.service.listActiveSessionIds(), ["session-1"]);

    now = "2026-07-31T01:02:00.000Z";
    const expired = await harness.service.recoverExpiredJobs();
    assert.equal(expired.providerMigrationsDetected, 0);
    assert.equal(expired.providerMigrationsExpired, 1);
    assert.deepEqual(await harness.service.listActiveSessionIds(), []);
    await assert.rejects(
      harness.service.retry("transcription-old-provider", "owner-1"),
      (error: unknown) =>
        Boolean(
          error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "MEETING_TRANSCRIPTION_PROVIDER_MIGRATION_EXPIRED"
        )
    );
  } finally {
    await harness.close();
  }
});

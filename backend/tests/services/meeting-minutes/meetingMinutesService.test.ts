import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MeetingMinutesPackageService } from "../../../src/services/meeting-minutes/meetingMinutesPackageService";
import type { MeetingMinutesProviderLike } from "../../../src/services/meeting-minutes/meetingMinutesProvider";
import { MeetingMinutesService } from "../../../src/services/meeting-minutes/meetingMinutesService";
import type { MeetingRecord } from "../../../src/services/meeting-minutes/meetingMinutesSchema";
import { MeetingMinutesJobRepository } from "../../../src/storage/meeting-minutes/meetingMinutesJobRepository";
import type { MeetingProcessingJobRecord } from "../../../src/storage/meeting-minutes/meetingProcessingJobRepository";
import type {
  MeetingTranscriptionArtifactRecord,
  MeetingTranscriptionJobRecord,
} from "../../../src/storage/meeting-minutes/meetingTranscriptionJobRepository";

const aiRecord: MeetingRecord = {
  version: 1,
  title: "AI 標題",
  date: null,
  subtitle: "AI 摘要",
  attendees: [],
  executiveSummary: "AI 產生摘要",
  discussionPoints: [],
  confirmedFacts: [{ content: "不良率 5%", sourceBasis: "逐字稿" }],
  confirmedDecisions: [],
  systemRequirements: [],
  pendingItems: [],
  followUpActions: [],
  uncertainTerms: [],
};

async function createHarness(options: {
  providerEnabled?: boolean;
  failProvider?: boolean;
  providerErrorCode?: string;
  now?: () => Date;
  providerMigrationRetryGraceMs?: number;
  retryDelayMs?: number;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "meeting-minutes-service-"));
  const repository = new MeetingMinutesJobRepository(path.join(root, "metadata.sqlite3"));
  const mergedPath = path.join(root, "merged.json");
  const textPath = path.join(root, "transcript.txt");
  const playbackPath = path.join(root, "playback.m4a");
  await writeFile(
    mergedPath,
    JSON.stringify({
      version: 1,
      sessionId: "session-1",
      language: "zh-TW",
      provider: "fake-transcription",
      model: "fake-model",
      generatedAt: "2026-07-16T01:00:00.000Z",
      segments: [],
    })
  );
  await writeFile(textPath, "[00:00:00] 測試逐字稿\n");
  await writeFile(playbackPath, "audio");
  const transcriptionJob: MeetingTranscriptionJobRecord = {
    jobId: "transcription-1",
    processingJobId: "processing-1",
    sessionId: "session-1",
    ownerId: "owner-1",
    provider: "fake-transcription",
    model: "fake-model",
    status: "ready",
    phase: "ready",
    attemptCount: 1,
    maxAttempts: 3,
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-07-16T01:00:00.000Z",
    startedAt: "2026-07-16T01:00:00.000Z",
    updatedAt: "2026-07-16T01:00:00.000Z",
    completedAt: "2026-07-16T01:00:00.000Z",
    artifacts: [
      {
        artifactId: "merged",
        jobId: "transcription-1",
        sessionId: "session-1",
        type: "transcript-merged-json",
        mimeType: "application/json",
        relativePath: "merged.json",
        sizeBytes: 100,
        sha256: "merged-sha",
        createdAt: "2026-07-16T01:00:00.000Z",
      },
      {
        artifactId: "text",
        jobId: "transcription-1",
        sessionId: "session-1",
        type: "transcript-text",
        mimeType: "text/plain",
        relativePath: "transcript.txt",
        sizeBytes: 20,
        sha256: "text-sha",
        createdAt: "2026-07-16T01:00:00.000Z",
      },
    ],
  };
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
    startedAt: "2026-07-16T01:00:00.000Z",
    updatedAt: "2026-07-16T01:00:00.000Z",
    completedAt: "2026-07-16T01:00:00.000Z",
    artifacts: [
      {
        artifactId: "playback",
        jobId: "processing-1",
        sessionId: "session-1",
        type: "playback",
        mimeType: "audio/mp4",
        relativePath: "playback.m4a",
        sizeBytes: 5,
        sha256: "playback-sha",
        createdAt: "2026-07-16T01:00:00.000Z",
      },
    ],
  };
  const provider: MeetingMinutesProviderLike = {
    enabled: options.providerEnabled ?? true,
    name: "fake-minutes",
    model: "fake-model",
    async summarize() {
      if (options.failProvider) {
        throw Object.assign(new Error("provider failure"), {
          code: options.providerErrorCode ?? "MINUTES_TIMEOUT",
        });
      }
      return aiRecord;
    },
  };
  let id = 0;
  let nowMs = Date.parse("2026-07-16T02:00:00.000Z");
  const service = new MeetingMinutesService({
    repository,
    transcriptionService: {
      getJobForSession: async (sessionId: string, ownerId: string) =>
        sessionId === "session-1" && ownerId === "owner-1" ? transcriptionJob : null,
      getJob: async (jobId: string, ownerId: string) =>
        jobId === "transcription-1" && ownerId === "owner-1" ? transcriptionJob : null,
      resolveArtifact: async (artifact: MeetingTranscriptionArtifactRecord) => ({
        filePath: artifact.type === "transcript-merged-json" ? mergedPath : textPath,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
      }),
    } as never,
    processingService: {
      getJobForSession: async (sessionId: string, ownerId: string) =>
        sessionId === "session-1" && ownerId === "owner-1" ? processingJob : null,
      resolveArtifact: async () => ({
        filePath: playbackPath,
        mimeType: "audio/mp4",
        sizeBytes: 5,
      }),
    } as never,
    packageService: new MeetingMinutesPackageService({ processingDir: root }),
    provider,
    idFactory: () => `id-${++id}`,
    now: options.now ?? (() => new Date(nowMs++)),
    providerMigrationRetryGraceMs: options.providerMigrationRetryGraceMs,
    retryDelayMs: options.retryDelayMs,
    workerEnabled: true,
  });
  await service.initialize();
  return {
    root,
    repository,
    service,
    transcriptionJob,
    async close() {
      await service.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const humanInput = {
  title: "人工品管會議",
  date: "2026-07-16",
  attendees: "品管：王小明",
  confirmedFacts: "不良率 3%",
  confirmedDecisions: "下週開始抽驗",
  termCorrections: "",
  otherNotes: "",
};

test("ready transcript enqueue 冪等，worker 產生 version/package 且人工資料優先", async () => {
  const harness = await createHarness();
  try {
    const first = await harness.service.enqueue({
      sessionId: "session-1",
      ownerId: "owner-1",
      clientRequestKey: "request-1",
      humanInput,
    });
    const duplicate = await harness.service.enqueue({
      sessionId: "session-1",
      ownerId: "owner-1",
      clientRequestKey: "request-1",
      humanInput,
    });
    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    const claimed = await harness.repository.claimNext({
      workerId: "worker-1",
      now: "2026-07-16T02:01:00.000Z",
      leaseExpiresAt: "2026-07-16T02:11:00.000Z",
    });
    assert.ok(claimed);
    const ready = await harness.service.processClaimedJob(claimed, "worker-1");
    assert.equal(ready.status, "ready");
    assert.equal(ready.version?.record.title, "人工品管會議");
    assert.equal(ready.version?.record.confirmedFacts[0]?.content, "不良率 3%");
    assert.equal(ready.version?.record.confirmedDecisions[0]?.content, "下週開始抽驗");
    assert.equal(ready.version?.record.confirmedFacts.length, 1);
    assert.ok(ready.version?.artifacts.some((artifact) => artifact.type === "minutes-audio"));
    assert.equal(harness.transcriptionJob.status, "ready");
  } finally {
    await harness.close();
  }
});

test("provider failure 只標 minutes failed，transcription 保持 ready", async () => {
  const harness = await createHarness({ failProvider: true });
  try {
    await harness.service.enqueue({
      sessionId: "session-1",
      ownerId: "owner-1",
      clientRequestKey: "request-1",
      humanInput,
    });
    const claimed = await harness.repository.claimNext({
      workerId: "worker-1",
      now: "2026-07-16T02:01:00.000Z",
      leaseExpiresAt: "2026-07-16T02:11:00.000Z",
    });
    assert.ok(claimed);
    const failed = await harness.service.processClaimedJob(claimed, "worker-1");
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, "MINUTES_TIMEOUT");
    assert.equal(harness.transcriptionJob.status, "ready");
  } finally {
    await harness.close();
  }
});

test("永久 MiniMax 錯誤會耗盡嘗試次數且不自動重送", async () => {
  const harness = await createHarness({
    failProvider: true,
    providerErrorCode: "MEETING_MINUTES_MINIMAX_AUTH_FAILED",
    retryDelayMs: 0,
  });
  try {
    await harness.service.enqueue({
      sessionId: "session-1",
      ownerId: "owner-1",
      clientRequestKey: "request-permanent",
      humanInput,
    });
    const claimed = await harness.repository.claimNext({
      workerId: "worker-1",
      now: "2026-07-16T02:01:00.000Z",
      leaseExpiresAt: "2026-07-16T02:11:00.000Z",
    });
    assert.ok(claimed);

    const failed = await harness.service.processClaimedJob(claimed, "worker-1");
    assert.equal(failed.status, "failed");
    assert.equal(failed.attemptCount, failed.maxAttempts);
    assert.equal((await harness.service.recoverExpiredJobs()).autoRetried, 0);
  } finally {
    await harness.close();
  }
});

test("暫時性 MiniMax 錯誤保留自動重送能力", async () => {
  const harness = await createHarness({
    failProvider: true,
    providerErrorCode: "MEETING_MINUTES_MINIMAX_RATE_LIMITED",
    retryDelayMs: 0,
  });
  try {
    await harness.service.enqueue({
      sessionId: "session-1",
      ownerId: "owner-1",
      clientRequestKey: "request-transient",
      humanInput,
    });
    const claimed = await harness.repository.claimNext({
      workerId: "worker-1",
      now: "2026-07-16T02:01:00.000Z",
      leaseExpiresAt: "2026-07-16T02:11:00.000Z",
    });
    assert.ok(claimed);

    const failed = await harness.service.processClaimedJob(claimed, "worker-1");
    assert.equal(failed.status, "failed");
    assert.ok(failed.attemptCount < failed.maxAttempts);
    assert.equal((await harness.service.recoverExpiredJobs()).autoRetried, 1);
    assert.equal((await harness.repository.getJob(failed.jobId))?.status, "pending");
  } finally {
    await harness.close();
  }
});

test("minutes provider disabled 時拒絕 enqueue 且不建立 job", async () => {
  const harness = await createHarness({ providerEnabled: false });
  try {
    await assert.rejects(
      harness.service.enqueue({
        sessionId: "session-1",
        ownerId: "owner-1",
        clientRequestKey: "request-1",
        humanInput,
      }),
      (error: unknown) =>
        Boolean(error && typeof error === "object" && "code" in error && error.code === "MEETING_MINUTES_PROVIDER_DISABLED")
    );
    assert.equal(await harness.repository.getJob("id-1"), null);
  } finally {
    await harness.close();
  }
});

test("worker 不混跑舊 minutes provider 任務，人工重送會升級到目前 provider", async () => {
  const harness = await createHarness();
  try {
    await harness.repository.enqueue({
      jobId: "minutes-old-provider",
      transcriptionJobId: "transcription-1",
      sessionId: "session-1",
      ownerId: "owner-1",
      clientRequestKey: "request-old-provider",
      inputSha256: "input-old-provider",
      humanInput,
      provider: "google-gemini",
      model: "gemini-old",
      maxAttempts: 1,
      now: "2026-07-16T01:00:00.000Z",
    });
    const claimed = await harness.repository.claimNext({
      workerId: "worker-1",
      now: "2026-07-16T02:01:00.000Z",
      leaseExpiresAt: "2026-07-16T02:11:00.000Z",
    });
    assert.ok(claimed);

    const failed = await harness.service.processClaimedJob(claimed, "worker-1");
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, "MEETING_MINUTES_PROVIDER_CHANGED");

    const retried = await harness.service.retry(claimed.jobId, "owner-1");
    assert.equal(retried.status, "pending");
    assert.equal(retried.provider, "fake-minutes");
    assert.equal(retried.model, "fake-model");
    assert.equal(retried.attemptCount, 0);
  } finally {
    await harness.close();
  }
});

test("過期 minutes provider migration 會停止保護來源並拒絕人工重送", async () => {
  let now = "2026-07-24T01:02:00.000Z";
  const harness = await createHarness({
    now: () => new Date(now),
    providerMigrationRetryGraceMs: 7 * 24 * 60 * 60 * 1000,
  });
  try {
    await harness.repository.enqueue({
      jobId: "minutes-old-provider",
      transcriptionJobId: "transcription-1",
      sessionId: "session-1",
      ownerId: "owner-1",
      clientRequestKey: "request-old-provider",
      inputSha256: "input-old-provider",
      humanInput,
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
      jobId: "minutes-old-provider",
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
      harness.service.retry("minutes-old-provider", "owner-1"),
      (error: unknown) =>
        Boolean(
          error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "MEETING_MINUTES_PROVIDER_MIGRATION_EXPIRED"
        )
    );
  } finally {
    await harness.close();
  }
});

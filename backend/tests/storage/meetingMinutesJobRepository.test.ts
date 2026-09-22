import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MeetingMinutesJobRepository,
  type MeetingMinutesArtifactRecord,
} from "../../src/storage/meeting-minutes/meetingMinutesJobRepository";
import type { MeetingRecord } from "../../src/services/meeting-minutes/meetingMinutesSchema";

const humanInput = {
  title: "品管會議",
  date: "2026-07-16",
  attendees: "品管：王小明",
  confirmedFacts: "不良率 3%",
  confirmedDecisions: "下週開始抽驗",
  termCorrections: "螺冒=>螺帽",
  otherNotes: "",
};

const record: MeetingRecord = {
  version: 1,
  title: "品管會議",
  subtitle: "測試摘要",
  date: "2026-07-16",
  attendees: [{ department: "品管", names: ["王小明"] }],
  executiveSummary: "本次確認抽驗方式。",
  discussionPoints: [],
  confirmedFacts: [{ content: "不良率 3%", sourceBasis: "人工確認" }],
  confirmedDecisions: [{ content: "下週開始抽驗", sourceBasis: "人工確認" }],
  systemRequirements: [],
  pendingItems: [],
  followUpActions: [],
  uncertainTerms: [],
};

async function createHarness() {
  const root = await mkdtemp(path.join(tmpdir(), "meeting-minutes-repository-"));
  const dbFile = path.join(root, "metadata.sqlite3");
  const first = new MeetingMinutesJobRepository(dbFile);
  const second = new MeetingMinutesJobRepository(dbFile);
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

async function enqueue(
  repository: MeetingMinutesJobRepository,
  overrides: Partial<Parameters<MeetingMinutesJobRepository["enqueue"]>[0]> = {}
) {
  return repository.enqueue({
    jobId: "minutes-1",
    transcriptionJobId: "transcription-1",
    sessionId: "session-1",
    ownerId: "owner-1",
    clientRequestKey: "request-1",
    inputSha256: "input-sha-1",
    humanInput,
    provider: "fake",
    model: "fake-model",
    maxAttempts: 3,
    now: "2026-07-16T01:00:00.000Z",
    ...overrides,
  });
}

test("minutes enqueue 依 owner/request key 冪等且拒絕 payload 漂移", async () => {
  const harness = await createHarness();
  try {
    const first = await enqueue(harness.first);
    const duplicate = await enqueue(harness.first, { jobId: "minutes-2" });
    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.job.jobId, "minutes-1");
    await assert.rejects(
      enqueue(harness.first, { jobId: "minutes-3", inputSha256: "changed" }),
      /payload mismatch/
    );
    assert.equal(await harness.first.getJobForOwner("minutes-1", "owner-2"), null);
  } finally {
    await harness.close();
  }
});

test("兩個 repository instance 只會 claim 同一筆 minutes job 一次", async () => {
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
  } finally {
    await harness.close();
  }
});

test("ready transaction 配發 session version 並保存 artifacts", async () => {
  const harness = await createHarness();
  try {
    await enqueue(harness.first);
    await harness.first.claimNext({
      workerId: "worker-a",
      now: "2026-07-16T01:01:00.000Z",
      leaseExpiresAt: "2026-07-16T01:11:00.000Z",
    });
    const version = await harness.first.reserveVersion({
      versionId: "version-1",
      jobId: "minutes-1",
      workerId: "worker-a",
      record,
      now: "2026-07-16T01:02:00.000Z",
    });
    assert.equal(version.versionNumber, 1);
    const artifact: MeetingMinutesArtifactRecord = {
      artifactId: "artifact-1",
      versionId: "version-1",
      jobId: "minutes-1",
      sessionId: "session-1",
      type: "minutes-html",
      filename: "index.html",
      mimeType: "text/html; charset=utf-8",
      relativePath: "session-1/minutes/v1/index.html",
      sizeBytes: 100,
      sha256: "artifact-sha",
      createdAt: "2026-07-16T01:03:00.000Z",
    };
    const ready = await harness.first.markReady({
      jobId: "minutes-1",
      workerId: "worker-a",
      versionId: "version-1",
      packageRelativePath: "session-1/minutes/v1",
      artifacts: [artifact],
      now: "2026-07-16T01:03:00.000Z",
    });
    assert.equal(ready.status, "ready");
    assert.equal(ready.version?.versionNumber, 1);
    assert.deepEqual(ready.version?.artifacts, [artifact]);

    await enqueue(harness.first, {
      jobId: "minutes-2",
      clientRequestKey: "request-2",
      inputSha256: "input-sha-2",
      now: "2026-07-16T01:04:00.000Z",
    });
    await harness.first.claimNext({
      workerId: "worker-b",
      now: "2026-07-16T01:05:00.000Z",
      leaseExpiresAt: "2026-07-16T01:15:00.000Z",
    });
    const secondVersion = await harness.first.reserveVersion({
      versionId: "version-2",
      jobId: "minutes-2",
      workerId: "worker-b",
      record,
      now: "2026-07-16T01:06:00.000Z",
    });
    assert.equal(secondVersion.versionNumber, 2);
  } finally {
    await harness.close();
  }
});

test("failed job 可重送且 terminal transcription cleanup cascade versions", async () => {
  const harness = await createHarness();
  try {
    await enqueue(harness.first);
    await harness.first.claimNext({
      workerId: "worker-a",
      now: "2026-07-16T01:01:00.000Z",
      leaseExpiresAt: "2026-07-16T01:11:00.000Z",
    });
    await harness.first.markFailed({
      jobId: "minutes-1",
      workerId: "worker-a",
      errorCode: "TRANSIENT",
      errorMessage: "temporary",
      now: "2026-07-16T01:02:00.000Z",
    });
    assert.equal(
      (
        await harness.first.retry({
          jobId: "minutes-1",
          ownerId: "owner-1",
          provider: "fake",
          model: "fake-model",
          now: "2026-07-16T01:03:00.000Z",
          providerChangedAfter: "2026-07-09T01:03:00.000Z",
        })
      )?.status,
      "pending"
    );
    await harness.first.claimNext({
      workerId: "worker-b",
      now: "2026-07-16T01:04:00.000Z",
      leaseExpiresAt: "2026-07-16T01:14:00.000Z",
    });
    await harness.first.markFailed({
      jobId: "minutes-1",
      workerId: "worker-b",
      errorCode: "PERMANENT",
      errorMessage: "failed",
      now: "2026-07-16T01:05:00.000Z",
    });
    assert.deepEqual(
      await harness.first.deleteTerminalJobsByTranscriptionJobIds(["transcription-1"]),
      ["minutes-1"]
    );
    assert.equal(await harness.first.getJob("minutes-1"), null);
  } finally {
    await harness.close();
  }
});

test("provider 變更後可重送已耗盡的 minutes job 並重設嘗試次數", async () => {
  const harness = await createHarness();
  try {
    await enqueue(harness.first, { maxAttempts: 1 });
    await harness.first.claimNext({
      workerId: "worker-a",
      now: "2026-07-16T01:01:00.000Z",
      leaseExpiresAt: "2026-07-16T01:11:00.000Z",
    });
    await harness.first.markFailed({
      jobId: "minutes-1",
      workerId: "worker-a",
      errorCode: "MEETING_MINUTES_PROVIDER_CHANGED",
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
      jobId: "minutes-1",
      ownerId: "owner-1",
      provider: "minimax",
      model: "MiniMax-M3",
      now: "2026-07-16T01:04:00.000Z",
      providerChangedAfter: "2026-07-09T01:04:00.000Z",
    });

    assert.equal(retried?.status, "pending");
    assert.equal(retried?.provider, "minimax");
    assert.equal(retried?.model, "MiniMax-M3");
    assert.equal(retried?.attemptCount, 0);
  } finally {
    await harness.close();
  }
});

test("自動重送只接受明確暫時性 minutes error code", async () => {
  const harness = await createHarness();
  try {
    await enqueue(harness.first);
    await harness.first.claimNext({
      workerId: "worker-a",
      now: "2026-07-16T01:01:00.000Z",
      leaseExpiresAt: "2026-07-16T01:11:00.000Z",
    });
    await harness.first.markFailed({
      jobId: "minutes-1",
      workerId: "worker-a",
      errorCode: "MEETING_MINUTES_MINIMAX_AUTH_FAILED",
      errorMessage: "invalid key",
      retryable: true,
      now: "2026-07-16T01:02:00.000Z",
    });
    assert.deepEqual(
      await harness.first.requeueRetryableFailed(
        "2026-07-16T01:03:00.000Z",
        "2026-07-16T01:02:00.000Z"
      ),
      []
    );

    await enqueue(harness.first, {
      jobId: "minutes-2",
      transcriptionJobId: "transcription-2",
      sessionId: "session-2",
      clientRequestKey: "request-2",
      inputSha256: "input-sha-2",
      now: "2026-07-16T01:04:00.000Z",
    });
    await harness.first.claimNext({
      workerId: "worker-b",
      now: "2026-07-16T01:05:00.000Z",
      leaseExpiresAt: "2026-07-16T01:15:00.000Z",
    });
    await harness.first.markFailed({
      jobId: "minutes-2",
      workerId: "worker-b",
      errorCode: "MEETING_MINUTES_MINIMAX_TIMEOUT",
      errorMessage: "timeout",
      retryable: true,
      now: "2026-07-16T01:06:00.000Z",
    });
    assert.deepEqual(
      await harness.first.requeueRetryableFailed(
        "2026-07-16T01:07:00.000Z",
        "2026-07-16T01:06:00.000Z"
      ),
      ["minutes-2"]
    );
  } finally {
    await harness.close();
  }
});

test("minutes provider migration 只在 grace 內保護來源，逾期後不可重送", async () => {
  const harness = await createHarness();
  try {
    await enqueue(harness.first, { maxAttempts: 1 });
    await harness.first.claimNext({
      workerId: "worker-a",
      now: "2026-07-16T01:01:00.000Z",
      leaseExpiresAt: "2026-07-16T01:11:00.000Z",
    });
    await harness.first.markFailed({
      jobId: "minutes-1",
      workerId: "worker-a",
      errorCode: "MEETING_MINUTES_PROVIDER_CHANGED",
      errorMessage: "provider changed",
      now: "2026-07-16T01:02:00.000Z",
    });

    const providerContext = {
      provider: "minimax",
      model: "MiniMax-M3",
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
      ["minutes-1"]
    );
    assert.deepEqual(await harness.first.listActiveSessionIds(providerContext), []);
    assert.equal(
      (await harness.first.getJob("minutes-1"))?.errorCode,
      "MEETING_MINUTES_PROVIDER_MIGRATION_EXPIRED"
    );
    assert.equal(
      await harness.first.retry({
        jobId: "minutes-1",
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

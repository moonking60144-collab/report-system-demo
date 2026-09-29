import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { env } from "../../src/config/env";
import { HttpError } from "../../src/utils/httpError";
import { MeetingOneShotRepository } from "../../src/storage/meeting-minutes/meetingOneShotRepository";
import { MeetingProcessingJobRepository } from "../../src/storage/meeting-minutes/meetingProcessingJobRepository";
import { MeetingSummaryArchiveRepository } from "../../src/storage/meeting-minutes/meetingSummaryArchiveRepository";
import { MeetingTranscriptionJobRepository } from "../../src/storage/meeting-minutes/meetingTranscriptionJobRepository";
import { MeetingMinutesJobRepository } from "../../src/storage/meeting-minutes/meetingMinutesJobRepository";
import { MeetingLiveTranscriptionRepository } from "../../src/storage/meeting-minutes/meetingLiveTranscriptionRepository";

test("worker 就緒心跳跨連線可讀，過期、provider 不符及停止後均不可承接新錄音", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "meeting-worker-ready-"));
  const filename = path.join(directory,"metadata.sqlite3");
  const worker = new MeetingOneShotRepository(filename);
  const api = new MeetingOneShotRepository(filename);
  try {
    assert.equal(await api.workerReady("profile", "2026-09-17T00:00:00Z"),false);
    await worker.heartbeatWorker("worker", "profile", "2026-09-17T00:00:00Z", "2026-09-17T00:00:15Z");
    assert.equal(await api.workerReady("profile", "2026-09-17T00:00:01Z"),true);
    assert.equal(await api.workerReady("other", "2026-09-17T00:00:01Z"),false);
    assert.equal(await api.workerReady("profile", "2026-09-17T00:00:15Z"),false);
    await worker.releaseWorker("worker");
    assert.equal(await api.workerReady("profile", "2026-09-17T00:00:01Z"),false);
  } finally { await api.close(); await worker.close(); await rm(directory,{recursive:true,force:true}); }
});

test("live queue 依音源輪流承接，較小相對位置不會連續插隊，舊積壓也不會獨占", async () => {
  const repository = new MeetingLiveTranscriptionRepository(":memory:");
  const chunk = (sessionId:string,chunkIndex:number) => ({sessionId,sourceId:"room-mic" as const,chunkIndex,profile:"p",audioHash:"h",audioPath:"test.wav",startMs:chunkIndex*60000,endMs:(chunkIndex+1)*60000,windowStartMs:chunkIndex*60000,windowEndMs:(chunkIndex+1)*60000});
  try {
    await repository.register(chunk("old",20)); await repository.register(chunk("old",21));
    await repository.register(chunk("new",0)); await repository.register(chunk("new",1));
    const claimed: string[]=[];
    for(let index=0;index<4;index++) {
      const result=await repository.claim("p",`l${index}`,index+1,1000);
      assert.ok(result); claimed.push(`${result.sessionId}:${result.chunkIndex}`);
      await repository.finish(`l${index}`,[]);
    }
    assert.deepEqual(claimed,["old:20","new:0","old:21","new:1"],"FAIR_SOURCE_ROTATION");
  } finally { await repository.close(); }
});

test("舊 one-shot 資料表升級保留會議，API 與 worker 同時開啟可接續讀取", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "meeting-extra-migration-"));
  const filename = path.join(directory, "meeting.sqlite3");
  const db = await open({ filename, driver: sqlite3.Database });
  await db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE meeting_one_shot_sessions (
    session_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL,
    expires_at TEXT, cleanup_started_at TEXT, cleaned_at TEXT, error_code TEXT, error_message TEXT,
    cancelled_at TEXT, next_check_at TEXT NOT NULL
  ); INSERT INTO meeting_one_shot_sessions (session_id, owner_id, title, created_at, next_check_at)
    VALUES ('old', 'owner', '既有會議', '2026-09-10', '2026-09-10');
    INSERT INTO meeting_one_shot_sessions (session_id, owner_id, title, created_at, expires_at, next_check_at)
    VALUES ('ready', 'ready-owner', '既有完成會議', '2026-09-10T00:00:00.000Z', '2026-09-12T00:00:00.000Z', '2026-09-10');
    INSERT INTO meeting_one_shot_sessions (session_id, owner_id, title, created_at, cancelled_at, next_check_at)
    VALUES ('cancelled', 'cancelled-owner', '既有取消會議', '2026-09-10T00:00:00.000Z', '2026-09-10T01:00:00.000Z', '2026-09-10');`);
  await db.close();
  const api = new MeetingOneShotRepository(filename);
  const worker = new MeetingOneShotRepository(filename);
  try {
    const [first, second] = await Promise.all([api.get("old"), worker.get("old")]);
    assert.equal(first?.title, "既有會議");
    assert.equal(first?.additionalSectionRequest, "", "LEGACY_REQUEST_DEFAULT");
    assert.deepEqual(first, second);
    assert.equal((await api.get("ready"))?.pipelineReleasedAt,
      new Date(Date.parse("2026-09-12T00:00:00.000Z") - env.MEETING_ONE_SHOT_DELIVERY_MS).toISOString());
    const cancelled = await api.get("cancelled");
    assert.equal(cancelled?.cleanupAfter, "2026-09-10T01:00:00.000Z", "既有取消資料升級後可進入 cleanup");
    assert.equal(cancelled?.pipelineReleasedAt, "2026-09-10T01:00:00.000Z");
    assert.equal(cancelled?.deviceSessionReleasedAt, "2026-09-10T01:00:00.000Z");
    await api.register({ sessionId: "new", ownerId: "owner", title: "新會議", createdAt: "2026-09-10", additionalSectionRequest: "風險分析" });
    await api.close();
    assert.equal((await worker.get("new"))?.additionalSectionRequest, "風險分析", "WORKER_SEES_SAVED_REQUEST");
    assert.equal((await api.get("new"))?.additionalSectionRequest, "風險分析");
  } finally {
    await api.close();
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("瀏覽器不限量且 SQLite transaction 最多只承接兩場會議", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "meeting-admission-"));
  const filename = path.join(directory, "meeting.sqlite3");
  const api = new MeetingOneShotRepository(filename);
  const secondProcess = new MeetingOneShotRepository(filename);
  const thirdProcess = new MeetingOneShotRepository(filename);
  const now = "2026-09-14T00:00:00.000Z";
  const input = (sessionId: string, ownerId: string, recorderId: string) => ({
    sessionId, ownerId, recorderId, title: sessionId, createdAt: now, maxPipelines: 2,
    metadata: { userAgent: `browser-${ownerId}`, ip: "127.0.0.1" },
  });
  try {
    const attempts = await Promise.allSettled([
      api.registerForOwner(input("session-a", "owner-a", "tab-a")),
      secondProcess.registerForOwner(input("session-b", "owner-b", "tab-b")),
      thirdProcess.registerForOwner(input("session-c", "owner-c", "tab-c")),
    ]);
    assert.equal(attempts.filter(result => result.status === "fulfilled").length, 2);
    const rejected = attempts.find(result => result.status === "rejected");
    assert.ok(rejected?.status === "rejected");
    assert.equal(rejected.reason.code, "MEETING_PIPELINE_CAPACITY_FULL");
    assert.match(rejected.reason.message, /目前已有 2 場會議進行中/);

    const active = await api.listActivePipelines();
    assert.equal(active.length, 2);
    const first = active[0]!;
    const reused = await api.registerForOwner(input("duplicate", first.ownerId, "observer-tab"));
    assert.equal(reused.created, false);
    assert.equal(reused.session.sessionId, first.sessionId);

    await api.releaseTerminalFailure(first.sessionId, now);
    await api.releaseCurrent(first.sessionId, first.ownerId, now, true);
    for (let index = 0; index < 12; index += 1) {
      const sessionId = `unlimited-${index}`;
      const ownerId = `browser-owner-${index}`;
      const admitted = await api.registerForOwner(input(sessionId, ownerId, `tab-${index}`));
      assert.equal(admitted.created, true);
      assert.equal(admitted.session.sourceName, `會議來源 ${index + 3}`);
      await api.releaseTerminalFailure(sessionId, now);
      await api.releaseCurrent(sessionId, ownerId, now, true);
    }
    assert.deepEqual(await api.admissionStats(2, now), { activeMeetings: 1, maxMeetings: 2 });

    const legacyDb = await open({ filename, driver: sqlite3.Database });
    try {
      await legacyDb.run(`INSERT INTO meeting_recording_devices
        (owner_id, slot_number, display_name, status, registered_at, last_seen_at, revoked_at)
        VALUES ('legacy-revoked', 99, '舊瀏覽器', 'revoked', ?, ?, ?)`, now, now, now);
    } finally { await legacyDb.close(); }
    const legacy = await api.registerForOwner(input("legacy-new", "legacy-revoked", "legacy-tab"));
    assert.equal(legacy.created, true, "舊 revoked metadata 不阻擋新會議");
    assert.equal(legacy.session.sourceName, "舊瀏覽器");
    const current = await api.currentForOwnerContext("legacy-revoked", now, "legacy-adopted");
    assert.equal(current?.session.sessionId, "legacy-new");
    assert.equal(current?.session.recorderId, "legacy-tab", "非 legacy recorder 不被觀察者接管");
  } finally {
    await api.close();
    await secondProcess.close();
    await thirdProcess.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("recorder lease 到期會釋放名額，續租時必須重新競爭 admission", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "meeting-recorder-lease-"));
  const filename = path.join(directory, "meeting.sqlite3");
  const sessions = new MeetingOneShotRepository(filename);
  const startedAt = "2026-09-16T00:00:00.000Z";
  const expiredAt = "2026-09-16T00:02:00.000Z";
  const leaseUntil = "2026-09-16T00:01:30.000Z";
  const register = (sessionId: string, ownerId: string, recorderId: string, createdAt = startedAt) =>
    sessions.registerForOwner({
      sessionId,
      ownerId,
      recorderId,
      title: sessionId,
      createdAt,
      recorderLeaseUntil: new Date(Date.parse(createdAt) + 90_000).toISOString(),
      maxPipelines: 2,
    });
  try {
    await register("session-a", "owner-a", "tab-a");
    await register("session-b", "owner-b", "tab-b");
    assert.deepEqual(await sessions.admissionStats(2, startedAt), { activeMeetings: 2, maxMeetings: 2 });
    assert.deepEqual(await sessions.admissionStats(2, expiredAt), { activeMeetings: 0, maxMeetings: 2 },
      "EXPIRED_RECORDER_LEASES_DO_NOT_OCCUPY_CAPACITY");

    await sessions.renewRecorderLease({
      sessionId: "session-a", ownerId: "owner-a", recorderId: "tab-a",
      now: expiredAt, leaseUntil: "2026-09-16T00:03:30.000Z", maxPipelines: 2,
    });
    await register("session-c", "owner-c", "tab-c", expiredAt);
    assert.deepEqual(await sessions.admissionStats(2, expiredAt), { activeMeetings: 2, maxMeetings: 2 });
    await assert.rejects(
      sessions.renewRecorderLease({
        sessionId: "session-b", ownerId: "owner-b", recorderId: "tab-b",
        now: expiredAt, leaseUntil, maxPipelines: 2,
      }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "MEETING_PIPELINE_CAPACITY_FULL"
    );
  } finally {
    await sessions.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("離開中斷會議與 recorder 恢復在同一交易重新判斷，不會釋放已恢復的名額", async () => {
  const sessions = new MeetingOneShotRepository(":memory:");
  const now = "2026-09-16T00:02:00.000Z";
  try {
    await sessions.registerForOwner({ sessionId: "resumed", ownerId: "owner", recorderId: "tab", title: "resumed",
      createdAt: "2026-09-16T00:00:00.000Z", maxPipelines: 2 });
    await sessions.renewRecorderLease({ sessionId: "resumed", ownerId: "owner", recorderId: "tab", now,
      leaseUntil: "2026-09-16T00:03:30.000Z", maxPipelines: 2 });
    await assert.rejects(sessions.releaseCurrent("resumed", "owner", now, true),
      (error: unknown) => error instanceof HttpError && error.code === "MEETING_ONE_SHOT_STILL_ACTIVE");
    assert.equal((await sessions.get("resumed"))?.pipelineReleasedAt, null);
    assert.equal((await sessions.admissionStats(2, now)).activeMeetings, 1);

    await sessions.releaseCurrent("resumed", "owner", "2026-09-16T00:04:00.000Z", true);
    await assert.rejects(sessions.renewRecorderLease({ sessionId: "resumed", ownerId: "owner", recorderId: "tab",
      now: "2026-09-16T00:04:00.000Z", leaseUntil: "2026-09-16T00:05:30.000Z", maxPipelines: 2 }),
      (error: unknown) => error instanceof HttpError && error.code === "MEETING_RECORDING_NOT_ACTIVE");
  } finally { await sessions.close(); }
});

test("API finalize operation 在長時間收尾及取消收斂前持有名額，過期完成也不能超收", async () => {
  const sessions = new MeetingOneShotRepository(":memory:");
  const now = "2026-09-16T00:02:00.000Z";
  const register = (sessionId: string, createdAt: string) => sessions.registerForOwner({ sessionId,
    ownerId: sessionId, recorderId: "tab", title: sessionId, createdAt, maxPipelines: 2 });
  try {
    await register("finalizing", "2026-09-16T00:00:00.000Z");
    const lease = await sessions.acquireFinalizationLease("finalizing", "finalizing", "tab",
      "2026-09-16T00:00:30.000Z", "2026-09-16T00:03:00.000Z", 2);
    await register("second", now);
    await assert.rejects(register("third", now), (error: unknown) => error instanceof HttpError && error.code === "MEETING_PIPELINE_CAPACITY_FULL");
    await sessions.requestCancellation("finalizing", now);
    assert.equal(await sessions.completeCancellationIfIdle("finalizing", now), false, "API_FINALIZE_MUST_SETTLE_BEFORE_CANCEL_RELEASE");
    await sessions.releaseFinalizationLease(lease);
    assert.equal(await sessions.completeCancellationIfIdle("finalizing", now), true);

    await register("expired-finalize", "2026-09-16T00:00:00.000Z");
    const expiredLease = await sessions.acquireFinalizationLease("expired-finalize", "expired-finalize", "tab",
      "2026-09-16T00:00:30.000Z", "2026-09-16T00:01:30.000Z", 2);
    await register("third", now);
    await assert.rejects(sessions.renewFinalizationLease(expiredLease, "2026-09-16T00:04:00.000Z", now),
      (error: unknown) => error instanceof HttpError && error.code === "MEETING_FINALIZATION_LEASE_EXPIRED");
    await assert.rejects(sessions.markRecordingFinalized("expired-finalize", "expired-finalize", now, 2),
      (error: unknown) => error instanceof HttpError && error.code === "MEETING_PIPELINE_CAPACITY_FULL");
    assert.equal((await sessions.get("expired-finalize"))?.recordingFinalizedAt, null);
    assert.equal((await sessions.admissionStats(2, now)).activeMeetings, 2);
  } finally { await sessions.close(); }
});

test("recorder 到期後 LIVE pending、有效 inference 及 decoder lease 仍占名額，停止後才釋放", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "meeting-live-admission-"));
  const filename = path.join(directory, "meeting.sqlite3");
  const sessions = new MeetingOneShotRepository(filename);
  const live = new MeetingLiveTranscriptionRepository(filename);
  const now = "2026-09-16T00:02:00.000Z";
  try {
    await sessions.registerForOwner({ sessionId: "live", ownerId: "owner", recorderId: "tab", title: "live",
      createdAt: "2026-09-16T00:00:00.000Z", maxPipelines: 2 });
    assert.equal(await live.renewDecoderLease("live", "room-mic", "p", "decoder", Date.parse("2026-09-16T00:01:00.000Z"), 120_000), true);
    assert.equal((await sessions.admissionStats(2, now)).activeMeetings, 1, "FFMPEG_LEASE_MUST_COUNT");
    await live.releaseDecoderLease("decoder");
    await live.register({ sessionId: "live", sourceId: "room-mic", chunkIndex: 0, profile: "p", audioHash: "hash",
      audioPath: "test.wav", startMs: 0, endMs: 60000, windowStartMs: 0, windowEndMs: 62000 });
    assert.equal((await sessions.admissionStats(2, now)).activeMeetings, 1, "PENDING_LIVE_ASR_MUST_COUNT");
    assert.ok(await live.claim("p", "inference", Date.parse(now), 120_000));
    await assert.rejects(sessions.releaseCurrent("live", "owner", now, true),
      (error: unknown) => error instanceof HttpError && error.code === "MEETING_ONE_SHOT_STILL_ACTIVE");
    assert.equal((await sessions.executionSessionIds(now)).live.has("live"), true);
    await live.finish("inference", []);
    assert.equal((await sessions.admissionStats(2, now)).activeMeetings, 0);
    assert.equal(await live.renewDecoderLease("live", "room-mic", "p", "late-decoder", Date.parse(now), 120_000), false,
      "EXPIRED_RECORDER_CANNOT_START_ANOTHER_DECODER");
  } finally { await sessions.close(); await live.close(); await rm(directory, { recursive: true, force: true }); }
});

test("可重領的 LIVE 工作到期後仍保留名額，恢復不會突破兩場上限", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "meeting-live-recovery-admission-"));
  const filename = path.join(directory, "meeting.sqlite3");
  const sessions = new MeetingOneShotRepository(filename);
  const live = new MeetingLiveTranscriptionRepository(filename);
  const startedAt = "2026-09-16T00:00:00.000Z";
  const later = "2026-09-16T00:03:00.000Z";
  const register = (sessionId: string, now: string) => sessions.registerForOwner({
    sessionId, ownerId: sessionId, recorderId: sessionId, title: sessionId,
    createdAt: now, maxPipelines: 2,
  });
  try {
    await register("old", startedAt);
    await live.register({ sessionId: "old", sourceId: "room-mic", chunkIndex: 0, profile: "p", audioHash: "hash",
      audioPath: "test.wav", startMs: 0, endMs: 60000, windowStartMs: 0, windowEndMs: 62000 });
    await live.claim("p", "crashed", Date.parse(startedAt), 120_000);
    assert.equal((await sessions.executionSessionIds(later)).live.has("old"), true,
      "RECOVERABLE_WORK_MUST_REMAIN_VISIBLE_AS_EXECUTING");
    await register("new-a", later);
    await assert.rejects(register("new-b", later),
      (error: unknown) => error instanceof HttpError && error.code === "MEETING_PIPELINE_CAPACITY_FULL",
      "RECLAIMABLE_LIVE_WORK_RESERVES_CAPACITY_BEFORE_RECOVERY");
    await live.retireOtherProfiles("p", Date.parse(later));
    assert.equal((await live.claim("p", "recovered", Date.parse(later), 120_000))?.sessionId, "old");
    assert.equal((await sessions.admissionStats(2, later)).activeMeetings, 2);
    await live.finish("recovered", []);
    await register("new-b", later);
    assert.equal((await sessions.admissionStats(2, later)).activeMeetings, 2);
  } finally { await sessions.close(); await live.close(); await rm(directory, { recursive: true, force: true }); }
});

test("finalized 錄音與可恢復背景工作在 recorder lease 到期後仍占名額", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "meeting-finalized-admission-"));
  const filename = path.join(directory, "meeting.sqlite3");
  const sessions = new MeetingOneShotRepository(filename);
  const jobs = new MeetingProcessingJobRepository(filename);
  const startedAt = "2026-09-16T00:00:00.000Z";
  const later = "2026-09-16T01:00:00.000Z";
  try {
    await jobs.initialize();
    await sessions.registerForOwner({
      sessionId: "finalized", ownerId: "owner-a", recorderId: "tab-a",
      title: "finalized", createdAt: startedAt, recorderLeaseUntil: "2026-09-16T00:01:30.000Z", maxPipelines: 2,
    });
    await sessions.markRecordingFinalized("finalized", "owner-a", "2026-09-16T00:00:30.000Z");
    assert.deepEqual(await sessions.admissionStats(2, later), { activeMeetings: 1, maxMeetings: 2 },
      "FINALIZED_SESSION_WAITS_FOR_BACKGROUND_PIPELINE");

    await sessions.registerForOwner({
      sessionId: "job-only", ownerId: "owner-b", recorderId: "tab-b",
      title: "job-only", createdAt: startedAt, recorderLeaseUntil: "2026-09-16T00:01:30.000Z", maxPipelines: 2,
    });
    await jobs.enqueue({ jobId: "job-only-processing", sessionId: "job-only", ownerId: "owner-b", maxAttempts: 3, now: startedAt });
    assert.deepEqual(await sessions.admissionStats(2, later), { activeMeetings: 2, maxMeetings: 2 },
      "PENDING_JOB_REMAINS_AUTHORITATIVE_AFTER_RECORDER_LEASE_EXPIRES");
    await jobs.claimNext({
      workerId: "worker", now: startedAt, leaseExpiresAt: "2026-09-16T00:10:00.000Z",
    });
    await assert.rejects(sessions.registerForOwner({
      sessionId: "third", ownerId: "owner-c", recorderId: "tab-c", title: "third", createdAt: later, maxPipelines: 2,
    }), (error: unknown) => error instanceof HttpError && error.code === "MEETING_PIPELINE_CAPACITY_FULL",
    "RECLAIMABLE_BACKGROUND_WORK_RESERVES_CAPACITY_BEFORE_RECOVERY");
    assert.deepEqual(await sessions.admissionStats(2, later), { activeMeetings: 2, maxMeetings: 2 });
    await jobs.recoverExpiredRunning(later);
    assert.deepEqual(await sessions.admissionStats(2, later), { activeMeetings: 2, maxMeetings: 2 },
      "RECOVERED_PENDING_JOB_OCCUPIES_CAPACITY_AGAIN");
  } finally {
    await sessions.close();
    await jobs.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("取消中的 running job 停止前不釋放名額，停止後才完成取消", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "meeting-cancel-admission-"));
  const filename = path.join(directory, "meeting.sqlite3");
  const sessions = new MeetingOneShotRepository(filename);
  const jobs = new MeetingProcessingJobRepository(filename);
  const transcriptionJobs = new MeetingTranscriptionJobRepository(filename);
  const minutesJobs = new MeetingMinutesJobRepository(filename);
  const archive = new MeetingSummaryArchiveRepository(filename, 1024);
  const createdAt = "2026-09-14T00:00:00.000Z";
  try {
    await jobs.initialize();
    await transcriptionJobs.initialize();
    await minutesJobs.initialize();
    await archive.stats();
    await sessions.registerForOwner({ sessionId: "cancel-me", ownerId: "owner", recorderId: "tab",
      title: "取消測試", createdAt, maxPipelines: 2 });
    await jobs.enqueue({ jobId: "job", sessionId: "cancel-me", ownerId: "owner", maxAttempts: 3, now: createdAt });
    await jobs.claimNext({ workerId: "worker", now: createdAt, leaseExpiresAt: "2026-09-14T00:10:00.000Z" });
    await sessions.requestCancellation("cancel-me", "2026-09-14T00:01:00.000Z");
    assert.equal(await sessions.publishDelivery("cancel-me", "2026-09-14T00:01:30.000Z", "2026-09-15T00:01:30.000Z"), false,
      "STALE_READY_SNAPSHOT_MUST_NOT_OVERRIDE_CANCELLATION");
    assert.equal((await sessions.get("cancel-me"))?.expiresAt, null);
    assert.equal(await jobs.cancelPendingForSession("cancel-me", "2026-09-14T00:01:00.000Z"), false);
    assert.equal(await sessions.completeCancellationIfIdle("cancel-me", "2026-09-14T00:01:00.000Z"), false);
    assert.deepEqual(await sessions.admissionStats(2), { activeMeetings: 1, maxMeetings: 2 });

    await jobs.requeueClaimed({ jobId: "job", workerId: "worker", now: "2026-09-14T00:02:00.000Z" });
    assert.equal(await sessions.completeCancellationIfIdle("cancel-me", "2026-09-14T00:02:00.000Z"), false,
      "PENDING_JOB_MUST_BLOCK_CANCELLATION_RELEASE");
    assert.equal(await jobs.cancelPendingForSession("cancel-me", "2026-09-14T00:02:00.000Z"), true);
    assert.equal(await sessions.completeCancellationIfIdle("cancel-me", "2026-09-14T00:02:00.000Z"), true);
    assert.deepEqual(await sessions.admissionStats(2), { activeMeetings: 0, maxMeetings: 2 });
    const cancelled = await sessions.get("cancel-me");
    assert.equal(cancelled?.cancelledAt, "2026-09-14T00:02:00.000Z");
    assert.equal(await sessions.isCancellationRequested("cancel-me"), true,
      "COMPLETED_CANCELLATION_REMAINS_A_DOWNSTREAM_GUARD");
    assert.equal(cancelled?.cleanupAfter, "2026-09-14T00:02:00.000Z");
    assert.equal(cancelled?.expiresAt, null, "取消清理期限不能冒充摘要下載期限");
    assert.equal((await jobs.getJob("job"))?.errorCode, "MEETING_CANCELLED");
    assert.deepEqual((await sessions.expired("2026-09-14T00:02:00.000Z")).map(entry => entry.sessionId), ["cancel-me"]);
    assert.equal(await sessions.claimCleanup("cancel-me", "2026-09-14T00:02:00.000Z"), true,
      "取消會議沒有摘要 archive 也必須可清理");
    await sessions.finishCleanup("cancel-me", "2026-09-14T00:03:00.000Z");
    assert.equal((await sessions.get("cancel-me"))?.cleanedAt, "2026-09-14T00:03:00.000Z");
    assert.equal(await jobs.getJob("job"), null, "終端 job metadata 隨取消清理移除");
  } finally {
    await sessions.close();
    await jobs.close();
    await transcriptionJobs.close();
    await minutesJobs.close();
    await archive.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("失敗會議重試會重新競爭名額，容量滿時不改變 failed job", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "meeting-retry-admission-"));
  const filename = path.join(directory, "meeting.sqlite3");
  const sessions = new MeetingOneShotRepository(filename);
  const jobs = new MeetingProcessingJobRepository(filename);
  const now = "2026-09-14T00:00:00.000Z";
  const register = (sessionId: string, ownerId: string) => sessions.registerForOwner({
    sessionId, ownerId, recorderId: "tab", title: sessionId, createdAt: now, maxPipelines: 2,
  });
  try {
    await register("failed", "failed-owner");
    await jobs.enqueue({ jobId: "failed-job", sessionId: "failed", ownerId: "failed-owner", maxAttempts: 1, now });
    await jobs.claimNext({ workerId: "worker", now, leaseExpiresAt: "2026-09-14T00:10:00.000Z" });
    await jobs.markFailed({ jobId: "failed-job", workerId: "worker", errorCode: "FFMPEG_FAILED", errorMessage: "failed", now });
    await sessions.releaseTerminalFailure("failed", now);
    await register("active-a", "owner-a");
    await register("active-b", "owner-b");

    await assert.rejects(sessions.claimRetryAdmission("failed", "failed-owner", now, 2),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "MEETING_PIPELINE_CAPACITY_FULL");
    assert.equal((await jobs.getJob("failed-job"))?.status, "failed");
    await sessions.releaseTerminalFailure("active-a", now);
    await sessions.releaseCurrent("active-a", "owner-a", now, true);
    await sessions.claimRetryAdmission("failed", "failed-owner", now, 2);
    const retried = await jobs.retry("failed-job", "failed-owner", now, true);
    assert.equal(retried?.status, "pending");
    assert.equal(retried?.attemptCount, 0);
    assert.deepEqual(await sessions.admissionStats(2, now), { activeMeetings: 2, maxMeetings: 2 });
  } finally {
    await sessions.close();
    await jobs.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("管理員重試舊會議不會覆蓋同一 owner 已開始的新會議", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "meeting-retry-current-owner-"));
  const filename = path.join(directory, "meeting.sqlite3");
  const sessions = new MeetingOneShotRepository(filename);
  const now = "2026-09-14T00:00:00.000Z";
  const register = (sessionId: string) => sessions.registerForOwner({
    sessionId, ownerId: "same-owner", recorderId: `tab-${sessionId}`,
    title: sessionId, createdAt: now, maxPipelines: 2,
  });
  try {
    await register("old-failed");
    await sessions.releaseTerminalFailure("old-failed", now);
    await sessions.releaseCurrent("old-failed", "same-owner", now, true);
    await register("new-current");

    await sessions.claimRetryAdmission("old-failed", "same-owner", now, 2);

    assert.equal((await sessions.get("old-failed"))?.deviceSessionReleasedAt, now,
      "RETRY_MUST_NOT_REATTACH_RELEASED_OWNER_CONTEXT");
    assert.equal((await sessions.currentForOwner("same-owner"))?.sessionId, "new-current");
    const db = await open({ filename, driver: sqlite3.Database });
    try {
      const current = await db.get<{ count: number }>(`SELECT COUNT(*) AS count
        FROM meeting_one_shot_sessions
        WHERE owner_id='same-owner' AND device_session_released_at IS NULL AND cleaned_at IS NULL`);
      assert.equal(Number(current?.count ?? 0), 1, "OWNER_HAS_ONLY_ONE_CURRENT_SESSION");
    } finally { await db.close(); }
  } finally {
    await sessions.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("transaction 自動中止後仍保留原始 SQLite 錯誤", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "meeting-rollback-error-"));
  const filename = path.join(directory, "meeting.sqlite3");
  const api = new MeetingOneShotRepository(filename);
  try {
    await api.get("missing");
    const db = await open({ filename, driver: sqlite3.Database });
    try {
      await db.exec(`CREATE TRIGGER reject_meeting_registration BEFORE INSERT ON meeting_one_shot_sessions
        BEGIN SELECT RAISE(ROLLBACK, 'original registration failure'); END;`);
    } finally {
      await db.close();
    }
    await assert.rejects(
      api.register({ sessionId: "rejected", ownerId: "owner", title: "拒絕", createdAt: new Date().toISOString() }),
      (error: unknown) => error instanceof Error && /original registration failure/.test(error.message)
    );
  } finally {
    await api.close();
    await rm(directory, { recursive: true, force: true });
  }
});

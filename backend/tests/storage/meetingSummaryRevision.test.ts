import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database, open } from "sqlite";
import sqlite3 from "sqlite3";
import { MeetingOneShotRepository } from "../../src/storage/meeting-minutes/meetingOneShotRepository";
import { MeetingMinutesJobRepository, type MeetingMinutesJobRecord } from "../../src/storage/meeting-minutes/meetingMinutesJobRepository";
import { MeetingSummaryArchiveRepository } from "../../src/storage/meeting-minutes/meetingSummaryArchiveRepository";
import type { MeetingRecord } from "../../src/services/meeting-minutes/meetingMinutesSchema";
import { compareMeetingSummaryRevision } from "../../src/services/meeting-minutes/meetingSummaryRevisionChanges";
import { MeetingOneShotService } from "../../src/services/meeting-minutes/meetingOneShotService";
import { MeetingWorkerRuntime } from "../../src/workers/meetingWorkerRuntime";

const now = "2026-09-17T01:00:00.000Z";
const expiry = "2026-09-18T01:00:00.000Z";
const record: MeetingRecord = { version: 1, title: "測試會議", date: "2026-09-17", subtitle: "摘要", attendees: [],
  executiveSummary: "原始摘要", discussionPoints: [], confirmedFacts: [], confirmedDecisions: [], systemRequirements: [],
  pendingItems: [], followUpActions: [], uncertainTerms: [], sourceEvidence: [] };

async function harness(run: (h: { sessions: MeetingOneShotRepository; first: MeetingMinutesJobRepository;
  second: MeetingMinutesJobRepository; third: MeetingMinutesJobRepository; archive: MeetingSummaryArchiveRepository; filename: string }) => Promise<void>, capacity = 10000) {
  const dir = await mkdtemp(path.join(tmpdir(), "meeting-revision-"));
  const filename = path.join(dir, "metadata.sqlite3");
  const sessions = new MeetingOneShotRepository(filename);
  const first = new MeetingMinutesJobRepository(filename);
  const second = new MeetingMinutesJobRepository(filename);
  const third = new MeetingMinutesJobRepository(filename);
  const archive = new MeetingSummaryArchiveRepository(filename, capacity);
  try {
    await sessions.get("initialize");
    await Promise.all([first.initialize(), second.initialize(), third.initialize()]);
    await run({ sessions, first, second, third, archive, filename });
  } finally {
    await Promise.all([sessions.close(), first.close(), second.close(), third.close(), archive.close()]);
    await rm(dir, { recursive: true, force: true });
  }
}

function input(id: string, sessionId = "meeting") {
  return { jobId: id, transcriptionJobId: `transcript-${sessionId}`, sessionId, ownerId: sessionId,
    clientRequestKey: id, inputSha256: id, humanInput: { title: record.title, date: record.date, attendees: "", confirmedFacts: "",
      confirmedDecisions: "", termCorrections: "", otherNotes: "" }, provider: "fake", model: "fake", maxAttempts: 3, now };
}
async function ready(repo: MeetingMinutesJobRepository, job: MeetingMinutesJobRecord, summary = record) {
  const claimed = await repo.claimNext({ workerId: "worker", now, leaseExpiresAt: expiry });
  assert.equal(claimed?.jobId, job.jobId);
  const version = await repo.reserveVersion({ versionId: `version-${job.jobId}`, jobId: job.jobId, workerId: "worker", record: summary, now });
  return (await repo.markReady({ jobId: job.jobId, workerId: "worker", versionId: version.versionId, packageRelativePath: "package", artifacts: [], now })).version!;
}
async function original(h: { sessions: MeetingOneShotRepository; first: MeetingMinutesJobRepository; archive: MeetingSummaryArchiveRepository }, sessionId = "meeting", summary = record) {
  await h.sessions.register({ sessionId, ownerId: sessionId, title: record.title, createdAt: now });
  const job = await h.first.enqueue(input(`original-${sessionId}`, sessionId));
  const version = await ready(h.first, job.job, summary);
  await h.archive.publish({ sessionId, versionNumber: 1, title: record.title, meetingDate: record.date, generatedAt: now, html: "original" }, now);
  await h.sessions.publishDelivery(sessionId, now, expiry, version.versionId);
  return version.versionId;
}
function revision(id: string, baseVersionId: string, sessionId = "meeting") {
  return { ...input(`revision:${id}`, sessionId), deliveryRevision: { baseVersionId, maxPending: 2 } };
}

test("另一場 STT 尚未完成，已完成摘要仍立即歸檔交付並釋放名額", async () => harness(async h => {
  await h.sessions.register({ sessionId: "meeting", ownerId: "meeting", title: record.title, createdAt: now });
  await h.sessions.markRecordingFinalized("meeting", "meeting", now, 2);
  const enqueued = await h.first.enqueue(input("automatic"));
  let releaseSummary!: () => void, releaseStt!: () => void, enterSummary!: () => void, enterStt!: () => void, delivered!: () => void;
  const summaryGate = new Promise<void>(resolve => { releaseSummary = resolve; });
  const sttGate = new Promise<void>(resolve => { releaseStt = resolve; });
  const summaryStarted = new Promise<void>(resolve => { enterSummary = resolve; });
  const sttStarted = new Promise<void>(resolve => { enterStt = resolve; });
  const delivery = new Promise<void>(resolve => { delivered = resolve; });
  const publish = h.sessions.publishDelivery.bind(h.sessions);
  h.sessions.publishDelivery = async (...args) => { const result = await publish(...args); delivered(); return result; };
  const processing = { jobId: "processing", sessionId: "meeting", ownerId: "meeting", status: "ready" };
  const transcription = { jobId: "transcript-meeting", sessionId: "meeting", ownerId: "meeting", status: "ready", artifacts: [{ type: "transcript-merged-json", sha256: "transcript" }] };
  let sttAvailable = false;
  const processingService = { enqueue: async () => ({ job: processing }), getJobForSession: async () => processing, close: async () => undefined };
  const transcriptionService = { providerEnabled: true, enqueueFromProcessingJob: async () => ({ job: transcription }), getJobForSession: async () => transcription,
    processClaimedJob: async () => { enterStt(); await sttGate; return { ...transcription, sessionId: "other" }; }, close: async () => undefined };
  const minutesService = { providerEnabled: true, enqueue: async () => ({ job: await h.first.getJob(enqueued.job.jobId), created: false }),
    getJobByRequestKey: async () => h.first.getJob(enqueued.job.jobId), getJob: async (id: string) => h.first.getJob(id),
    getVersion: async (id: string) => h.first.getVersionForOwner(id, "meeting"),
    processClaimedJob: async (claimed: MeetingMinutesJobRecord, workerId: string) => {
      enterSummary(); await summaryGate;
      const version = await h.first.reserveVersion({ versionId: "completed-version", jobId: claimed.jobId, workerId, record, now });
      return h.first.markReady({ jobId: claimed.jobId, workerId, versionId: version.versionId, packageRelativePath: "package", artifacts: [], now });
    }, close: async () => undefined };
  const liveService = { cleanupSession: async () => undefined, seal: async () => undefined, stop: async () => undefined, close: async () => undefined };
  const oneShot = new MeetingOneShotService({ repository: h.sessions, archive: h.archive,
    recordings: { getSession: async () => ({ status: "finalized" }) } as never,
    processing: processingService as never, transcription: transcriptionService as never, minutes: minutesService as never,
    liveService: liveService as never, liveRepository: { progress: async () => [] } as never,
    now: () => new Date(now) });
  const runtime = new MeetingWorkerRuntime({ repository: { claimNext: async () => null } as never, processingService: processingService as never,
    transcriptionRepository: { claimNext: async () => sttAvailable ? { ...transcription, status: "running", sessionId: "other" } : null } as never,
    transcriptionService: transcriptionService as never, minutesRepository: h.first, minutesService: minutesService as never,
    oneShotService: oneShot, liveTranscriptionService: liveService as never, now: () => new Date(now) });
  let running: Promise<boolean> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await runtime.runOnce(); await summaryStarted;
    sttAvailable = true; running = runtime.runOnce(); await sttStarted;
    releaseSummary();
    await Promise.race([delivery, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("SUMMARY_DELIVERY_MUST_NOT_WAIT_FOR_OTHER_STT")), 1000); })]);
    const saved = (await h.sessions.get("meeting"))!;
    assert.equal(saved.adoptedVersionId, "completed-version");
    assert.equal(saved.expiresAt, expiry);
    assert.equal(saved.pipelineReleasedAt, now);
    assert.ok((await h.archive.get("meeting"))!.html.includes(record.executiveSummary));
    assert.equal((await oneShot.status("meeting", "meeting")).phase, "ready", "DELIVERY_STATUS_READY_DURING_OTHER_STT");
  } finally {
    clearTimeout(timeout); releaseSummary(); releaseStt();
    await running;
    await runtime.stop();
  }
}));

test("修訂交易回滾不會撤銷另一場已接受的摘要工作", async () => harness(async h => {
  const base = await original(h);
  const sharedDb = await (h.first as unknown as { getDb(): Promise<Database> }).getDb();
  const originalGet = Database.prototype.get;
  let ordinary: ReturnType<MeetingMinutesJobRepository["enqueue"]> | undefined;
  Database.prototype.get = async function<T>(sql: Parameters<Database["get"]>[0], ...params: unknown[]): Promise<T> {
    const result = await originalGet.call(this, sql, ...params);
    if (typeof sql === "string" && sql.includes("SELECT COUNT(*) AS count FROM meeting_minutes_jobs") && !ordinary) {
      ordinary = h.first.enqueue(input("ordinary-other-meeting", "other"));
      // 同 connection 可在交易內完成；獨立 connection 必須等交易回滾後才能提交。
      if (this === sharedDb) await ordinary;
    }
    return result as T;
  };
  try {
    await assert.rejects(h.first.enqueue({ ...revision("rollback", base), deliveryRevision: { baseVersionId: base, maxPending: 0 } }), { code: "MEETING_REVISION_CAPACITY_FULL" });
    assert.ok(ordinary);
    const accepted = await ordinary;
    assert.equal(accepted.created, true);
    assert.equal((await h.second.getJob(accepted.job.jobId))?.jobId, accepted.job.jobId, "ACCEPTED_OTHER_JOB_SURVIVES_REVISION_ROLLBACK");
  } finally {
    Database.prototype.get = originalGet;
    await ordinary?.catch(() => undefined);
  }
}));

test("跨 connection 同時申請三筆修訂最多入列兩筆，且每場只有一筆待確認", async () => harness(async h => {
  const bases: Array<{ id: string; version: string }> = [];
  for (const id of ["a", "b", "c"]) bases.push({ id, version: await original(h, id) });
  const repos = [h.first, h.second, h.third];
  const attempts = await Promise.allSettled(bases.map((base, i) => repos[i]!.enqueue(revision(base.id, base.version, base.id))));
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 2, "ATOMIC_GLOBAL_REVISION_LIMIT");
  const failure = attempts.find(result => result.status === "rejected");
  assert.ok(failure?.status === "rejected");
  assert.equal(failure.reason.code, "MEETING_REVISION_CAPACITY_FULL");
  const accepted = bases.find((_, i) => attempts[i]!.status === "fulfilled")!;
  await assert.rejects(h.third.enqueue(revision("duplicate", accepted.version, accepted.id)), { code: "MEETING_REVISION_PENDING" });
  const replay = await h.third.enqueue(revision(accepted.id, accepted.version, accepted.id));
  assert.equal(replay.created, false, "CROSS_CONNECTION_REPLAY_SAME_JOB");
  assert.equal((await h.sessions.get(accepted.id))!.expiresAt, expiry);
}));

test("採用與歸檔同一交易：容量不足、過期與舊版本不會改採用指標或原 HTML", async () => harness(async h => {
  const baseVersionId = await original(h);
  const enqueued = await h.first.enqueue(revision("adopt", baseVersionId));
  const version = await ready(h.first, enqueued.job);
  const adoption = { ownerId: "meeting", expectedVersionId: baseVersionId, versionId: version.versionId, jobId: version.jobId };
  const archiveInput = { sessionId: "meeting", versionNumber: version.versionNumber, title: record.title, meetingDate: record.date, generatedAt: now, html: "x".repeat(101) };
  await assert.rejects(h.archive.publish(archiveInput, now, adoption), { code: "MEETING_SUMMARY_ARCHIVE_FULL" });
  assert.equal((await h.sessions.get("meeting"))!.adoptedVersionId, baseVersionId, "ROLLBACK_POINTER_WITH_ARCHIVE");
  assert.equal((await h.sessions.get("meeting"))!.revisionJobId, version.jobId);
  assert.equal((await h.archive.get("meeting"))!.html, "original");
  await assert.rejects(h.archive.publish({ ...archiveInput, html: "new" }, now, { ...adoption, expectedVersionId: "stale" }), { code: "MEETING_REVISION_CONFLICT" });
  await assert.rejects(h.archive.publish({ ...archiveInput, html: "new" }, expiry, adoption), { code: "MEETING_ONE_SHOT_EXPIRED" });
  await h.archive.publish({ ...archiveInput, html: "new" }, now, adoption);
  assert.equal((await h.archive.get("meeting"))!.html, "new");
  const saved = (await h.sessions.get("meeting"))!;
  assert.equal(saved.adoptedVersionId, version.versionId); assert.equal(saved.revisionJobId, null);
  assert.equal(saved.expiresAt, expiry); assert.equal(saved.pipelineReleasedAt, now);
  await h.archive.publish({ ...archiveInput, html: "new" }, now, adoption);
  await h.sessions.close();
  assert.equal((await h.sessions.get("meeting"))!.adoptedVersionId, version.versionId, "ADOPT_SURVIVES_REOPEN");
}, 100));

test("已離開、到期或開始清理的會議不能入列修訂，原始摘要不變", async () => harness(async h => {
  const base = await original(h);
  await h.sessions.releaseCurrent("meeting", "meeting", now);
  await assert.rejects(h.first.enqueue(revision("released", base)), { code: "MEETING_REVISION_CONFLICT" });
  await assert.rejects(h.second.enqueue({ ...revision("expired", base), now: expiry }), { code: "MEETING_ONE_SHOT_EXPIRED" });
  assert.equal((await h.sessions.get("meeting"))!.revisionJobId, null);
  assert.equal((await h.archive.get("meeting"))!.html, "original");
}));

test("既有內容差異能抓出同數量改寫、重複項移除與章節清空，確認資訊綁定實際內容", () => {
  const base: MeetingRecord = { ...record, confirmedDecisions: [{ content: "先簽核再發布", sourceBasis: "錄音" }, { content: "先簽核再發布", sourceBasis: null }],
    discussionPoints: [{ title: "交期", currentProblem: null, discussion: "仍待確認", direction: null }] };
  const preserved = compareMeetingSummaryRevision("v1", "v2", base, { ...base, title: "新標題", confirmedDecisions: [...base.confirmedDecisions].reverse() });
  assert.equal(preserved.requiresAcknowledgement, false, "TITLE_AND_REORDER_KEEP_CONTENT");
  assert.deepEqual(preserved.entries.map(entry => entry.field), ["title"]);
  for (const candidate of [
    { ...base, confirmedDecisions: [{ content: "先發布再簽核", sourceBasis: null }, base.confirmedDecisions[1]!] },
    { ...base, confirmedDecisions: [base.confirmedDecisions[0]!] },
    { ...base, discussionPoints: [] },
  ]) {
    const diff = compareMeetingSummaryRevision("v1", "v2", base, candidate);
    assert.equal(diff.requiresAcknowledgement, true, "NO_SILENT_CONTENT_LOSS");
    assert.ok(diff.entries.some(entry => entry.removed.length > 0));
    assert.notEqual(diff.acknowledgementToken, preserved.acknowledgementToken, "ACK_BINDS_CONTENT");
    assert.notEqual(diff.acknowledgementToken, compareMeetingSummaryRevision("v1", "v3", base, candidate).acknowledgementToken, "ACK_BINDS_VERSION");
  }
});

test("Server 採用保護：未確認、舊確認資訊均拒絕，跨 connection 重啟仍綁定原版本", async () => harness(async h => {
  const baseline: MeetingRecord = { ...record, confirmedFacts: [{ content: "模具已交付", sourceBasis: "使用者補充／確認" }],
    confirmedDecisions: [{ content: "先簽核再發布", sourceBasis: "錄音" }],
    followUpActions: [{ content: "確認交期", owner: null, dueDate: null }] };
  const base = await original(h, "meeting", baseline);
  const enqueued = await h.first.enqueue(revision("protected", base));
  await h.first.close();
  assert.equal((await h.second.getJob(enqueued.job.jobId))!.revisionBaseVersionId, base, "BASE_BINDING_SURVIVES_REOPEN");
  const candidateRecord = { ...record, title: "只改標題卻漏掉內容" };
  const candidate = await ready(h.second, enqueued.job, candidateRecord);
  const savedBase = (await h.second.getVersionForOwner(base, "meeting"))!.record;
  const savedCandidate = (await h.second.getVersionForOwner(candidate.versionId, "meeting"))!.record;
  const diff = compareMeetingSummaryRevision(base, candidate.versionId, savedBase, savedCandidate);
  assert.equal(diff.requiresAcknowledgement, true);
  const adoption = { ownerId: "meeting", expectedVersionId: base, versionId: candidate.versionId, jobId: candidate.jobId };
  const html = { sessionId: "meeting", versionNumber: candidate.versionNumber, title: candidateRecord.title, meetingDate: record.date, generatedAt: now, html: "candidate" };
  for (const acknowledgementToken of [undefined, "stale", compareMeetingSummaryRevision(base, "different-version", savedBase, savedCandidate).acknowledgementToken]) {
    await assert.rejects(h.archive.publish(html, now, { ...adoption, acknowledgementToken }), { code: "MEETING_REVISION_CHANGES_NOT_ACKNOWLEDGED" }, "ACK_REQUIRED_BEFORE_ARCHIVE");
    assert.equal((await h.sessions.get("meeting"))!.adoptedVersionId, base, "REJECT_PRESERVES_BASE");
    assert.equal((await h.archive.get("meeting"))!.html, "original", "REJECT_PRESERVES_HTML");
  }
  await h.archive.publish(html, now, { ...adoption, acknowledgementToken: diff.acknowledgementToken });
  assert.equal((await h.sessions.get("meeting"))!.adoptedVersionId, candidate.versionId);
  assert.equal((await h.archive.get("meeting"))!.html, "candidate");
  assert.equal((await h.sessions.get("meeting"))!.expiresAt, expiry);
  const next = await h.third.enqueue(revision("next", candidate.versionId));
  await h.archive.publish(html, now, adoption);
  assert.equal((await h.sessions.get("meeting"))!.revisionJobId, next.job.jobId, "ADOPT_REPLAY_KEEPS_NEWER_CANDIDATE");
}));

test("舊 schema 多 connection 升級只補一欄；無基準綁定的舊候選拒絕採用但可放棄重建", async () => harness(async h => {
  const base = await original(h);
  const enqueued = await h.first.enqueue(revision("legacy", base));
  const candidate = await ready(h.first, enqueued.job);
  await Promise.all([h.first.close(), h.second.close(), h.third.close()]);
  const legacy = await open({ filename: h.filename, driver: sqlite3.Database });
  await legacy.exec("ALTER TABLE meeting_minutes_jobs DROP COLUMN revision_base_version_id");
  await legacy.close();
  await Promise.all([h.first.initialize(), h.second.initialize(), h.third.initialize()]);
  assert.equal((await h.first.getJob(candidate.jobId))!.revisionBaseVersionId, null, "LEGACY_BASE_NOT_INVENTED");
  await assert.rejects(h.archive.publish({ sessionId: "meeting", versionNumber: candidate.versionNumber,
    title: record.title, meetingDate: record.date, generatedAt: now, html: "legacy-candidate" }, now,
  { ownerId: "meeting", expectedVersionId: base, versionId: candidate.versionId, jobId: candidate.jobId }), { code: "MEETING_REVISION_BASE_MISSING" });
  assert.equal((await h.archive.get("meeting"))!.html, "original");
  assert.equal((await h.sessions.get("meeting"))!.adoptedVersionId, base);
  await h.sessions.discardRevision("meeting", "meeting", candidate.jobId, now);
  const next = await h.second.enqueue(revision("after-migration", base));
  assert.equal(next.job.revisionBaseVersionId, base, "NEW_CANDIDATE_HAS_REAL_BASE");
}));

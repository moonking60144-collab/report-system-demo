import { randomUUID } from "node:crypto";
import test from "node:test";
import { open } from "sqlite";
import sqlite3 from "sqlite3";
import { MeetingLegacyRecordingAccess } from "../../src/services/meeting-minutes/meetingLegacyRecordingAccess";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { errorHandler } from "../../src/middleware/errorHandler";
import { createMeetingRecordingsRouter } from "../../src/routes/meetingRecordings";
import { createMeetingRecordingOwnerAuth } from "../../src/services/meeting-minutes/meetingRecordingOwnerAuth";
import { MeetingRecordingStorageService } from "../../src/services/meeting-minutes/meetingRecordingStorageService";
import { MeetingProcessingService } from "../../src/services/meeting-minutes/meetingProcessingService";
import { MeetingTranscriptionService } from "../../src/services/meeting-minutes/meetingTranscriptionService";
import { MeetingMinutesService } from "../../src/services/meeting-minutes/meetingMinutesService";
import { MeetingMinutesPackageService } from "../../src/services/meeting-minutes/meetingMinutesPackageService";
import type { MeetingMinutesProviderLike } from "../../src/services/meeting-minutes/meetingMinutesProvider";
import type { MeetingTranscriptProcessorLike } from "../../src/services/meeting-minutes/meetingTranscriptProcessor";
import { MeetingProcessingJobRepository } from "../../src/storage/meeting-minutes/meetingProcessingJobRepository";
import { MeetingTranscriptionJobRepository } from "../../src/storage/meeting-minutes/meetingTranscriptionJobRepository";
import { MeetingMinutesJobRepository } from "../../src/storage/meeting-minutes/meetingMinutesJobRepository";
import { HttpError } from "../../src/utils/httpError";
import { MeetingOneShotService } from "../../src/services/meeting-minutes/meetingOneShotService";
import { MeetingOneShotRepository } from "../../src/storage/meeting-minutes/meetingOneShotRepository";
import { MeetingSummaryArchiveRepository } from "../../src/storage/meeting-minutes/meetingSummaryArchiveRepository";
import { MeetingLiveTranscriptionRepository } from "../../src/storage/meeting-minutes/meetingLiveTranscriptionRepository";
import { MeetingLiveTranscriptionService } from "../../src/services/meeting-minutes/meetingLiveTranscriptionService";

const SESSION_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];

test("configured providers 正常但 runtime 未就緒，開始錄音回 503 且不占名額", async () => {
  await withTestServer(async baseUrl => {
    const response=await fetch(`${baseUrl}/api/meetings/recordings`,{method:"POST",headers:{"Content-Type":"application/json","X-Meeting-Request":"1","X-Meeting-Recorder-Id":"recorder-test"},body:JSON.stringify({deliveryMode:"one-shot",sourceIds:["room-mic"]})});
    assert.equal(response.status,503);
    const state=await (await fetch(`${baseUrl}/api/meetings/one-shot`)).json();
    assert.equal(state.data.available,false); assert.equal(state.data.admission.activeMeetings,0);
  },{oneShot:true,runtimeReady:false});
});
const OWNER_IDS = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
];
const OWNER_LIBRARY_CODES = ["NW8-K9Q", "Q7M-X8P"];
const PROCESSING_JOB_IDS = [
  "99999999-9999-4999-8999-999999999999",
  "88888888-8888-4888-8888-888888888888",
];
const TRANSCRIPTION_JOB_IDS = [
  "77777777-7777-4777-8777-777777777777",
  "66666666-6666-4666-8666-666666666666",
];

function ownerCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie);
  return setCookie.split(";", 1)[0];
}

function ownerHeaders(cookie: string, headers: Record<string, string> = {}) {
  return { Cookie: cookie, "X-Meeting-Request": "1", "X-Meeting-Recorder-Id": "recorder-test", ...headers };
}

async function withTestServer(
  run: (
    baseUrl: string,
    root: string,
    context: {
      processingRepository: MeetingProcessingJobRepository;
      processingService: MeetingProcessingService;
      transcriptionRepository: MeetingTranscriptionJobRepository;
      transcriptionService: MeetingTranscriptionService;
      minutesRepository: MeetingMinutesJobRepository;
      minutesService: MeetingMinutesService;
      service: MeetingRecordingStorageService;
      oneShot: MeetingOneShotService;
    }
  ) => Promise<void>,
  options: {
    ownerSecret?: string;
    oneShot?: boolean;
    archiveMaxBytes?: number;
    secureCookie?: boolean;
    workerEnabled?: boolean;
    transcriptionProviderEnabled?: boolean;
    minutesProviderEnabled?: boolean;
    minutesProvider?: MeetingMinutesProviderLike;
    adminToken?: string;
    nowMs?: () => number;
    runtimeReady?: boolean;
  } = {}
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "meeting-route-"));
  let sessionIndex = 0;
  let ownerIndex = 0;
  let processingJobIndex = 0;
  let transcriptionJobIndex = 0;
  const service = new MeetingRecordingStorageService({
    storageDir: root,
    maxTotalBytes: 1024,
    maxSessionBytes: 1024,
    maxChunkBytes: 128,
    staleSessionMs: 60_000,
    now: options.nowMs ? () => new Date(options.nowMs!()) : undefined,
    idFactory: () => SESSION_IDS[sessionIndex++] ?? randomUUID(),
  });
  const ownerAuth = createMeetingRecordingOwnerAuth({
    secret: options.ownerSecret ?? "meeting-route-test-secret-at-least-32-bytes",
    secureCookie: options.secureCookie ?? false,
    ownerIdFactory: () => OWNER_IDS[ownerIndex++] ?? randomUUID(),
  });
  const processingDir = path.join(root, "processing");
  const processingRepository = new MeetingProcessingJobRepository(
    path.join(root, "processing.sqlite3")
  );
  const processingService = new MeetingProcessingService({
    repository: processingRepository,
    recordingStorage: service,
    audioProcessor: {
      process: async () => [],
      resolveArtifactPath: (relativePath) => path.join(processingDir, relativePath),
      cleanupTrash: async () => undefined,
      removeSessionAudioArtifacts: async () => false,
    },
    idFactory: () =>
      PROCESSING_JOB_IDS[processingJobIndex++] ??
      PROCESSING_JOB_IDS[PROCESSING_JOB_IDS.length - 1],
    maxAttempts: 3,
    workerEnabled: options.workerEnabled ?? true,
  });
  const transcriptionRepository = new MeetingTranscriptionJobRepository(
    path.join(root, "processing.sqlite3")
  );
  const transcriptProcessor: MeetingTranscriptProcessorLike = {
    enabled: options.transcriptionProviderEnabled ?? true,
    providerName: options.transcriptionProviderEnabled === false ? "disabled" : "fake",
    model: options.transcriptionProviderEnabled === false ? "disabled" : "fake-model",
    process: async () => [],
    resolveArtifactPath: (relativePath) => path.join(processingDir, relativePath),
  };
  const transcriptionService = new MeetingTranscriptionService({
    repository: transcriptionRepository,
    processingRepository,
    processingService,
    transcriptProcessor,
    idFactory: () =>
      TRANSCRIPTION_JOB_IDS[transcriptionJobIndex++] ??
      TRANSCRIPTION_JOB_IDS[TRANSCRIPTION_JOB_IDS.length - 1],
    maxAttempts: 3,
    workerEnabled: options.workerEnabled ?? true,
  });
  const minutesRepository = new MeetingMinutesJobRepository(
    path.join(root, "processing.sqlite3")
  );
  const minutesProvider: MeetingMinutesProviderLike = {
    enabled: options.minutesProviderEnabled ?? true,
    name: options.minutesProviderEnabled === false ? "disabled" : "fake-minutes",
    model: options.minutesProviderEnabled === false ? "disabled" : "fake-model",
    async summarize() {
      return {
        version: 1,
        title: "AI 會議",
        date: null,
        subtitle: "會議摘要",
        attendees: [],
        executiveSummary: "已整理會議重點。",
        discussionPoints: [],
        confirmedFacts: [],
        confirmedDecisions: [],
        systemRequirements: [],
        pendingItems: [],
        followUpActions: [],
        uncertainTerms: [],
        additionalSections: [{ title: "風險分析", content: "建議：確認資料完整性。" }],
      };
    },
  };
  let minutesId = 0;
  const minutesService = new MeetingMinutesService({
    repository: minutesRepository,
    transcriptionService,
    processingService,
    packageService: new MeetingMinutesPackageService({ processingDir }),
    provider: options.minutesProvider ?? minutesProvider,
    now: options.nowMs ? () => new Date(options.nowMs!()) : undefined,
    idFactory: () => `minutes-id-${++minutesId}`,
    maxAttempts: 3,
    workerEnabled: options.workerEnabled ?? true,
  });
  const legacyAccess = new MeetingLegacyRecordingAccess(path.join(root, "processing.sqlite3"));
  const adminToken = options.adminToken ?? "meeting-admin-token";
  const liveRepository = new MeetingLiveTranscriptionRepository(path.join(root,"processing.sqlite3"));
  const oneShotRepository = new MeetingOneShotRepository(path.join(root,"processing.sqlite3"));
  const oneShot = new MeetingOneShotService({
    checkRuntimeReadiness: async () => options.runtimeReady ?? true,
    liveRepository,
    liveService: new MeetingLiveTranscriptionService({repository:liveRepository,sessions:oneShotRepository,recordings:service,transcriptionJobs:transcriptionRepository,processingDir}),
    repository: oneShotRepository,
    archive: new MeetingSummaryArchiveRepository(path.join(root, "processing.sqlite3"), options.archiveMaxBytes ?? 256 * 1024 * 1024),
    recordings: service, processing: processingService, transcription: transcriptionService, minutes: minutesService,
    processingDir, deliveryMs: 86_400_000, now: options.nowMs ? () => new Date(options.nowMs!()) : undefined,
  });
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(
    "/api",
    createMeetingRecordingsRouter(
      service,
      ownerAuth,
      processingService,
      transcriptionService,
      minutesService,
      {
        legacyAccess,
        oneShotService: options.oneShot ? oneShot : undefined,
        nowMs: options.nowMs,
        verifyAdminToken: (authorizationHeader) => {
          if (authorizationHeader !== `Bearer ${adminToken}`) {
            throw new HttpError(401, "缺少授權資訊", "NOTICE_TOKEN_MISSING");
          }
          return { username: "meeting-admin" };
        },
      }
    )
  );
  app.use(errorHandler);
  const server = await new Promise<Server>((resolve) => {
    const nextServer = app.listen(0, "127.0.0.1", () => resolve(nextServer));
  });
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`, root, {
      processingRepository,
      processingService,
      transcriptionRepository,
      transcriptionService,
      minutesRepository,
      minutesService,
      service,
      oneShot,
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await minutesService.close();
    await transcriptionService.close();
    await processingService.close();
    await legacyAccess.close();
    await oneShot.repository.close();
    await oneShot.archive.close();
    await liveRepository.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("完成頁錄音下載與修訂：重送、重啟、採用、放棄及到期均保留正確版本", async () => {
  let clock = Date.parse("2026-09-17T01:00:00.000Z");
  const calls: Array<Parameters<MeetingMinutesProviderLike["summarize"]>[0]> = [];
  const revisedTitle = "模".repeat(200);
  const revisedDate = "2".repeat(40);
  const provider: MeetingMinutesProviderLike = {
    enabled: true, name: "fake-minutes", model: "fake-model",
    async summarize(input) {
      calls.push(input);
      if (input.human.revisionRequest === "模擬修訂失敗") throw Object.assign(new Error("修訂模型拒絕"), { code: "TEST_REVISION_REJECTED" });
      return { version: 1, title: input.human.revisionRequest ? revisedTitle : input.human.title,
        date: input.human.revisionRequest ? revisedDate : input.human.date, subtitle: "測試摘要", attendees: [],
        executiveSummary: input.human.revisionRequest ?? "原始摘要", discussionPoints: [], confirmedFacts: [],
        confirmedDecisions: input.human.revisionRequest ? [] : [{ content: "先簽核再發布", sourceBasis: "錄音" }],
        systemRequirements: [], pendingItems: [], followUpActions: [], uncertainTerms: [], sourceEvidence: [] };
    },
  };
  await withTestServer(async (baseUrl, root, context) => {
    const recording = await createFinalizedRecordingWithLibrary(baseUrl, "修訂測試", "one-shot");
    const sid = recording.sessionId;
    const base = `${baseUrl}/api/meetings/recordings/${sid}`;
    const headers = ownerHeaders(recording.cookie, { "Content-Type": "application/json" });
    const delivery = async () => (await (await fetch(`${base}/delivery`, { headers })).json()).data;
    const html = async () => (await fetch(`${base}/delivery/html`, { headers })).text();
    const post = (path: string, body: unknown = {}) => fetch(`${base}/delivery/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    await context.oneShot.advance();
    await createReadyProcessingJob(baseUrl, root, context, { ...recording, withPlayback: true });
    await context.processingService.recoverExpiredJobs();
    await createReadyTranscriptionJob(baseUrl, root, context, recording);
    clock += 11_000;
    await context.oneShot.advance();
    const processMinutes = async () => {
      const claimed = await context.minutesRepository.claimNext({ workerId: "revision-worker", now: new Date(clock).toISOString(), leaseExpiresAt: new Date(clock + 600_000).toISOString() });
      assert.ok(claimed);
      const job = await context.minutesService.processClaimedJob(claimed, "revision-worker");
      assert.equal(job.status, "ready");
      return job;
    };
    await processMinutes();
    clock += 11_000;
    await context.oneShot.advance();
    const original = await delivery();
    const originalHtml = await html();
    const originalArchivedAt = (await context.oneShot.archive.get(sid))!.archivedAt;
    const originalVersion = original.minutes.version.versionId;
    const deadline = original.expiresAt;
    const audio = original.minutes.version.artifacts.find((item: { type: string }) => item.type === "minutes-audio");
    assert.ok(audio);
    const downloaded = await fetch(`${baseUrl}${audio.downloadUrl}?download=1`, { headers });
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get("content-type"), "audio/mp4");
    assert.match(downloaded.headers.get("content-disposition")!, /^attachment;/);
    assert.equal(await downloaded.text(), "playable-audio");
    assert.equal((await fetch(`${baseUrl}${audio.downloadUrl}`)).status, 401);
    const payload = { baseVersionId: originalVersion, request: "週五交貨尚未確認，請移到仍需確認。", confirmedFacts: "模具已交付，這項已人工確認。", clientRequestKey: "rev-1" };
    assert.equal((await fetch(`${base}/delivery/revisions`, { method: "POST", headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" }, body: JSON.stringify(payload) })).status, 401);
    assert.equal((await fetch(`${base}/delivery/revisions`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: recording.cookie }, body: JSON.stringify(payload) })).status, 403);
    const [accepted, repeated] = await Promise.all([post("revisions", payload), post("revisions", payload)]);
    assert.equal(accepted.status, 202); assert.equal(repeated.status, 202);
    const candidateId = (await accepted.json()).data.jobId;
    assert.equal((await repeated.json()).data.jobId, candidateId, "RETRY_SAME_JOB");
    assert.equal((await delivery()).revision.jobId, candidateId);
    assert.equal(await html(), originalHtml, "PENDING_PRESERVES_HTML");
    assert.equal((await delivery()).minutes.version.versionId, originalVersion);
    assert.equal((await context.oneShot.availability()).admission.activeMeetings, 0, "REVISION_NOT_RECORDING_SLOT");
    assert.equal((await post(`revisions/${candidateId}/adopt`, { expectedVersionId: originalVersion })).status, 409);
    assert.equal((await post("revisions", { ...payload, clientRequestKey: "rev-2" })).status, 409);
    assert.equal((await post("revisions", { ...payload, request: "不同內容" })).status, 409, "REQUEST_KEY_PAYLOAD_CONFLICT");
    assert.equal((await fetch(`${base}/release-current`, { method: "POST", headers })).status, 409);
    await context.oneShot.repository.close(); await context.minutesRepository.close();
    assert.equal((await delivery()).revision.jobId, candidateId, "RESTART_RETURNS_CANDIDATE");
    const candidate = await processMinutes();
    assert.equal(calls.length, 2, "ONE_INITIAL_ONE_REVISION_AI_CALL");
    assert.equal(calls[1].human.revisionRequest, payload.request);
    assert.equal(calls[1].human.revisionConfirmedFacts, payload.confirmedFacts, "DEDICATED_CONFIRMED_FACT_INPUT");
    assert.doesNotMatch(calls[1].human.otherNotes, /週五交貨|使用者修訂要求/, "DIRECTIVE_NOT_SOURCE_NOTE");
    assert.equal(JSON.parse(calls[1].human.previousSummary!).executiveSummary, "原始摘要", "IMMUTABLE_BASE_SENT_TO_AI");
    assert.equal(calls[1].transcript.sessionId, sid, "REUSE_TRANSCRIPT");
    assert.equal(await html(), originalHtml, "READY_CANDIDATE_NOT_ADOPTED");
    assert.equal((await delivery()).minutes.version.versionId, originalVersion);
    const preview = await fetch(`${base}/delivery/revisions/${candidateId}/html`, { headers });
    assert.equal(preview.status, 200); assert.match(await preview.text(), /週五交貨尚未確認/);
    assert.equal((await post(`revisions/${candidateId}/adopt`, { expectedVersionId: "stale" })).status, 409);
    assert.equal(await html(), originalHtml, "STALE_ADOPT_NO_ARCHIVE_CHANGE");
    const comparison = (await delivery()).revision.revisionChanges;
    assert.equal(comparison.baseVersionId, originalVersion);
    assert.equal(comparison.candidateVersionId, candidate.version!.versionId);
    assert.equal(comparison.requiresAcknowledgement, true);
    assert.ok(comparison.entries.some((entry: { removed: string[] }) => entry.removed.includes("先簽核再發布")), "STATUS_SHOWS_ACTUAL_REMOVED_DECISION");
    for (const acknowledgementToken of [undefined, "outdated-content-token"]) {
      const rejected = await post(`revisions/${candidateId}/adopt`, { expectedVersionId: originalVersion, acknowledgementToken });
      assert.equal(rejected.status, 409, "ROUTE_REQUIRES_CONTENT_ACK");
      assert.equal((await rejected.json()).error.code, "MEETING_REVISION_CHANGES_NOT_ACKNOWLEDGED");
      assert.equal(await html(), originalHtml, "UNACKNOWLEDGED_ADOPT_PRESERVES_HTML");
    }
    const [adopted, replay] = await Promise.all([
      post(`revisions/${candidateId}/adopt`, { expectedVersionId: originalVersion, acknowledgementToken: comparison.acknowledgementToken }),
      post(`revisions/${candidateId}/adopt`, { expectedVersionId: originalVersion, acknowledgementToken: comparison.acknowledgementToken }),
    ]);
    assert.equal(adopted.status, 204); assert.equal(replay.status, 204);
    const latest = await delivery();
    assert.equal(latest.revision, null);
    assert.equal(latest.minutes.version.versionId, candidate.version!.versionId);
    assert.equal(latest.expiresAt, deadline, "ADOPT_DOES_NOT_EXTEND_TTL");
    assert.match(await html(), /週五交貨尚未確認/);
    assert.equal((await context.oneShot.archive.stats()).count, 1);
    assert.equal((await context.oneShot.archive.get(sid))!.archivedAt, originalArchivedAt, "ORIGINAL_RETENTION_ORIGIN_PRESERVED");
    const next = { ...payload, baseVersionId: latest.minutes.version.versionId, request: "補充模具進度", clientRequestKey: "rev-3" };
    const nextAccepted = await post("revisions", next);
    const nextId = (await nextAccepted.json()).data.jobId;
    await processMinutes();
    assert.equal(calls[2].human.title, revisedTitle, "ADOPTED_TITLE_CAN_ENTER_NEXT_REVISION");
    assert.equal(calls[2].human.date, revisedDate, "ADOPTED_DATE_CAN_ENTER_NEXT_REVISION");
    assert.match(calls[2].human.confirmedFacts, /模具已交付/, "PRIOR_CONFIRMED_FACTS_REMAIN_SOURCE");
    assert.match(calls[2].human.revisionHistory!, /週五交貨/, "PRIOR_DIRECTIVE_ONLY_IN_HISTORY");
    assert.doesNotMatch(calls[2].human.otherNotes, /週五交貨/, "PRIOR_DIRECTIVE_NOT_EVIDENCE");
    assert.equal((await post(`revisions/${nextId}/discard`)).status, 204);
    assert.equal((await delivery()).minutes.version.versionId, latest.minutes.version.versionId, "DISCARD_KEEPS_ADOPTED");
    const failureResponse = await post("revisions", { ...next, request: "模擬修訂失敗", clientRequestKey: "rev-failure" });
    const failureId = (await failureResponse.json()).data.jobId;
    const failureClaim = await context.minutesRepository.claimNext({ workerId: "revision-worker", now: new Date(clock).toISOString(), leaseExpiresAt: deadline });
    assert.ok(failureClaim);
    assert.equal((await context.minutesService.processClaimedJob(failureClaim, "revision-worker")).status, "failed");
    const afterFailure = await delivery();
    assert.equal(afterFailure.phase, "ready", "FAILED_REVISION_DOES_NOT_FAIL_DELIVERY");
    assert.equal(afterFailure.minutes.version.versionId, latest.minutes.version.versionId);
    assert.equal(afterFailure.revision.status, "failed");
    assert.equal((await post(`revisions/${failureId}/discard`)).status, 204);
    assert.equal((await post("revisions", { ...next, clientRequestKey: "rev-expiring" })).status, 202);
    clock = Date.parse(deadline) + 1;
    await context.oneShot.cleanup();
    assert.equal((await context.oneShot.repository.get(sid))!.cleanedAt, null, "DO_NOT_CLEAN_RUNNING_REVISION_INPUT");
    assert.equal((await post("revisions", { ...next, clientRequestKey: "expired" })).status, 410);
    assert.equal((await post(`revisions/${nextId}/adopt`, { expectedVersionId: latest.minutes.version.versionId })).status, 410);
    assert.equal((await delivery()).phase, "expired");
    await processMinutes();
    await context.oneShot.cleanup();
    assert.ok((await context.oneShot.repository.get(sid))!.cleanedAt);
    assert.match((await context.oneShot.archive.get(sid))!.html, /週五交貨尚未確認/, "EXPIRED_UNADOPTED_NEVER_ARCHIVED");
  }, { oneShot: true, nowMs: () => clock, minutesProvider: provider });
});

for (const additionalSectionRequest of [undefined, "請增加風險分析"]) {
test(`one-shot 不需 library setup，自動發布、重播、隔離舊 viewer、下載 lease 與 24h 清理 (${additionalSectionRequest ?? "固定格式"})`, async () => {
  let clock = Date.parse("2026-09-09T01:00:00.000Z");
  await withTestServer(async (baseUrl, root, context) => {
    const recording = await createFinalizedRecordingWithLibrary(baseUrl, "一次性測試", "one-shot", additionalSectionRequest);
    const sid = recording.sessionId;
    await context.oneShot.repository.close();
    assert.equal((await context.oneShot.repository.get(sid))!.additionalSectionRequest, additionalSectionRequest ?? "", "ADDITIONAL_REQUEST_DURABLE");
    const owner = (await context.oneShot.repository.get(sid))!.ownerId;
    const base = `${baseUrl}/api/meetings/recordings/${sid}`;
    assert.equal((await fetch(`${baseUrl}/api/meetings/recordings/${sid}/delivery`)).status, 401);
    const manual = await fetch(`${base}/minutes`, { method: "POST", headers: ownerHeaders(recording.cookie, { "Content-Type": "application/json" }), body: JSON.stringify({ title: "額外", clientRequestKey: "manual-duplicate" }) });
    assert.equal(manual.status, 404);
    assert.equal((await fetch(`${base}/minutes/`, { method: "POST", headers: ownerHeaders(recording.cookie), body: "" })).status, 404);
    // No browser process request: the durable coordinator establishes the first job.
    await context.oneShot.advance();
    assert.ok(await context.processingService.getJobForSession(sid, owner));
    await createReadyProcessingJob(baseUrl, root, context, recording);
    // The fixture marks the DB ready without running the processor's finally block.
    await context.processingService.recoverExpiredJobs();
    await createReadyTranscriptionJob(baseUrl, root, context, recording);
    clock += 11_000;
    await context.oneShot.advance();
    const claimed = await context.minutesRepository.claimNext({ workerId: "auto-worker", now: new Date(clock).toISOString(), leaseExpiresAt: new Date(clock + 600_000).toISOString() });
    assert.ok(claimed);
    assert.equal(claimed.input.additionalSectionRequest, additionalSectionRequest, "ADDITIONAL_REQUEST_JOB");
    const ready = await context.minutesService.processClaimedJob(claimed, "auto-worker");
    assert.equal(ready.status, "ready");
    clock += 11_000;
    await context.oneShot.advance();
    const first = await context.oneShot.archive.get(sid);
    assert.ok(first);
    for (const heading of ["一、會議討論重點", "二、人工確認事實", "三、已定案事項", "四、系統需求整理", "五、仍需確認", "六、後續工作"]) assert.ok(first.html.includes(`<h2>${heading}</h2>`), "FIXED_SECTIONS_PRESERVED");
    assert.equal(first.html.includes('<section id="additional-1"'), Boolean(additionalSectionRequest), "ADDITIONAL_SECTION_ARCHIVE");
    if (additionalSectionRequest) assert.ok(first.html.indexOf('<section id="additional-1"') > first.html.indexOf('<section id="actions"'), "ADDITIONAL_SECTION_ORDER");
    assert.doesNotMatch(first.html, /<audio|<script|transcript\.txt/);
    const originalExpiry = (await context.oneShot.repository.get(sid))!.expiresAt!;
    await context.oneShot.repository.close();
    await context.oneShot.archive.close();
    clock += 11_000;
    await context.oneShot.advance();
    assert.equal((await context.oneShot.repository.get(sid))!.expiresAt, originalExpiry);
    assert.equal((await context.oneShot.archive.stats()).count, 1);
    const status = await fetch(`${baseUrl}/api/meetings/recordings/${sid}/delivery`, { headers: { Cookie: recording.cookie } });
    const statusText = await status.text();
    assert.doesNotMatch(statusText, /ownerId|relativePath|inputSha256/);
    assert.equal(JSON.parse(statusText).data.phase, "ready");
    assert.equal(JSON.parse(statusText).data.additionalSectionRequest, additionalSectionRequest ?? "");
    const currentBeforeRelease = await fetch(`${baseUrl}/api/meetings/recordings/current`, { headers: { Cookie: recording.cookie } });
    assert.equal((await currentBeforeRelease.json() as { data: { sessionId: string | null } }).data.sessionId, sid);
    const released = await fetch(`${baseUrl}/api/meetings/recordings/${sid}/release-current`, { method: "POST", headers: ownerHeaders(recording.cookie) });
    assert.equal(released.status, 204);
    const currentAfterRelease = await fetch(`${baseUrl}/api/meetings/recordings/current`, { headers: { Cookie: recording.cookie } });
    assert.equal((await currentAfterRelease.json() as { data: { sessionId: string | null } }).data.sessionId, null);
    const html = await fetch(`${baseUrl}/api/meetings/recordings/${sid}/delivery/html`, { headers: { Cookie: recording.cookie } });
    assert.equal(html.status, 200);
    assert.equal(await html.text(), first.html);
    // Existing legacy data is seeded internally, never via the retired create API.
    for (const suffix of ["", "/tracks/room-mic", `/minutes/versions/${ready.version!.versionId}/package.zip`]) {
      assert.equal((await fetch(`${baseUrl}/api/meetings/library/recordings/${sid}${suffix}`, { headers: { Cookie: recording.cookie } })).status, 404);
    }
    const legacy = await context.service.createSession({ ownerId: owner, title: "保留的舊錄音", sourceIds: ["room-mic"] });
    const lease = await context.oneShot.repository.acquireAccess(sid, new Date(clock).toISOString(), new Date(Date.parse(originalExpiry) + 60_000).toISOString());
    clock = Date.parse(originalExpiry) + 1;
    await context.oneShot.cleanup();
    assert.equal((await context.oneShot.repository.get(sid))!.cleanedAt, null, "ONE_SHOT_DOWNLOAD_LEASE");
    await access(path.join(root, "processing", sid));
    assert.equal((await fetch(`${baseUrl}/api/meetings/recordings/${sid}/delivery/html`, { headers: { Cookie: recording.cookie } })).status, 410);
    assert.equal((await fetch(`${base}/tracks/room-mic`, { headers: { Cookie: recording.cookie } })).status, 410);
    await context.oneShot.repository.releaseAccess(lease);
    await context.oneShot.cleanup();
    assert.ok((await context.oneShot.repository.get(sid))!.cleanedAt);
    assert.equal((await context.oneShot.repository.get(sid))!.additionalSectionRequest, "");
    await assert.rejects(access(path.join(root, "processing", sid)));
    assert.equal(await context.processingService.getJobForSession(sid, owner), null);
    assert.equal(await context.transcriptionService.getJobForSession(sid, owner), null);
    assert.equal((await context.minutesService.listVersions(sid, owner)).length, 0);
    assert.equal((await context.oneShot.archive.get(sid))!.html, first.html);
    assert.equal((await context.service.getSession(legacy.sessionId, owner)).title, "保留的舊錄音");
    const archived = await fetch(`${baseUrl}/api/meetings/admin/summaries/${sid}/html`, { headers: { Authorization: "Bearer meeting-admin-token" } });
    assert.equal(archived.status, 200);
    assert.equal(await archived.text(), first.html);
  }, { oneShot: true, nowMs: () => clock });
});
}

test("one-shot 額外段落拒絕非文字及超長輸入", async () => {
  await withTestServer(async (baseUrl) => {
    for (const additionalSectionRequest of [null, {}, 7, "字".repeat(2001)]) {
      const response = await fetch(`${baseUrl}/api/meetings/recordings`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Meeting-Request": "1", "X-Meeting-Recorder-Id": "recorder-test" },
        body: JSON.stringify({ title: "驗證", sourceIds: ["room-mic"], deliveryMode: "one-shot", additionalSectionRequest }),
      });
      assert.equal(response.status, 400);
      assert.match(await response.text(), /MEETING_ADDITIONAL_SECTIONS_INVALID/);
    }
  }, { oneShot: true });
});

test("retirement: 舊新增與密碼入口拒絕，不能繞過 one-shot admission", async () => {
  await withTestServer(async baseUrl => {
    const base = `${baseUrl}/api/meetings`;
    for (const body of [{ sourceIds: ["room-mic"] }, { deliveryMode: "legacy", sourceIds: ["room-mic"] }]) {
      const result = await fetch(`${base}/recordings`, { method: "POST", headers: { "X-Meeting-Request": "1", "Content-Type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(result.status, 426);
      assert.match(await result.text(), /MEETING_CLIENT_UPDATE_REQUIRED/);
    }
    for (const endpoint of ["library-access", "recordings/library", "recordings/library-access", "recordings/library/rotate-code", `admin/libraries/${OWNER_IDS[0]}/open`, `admin/libraries/${OWNER_IDS[0]}/rotate-code`]) {
      const result = await fetch(`${base}/${endpoint}`, { method: "POST", headers: { "X-Meeting-Request": "1", Authorization: "Bearer meeting-admin-token", "Content-Type": "application/json" }, body: JSON.stringify({ code: "ABC-234" }) });
      assert.equal(result.status, 404, endpoint);
    }
  }, { oneShot: true });
});

test("retirement: 舊 session 可續傳、冪等 finalize、Range 下載，權限撤銷與開發者唯讀隔離", async () => {
  let clock = Date.parse("2026-09-09T00:00:00Z");
  await withTestServer(async (baseUrl, root, context) => {
    const db = await open({ filename: path.join(root, "processing.sqlite3"), driver: sqlite3.Database });
    try {
      await db.exec("CREATE TABLE meeting_libraries (library_id TEXT PRIMARY KEY, access_version INTEGER NOT NULL, revoked_at TEXT)");
      await db.run("INSERT INTO meeting_libraries VALUES (?, 1, NULL)", OWNER_IDS[0]);
      const capability = "a".repeat(43);
      const session = await context.service.createSession({ ownerId: OWNER_IDS[0], title: "舊錄音", sourceIds: ["room-mic"], recorderGrantId: OWNER_IDS[1], sessionCapability: capability, recorderLibraryAccessVersion: 1, sessionCapabilityExpiresAt: new Date(clock + 60_000).toISOString() });
      const base = `${baseUrl}/api/meetings/recordings/${session.sessionId}`;
      const headers = { "X-Meeting-Request": "1", "X-Meeting-Session-Capability": capability };
      assert.equal((await fetch(base)).status, 401);
      assert.equal((await fetch(base, { headers: { "X-Meeting-Session-Capability": "b".repeat(43) } })).status, 404);
      const second = await context.service.createSession({ ownerId: OWNER_IDS[1], sourceIds: ["room-mic"] });
      assert.equal((await fetch(`${baseUrl}/api/meetings/recordings/${second.sessionId}`, { headers })).status, 401);
      assert.equal((await fetch(`${base}/tracks/room-mic/chunks/0`, { method: "PUT", headers: { ...headers, "Content-Type": "audio/webm" }, body: "audio-body" })).status, 200);
      const finalize = () => fetch(`${base}/finalize`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ durationMs: 5000, tracks: [{ sourceId: "room-mic", chunkCount: 1 }] }) });
      assert.equal((await finalize()).status, 200);
      assert.equal((await finalize()).status, 200);
      const status = await fetch(`${base}/delivery`, { headers });
      assert.equal(status.status, 200);
      assert.equal((await status.json() as { data: { phase: string } }).data.phase, "legacy-saved");
      const range = await fetch(`${base}/tracks/room-mic`, { headers: { ...headers, Range: "bytes=0-4" } });
      assert.equal(range.status, 206);
      assert.equal(await range.text(), "audio");
      for (const suffix of ["process", "transcriptions", "processing-jobs/old/retry"]) {
        assert.equal((await fetch(`${base}/${suffix}`, { method: "POST", headers })).status, 410);
      }
      const adminBase = `${baseUrl}/api/meetings/admin/legacy-recordings`;
      assert.equal((await fetch(adminBase, { headers })).status, 401);
      const adminHeaders = { Authorization: "Bearer meeting-admin-token" };
      const listing = await fetch(adminBase, { headers: adminHeaders });
      assert.equal(listing.status, 200);
      assert.doesNotMatch(await listing.text(), /ownerId|sessionCapability|recorderGrantId|relativePath/);
      assert.equal((await fetch(`${adminBase}/${session.sessionId}/tracks/room-mic`, { headers: adminHeaders })).status, 200);
      assert.equal((await fetch(`${adminBase}/${session.sessionId}/abort`, { method: "POST", headers: { ...adminHeaders, "X-Meeting-Request": "1" } })).status, 404);
      await db.run("UPDATE meeting_libraries SET access_version=2");
      assert.equal((await fetch(`${base}/delivery`, { headers })).status, 401);
      await db.run("UPDATE meeting_libraries SET access_version=1, revoked_at='2026-09-09'");
      assert.equal((await fetch(base, { headers })).status, 401);
      await db.run("UPDATE meeting_libraries SET revoked_at=NULL");
      clock += 60_001;
      const expired = await fetch(base, { headers });
      assert.equal(expired.status, 401);
      assert.match(await expired.text(), /CAPABILITY_EXPIRED/);
      assert.equal((await context.service.getSession(session.sessionId, OWNER_IDS[0])).status, "finalized");
    } finally { await db.close(); }
  }, { oneShot: true, nowMs: () => clock });
});

test("one-shot archive full 暫停新 admission，不移除既有 HTML", async () => {
  await withTestServer(async (baseUrl, _root, context) => {
    await context.oneShot.archive.publish({ sessionId: SESSION_IDS[0], title: "Saved", meetingDate: null, generatedAt: new Date().toISOString(), versionNumber: 1, html: "12345678" }, new Date().toISOString());
    const response = await fetch(`${baseUrl}/api/meetings/recordings`, { method: "POST", headers: { "X-Meeting-Request": "1", "X-Meeting-Recorder-Id": "recorder-test", "Content-Type": "application/json" }, body: JSON.stringify({ deliveryMode: "one-shot", sourceIds: ["room-mic"] }) });
    assert.equal(response.status, 503);
    assert.match(await response.text(), /MEETING_SUMMARY_ARCHIVE_FULL/);
    assert.equal((await context.oneShot.archive.get(SESSION_IDS[0]))!.html, "12345678");
  }, { oneShot: true, archiveMaxBytes: 8 });
});

test("開發者會議 API 將沒有 recorder lease 或背景 job 的舊 session 標為中斷且不占名額", async () => {
  await withTestServer(async (baseUrl, _root, context) => {
    await context.oneShot.repository.register({
      sessionId: SESSION_IDS[0],
      ownerId: OWNER_IDS[0],
      title: "未釋放會議",
      createdAt: "2026-09-14T00:00:00.000Z",
    });
    const live = context.oneShot as unknown as { liveRepository: { progress(): Promise<never> } };
    live.liveRepository.progress = async () => assert.fail("ADMIN_LIST_MUST_NOT_SCAN_LIVE_CHUNKS");
    let processingLists = 0;
    let transcriptionLists = 0;
    let minutesLists = 0;
    const listProcessing = context.processingService.listJobStatesForSessions.bind(context.processingService);
    const listTranscription = context.transcriptionService.listJobStatesForSessions.bind(context.transcriptionService);
    const listMinutes = context.minutesService.listJobStatesForSessions.bind(context.minutesService);
    context.processingService.listJobStatesForSessions = async sessionIds => {
      processingLists += 1;
      return listProcessing(sessionIds);
    };
    context.transcriptionService.listJobStatesForSessions = async sessionIds => {
      transcriptionLists += 1;
      return listTranscription(sessionIds);
    };
    context.minutesService.listJobStatesForSessions = async sessionIds => {
      minutesLists += 1;
      return listMinutes(sessionIds);
    };

    const response = await fetch(`${baseUrl}/api/meetings/admin/meetings`, {
      headers: { Authorization: "Bearer meeting-admin-token" },
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      data: {
        meetings: Array<{ sessionId: string; title: string; phase: string; occupiesSlot: boolean; source: { displayName: string } }>;
        stats: { activeMeetings: number; maxMeetings: number };
      };
    };
    assert.deepEqual(payload.data.stats, { activeMeetings: 0, maxMeetings: 2 });
    assert.deepEqual(payload.data.meetings.map(meeting => ({
      sessionId: meeting.sessionId, title: meeting.title, phase: meeting.phase,
      occupiesSlot: meeting.occupiesSlot, source: meeting.source,
    })), [{
      sessionId: SESSION_IDS[0], title: "未釋放會議", phase: "interrupted",
      occupiesSlot: false, source: { displayName: "未命名來源", userAgent: null, ip: null },
    }]);
    assert.deepEqual([processingLists, transcriptionLists, minutesLists], [1, 1, 1],
      "ADMIN_LIST_LOADS_EACH_JOB_TABLE_ONCE");
    assert.equal((await fetch(`${baseUrl}/api/meetings/admin/devices`, {
      headers: { Authorization: "Bearer meeting-admin-token" },
    })).status, 404, "舊裝置管理入口已退場");
  }, { oneShot: true });
});

test("finalized 錄音取消後拒絕再次 finalize，並由取消清理回收檔案", async () => {
  await withTestServer(async (baseUrl, root, context) => {
    const recording = await createFinalizedRecordingWithLibrary(baseUrl, "取消 finalized 錄音", "one-shot");
    const base = `${baseUrl}/api/meetings/recordings/${recording.sessionId}`;
    const beforeCancel = await fetch(`${base}/delivery`, { headers: { Cookie: recording.cookie } });
    assert.equal(beforeCancel.status, 200);
    assert.equal((await beforeCancel.json() as { data: { phase: string } }).data.phase, "processing",
      "FINALIZED_WITHOUT_JOB_IS_PROCESSING");

    const cancelled = await fetch(`${baseUrl}/api/meetings/admin/meetings/${recording.sessionId}/cancel`, {
      method: "POST",
      headers: { Authorization: "Bearer meeting-admin-token" },
    });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json() as { data: { phase: string } }).data.phase, "cancelling");

    const finalizeAgain = await fetch(`${base}/finalize`, {
      method: "POST",
      headers: ownerHeaders(recording.cookie, { "Content-Type": "application/json" }),
      body: JSON.stringify({ durationMs: 5_000, tracks: [{ sourceId: "room-mic", chunkCount: 1 }] }),
    });
    assert.equal(finalizeAgain.status, 409);
    assert.match(await finalizeAgain.text(), /MEETING_CANCEL_IN_PROGRESS/);

    const processAgain = await fetch(`${base}/process`, {
      method: "POST",
      headers: ownerHeaders(recording.cookie),
    });
    assert.equal(processAgain.status, 409);
    assert.match(await processAgain.text(), /MEETING_CANCEL_IN_PROGRESS/,
      "CANCELLING_SESSION_MUST_REJECT_NEW_BACKGROUND_JOBS");

    await new Promise(resolve => setImmediate(resolve));
    await context.oneShot.advance();
    const settled = await context.oneShot.repository.get(recording.sessionId);
    assert.ok(settled?.cancelledAt);
    assert.equal(settled.cleanupAfter, settled.cancelledAt);
    assert.equal(settled.expiresAt, null);
    assert.deepEqual(await context.oneShot.repository.admissionStats(2), { activeMeetings: 0, maxMeetings: 2 });

    await new Promise(resolve => setImmediate(resolve));
    await context.oneShot.cleanup();
    const cleaned = await context.oneShot.repository.get(recording.sessionId);
    assert.ok(cleaned?.cleanedAt);
    await assert.rejects(context.service.getSession(recording.sessionId, OWNER_IDS[0]),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "MEETING_RECORDING_NOT_FOUND");
    await assert.rejects(access(path.join(root, "recordings", recording.sessionId)));
  }, { oneShot: true });
});

test("開發者重試失敗會議會先重新取得 admission", async () => {
  await withTestServer(async (baseUrl, _root, context) => {
    const createdAt = "2026-09-14T00:00:00.000Z";
    const recording = await createFinalizedRecordingWithLibrary(baseUrl, "待重試會議", "one-shot");
    const sessionId = recording.sessionId;
    const ownerId = (await context.oneShot.repository.get(sessionId))!.ownerId;
    await context.processingRepository.enqueue({
      jobId: PROCESSING_JOB_IDS[0], sessionId, ownerId,
      maxAttempts: 1, now: createdAt,
    });
    await context.processingRepository.claimNext({
      workerId: "worker", now: createdAt, leaseExpiresAt: "2026-09-14T00:10:00.000Z",
    });
    await context.processingRepository.markFailed({
      jobId: PROCESSING_JOB_IDS[0], workerId: "worker", errorCode: "FFMPEG_FAILED",
      errorMessage: "failed", now: createdAt,
    });
    assert.equal((await context.oneShot.status(sessionId, ownerId)).retryAvailable, false,
      "terminal job 完成與 pipeline release 之間不能先顯示可重試");
    assert.equal(await context.oneShot.settleTerminalFailure(sessionId), true);
    assert.equal((await context.oneShot.status(sessionId, ownerId)).retryAvailable, true);
    assert.deepEqual(await context.oneShot.repository.admissionStats(2), { activeMeetings: 0, maxMeetings: 2 });

    const response = await fetch(`${baseUrl}/api/meetings/admin/meetings/${sessionId}/retry`, {
      method: "POST",
      headers: { Authorization: "Bearer meeting-admin-token" },
    });
    const responseBody = await response.text();
    assert.equal(response.status, 202, responseBody);
    const retried = (JSON.parse(responseBody) as { data: { phase: string; occupiesSlot: boolean } }).data;
    assert.equal(retried.phase, "processing");
    assert.equal(retried.occupiesSlot, true);
    assert.deepEqual(await context.oneShot.repository.admissionStats(2), { activeMeetings: 1, maxMeetings: 2 });
    assert.deepEqual(await context.processingRepository.getJob(PROCESSING_JOB_IDS[0]).then(job => ({
      status: job?.status, attemptCount: job?.attemptCount,
    })), { status: "pending", attemptCount: 0 });
  }, { oneShot: true });
});

test("Cookie 只維持歸屬，瀏覽器不限量且全系統最多兩場會議", async () => {
  await withTestServer(async (baseUrl, _root, context) => {
    const untouched = await fetch(`${baseUrl}/api/meetings/recordings/current`);
    assert.deepEqual(await untouched.json(), { data: { source: null, sessionId: null } });
    const adminHeaders = { Authorization: "Bearer meeting-admin-token" };
    const emptyMeetings = await fetch(`${baseUrl}/api/meetings/admin/meetings`, { headers: adminHeaders });
    assert.equal((await emptyMeetings.json() as { data: { meetings: unknown[] } }).data.meetings.length, 0, "只開頁面不能占用名額");
    const create = (cookie: string | null, recorderId: string) => fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        "Content-Type": "application/json",
        "X-Meeting-Request": "1",
        "X-Meeting-Recorder-Id": recorderId,
      },
      body: JSON.stringify({ deliveryMode: "one-shot", sourceIds: ["room-mic"] }),
    });

    const first = await create(null, "tab-a");
    assert.equal(first.status, 201);
    const firstCookie = ownerCookie(first);
    const firstSession = (await first.json() as { data: { sessionId: string } }).data.sessionId;
    const heartbeat = await fetch(`${baseUrl}/api/meetings/recordings/${firstSession}/heartbeat`, {
      method: "POST", headers: ownerHeaders(firstCookie, { "X-Meeting-Recorder-Id": "tab-a" }),
    });
    assert.equal(heartbeat.status, 204);
    const reused = await create(firstCookie, "tab-a-observer");
    assert.equal(reused.status, 200);
    assert.equal((await reused.json() as { data: { sessionId: string } }).data.sessionId, firstSession);
    const rejectedHeartbeat = await fetch(`${baseUrl}/api/meetings/recordings/${firstSession}/heartbeat`, {
      method: "POST", headers: ownerHeaders(firstCookie, { "X-Meeting-Recorder-Id": "tab-a-observer" }),
    });
    assert.equal(rejectedHeartbeat.status, 409);
    assert.match(await rejectedHeartbeat.text(), /MEETING_RECORDER_LEASE_NOT_OWNER/);

    const rejectedRecorder = await fetch(`${baseUrl}/api/meetings/recordings/${firstSession}/tracks/room-mic/chunks/0`, {
      method: "PUT", headers: ownerHeaders(firstCookie, { "Content-Type": "audio/webm", "X-Meeting-Recorder-Id": "tab-a-observer" }), body: "audio",
    });
    assert.equal(rejectedRecorder.status, 409);
    assert.match(await rejectedRecorder.text(), /MEETING_RECORDER_LEASE_NOT_OWNER/);

    const second = await create(null, "tab-b");
    assert.equal(second.status, 201);
    const third = await create(null, "tab-c");
    assert.equal(third.status, 409);
    assert.match(await third.text(), /目前已有 2 場會議進行中，請待其中一場完成後再開始錄音/);
    const thirdCookie = ownerCookie(third);

    const listing = await fetch(`${baseUrl}/api/meetings/admin/meetings`, { headers: adminHeaders });
    const meetings = (await listing.json() as { data: { meetings: Array<{ sessionId: string }>; stats: { activeMeetings: number } } }).data;
    assert.equal(meetings.meetings.length, 2);
    assert.equal(meetings.stats.activeMeetings, 2);
    const cancelled = await fetch(`${baseUrl}/api/meetings/admin/meetings/${firstSession}/cancel`, {
      method: "POST", headers: adminHeaders,
    });
    assert.equal(cancelled.status, 200);
    const cancelledMeeting = (await cancelled.json() as { data: { phase: string; occupiesSlot: boolean } }).data;
    assert.equal(cancelledMeeting.phase, "cancelling");
    assert.equal(cancelledMeeting.occupiesSlot, true, "worker 確認資源停止前不能交還名額");
    assert.equal((await create(firstCookie, "tab-a-new")).status, 409, "同一 owner 不能在取消中誤重用已刪除的錄音");
    assert.equal((await create(thirdCookie, "tab-c")).status, 409, "取消尚未 settle 時仍不能超收第三場");
    await context.oneShot.advance();
    const detached = await fetch(`${baseUrl}/api/meetings/recordings/current`, { headers: { Cookie: firstCookie } });
    assert.deepEqual(await detached.json(), { data: { source: null, sessionId: null } });
    assert.equal((await fetch(`${baseUrl}/api/meetings/recordings/${firstSession}/release-current`, {
      method: "POST", headers: ownerHeaders(firstCookie),
    })).status, 204, "已取消結果可以正常離開");

    const replacement = await create(thirdCookie, "tab-c");
    assert.equal(replacement.status, 201);
    assert.equal(replacement.headers.get("set-cookie"), null, "容量拒絕時取得的 owner cookie 可直接重試");
    let currentCookie = thirdCookie;
    let currentSession = (await replacement.json() as { data: { sessionId: string } }).data.sessionId;
    for (let index = 0; index < 8; index += 1) {
      const aborted = await fetch(`${baseUrl}/api/meetings/recordings/${currentSession}/abort`, {
        method: "POST", headers: ownerHeaders(currentCookie, { "X-Meeting-Recorder-Id": `tab-${index === 0 ? "c" : index - 1}` }),
      });
      assert.equal(aborted.status, 204);
      const pendingAttempt = await create(null, `tab-pending-${index}`);
      assert.equal(pendingAttempt.status, 409,
        `中止尚未 settle 時仍占用名額：${await pendingAttempt.text()}`);
      await context.oneShot.advance();
      const next = await create(null, `tab-${index}`);
      assert.equal(next.status, 201, "歷史瀏覽器數量不影響新會議 admission");
      currentCookie = ownerCookie(next);
      currentSession = (await next.json() as { data: { sessionId: string } }).data.sessionId;
    }
  }, { oneShot: true });
});

test("API finalize 尚未結束時管理員取消仍占位，worker 不會提前完成取消", async () => {
  await withTestServer(async (baseUrl, _root, context) => {
    const created = await fetch(`${baseUrl}/api/meetings/recordings`, { method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1", "X-Meeting-Recorder-Id": "recorder-test" },
      body: JSON.stringify({ deliveryMode: "one-shot", sourceIds: ["room-mic"] }) });
    const cookie = ownerCookie(created);
    const sessionId = (await created.json() as { data: { sessionId: string } }).data.sessionId;
    const captured = await context.service.getSession(sessionId, OWNER_IDS[0]);
    let entered!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    context.service.finalizeSession = async () => { entered(); await gate; return captured; };
    const finalizing = fetch(`${baseUrl}/api/meetings/recordings/${sessionId}/finalize`, { method: "POST",
      headers: ownerHeaders(cookie, { "Content-Type": "application/json" }),
      body: JSON.stringify({ durationMs: 5000, tracks: [{ sourceId: "room-mic", chunkCount: 1 }] }) });
    try {
      await started;
      const beforeCancel = await context.oneShot.getMeetingForAdmin(sessionId);
      assert.equal(beforeCancel.phase, "finalizing");
      assert.equal(beforeCancel.occupiesSlot, true);
      const cancelled = await fetch(`${baseUrl}/api/meetings/admin/meetings/${sessionId}/cancel`, {
        method: "POST", headers: { Authorization: "Bearer meeting-admin-token" } });
      assert.equal(cancelled.status, 200);
      assert.equal(await context.oneShot.settleCancellation(sessionId), false, "API_OPERATION_MUST_SETTLE_BEFORE_CANCEL_COMPLETES");
      assert.equal((await context.oneShot.availability()).admission.activeMeetings, 1);
      finish();
      assert.equal((await finalizing).status, 200);
      assert.equal(await context.oneShot.settleCancellation(sessionId), true);
      assert.equal((await context.oneShot.availability()).admission.activeMeetings, 0);
      assert.equal((await context.oneShot.getMeetingForAdmin(sessionId)).actions.canCancel, false);
      await context.oneShot.advance();
      assert.equal(await context.processingService.getJobForSession(sessionId, OWNER_IDS[0]), null,
        "CANCELLED_FINALIZE_MUST_NOT_ENQUEUE_PROCESSING");
    } finally { finish(); await finalizing; }
  }, { oneShot: true });
});

test("部署升級後由 owner 的第一個新分頁接手既有 one-shot session", async () => {
  await withTestServer(async (baseUrl, root) => {
    const created = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1", "X-Meeting-Recorder-Id": "old-tab" },
      body: JSON.stringify({ deliveryMode: "one-shot", sourceIds: ["room-mic"] }),
    });
    assert.equal(created.status, 201);
    const cookie = ownerCookie(created);
    const sessionId = (await created.json() as { data: { sessionId: string } }).data.sessionId;

    const db = await open({ filename: path.join(root, "processing.sqlite3"), driver: sqlite3.Database });
    try {
      await db.run("DELETE FROM meeting_recording_devices");
      await db.run("UPDATE meeting_one_shot_sessions SET recorder_id='legacy' WHERE session_id=?", sessionId);
    } finally {
      await db.close();
    }

    const current = await fetch(`${baseUrl}/api/meetings/recordings/current`, {
      headers: { Cookie: cookie, "X-Meeting-Recorder-Id": "adopted-tab" },
    });
    assert.equal(current.status, 200);
    assert.equal((await current.json() as { data: { sessionId: string | null } }).data.sessionId, sessionId);

    const resumedChunk = await fetch(`${baseUrl}/api/meetings/recordings/${sessionId}/tracks/room-mic/chunks/0`, {
      method: "PUT",
      headers: ownerHeaders(cookie, { "Content-Type": "audio/webm", "X-Meeting-Recorder-Id": "adopted-tab" }),
      body: "audio",
    });
    assert.equal(resumedChunk.status, 200);
    const meetings = await fetch(`${baseUrl}/api/meetings/admin/meetings`, { headers: { Authorization: "Bearer meeting-admin-token" } });
    assert.equal((await meetings.json() as { data: { meetings: unknown[] } }).data.meetings.length, 1);
  }, { oneShot: true });
});

async function createFinalizedRecordingWithLibrary(
  baseUrl: string,
  title: string,
  deliveryMode?: "one-shot",
  additionalSectionRequest?: string
): Promise<{
  cookie: string;
  sessionId: string;
}> {
  const createResponse = await fetch(`${baseUrl}/api/meetings/recordings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Meeting-Request": "1", "X-Meeting-Recorder-Id": "recorder-test" },
    body: JSON.stringify({ title, sourceIds: ["room-mic"], deliveryMode, additionalSectionRequest }),
  });
  assert.equal(createResponse.status, 201);
  const cookie = ownerCookie(createResponse);
  const created = (await createResponse.json()) as {
    data: { sessionId: string };
    meta: { libraryCode: string | null };
  };
  const chunk = await fetch(
    `${baseUrl}/api/meetings/recordings/${created.data.sessionId}/tracks/room-mic/chunks/0`,
    {
      method: "PUT",
      headers: ownerHeaders(cookie, { "Content-Type": "audio/webm" }),
      body: Buffer.from("audio-body"),
    }
  );
  assert.equal(chunk.status, 200);
  const finalized = await fetch(
    `${baseUrl}/api/meetings/recordings/${created.data.sessionId}/finalize`,
    {
      method: "POST",
      headers: ownerHeaders(cookie, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        durationMs: 5_000,
        tracks: [{ sourceId: "room-mic", chunkCount: 1 }],
      }),
    }
  );
  assert.equal(finalized.status, 200);
  return {
    cookie,
    sessionId: created.data.sessionId,
  };
}

async function createReadyProcessingJob(
  baseUrl: string,
  root: string,
  context: {
    processingRepository: MeetingProcessingJobRepository;
  },
  input: { cookie: string; sessionId: string; withPlayback?: boolean }
): Promise<string> {
  const accepted = await fetch(
    `${baseUrl}/api/meetings/recordings/${input.sessionId}/process`,
    { method: "POST", headers: ownerHeaders(input.cookie) }
  );
  assert.equal(accepted.status, 202);
  const acceptedPayload = (await accepted.json()) as { data: { jobId: string } };
  const claimed = await context.processingRepository.claimNext({
    workerId: "processing-worker",
    now: "2026-07-16T08:00:00.000Z",
    leaseExpiresAt: "2026-07-16T08:10:00.000Z",
  });
  assert.ok(claimed);
  const relativePath = `${input.sessionId}/room-mic.wav`;
  const filePath = path.join(root, "processing", relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "canonical-audio");
  if (input.withPlayback) await writeFile(path.join(path.dirname(filePath), "playback.m4a"), "playable-audio");
  await context.processingRepository.markReady({
    jobId: claimed.jobId,
    workerId: "processing-worker",
    now: "2026-07-16T08:01:00.000Z",
    artifacts: [
      ...(input.withPlayback ? [{ artifactId: "playback", jobId: claimed.jobId, sessionId: input.sessionId,
        type: "playback" as const, mimeType: "audio/mp4", relativePath: `${input.sessionId}/playback.m4a`,
        sizeBytes: 14, sha256: "playback-sha", createdAt: "2026-07-16T08:01:00.000Z" }] : []),
      {
        artifactId: "canonical-room-mic",
        jobId: claimed.jobId,
        sessionId: input.sessionId,
        type: "canonical-room-mic",
        mimeType: "audio/wav",
        relativePath,
        sizeBytes: 15,
        sha256: "canonical-sha",
        createdAt: "2026-07-16T08:01:00.000Z",
      },
    ],
  });
  return acceptedPayload.data.jobId;
}

async function createReadyTranscriptionJob(
  baseUrl: string,
  root: string,
  context: {
    transcriptionRepository: MeetingTranscriptionJobRepository;
  },
  input: { cookie: string; sessionId: string }
): Promise<string> {
  const accepted = await fetch(
    `${baseUrl}/api/meetings/recordings/${input.sessionId}/transcriptions`,
    { method: "POST", headers: ownerHeaders(input.cookie) }
  );
  assert.equal(accepted.status, 202);
  const acceptedPayload = (await accepted.json()) as { data: { jobId: string } };
  const claimed = await context.transcriptionRepository.claimNext({
    workerId: "transcription-worker",
    now: "2026-07-16T08:02:00.000Z",
    leaseExpiresAt: "2026-07-16T08:12:00.000Z",
  });
  assert.ok(claimed);
  const transcriptDir = path.join(root, "processing", input.sessionId, "transcript");
  await mkdir(transcriptDir, { recursive: true });
  const mergedPath = path.join(transcriptDir, "merged.json");
  const textPath = path.join(transcriptDir, "transcript.txt");
  const merged = JSON.stringify({
    version: 1,
    sessionId: input.sessionId,
    language: "zh-TW",
    provider: "fake",
    model: "fake-model",
    generatedAt: "2026-07-16T08:03:00.000Z",
    segments: [{ segmentId: "merged:0", startMs: 0, endMs: 1000, text: "測試逐字稿", primarySourceId: "room-mic", sourceSegmentIds: ["room-mic:0"], speakerLabel: null }],
  });
  const transcriptText = "[00:00:00] 測試逐字稿\n";
  await Promise.all([
    writeFile(mergedPath, merged),
    writeFile(textPath, transcriptText),
  ]);
  await context.transcriptionRepository.markReady({
    jobId: claimed.jobId,
    workerId: "transcription-worker",
    now: "2026-07-16T08:03:00.000Z",
    artifacts: [
      {
        artifactId: "transcript-merged",
        jobId: claimed.jobId,
        sessionId: input.sessionId,
        type: "transcript-merged-json",
        mimeType: "application/json; charset=utf-8",
        relativePath: path.relative(path.join(root, "processing"), mergedPath),
        sizeBytes: Buffer.byteLength(merged),
        sha256: "merged-sha",
        createdAt: "2026-07-16T08:03:00.000Z",
      },
      {
        artifactId: "transcript-text",
        jobId: claimed.jobId,
        sessionId: input.sessionId,
        type: "transcript-text",
        mimeType: "text/plain; charset=utf-8",
        relativePath: path.relative(path.join(root, "processing"), textPath),
        sizeBytes: Buffer.byteLength(transcriptText),
        sha256: "text-sha",
        createdAt: "2026-07-16T08:03:00.000Z",
      },
    ],
  });
  return acceptedPayload.data.jobId;
}

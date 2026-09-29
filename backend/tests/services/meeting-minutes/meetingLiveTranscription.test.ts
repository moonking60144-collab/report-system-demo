import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { MeetingLiveTranscriptionRepository, type LiveChunk } from "../../../src/storage/meeting-minutes/meetingLiveTranscriptionRepository";
import { MeetingOneShotRepository } from "../../../src/storage/meeting-minutes/meetingOneShotRepository";
import { MeetingTranscriptionJobRepository } from "../../../src/storage/meeting-minutes/meetingTranscriptionJobRepository";
import { MeetingRecordingStorageService } from "../../../src/services/meeting-minutes/meetingRecordingStorageService";
import { MeetingLiveTranscriptionService, liveTranscriptionProfile } from "../../../src/services/meeting-minutes/meetingLiveTranscriptionService";
import { MeetingTranscriptProcessor } from "../../../src/services/meeting-minutes/meetingTranscriptProcessor";
import { appendWindowSegments, pcmWave, wavePcm, pcmHash } from "../../../src/services/meeting-minutes/meetingLiveAudio";
import { MeetingOneShotService } from "../../../src/services/meeting-minutes/meetingOneShotService";
import { HttpError } from "../../../src/utils/httpError";

test("live window leases are exclusive, stale results rejected, and gaps cannot report complete progress", async () => {
  const root = await mkdtemp(path.join(tmpdir(),"live-lease-"));
  const a = new MeetingLiveTranscriptionRepository(path.join(root,"db.sqlite"));
  const b = new MeetingLiveTranscriptionRepository(path.join(root,"db.sqlite"));
  const chunk: LiveChunk = { sessionId:"test",sourceId:"room-mic",chunkIndex:0,profile:"p",audioHash:"hash",audioPath:"test.wav",startMs:0,endMs:60000,windowStartMs:0,windowEndMs:62000 };
  try {
    await a.source("test","room-mic","p",120000,false);
    await a.register(chunk);
    const claims = await Promise.all([a.claim("p","a",0,1000),b.claim("p","b",0,1000)]);
    assert.equal(claims.filter(Boolean).length,1,"LIVE_LEASE_EXCLUSIVE");
    const original = claims[0] ? "a" : "b";
    assert.ok(await b.claim("p","replacement",1001,1000));
    assert.equal(await a.finish(original,[]),false,"STALE_LEASE_CANNOT_PUBLISH");
    assert.equal(await b.finish("replacement",[]),true);
    assert.deepEqual(await a.cached(chunk),[]);
    assert.equal(await a.cached({...chunk,audioHash:"different"}),null);
    assert.equal(await a.cached({...chunk,profile:"different"}),null);
    await a.register({...chunk,chunkIndex:2,startMs:120000,endMs:180000});
    await b.claim("p","third",2002,1000); await b.finish("third",[]);
    assert.equal((await a.progress("test","p"))[0].processedMs,60000,"PROGRESS_STOPS_AT_GAP");
  } finally { await a.close();await b.close();await rm(root,{recursive:true,force:true}); }
});

test("uncertain ASR timestamp drift and regrouping preserve original utterances", () => {
  for (const shift of [-200,0,200]) {
    const previous = [{startMs:58000,endMs:61900+shift,text:"目前尚未核准。"}];
    appendWindowSegments(previous,[{startMs:58000,endMs:62100-shift,text:"目前尚未核准。"},
      {startMs:63000,endMs:65000,text:"後來更正為五個工作天。"}]);
    assert.deepEqual(previous.map(s=>s.text),["目前尚未核准。","目前尚未核准。","後來更正為五個工作天。"],"UNCERTAIN_BOUNDARY_SENTENCE_PRESERVED");
  }
  const repeated = [{startMs:1000,endMs:2000,text:"目前尚未核准。"}];
  appendWindowSegments(repeated,[{startMs:58000,endMs:61000,text:"目前尚未核准。"}]);
  assert.equal(repeated.length,2,"SEPARATE_UTTERANCES_PRESERVED");
  const regrouped=[{startMs:57520,endMs:60040,text:"請特別保留尚未核准與"},
    {startMs:60040,endMs:61940,text:"已經否決之間的差別"}];
  appendWindowSegments(regrouped,[{startMs:58000,endMs:61960,text:"特別保留尚未核准與已經否決之間的差別"}]);
  assert.equal(regrouped.length,3,"UNCERTAIN_REGROUPED_SPEECH_PRESERVED");
  for (const [left,right] of [["不良率3.5%","不良率35%"],["溫度-3","溫度3"]]) {
    const values=[{startMs:58000,endMs:61900,text:left}];
    appendWindowSegments(values,[{startMs:58000,endMs:62100,text:right}]);
    assert.deepEqual(values.map(item=>item.text),[left,right],"DIFFERENT_NUMBERS_PRESERVED");
  }
});

test("STT profile 切換只淘汰無 consumer 的舊 pending／過期 running，保留 ready 與有效 inference", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "live-profile-retirement-"));
  const filename = path.join(root, "meeting.sqlite3");
  const sessions = new MeetingOneShotRepository(filename);
  const repository = new MeetingLiveTranscriptionRepository(filename);
  const now = Date.parse("2026-09-16T00:02:00.000Z");
  const chunk = (chunkIndex: number) => ({ sessionId: "profile-session", sourceId: "room-mic" as const, chunkIndex,
    profile: "old", audioHash: String(chunkIndex), audioPath: path.join(root, `${chunkIndex}.wav`),
    startMs: chunkIndex * 60_000, endMs: (chunkIndex + 1) * 60_000, windowStartMs: chunkIndex * 60_000, windowEndMs: (chunkIndex + 1) * 60_000 });
  try {
    await sessions.registerForOwner({ sessionId: "profile-session", ownerId: "owner", recorderId: "tab", title: "profile-session",
      createdAt: new Date(now - 120_000).toISOString(), maxPipelines: 2 });
    for (let index = 0; index < 4; index += 1) await repository.register(chunk(index));
    await repository.claim("old", "valid", now, 120_000);
    await repository.claim("old", "stale", now, 120_000);
    await repository.claim("old", "ready", now, 120_000);
    await repository.finish("ready", []);
    await repository.heartbeat("stale", now - 1);
    await repository.retireOtherProfiles("current", now);
    assert.equal((await sessions.admissionStats(2, new Date(now).toISOString())).activeMeetings, 1,
      "OLD_PROFILE_VALID_INFERENCE_MUST_REMAIN_ADMITTED");
    assert.deepEqual(await repository.cached(chunk(2)), [], "READY_CACHE_MUST_BE_PRESERVED");
    assert.equal(await repository.claim("old", "cannot-revive", now, 120_000), null,
      "SUPERSEDED_OLD_PENDING_MUST_NOT_BE_CLAIMABLE");
    await repository.retireOtherProfiles("current", now + 120_001);
    assert.equal((await sessions.admissionStats(2, new Date(now + 120_001).toISOString())).activeMeetings, 0,
      "UNCONSUMED_OLD_PROFILE_MUST_NOT_HOLD_CAPACITY");
  } finally { await sessions.close(); await repository.close(); await rm(root, { recursive: true, force: true }); }
});

test("disabled STT 仍週期淘汰到期工作，保留有效 lease 且不執行 inference", async context => {
  const startedAt = Date.parse("2026-09-16T00:00:00.000Z");
  context.mock.timers.enable({ apis: ["setInterval", "Date"], now: startedAt });
  const root = await mkdtemp(path.join(tmpdir(), "live-disabled-retirement-"));
  const filename = path.join(root, "meeting.sqlite3");
  const sessions = new MeetingOneShotRepository(filename);
  const repository = new MeetingLiveTranscriptionRepository(filename);
  const service = new MeetingLiveTranscriptionService({ sessions, repository, provider: {
    enabled: false, name: "disabled", model: "disabled", transcribe: async () => { assert.fail("DISABLED_MUST_NOT_TRANSCRIBE"); },
  } });
  try {
    await sessions.registerForOwner({ sessionId: "old", ownerId: "old", recorderId: "old", title: "old",
      createdAt: new Date(startedAt).toISOString(), maxPipelines: 2 });
    await repository.register({ sessionId: "old", sourceId: "room-mic", chunkIndex: 0, profile: "old",
      audioHash: "hash", audioPath: "test.wav", startMs: 0, endMs: 60_000, windowStartMs: 0, windowEndMs: 62_000 });
    await repository.claim("old", "in-flight", startedAt, 120_000);
    service.start();
    await service.pump();
    assert.equal((await sessions.admissionStats(2, new Date(startedAt + 100_000).toISOString())).activeMeetings, 1);
    context.mock.timers.tick(120_001);
    await service.pump();
    assert.equal((await sessions.admissionStats(2, new Date().toISOString())).activeMeetings, 0);
    assert.equal(await repository.heartbeat("in-flight", Date.now() + 120_000), false);
  } finally { await service.stop(); await sessions.close(); await repository.close(); await rm(root, { recursive: true, force: true }); }
});

test("最後一次 live attempt 先收斂才釋放，晚到 heartbeat 與 aborted retry 不會復活", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "live-exhausted-retirement-"));
  const filename = path.join(root, "meeting.sqlite3");
  const sessions = new MeetingOneShotRepository(filename);
  const repository = new MeetingLiveTranscriptionRepository(filename);
  const startedAt = Date.parse("2026-09-16T00:00:00.000Z");
  const later = startedAt + 180_000;
  try {
    await sessions.registerForOwner({ sessionId: "old", ownerId: "old", recorderId: "old", title: "old",
      createdAt: new Date(startedAt).toISOString(), maxPipelines: 2 });
    await repository.register({ sessionId: "old", sourceId: "room-mic", chunkIndex: 0, profile: "p",
      audioHash: "hash", audioPath: "test.wav", startMs: 0, endMs: 60_000, windowStartMs: 0, windowEndMs: 62_000 });
    for (let attempt = 0; attempt < 3; attempt++) assert.ok(await repository.claim("p", `attempt-${attempt}`, startedAt + attempt * 1000, 1000));
    assert.equal((await sessions.admissionStats(2, new Date(later).toISOString())).activeMeetings, 1,
      "EXHAUSTED_RUNNING_MUST_SETTLE_BEFORE_RELEASE");
    await repository.retireOtherProfiles("p", later);
    assert.equal((await sessions.admissionStats(2, new Date(later).toISOString())).activeMeetings, 0);
    assert.equal(await repository.heartbeat("attempt-2", later + 120_000), false);
    await repository.fail("attempt-2", "late abort", later, true);
    assert.equal(await repository.claim("p", "cannot-revive", later, 120_000), null);
    assert.equal((await sessions.admissionStats(2, new Date(later).toISOString())).activeMeetings, 0);
  } finally { await sessions.close(); await repository.close(); await rm(root, { recursive: true, force: true }); }
});

test("expired decoder 不可續租或排入新 chunks 重新占名額", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "live-decoder-fencing-"));
  const filename = path.join(root, "meeting.sqlite3");
  const sessions = new MeetingOneShotRepository(filename);
  const repository = new MeetingLiveTranscriptionRepository(filename);
  const startedAt = Date.parse("2026-09-16T00:00:00.000Z");
  const later = startedAt + 180_000;
  try {
    await sessions.registerForOwner({ sessionId: "old", ownerId: "old", recorderId: "old", title: "old",
      createdAt: new Date(startedAt).toISOString(), maxPipelines: 2 });
    assert.equal(await repository.renewDecoderLease("old", "room-mic", "p", "decoder", startedAt, 120_000), true);
    assert.equal(await repository.heartbeatDecoderLease("old", "room-mic", "p", "decoder", later + 120_000, later), false);
    await assert.rejects(repository.register({ sessionId: "old", sourceId: "room-mic", chunkIndex: 0, profile: "p",
      audioHash: "hash", audioPath: "test.wav", startMs: 0, endMs: 60_000, windowStartMs: 0, windowEndMs: 62_000 }, "decoder", later));
    assert.equal(await repository.claim("p", "cannot-revive", later, 120_000), null);
    assert.equal((await sessions.admissionStats(2, new Date(later).toISOString())).activeMeetings, 0);
  } finally { await sessions.close(); await repository.close(); await rm(root, { recursive: true, force: true }); }
});

test("a missing session cleanup failure does not stop the following finalized session", async () => {
  const checked:string[]=[],enqueued:string[]=[];
  const service=new MeetingOneShotService({
    repository:{expireRecorderLeases:async()=>undefined,listPendingCancellations:async()=>[],due:async()=>[{sessionId:"missing",ownerId:"o"},{sessionId:"next",ownerId:"o"}],checked:async(id:string)=>{checked.push(id);},forgetMissing:async()=>assert.fail("failed cleanup must retain row"),markRecordingFinalized:async()=>undefined} as never,
    recordings:{getSession:async(id:string)=>{if(id==="missing")throw new HttpError(404,"missing","MEETING_RECORDING_NOT_FOUND");return {status:"finalized"};}} as never,
    liveService:{cleanupSession:async()=>{throw new Error("EBUSY");}} as never,
    processing:{enqueue:async(id:string)=>{enqueued.push(id);return {job:{status:"pending"}};}} as never,
  });
  await service.advance();assert.deepEqual(enqueued,["next"],"CLEANUP_CANNOT_STARVE_OTHER_SESSIONS");assert.deepEqual(checked,["missing","next"]);
});

test("取消清理 live inference 失敗時保留 admission 名額", async () => {
  let cancelPendingCalls = 0;
  let released = false;
  const service = new MeetingOneShotService({
    repository: {
      isCancellationRequested: async () => true,
      completeCancellationIfIdle: async () => { released = true; return true; },
    } as never,
    liveService: { cleanupSession: async () => { throw new Error("live inference still running"); } } as never,
    processing: { cancelPendingForSession: async () => { cancelPendingCalls += 1; } } as never,
    transcription: { cancelPendingForSession: async () => { cancelPendingCalls += 1; } } as never,
    minutes: { cancelPendingForSession: async () => { cancelPendingCalls += 1; } } as never,
  });

  await assert.rejects(service.settleCancellation("session"), /live inference still running/);
  assert.equal(cancelPendingCalls, 0);
  assert.equal(released, false, "LIVE_CLEANUP_FAILURE_MUST_RETAIN_ADMISSION");
});

test("下游 job 仍在執行時不被上游 terminal failure 提前釋放", async () => {
  let released = false;
  const entry = {
    sessionId: "session", ownerId: "owner", title: "test", additionalSectionRequest: "",
    createdAt: "2026-09-14T00:00:00.000Z", expiresAt: null, cleanupStartedAt: null,
    cleanedAt: null, errorCode: null, errorMessage: null, recorderId: "tab",
    pipelineReleasedAt: null, deviceSessionReleasedAt: null, cancelRequestedAt: null,
    cancelledAt: null, sourceName: null, sourceUserAgent: null, sourceIp: null,
  };
  const processing = { status: "failed", attemptCount: 3, maxAttempts: 3, errorCode: "FAILED", errorMessage: "failed" };
  const transcription = { status: "running", attemptCount: 1, maxAttempts: 3, errorCode: null, errorMessage: null };
  const service = new MeetingOneShotService({
    repository: {
      get: async () => entry,
      admissionStats: async () => ({ activeMeetings: 1, maxMeetings: 2 }),
      executionSessionIds: async () => ({ live: new Set(), finalizing: new Set() }),
      releaseTerminalFailure: async () => { released = true; return true; },
    } as never,
    processing: { getJobForSession: async () => processing } as never,
    transcription: { getJobForSession: async () => transcription } as never,
    minutes: {} as never,
    liveRepository: { progress: async () => [] } as never,
  });

  assert.equal((await service.status("session", "owner")).phase, "transcribing");
  assert.equal(await service.settleTerminalFailure("session"), false);
  assert.equal(released, false, "DOWNSTREAM_RUNNING_MUST_RETAIN_ADMISSION");
});

test("terminal live cleanup 失敗時先釋放 SQLite pipeline，再清 process state", async () => {
  const order: string[] = [];
  const entry = {
    sessionId: "session", ownerId: "owner", pipelineReleasedAt: null, cancelRequestedAt: null,
  };
  const service = new MeetingOneShotService({
    repository: {
      get: async () => entry,
      releaseTerminalFailure: async () => { order.push("pipeline"); return true; },
    } as never,
    liveService: {
      cleanupSession: async () => { order.push("cleanup"); throw new Error("EBUSY"); },
      releaseSessionState: async () => { order.push("process-state"); },
    } as never,
  });
  service.status = async () => ({
    processing: { status: "failed", attemptCount: 3, maxAttempts: 3 },
    transcription: null,
    minutes: null,
  }) as never;

  assert.equal(await service.settleTerminalFailure("session"), true);
  assert.deepEqual(order, ["cleanup", "pipeline", "process-state"]);
});

test("shutdown during an awaited claim requeues without starting ASR", async () => {
  let resolveClaim!: (value: LiveChunk) => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve=>{entered=resolve;});
  const calls: string[] = [];
  const service = new MeetingLiveTranscriptionService({
    repository:{claim:()=>{entered();return new Promise<LiveChunk>(resolve=>{resolveClaim=resolve;});},fail:async()=>{calls.push("released");},releaseDecoderLease:async()=>undefined,retireOtherProfiles:async()=>undefined} as never,
    provider:{enabled:true,name:"fake",model:"fake",transcribe:async()=>{calls.push("asr");return [];}}
  });
  const running=service.runOnce(); await waiting; const stopping=service.stop();
  resolveClaim({sessionId:"test"} as LiveChunk); await Promise.all([running,stopping]);
  assert.deepEqual(calls,["released"],"STOPPED_CLAIM_CANNOT_TRANSCRIBE");
});

test("取消標記會阻止其他 worker 開始新的 live ASR", async () => {
  let sealed = 0;
  let transcribed = 0;
  const service = new MeetingLiveTranscriptionService({
    repository: {
      claim: async () => ({ sessionId: "cancelled", audioPath: "unused.wav" }),
      seal: async () => { sealed += 1; },
      retireOtherProfiles: async () => undefined,
    } as never,
    sessions: { get: async () => ({ cancelRequestedAt: "2026-09-14T00:00:00.000Z" }) } as never,
    provider: { enabled: true, name: "fake", model: "fake", transcribe: async () => { transcribed += 1; return []; } },
  });

  assert.equal(await service.runOnce(), true);
  assert.equal(sealed, 1);
  assert.equal(transcribed, 0, "CANCELLED_SESSION_MUST_NOT_START_LIVE_ASR");
});

test("normal seal waits for in-flight ASR and preserves its ready checkpoint", async () => {
  const root=await mkdtemp(path.join(tmpdir(),"live-seal-"));
  const repository=new MeetingLiveTranscriptionRepository(path.join(root,"db.sqlite"));
  let entered!:()=>void,finish!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const pending=new Promise<void>(resolve=>{finish=resolve;});
  let signal:AbortSignal|undefined;
  const service=new MeetingLiveTranscriptionService({repository,
    sessions:{get:async()=>({ownerId:"owner"})} as never,
    recordings:{getSession:async()=>({})} as never,
    provider:{enabled:true,name:"fake",model:"fake",async transcribe(input){signal=input.signal;entered();await pending;return [{startMs:0,endMs:1000,text:"保留這段",speakerLabel:null,confidence:null}];}}
  });
  const chunk:LiveChunk={sessionId:"session",sourceId:"room-mic",chunkIndex:0,profile:service.profile,audioHash:"hash",audioPath:path.join(root,"window.wav"),startMs:0,endMs:60000,windowStartMs:0,windowEndMs:62000};
  try {
    await writeFile(chunk.audioPath,"fixture");
    await repository.source("session","room-mic",service.profile,60000,false);
    await repository.register(chunk);
    const running=service.runOnce();await started;
    let sealed=false;const sealing=service.seal("session").then(()=>{sealed=true;});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(signal?.aborted,false,"NORMAL_FINALIZE_MUST_NOT_ABORT_REMOTE_ASR");
    assert.equal(sealed,false,"FINAL_PROCESSOR_MUST_WAIT_FOR_CHECKPOINT");
    finish();await Promise.all([running,sealing]);
    assert.equal((await repository.cached(chunk))?.[0].text,"保留這段","FINALIZATION_PRESERVES_READY_CHECKPOINT");
  } finally {finish();await service.stop();await repository.close();await rm(root,{recursive:true,force:true});}
});

test("取消清理會等待已開始的 Python ASR 自然結束", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "live-cancel-wait-"));
  const repository = new MeetingLiveTranscriptionRepository(path.join(root, "db.sqlite"));
  const sessionId = "44444444-4444-4444-8444-444444444444";
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let signal: AbortSignal | undefined;
  const service = new MeetingLiveTranscriptionService({ repository,
    sessions: { get: async () => ({ ownerId: "owner" }) } as never,
    recordings: { getSession: async () => ({}) } as never,
    provider: { enabled: true, name: "fake", model: "fake", async transcribe(input) {
      signal = input.signal; entered(); await pending; return [];
    } },
    processingDir: root,
  });
  const chunk: LiveChunk = { sessionId, sourceId: "room-mic", chunkIndex: 0, profile: service.profile,
    audioHash: "hash", audioPath: path.join(root, "window.wav"), startMs: 0, endMs: 60_000,
    windowStartMs: 0, windowEndMs: 62_000 };
  try {
    await writeFile(chunk.audioPath, "fixture");
    await repository.source(sessionId, "room-mic", service.profile, 60_000, false);
    await repository.register(chunk);
    const running = service.runOnce();
    await started;
    let cleaned = false;
    const cleaning = service.cleanupSession(sessionId).then(() => { cleaned = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(signal?.aborted, false, "HTTP_ABORT_CANNOT_PROVE_PYTHON_INFERENCE_STOPPED");
    assert.equal(cleaned, false, "ADMISSION_CLEANUP_MUST_WAIT_FOR_STARTED_ASR");
    finish();
    await Promise.all([running, cleaning]);
    assert.deepEqual(await repository.progress(sessionId, service.profile), []);
  } finally {
    finish();
    await service.stop();
    await repository.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("session 清理會釋放 sealed、decode retry 與 decoder process state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "live-state-release-"));
  const sessionId = "55555555-5555-4555-8555-555555555555";
  let decoderStops = 0;
  let forgot = false;
  const service = new MeetingLiveTranscriptionService({
    repository: {
      seal: async () => undefined,
      forget: async () => { forgot = true; },
      releaseDecoderLease: async () => undefined,
    } as never,
    provider: { enabled: false, name: "disabled", model: "disabled", transcribe: async () => [] },
    processingDir: root,
  });
  const state = service as unknown as {
    sealed: Set<string>;
    retryAt: Map<string, number>;
    decoders: Map<string, { stop(): Promise<void> }>;
  };
  state.sealed.add(sessionId);
  state.sealed.add("other-session");
  state.retryAt.set(`${sessionId}:room-mic`, Date.now() + 30_000);
  state.retryAt.set("other-session:room-mic", Date.now() + 30_000);
  state.decoders.set(`${sessionId}:room-mic`, { stop: async () => { decoderStops += 1; } });
  try {
    await service.cleanupSession(sessionId);
    assert.equal(forgot, true);
    assert.equal(decoderStops, 1);
    assert.equal(state.sealed.has(sessionId), false);
    assert.equal(state.retryAt.has(`${sessionId}:room-mic`), false);
    assert.equal(state.decoders.has(`${sessionId}:room-mic`), false);
    assert.equal(state.sealed.has("other-session"), true, "OTHER_SESSION_STATE_PRESERVED");
    assert.equal(state.retryAt.has("other-session:room-mic"), true, "OTHER_SESSION_RETRY_PRESERVED");
  } finally {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("shutdown during source lookup cannot start a decoder", async () => {
  let release!: (value: boolean)=>void; let entered!:()=>void;
  const waiting=new Promise<void>(resolve=>{entered=resolve;}); let sourceWrites=0;
  const service=new MeetingLiveTranscriptionService({
    sessions:{expireRecorderLeases:async()=>undefined,protectedSessionIds:async()=>["s"],get:async()=>({ownerId:"o",recorderLeaseUntil:new Date(Date.now()+90_000).toISOString()})} as never,
    transcriptionJobs:{getJobBySessionForOwner:async()=>null} as never,
    recordings:{getSession:async()=>({tracks:[{sourceId:"room-mic",chunkCount:1}]})} as never,
    repository:{sourceComplete:()=>{entered();return new Promise<boolean>(resolve=>{release=resolve;});},source:async()=>{sourceWrites++;},releaseDecoderLease:async()=>undefined,retireOtherProfiles:async()=>undefined} as never,
    provider:{enabled:true,name:"fake",model:"fake",transcribe:async()=>[]},ffmpegPath:"must-not-spawn"
  });
  const pumping=service.pump(); await waiting; const stopping=service.stop();release(false);
  await Promise.all([pumping,stopping]);assert.equal(sourceWrites,0,"STOPPED_PUMP_CANNOT_CREATE_DECODER");
});

test("recorder 到期但 LIVE provider 還在 inference 時不能接受第三場，完成後才讓出名額", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "live-inference-admission-"));
  const filename = path.join(root, "meeting.sqlite3");
  const sessions = new MeetingOneShotRepository(filename);
  const repository = new MeetingLiveTranscriptionRepository(filename);
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const service = new MeetingLiveTranscriptionService({ repository, sessions,
    recordings: { getSession: async () => ({}) } as never,
    provider: { enabled: true, name: "fake", model: "fake", transcribe: async () => { entered(); await gate; return []; } },
  });
  const now = Date.now();
  const register = (sessionId: string, createdAt: number) => sessions.registerForOwner({ sessionId,
    ownerId: sessionId, recorderId: "tab", title: sessionId, createdAt: new Date(createdAt).toISOString(), maxPipelines: 2 });
  let inference: Promise<boolean> | null = null;
  try {
    await register("old-live", now - 120_000);
    await repository.register({ sessionId: "old-live", sourceId: "room-mic", chunkIndex: 0, profile: service.profile,
      audioHash: "hash", audioPath: path.join(root, "unused.wav"), startMs: 0, endMs: 60_000, windowStartMs: 0, windowEndMs: 62_000 });
    inference = service.runOnce();
    await started;
    await register("second", now);
    await assert.rejects(register("third", now), (error: unknown) => error instanceof HttpError && error.code === "MEETING_PIPELINE_CAPACITY_FULL");
    assert.equal((await sessions.admissionStats(2)).activeMeetings, 2, "RUNNING_LIVE_ASR_MUST_REMAIN_ADMITTED");
    finish();
    await inference;
    await register("third", now);
    assert.equal((await sessions.admissionStats(2)).activeMeetings, 2);
  } finally { finish(); await inference; await service.stop(); await sessions.close(); await repository.close(); await rm(root, { recursive: true, force: true }); }
});

test("recorder lease 到期後 pump 停止 idle decoder 並在停止完成後釋放 SQLite lease", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "live-recorder-expiry-"));
  const filename = path.join(root, "meeting.sqlite3");
  const sessions = new MeetingOneShotRepository(filename);
  const repository = new MeetingLiveTranscriptionRepository(filename);
  const now = Date.now();
  let stops = 0;
  const service = new MeetingLiveTranscriptionService({ repository, sessions,
    transcriptionJobs: { getJobBySessionForOwner: async () => null } as never,
    recordings: { getSession: async () => assert.fail("expired recorder must not feed more audio") } as never,
    provider: { enabled: true, name: "fake", model: "fake", transcribe: async () => [] },
  });
  const state = service as unknown as { decoderLeaseId: string; decoders: Map<string, { stop(): Promise<void>; complete: boolean }> };
  try {
    await sessions.registerForOwner({ sessionId: "expired", ownerId: "owner", recorderId: "tab", title: "expired",
      createdAt: new Date(now - 120_000).toISOString(), recorderLeaseUntil: new Date(now - 30_000).toISOString(), maxPipelines: 2 });
    assert.equal(await repository.renewDecoderLease("expired", "room-mic", service.profile, state.decoderLeaseId, now - 60_000, 120_000), true);
    state.decoders.set("expired:room-mic", { complete: false, stop: async () => {
      assert.equal((await sessions.admissionStats(2)).activeMeetings, 1, "LEASE_REMAINS_UNTIL_FFMPEG_STOPS");
      stops += 1;
    } });
    await service.pump();
    assert.equal(stops, 1);
    assert.equal(state.decoders.size, 0);
    assert.equal((await sessions.admissionStats(2)).activeMeetings, 0);
  } finally { await service.stop(); await sessions.close(); await repository.close(); await rm(root, { recursive: true, force: true }); }
});

test("stream slice waits for contiguous chunks and continues through finalized identical bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(),"live-slice-"));
  const ownerId = "11111111-1111-4111-8111-111111111111";
  const store = new MeetingRecordingStorageService({storageDir:root});
  try {
    const session = await store.createSession({ownerId,sourceIds:["room-mic"]});
    const upload = (sequence:number,body:string) => store.uploadChunk({ownerId,sessionId:session.sessionId,sourceId:"room-mic",sequence,mimeType:"audio/webm",body:Buffer.from(body)});
    await upload(1,"second");
    assert.equal((await store.readStreamingAudio(session.sessionId,ownerId,"room-mic",0)).body.length,0);
    await upload(0,"first");
    assert.equal((await store.readStreamingAudio(session.sessionId,ownerId,"room-mic",0)).body.toString(),"first");
    await assert.rejects(store.readStreamingAudio(session.sessionId,"22222222-2222-4222-8222-222222222222","room-mic",0));
    await store.finalizeSession({ownerId,sessionId:session.sessionId,durationMs:10000,tracks:[{sourceId:"room-mic",chunkCount:2}]});
    assert.equal((await store.readStreamingAudio(session.sessionId,ownerId,"room-mic",5)).body.toString(),"second");
    assert.equal((await store.readStreamingAudio(session.sessionId,ownerId,"room-mic",11)).eof,true);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("real WebM streams before EOF and final processor reuses all PCM checkpoints", {skip: !process.env.MEETING_LIVE_FFMPEG_TEST}, async () => {
  const root = await mkdtemp(path.join(tmpdir(),"live-integrated-"));
  const db = path.join(root,"db.sqlite"), processingDir=path.join(root,"artifacts");
  const live = new MeetingLiveTranscriptionRepository(db), sessions = new MeetingOneShotRepository(db);
  const jobs = new MeetingTranscriptionJobRepository(db);
  const recordings = new MeetingRecordingStorageService({storageDir:path.join(root,"recordings")});
  const calls: number[] = [];
  const provider = { enabled:true,name:"fake",model:"fake",async transcribe(input:{durationMs:number}) {
    calls.push(input.durationMs); if (input.durationMs < 6000) return []; return [{startMs:5000,endMs:6000,text:`內容${calls.length}`,speakerLabel:null,confidence:null}];
  }};
  const createLive=()=>new MeetingLiveTranscriptionService({repository:live,sessions,recordings,provider,processingDir,ffmpegPath:"ffmpeg",transcriptionJobs:jobs,maxLiveAudioBytes:1024*1024*1024});
  let service = createLive();
  const originalConcat=Buffer.concat;let concatBytes=0;
  const command = promisify(execFile);
  const waitFor = async (predicate:()=>Promise<boolean>) => {
    const deadline=Date.now()+(process.env.MEETING_LIVE_LONG_TEST ? 120000 : 10000);
    while (!await predicate()) { assert.ok(Date.now()<deadline,"STREAM_PROGRESS_TIMEOUT");await new Promise(resolve=>setTimeout(resolve,20)); }
  };
  try {
    const ownerId="11111111-1111-4111-8111-111111111111";
    const session = await recordings.createSession({ownerId,sourceIds:["room-mic"],deliveryMode:"one-shot"});
    await sessions.registerForOwner({sessionId:session.sessionId,ownerId,title:"test",createdAt:new Date().toISOString(),
      recorderId:"test-tab",recorderLeaseUntil:new Date(Date.now()+60*60*1000).toISOString(),maxPipelines:2});
    const durationMs=process.env.MEETING_LIVE_LONG_TEST ? 14_400_280 : 125_280;
    const beforeCount=Math.floor((durationMs-2000)/60000);
    const totalCount=Math.ceil(durationMs/60000);
    const input=path.join(root,"input.webm"),canonical=path.join(root,"canonical.wav");
    await command("ffmpeg",["-v","error","-f","lavfi","-i","sine=frequency=440:sample_rate=48000","-t",String(durationMs/1000),"-c:a","libopus","-b:a","24k",input]);
    const bytes=await readFile(input);
    let chunkCount=0;
    for(let offset=0;offset<bytes.length;offset+=256*1024) await recordings.uploadChunk({ownerId,sessionId:session.sessionId,sourceId:"room-mic",sequence:chunkCount++,mimeType:"audio/webm",body:bytes.subarray(offset,offset+256*1024)});
    const cpuStarted=process.cpuUsage();
    Buffer.concat=(pieces,length)=>{concatBytes+=length ?? pieces.reduce((sum,piece)=>sum+piece.length,0);return originalConcat(pieces,length);};
    await service.pump();
    await waitFor(async()=>{await service.pump();return (await live.progress(session.sessionId,service.profile))[0]?.decodedMs>=beforeCount*60000;});
    Buffer.concat=originalConcat;
    assert.ok(concatBytes<durationMs*32*3,"PCM_COPY_VOLUME_IS_LINEAR");
    console.log(JSON.stringify({event:"decoder_copy_budget",durationMs,concatBytes,nodeCpu:process.cpuUsage(cpuStarted)}));
    assert.equal((await recordings.getSession(session.sessionId,ownerId)).status,"recording","TRANSCRIBE_BEFORE_FINALIZE");
    for(let index=0;index<beforeCount;index++) assert.equal(await service.runOnce(),true);
    assert.equal(calls.length,beforeCount);
    await service.stop(); service=createLive(); await service.pump();
    await recordings.finalizeSession({ownerId,sessionId:session.sessionId,durationMs,tracks:[{sourceId:"room-mic",chunkCount}]});
    await sessions.markRecordingFinalized(session.sessionId,ownerId,new Date().toISOString());
    await service.pump();
    await waitFor(async()=>{await service.pump();return live.sourceComplete(session.sessionId,"room-mic",service.profile);});
    while(await service.runOnce()) { /* Drain only previously unfinished windows. */ }
    await service.seal(session.sessionId);
    await command("ffmpeg",["-v","error","-i",input,"-ac","1","-ar","16000","-c:a","pcm_s16le",canonical]);
    await jobs.enqueue({jobId:"final-job",processingJobId:"audio-job",sessionId:session.sessionId,ownerId,provider:"fake",model:"fake",maxAttempts:3,now:new Date().toISOString()});
    let extractions = 0;
    const processor = new MeetingTranscriptProcessor({repository:jobs,liveRepository:live,provider,processingDir,ffmpegPath:"ffmpeg",ffprobePath:"ffprobe",
      runCommand:async(binary,args)=>{if(args.includes("-ss"))extractions++;return await command(binary,args);}});
    const finalStarted = performance.now();
    await processor.process({jobId:"final-job",sessionId:session.sessionId,tracks:[{sourceId:"room-mic",filePath:canonical}]},async()=>undefined);
    assert.equal(calls.length,totalCount,"FINAL_REUSES_ALL_LIVE_WINDOWS");
    assert.equal(extractions,0,"LIVE_REUSE_MUST_NOT_SPAWN_FFMPEG_PER_WINDOW");
    console.log(JSON.stringify({event:"live_finalization",durationMs,windows:totalCount,ffmpegExtractions:extractions,settleMs:performance.now()-finalStarted}));
    const fullPcm=wavePcm(await readFile(canonical));
    const first=fullPcm.subarray(0,62000*32);
    assert.ok(await live.cached({sessionId:session.sessionId,sourceId:"room-mic",chunkIndex:0,profile:service.profile,audioHash:pcmHash(first)}),"PCM_IDENTITY");
    assert.deepEqual(wavePcm(pcmWave(first)),first);
    const changed = await readFile(canonical);
    changed[changed.length-wavePcm(changed).length] ^= 1;
    await writeFile(canonical,changed);
    await processor.process({jobId:"final-job",sessionId:session.sessionId,tracks:[{sourceId:"room-mic",filePath:canonical}]},async()=>undefined);
    assert.equal(calls.length,totalCount+1,"CHANGED_PCM_MUST_NOT_REUSE_STALE_TRANSCRIPT");
    await assert.rejects(readFile(path.join(processingDir,session.sessionId,"live-transcript","room-mic",`0-${liveTranscriptionProfile(provider)}.wav`)),{code:"ENOENT"});
    await service.cleanupSession(session.sessionId);
    await assert.rejects(readFile(path.join(processingDir,session.sessionId,"live-transcript","room-mic",`0-${service.profile}.wav`)),{code:"ENOENT"});
  } finally { Buffer.concat=originalConcat; await service.stop(); await live.close();await jobs.close();await sessions.close();await rm(root,{recursive:true,force:true}); }
});

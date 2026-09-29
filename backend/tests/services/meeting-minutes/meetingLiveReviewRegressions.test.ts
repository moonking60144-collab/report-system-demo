import test from "node:test";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scheduleMeetingTranscription } from "../../../src/services/meeting-minutes/meetingTranscriptionScheduler";
import { MeetingLiveTranscriptionService, liveTranscriptionProfile } from "../../../src/services/meeting-minutes/meetingLiveTranscriptionService";
import { MeetingTranscriptProcessor } from "../../../src/services/meeting-minutes/meetingTranscriptProcessor";
import { MeetingWorkerRuntime } from "../../../src/workers/meetingWorkerRuntime";
import { MeetingPcmReader } from "../../../src/services/meeting-minutes/meetingPcmReader";
import { appendWindowSegments, pcmWave, pcmHash } from "../../../src/services/meeting-minutes/meetingLiveAudio";
import type { MeetingTranscriptionProviderInput, MeetingTranscriptionProviderLike } from "../../../src/services/meeting-minutes/meetingTranscriptionProvider";
import { MeetingLiveTranscriptionRepository } from "../../../src/storage/meeting-minutes/meetingLiveTranscriptionRepository";
import { MeetingTranscriptionJobRepository } from "../../../src/storage/meeting-minutes/meetingTranscriptionJobRepository";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return {promise,resolve}; }
const input = (audioPath: string, signal?: AbortSignal): MeetingTranscriptionProviderInput => ({audioPath,sourceId:"room-mic",mimeType:"audio/wav",language:"zh-TW",durationMs:62000,signal});

test("live and final requests alternate at chunk boundaries without overlapping inference, including canceled waiters", async () => {
  const entered = deferred(), release = deferred(); const order: string[]=[]; let active=0,max=0;
  const provider: MeetingTranscriptionProviderLike = {name:"fake",model:"fake",enabled:true,async transcribe(item) {
    active++;max=Math.max(max,active);order.push(item.audioPath);
    try { if(item.audioPath==="final-0"){entered.resolve();await release.promise;} return []; }
    finally {active--;}
  }};
  const final = scheduleMeetingTranscription(provider), live = scheduleMeetingTranscription(provider);
  const first = final.transcribe(input("final-0")); await entered.promise;
  const cancel = new AbortController();
  const canceled=live.transcribe(input("canceled",cancel.signal));
  const failed=assert.rejects(canceled,{code:"MEETING_TRANSCRIPTION_ABORTED"});cancel.abort();await failed;
  const next=live.transcribe(input("live-0"));
  await Promise.resolve(); assert.deepEqual(order,["final-0"]);
  release.resolve(); await first;
  const finalNext=final.transcribe(input("final-1"));
  await Promise.all([next,finalNext]);
  assert.equal(max,1,"SINGLE_INFERENCE");
  assert.deepEqual(order,["final-0","live-0","final-1"],"LIVE_NOT_OVERTAKEN_BY_FINAL_NEXT_CHUNK");
});

test("live inference continues while runtime waits on an unfinished summary", async () => {
  const summaryEntered=deferred(),summaryRelease=deferred(),liveFinished=deferred();let claims=0;
  const provider: MeetingTranscriptionProviderLike={enabled:true,name:"fake",model:"fake",transcribe:async()=>[]};
  const live=new MeetingLiveTranscriptionService({provider,
    repository:{claim:async()=>claims++===0?{sessionId:"s",sourceId:"room-mic",audioPath:"unused",windowStartMs:0,windowEndMs:62000}:null,
      finish:async()=>{liveFinished.resolve();return false;},fail:async()=>{},close:async()=>{},releaseDecoderLease:async()=>{},retireOtherProfiles:async()=>{}} as never,
    sessions:{get:async()=>({ownerId:"o"}),protectedSessionIds:async()=>[],expireRecorderLeases:async()=>{}} as never,
    recordings:{getSession:async()=>({tracks:[]})} as never});
  const runtime=new MeetingWorkerRuntime({repository:{claimNext:async()=>null} as never,processingService:{} as never,
    liveTranscriptionService:live,minutesRepository:{claimNext:async()=>({jobId:"m"})} as never,
    minutesService:{providerEnabled:true,processClaimedJob:async()=>{summaryEntered.resolve();await summaryRelease.promise;return {status:"ready"};}} as never});
  const summary=runtime.runOnce();await summaryEntered.promise;
  live.start();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([liveFinished.promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("LIVE_STARVED_BY_SUMMARY")),1500);})]);
  } finally {if(timer)clearTimeout(timer);summaryRelease.resolve();await summary;await live.stop();await live.close();}
});

test("touching timestamps, small overlap, and brief acknowledgements are separate utterances", () => {
  for(const text of ["好。","可以。","目前尚未核准。"]){
    for(const startMs of [59000,58990]){
      const old=[{startMs:58000,endMs:59000,text}];
      appendWindowSegments(old,[{startMs,endMs:60000,text}]);
      assert.equal(old.length,2,"SEPARATE_UTTERANCE_NOT_CONTEXT");
    }
  }
  const old=[{startMs:58000,endMs:59000,text:"好。"}];
  appendWindowSegments(old,[{startMs:58000,endMs:59000,text:"好。"}]);
  assert.equal(old.length,2,"SHORT_ACKNOWLEDGEMENTS_ARE_AMBIGUOUS");
});

test("canonical PCM reader handles RIFF metadata and preserves exact window bytes", async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"meeting-pcm-"));
  let reader: MeetingPcmReader|null=null;
  try {
    const pcm=Buffer.from(Array.from({length:64000},(_,i)=>i%251));const wav=pcmWave(pcm);
    const metadata=Buffer.from([74,85,78,75,1,0,0,0,99,0]); // odd-sized JUNK plus padding
    const withMetadata=Buffer.concat([wav.subarray(0,36),metadata,wav.subarray(36)]);withMetadata.writeUInt32LE(withMetadata.length-8,4);
    const file=path.join(root,"canonical.wav");await writeFile(file,withMetadata);
    reader=await MeetingPcmReader.open(file);assert.ok(reader);
    assert.deepEqual(await reader.readWindow(500,1500),pcm.subarray(16000,48000));
    await reader.close();reader=null;
    const wrong=Buffer.from(wav);wrong.writeUInt32LE(48000,24);await writeFile(file,wrong);
    assert.equal(await MeetingPcmReader.open(file),null,"NONCANONICAL_FORMAT_USES_FFMPEG_FALLBACK");
  }finally{await reader?.close();await rm(root,{recursive:true,force:true});}
});

test("markers and another source do not imply ready cache; final checkpoints require decoder profile", async()=>{
  const live=new MeetingLiveTranscriptionRepository(":memory:");const jobs=new MeetingTranscriptionJobRepository(":memory:");
  try{
    await live.source("s","room-mic","p",0,false);
    assert.equal(await live.hasReadySource("s","room-mic","p"),false);
    await live.register({sessionId:"s",sourceId:"room-mic",profile:"p",chunkIndex:0,audioPath:"unused",audioHash:pcmHash(Buffer.from("a")),startMs:0,endMs:60000,windowStartMs:0,windowEndMs:62000});
    await live.claim("p","l",0,1000);await live.finish("l",[]);
    assert.equal(await live.hasReadySource("s","room-mic","p"),true);
    assert.equal(await live.hasReadySource("s","remote-tab","p"),false);
    await jobs.enqueue({jobId:"j",processingJobId:"a",sessionId:"s",ownerId:"o",provider:"fake",model:"fake",maxAttempts:3,now:new Date().toISOString()});
    await jobs.saveChunkCheckpoint({jobId:"j",sessionId:"s",sourceId:"room-mic",chunkIndex:0,startMs:0,endMs:1000,audioSha256:"same",segments:[],now:new Date().toISOString(),decoderProfile:"beam1"});
    assert.ok(await jobs.getChunkCheckpoint("j","room-mic",0,"same","beam1"));
    assert.equal(await jobs.getChunkCheckpoint("j","room-mic",0,"same","beam5"),null);
    const base={name:"fake",model:"fake",enabled:true,transcribe:async()=>[]};
    assert.notEqual(liveTranscriptionProfile({...base,inferenceProfile:"beam1"}),liveTranscriptionProfile({...base,inferenceProfile:"beam5"}));
  }finally{await live.close();await jobs.close();}
});

test("final processor uses live cache only for the ready source and keeps other source on legacy chunk size", async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"meeting-source-fallback-"));
  const live=new MeetingLiveTranscriptionRepository(":memory:"), jobs=new MeetingTranscriptionJobRepository(":memory:");
  const calls:Array<{source:string;duration:number}>=[],extractions:string[]=[];
  const provider:MeetingTranscriptionProviderLike={enabled:true,name:"fake",model:"fake",transcribe:async item=>{calls.push({source:item.sourceId,duration:item.durationMs});return item.sourceId==="room-mic" && item.durationMs===64000 ? [{startMs:100,endMs:2100,text:"這個方案可以。",speakerLabel:"B",confidence:null}] : [];}};
  const profile=liveTranscriptionProfile(provider), pcm=Buffer.alloc(130000*32,1);
  const canonical=path.join(root,"canonical.wav");
  try{
    await writeFile(canonical,pcmWave(pcm));
    await live.source("s","room-mic",profile,60000,false);
    await live.source("s","remote-tab",profile,0,false);
    await live.deferSource("s","room-mic",profile);
    await live.deferSource("s","remote-tab",profile);
    await live.register({sessionId:"s",sourceId:"room-mic",profile,chunkIndex:0,audioPath:"unused",audioHash:pcmHash(pcm.subarray(0,62000*32)),startMs:0,endMs:60000,windowStartMs:0,windowEndMs:62000});
    await live.claim(profile,"l",0,1000);await live.finish("l",[{startMs:58000,endMs:60000,text:"這個方案可以。",speakerLabel:"A",confidence:null}]);
    await jobs.enqueue({jobId:"j",processingJobId:"a",sessionId:"s",ownerId:"o",provider:"fake",model:"fake",maxAttempts:3,now:new Date().toISOString()});
    const processor=new MeetingTranscriptProcessor({provider,repository:jobs,liveRepository:live,processingDir:root,chunkMs:600000,ffmpegPath:"mock-ffmpeg",ffprobePath:"mock-probe",
      runCommand:async(command,args)=>{
        if(command==="mock-probe") return {stdout:JSON.stringify({format:{duration:130}}),stderr:""};
        const output=args[args.length-1];extractions.push(output);
        const start=Number(args[args.indexOf("-ss")+1])*32000,end=start+Number(args[args.indexOf("-t")+1])*32000;
        await writeFile(output,pcmWave(pcm.subarray(start,end)));return {stdout:"",stderr:""};
      }});
    const artifacts=await processor.process({jobId:"j",sessionId:"s",tracks:[{sourceId:"room-mic",filePath:canonical},{sourceId:"remote-tab",filePath:canonical}]},async()=>{});
    assert.deepEqual(calls,[{source:"room-mic",duration:64000},{source:"room-mic",duration:12000},{source:"remote-tab",duration:130000}],"ONLY_READY_SOURCE_USES_LIVE_WINDOWS");
    assert.equal(extractions.length,1);assert.match(extractions[0],/remote-tab/);
    for (const artifact of artifacts.filter(item=>["transcript-room-mic-json","transcript-merged-json"].includes(item.type))) {
      const segments=JSON.parse(await readFile(processor.resolveArtifactPath(artifact.relativePath),"utf8")).segments;
      assert.deepEqual(segments.map((segment:{startMs:number;text:string})=>[segment.startMs,segment.text]),[[58000,"這個方案可以。"],[58100,"這個方案可以。"]],"CACHED_AND_FRESH_BOUNDARY_SPEECH_SURVIVES_ARTIFACTS");
    }
    const beforeReplay=calls.length;
    const replayed=await processor.process({jobId:"j",sessionId:"s",tracks:[{sourceId:"room-mic",filePath:canonical},{sourceId:"remote-tab",filePath:canonical}]},async()=>{});
    const merged=replayed.find(item=>item.type==="transcript-merged-json")!;
    const segments=JSON.parse(await readFile(processor.resolveArtifactPath(merged.relativePath),"utf8")).segments;
    assert.equal(segments.length,2,"CHECKPOINT_REPLAY_PRESERVES_BOTH_SPEAKERS");
    assert.equal(calls.length,beforeReplay,"REPLAY_REUSES_CHECKPOINTS");
  }finally{await live.close();await jobs.close();await rm(root,{recursive:true,force:true});}
});

test("legacy WAL checkpoint schema migrates without losing stored text and is not treated as a known decoder profile", async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"meeting-checkpoint-migration-"));const filename=path.join(root,"old.sqlite");
  const old=await open({filename,driver:sqlite3.Database});
  await old.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE meeting_transcription_chunks (
    job_id TEXT,session_id TEXT,source_id TEXT,chunk_index INTEGER,start_ms INTEGER,end_ms INTEGER,
    audio_sha256 TEXT,segments_json TEXT,created_at TEXT,updated_at TEXT,PRIMARY KEY(job_id,source_id,chunk_index));
    INSERT INTO meeting_transcription_chunks VALUES ('j','s','room-mic',0,0,1000,'audio','[]','2026-01-01','2026-01-01');`);
  await old.close();const a=new MeetingTranscriptionJobRepository(filename),b=new MeetingTranscriptionJobRepository(filename);
  try{
    const results=await Promise.all([a.getChunkCheckpoint("j","room-mic",0,"audio"),b.getChunkCheckpoint("j","room-mic",0,"audio")]);
    assert.ok(results.every(Boolean),"MIGRATION_RETAINS_LEGACY_CHECKPOINT");
    assert.equal(await a.getChunkCheckpoint("j","room-mic",0,"audio","beam1"),null,"LEGACY_PROFILE_IS_UNKNOWN");
  }finally{await a.close();await b.close();await rm(root,{recursive:true,force:true});}
});

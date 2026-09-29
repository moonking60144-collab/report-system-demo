import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MeetingLiveAudioQuota } from "../../../src/services/meeting-minutes/meetingLiveAudioQuota";
import { MeetingStreamingDecoder } from "../../../src/services/meeting-minutes/meetingStreamingDecoder";
import { MeetingLiveTranscriptionRepository } from "../../../src/storage/meeting-minutes/meetingLiveTranscriptionRepository";
import { appendWindowSegments } from "../../../src/services/meeting-minutes/meetingLiveAudio";
import { open } from "sqlite";
import sqlite3 from "sqlite3";

test("quota serializes sources, counts orphan files across restart and allows space reclaimed by inference", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "live-quota-"));
  const a = path.join(root,"s1","live-transcript","room-mic","0.wav");
  const b = path.join(root,"s2","live-transcript","remote-tab","0.wav");
  try {
    const q1 = new MeetingLiveAudioQuota(root, 100, 0), q2 = new MeetingLiveAudioQuota(root, 100, 0);
    assert.deepEqual(await Promise.all([q1.write(a,Buffer.alloc(60)),q2.write(b,Buffer.alloc(60))]),[true,false]);
    const restarted = new MeetingLiveAudioQuota(root, 100, 0);
    assert.equal(await restarted.write(b,Buffer.alloc(60)),false);
    await rm(a);
    assert.equal(await restarted.write(b,Buffer.alloc(60)),true);
    await mkdir(path.dirname(a),{recursive:true});
    await writeFile(`${a}.tmp`,Buffer.alloc(30));
    assert.equal(await restarted.write(a,Buffer.alloc(11)),false,"ORPHAN_TEMP_COUNTS");
    assert.equal(await new MeetingLiveAudioQuota(root,1000,Number.MAX_SAFE_INTEGER).write(a,Buffer.alloc(1)),false,"FREE_DISK_RESERVE");
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("quota stops live decoding, retains ready work and persists deferred source across restart", {skip: !process.env.MEETING_LIVE_FFMPEG_TEST}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "live-deferred-"));
  const filename=path.join(root,"db.sqlite");
  let repo=new MeetingLiveTranscriptionRepository(filename);
  let decoder: MeetingStreamingDecoder | undefined;
  const command=promisify(execFile);
  try {
    const audio=path.join(root,"input.webm");
    await command("ffmpeg",["-v","error","-f","lavfi","-i","sine=frequency=440:sample_rate=48000","-t","130","-c:a","libopus",audio]);
    await repo.source("s","room-mic","p",0,false);
    decoder=new MeetingStreamingDecoder({sessionId:"s",sourceId:"room-mic",profile:"p",processingDir:root,
      repository:repo,ffmpegPath:"ffmpeg",quota:new MeetingLiveAudioQuota(root,62000*32+44,0)});
    await decoder.feed(await readFile(audio),true);
    await decoder.completion;
    assert.equal(decoder.error,null);
    assert.equal(decoder.complete,true);
    assert.deepEqual(await readdir(path.join(root,"s","live-transcript","room-mic")),["0-p.wav"]);
    const progress=(await repo.progress("s","p"))[0];
    assert.equal(progress.deferred,true);assert.equal(progress.complete,false);assert.equal(progress.decodedMs,60000);
    const ready=await repo.claim("p","l",0,1000);assert.ok(ready);
    await repo.finish("l",[{startMs:0,endMs:1000,text:"已保存",speakerLabel:null,confidence:null}]);
    await repo.close(); repo=new MeetingLiveTranscriptionRepository(filename);
    assert.equal(await repo.sourceComplete("s","room-mic","p"),true,"RESTART_DOES_NOT_DECODE_AGAIN");
    assert.equal((await repo.progress("s","p"))[0].deferred,true);
    assert.ok(await repo.cached(ready),"READY_CACHE_SURVIVES_DEFER");
    assert.ok((await readFile(audio)).length>0,"ORIGINAL_AUDIO_PRESERVED");
  } finally { await decoder?.stop();await repo.close();await rm(root,{recursive:true,force:true}); }
});

test("merge preserves different and chunk-local speakers, repeated speech, and same-window repetitions", () => {
  const earlier={startMs:58000,endMs:60000,text:"這個方案可以。",speakerLabel:"room:chunk-0:A"};
  for (const incoming of [
    {...earlier,speakerLabel:"room:chunk-1:B"},
    {...earlier,speakerLabel:"room:chunk-1:A"},
    {...earlier,startMs:58100,endMs:60100},
    {...earlier,speakerLabel:null},
  ]) {
    const segments:Array<typeof incoming>=[earlier];appendWindowSegments(segments,[incoming]);
    assert.equal(segments.length,2);
  }
  const exact=[earlier];appendWindowSegments(exact,[{...earlier}]);assert.equal(exact.length,1);
  const sameWindow:typeof earlier[]=[];appendWindowSegments(sameWindow,[earlier,{...earlier}]);assert.equal(sameWindow.length,2);
});

test("legacy live source migration retains completed progress and persists deferred independently", async () => {
  const root=await mkdtemp(path.join(tmpdir(),"live-source-migration-"));const filename=path.join(root,"db.sqlite");
  const old=await open({filename,driver:sqlite3.Database});
  await old.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE meeting_live_sources(session_id TEXT,source_id TEXT,profile TEXT,decoded_ms INTEGER,complete INTEGER,PRIMARY KEY(session_id,source_id,profile));
    INSERT INTO meeting_live_sources VALUES('s','room-mic','p',60000,1);`);
  await old.close();const a=new MeetingLiveTranscriptionRepository(filename),b=new MeetingLiveTranscriptionRepository(filename);
  try {
    const results=await Promise.all([a.progress("s","p"),b.progress("s","p")]);
    for(const [source] of results){assert.equal(source.decodedMs,60000);assert.equal(source.complete,true);assert.equal(source.deferred,false);}
    await a.source("s","remote-tab","p",0,false);await b.deferSource("s","remote-tab","p");
    const remote=(await a.progress("s","p")).find(source=>source.sourceId==="remote-tab")!;
    assert.equal(remote.deferred,true);assert.equal(remote.complete,false);
  } finally {await a.close();await b.close();await rm(root,{recursive:true,force:true});}
});

test("shutdown settles while decoder is waiting on a quota decision", {skip: !process.env.MEETING_LIVE_FFMPEG_TEST}, async () => {
  const root=await mkdtemp(path.join(tmpdir(),"live-quota-stop-"));const repo=new MeetingLiveTranscriptionRepository(":memory:");
  let release!:()=>void,entered!:()=>void;const enteredPromise=new Promise<void>(resolve=>{entered=resolve;});
  const gate=new Promise<void>(resolve=>{release=resolve;});let decoder:MeetingStreamingDecoder|undefined;
  try {
    const audio=path.join(root,"input.webm");
    await promisify(execFile)("ffmpeg",["-v","error","-f","lavfi","-i","sine=frequency=440:sample_rate=48000","-t","130","-c:a","libopus",audio]);
    await repo.source("s","room-mic","p",0,false);
    decoder=new MeetingStreamingDecoder({sessionId:"s",sourceId:"room-mic",profile:"p",repository:repo,processingDir:root,ffmpegPath:"ffmpeg",
      quota:{write:async()=>{entered();await gate;return false;}} as never});
    const feeding=decoder.feed(await readFile(audio),true);await enteredPromise;
    let stopped=false;const stopping=decoder.stop().then(()=>{stopped=true;});
    await Promise.resolve();assert.equal(stopped,false,"STOP_DRAINS_IN_FLIGHT_QUOTA");release();
    await Promise.all([feeding,stopping]);assert.equal(await repo.claim("p","l",0,1000),null);
  } finally {release?.();await decoder?.stop();await repo.close();await rm(root,{recursive:true,force:true});}
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MeetingStreamingDecoder } from "../../../src/services/meeting-minutes/meetingStreamingDecoder";
import { MeetingLiveAudioQuota } from "../../../src/services/meeting-minutes/meetingLiveAudioQuota";
import { MeetingAudioProcessor } from "../../../src/services/meeting-minutes/meetingAudioProcessor";
import { MeetingLiveTranscriptionRepository } from "../../../src/storage/meeting-minutes/meetingLiveTranscriptionRepository";
import { MeetingTranscriptionJobRepository } from "../../../src/storage/meeting-minutes/meetingTranscriptionJobRepository";
import { MeetingTranscriptProcessor } from "../../../src/services/meeting-minutes/meetingTranscriptProcessor";
import { liveTranscriptionProfile } from "../../../src/services/meeting-minutes/meetingLiveTranscriptionService";
import { wavePcm, pcmHash } from "../../../src/services/meeting-minutes/meetingLiveAudio";

test("Chromium MediaRecorder chunks match actual canonical processor PCM and final cache for both sources", {skip: !process.env.MEETING_PCM_FIXTURE_DIR}, async()=>{
  const fixtures: Array<{sourceId:"room-mic"|"remote-tab";mimeType:string;filePath:string;chunkSizes:number[]}>=JSON.parse(await readFile(path.join(process.env.MEETING_PCM_FIXTURE_DIR!,"manifest.json"),"utf8"));
  const root=await mkdtemp(path.join(tmpdir(),"browser-pcm-"));
  const live=new MeetingLiveTranscriptionRepository(":memory:"),jobs=new MeetingTranscriptionJobRepository(":memory:");
  const decoders:MeetingStreamingDecoder[]=[];
  const provider={enabled:true,name:"fixture",model:"fixture",transcribe:async()=>{assert.fail("CANONICAL_PCM_CACHE_MISS");return [];}};
  const profile=liveTranscriptionProfile(provider),sessionId="81818181-8181-4181-8181-818181818181";
  try {
    for (const fixture of fixtures) {
      await live.source(sessionId,fixture.sourceId,profile,0,false);
      const decoder=new MeetingStreamingDecoder({sessionId,sourceId:fixture.sourceId,profile,repository:live,processingDir:root,ffmpegPath:"ffmpeg",
        quota:new MeetingLiveAudioQuota(root,64*1024*1024,0)});decoders.push(decoder);
      const bytes=await readFile(fixture.filePath);let offset=0;
      for(const size of fixture.chunkSizes){await decoder.feed(bytes.subarray(offset,offset+size),false);offset+=size;}
      assert.equal(offset,bytes.length);await decoder.feed(Buffer.alloc(0),true);await decoder.completion;
      assert.equal(decoder.error,null);
    }
    const audio=new MeetingAudioProcessor({processingDir:path.join(root,"canonical"),ffmpegPath:"ffmpeg",ffprobePath:"ffprobe"});
    const artifacts=await audio.process({sessionId,ownerId:"fixture",title:"PCM parity",durationMs:65000,
      tracks:await Promise.all(fixtures.map(async f=>({...f,sizeBytes:(await readFile(f.filePath)).length})))},async()=>{});
    const tracks=fixtures.map(f=>({sourceId:f.sourceId,filePath:audio.resolveArtifactPath(artifacts.find(a=>a.type===`canonical-${f.sourceId}`)!.relativePath)}));
    let windows=0;
    for (;;) {
      const chunk=await live.claim(profile,`l${windows}`,Date.now(),60000);if(!chunk)break;
      const canonical=wavePcm(await readFile(tracks.find(t=>t.sourceId===chunk.sourceId)!.filePath));
      const expected=canonical.subarray(chunk.windowStartMs*32,chunk.windowEndMs*32);
      assert.deepEqual(wavePcm(await readFile(chunk.audioPath)),expected,`${chunk.sourceId}:${chunk.chunkIndex}:PCM_BYTES`);
      assert.equal(chunk.audioHash,pcmHash(expected));
      await live.finish(`l${windows}`,[]);windows++;
    }
    assert.ok(windows>=4,"BOTH_SOURCES_CROSS_WINDOW_BOUNDARY");
    await jobs.enqueue({jobId:"j",processingJobId:"a",sessionId,ownerId:"fixture",provider:provider.name,model:provider.model,maxAttempts:3,now:new Date().toISOString()});
    const processor=new MeetingTranscriptProcessor({provider,repository:jobs,liveRepository:live,processingDir:path.join(root,"final"),ffmpegPath:"ffmpeg",ffprobePath:"ffprobe"});
    await processor.process({jobId:"j",sessionId,tracks},async()=>{});
    console.log(JSON.stringify({event:"browser_pcm_parity",windows,sources:fixtures.map(f=>({sourceId:f.sourceId,mimeType:f.mimeType})),cacheMisses:0}));
  } finally {await Promise.all(decoders.map(d=>d.stop()));await live.close();await jobs.close();await rm(root,{recursive:true,force:true});}
});

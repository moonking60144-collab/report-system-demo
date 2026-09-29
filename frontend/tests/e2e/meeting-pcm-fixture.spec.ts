import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { selectMeetingRecordingMimeType } from "../../src/features/meeting-minutes/audio/meetingAudioSupport";

test("capture real MediaRecorder windows for streaming/canonical parity", async ({page}) => {
  test.skip(!process.env.MEETING_PCM_FIXTURE_DIR);
  test.setTimeout(90_000);
  await page.setContent('<button>Start fixture</button>');
  const candidates: string[]=[];
  selectMeetingRecordingMimeType(candidate=>{candidates.push(candidate);return false;});
  const supported=await page.evaluate(types=>types.filter(type=>MediaRecorder.isTypeSupported(type)),candidates);
  const mimeType=selectMeetingRecordingMimeType(type=>supported.includes(type));
  expect(mimeType).toBeTruthy();
  await page.getByRole("button").click();
  const fixtures=await page.evaluate(async type=>{
    const context=new AudioContext(); await context.resume();
    try {
      return await Promise.all(["room-mic","remote-tab"].map(async (sourceId,index)=>{
        const destination=context.createMediaStreamDestination();
        const oscillator=context.createOscillator();oscillator.frequency.value=440+index*220;
        oscillator.connect(destination);oscillator.start();
        const recorder=new MediaRecorder(destination.stream,{mimeType:type});
        const pieces:Blob[]=[];
        recorder.ondataavailable=event=>{if(event.data.size)pieces.push(event.data);};
        const stopped=new Promise<void>(resolve=>{recorder.onstop=()=>resolve();});
        recorder.start(1000);
        await new Promise(resolve=>setTimeout(resolve,31000));recorder.pause();
        await new Promise(resolve=>setTimeout(resolve,1000));recorder.resume();
        await new Promise(resolve=>setTimeout(resolve,34000));recorder.stop();await stopped;
        oscillator.stop();destination.stream.getTracks().forEach(track=>track.stop());
        return {sourceId,mimeType:recorder.mimeType,chunkSizes:pieces.map(piece=>piece.size),
          bytes:Array.from(new Uint8Array(await new Blob(pieces).arrayBuffer()))};
      }));
    } finally { await context.close(); }
  },mimeType!);
  const directory=process.env.MEETING_PCM_FIXTURE_DIR!;mkdirSync(directory,{recursive:true});
  const manifest=fixtures.map(({bytes,...metadata})=>{
    const filePath=path.join(directory,`${metadata.sourceId}.webm`);writeFileSync(filePath,Buffer.from(bytes));
    return {...metadata,filePath};
  });
  writeFileSync(path.join(directory,"manifest.json"),JSON.stringify(manifest,null,2));
});

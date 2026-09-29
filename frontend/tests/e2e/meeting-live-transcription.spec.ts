import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

test.use({locale:"zh-TW"});

test("recording receives live progress events; pause excludes break time and preserves real encoded audio", async ({page},testInfo) => {
  const sessionId="61616161-6161-4161-8161-616161616161";
  const chunks: Buffer[]=[]; let polls=0; let durationMs=0; let deferred=false; let created=false;
  const session={sessionId,title:"測試",status:"recording",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
    finalizedAt:null,durationMs:null,totalSizeBytes:0,deliveryMode:"one-shot",tracks:[{sourceId:"room-mic",mimeType:"audio/webm",chunkCount:0,sizeBytes:0,available:false}]};
  await page.addInitScript(()=>{
    const sources = new Set<EventTarget>();
    class Source extends EventTarget {
      readyState = 1;
      constructor() { super(); sources.add(this); }
      close() { sources.delete(this); }
    }
    window.EventSource = Source as unknown as typeof EventSource;
    Object.assign(window, { emitMeetingChange: () => {
      for (const source of sources) source.dispatchEvent(new MessageEvent("work-report-event", { data: JSON.stringify({ type: "meeting-state-changed" }) }));
    } });
    Object.defineProperty(navigator.mediaDevices,"getUserMedia",{value:async()=>{
      const context=new AudioContext();await context.resume();
      const oscillator=context.createOscillator(),destination=context.createMediaStreamDestination();
      oscillator.connect(destination);oscillator.start();return destination.stream;
    }});
  });
  await page.route("**/api/meetings/one-shot",route=>route.fulfill({json:{data:{mode:"one-shot",available:true,deliveryMs:86400000,admission:{activeMeetings:0,maxMeetings:2}}}}));
  await page.route("**/api/meetings/recordings**",async route=>{
    const url=new URL(route.request().url());
    if(url.pathname.endsWith("/current")) return route.fulfill({json:{data:{source:null,sessionId:created?sessionId:null}}});
    if(route.request().method()==="POST" && url.pathname.endsWith("/recordings")) created=true;
    if(url.pathname.endsWith("/delivery")) {polls++;return route.fulfill({json:{data:{phase:durationMs?"processing":"recording",processing:null,transcription:null,minutes:null,
      liveTranscription:[{sourceId:"room-mic",processedMs:0,decodedMs:0,complete:false,failed:false,deferred}]}}});}
    if(url.pathname.includes("/chunks/")) {chunks[Number(url.pathname.split("/").at(-1))]=route.request().postDataBuffer()!;return route.fulfill({json:{data:{}}});}
    if(url.pathname.endsWith("/finalize")) {durationMs=route.request().postDataJSON().durationMs;return route.fulfill({json:{data:{...session,status:"finalized",durationMs}}});}
    return route.fulfill({json:{data:session,meta:{sessionCapability:"a".repeat(43)}}});
  });
  await page.goto("/meetings/audio-check");
  await expect(page.getByRole("button",{name:"開始錄音",exact:true})).toBeEnabled();
  await page.getByRole("button",{name:"開始錄音",exact:true}).click();
  await expect(page.getByRole("button",{name:"暫停／休息"})).toBeVisible();
  await expect.poll(()=>polls).toBeGreaterThan(0);
  await expect(page.getByText(/逐字稿已完成至/)).toBeVisible();
  await page.waitForTimeout(1300);
  await page.getByRole("button",{name:"暫停／休息"}).click();
  await expect(page.getByRole("status").filter({hasText:"已暫停錄音"})).toBeVisible();
  const progressBox=await page.getByRole("status").filter({hasText:"已暫停錄音"}).boundingBox();
  const actionBox=await page.getByRole("button",{name:"繼續錄音"}).boundingBox();
  expect(actionBox!.y,"CONTROLS_MUST_NOT_COVER_PROGRESS").toBeGreaterThanOrEqual(progressBox!.y+progressBox!.height);
  await page.screenshot({path:testInfo.outputPath("paused-recording.png"),fullPage:true});
  await expect(page.locator(".meeting-recovery-panel")).toHaveCount(0);
  deferred=true;
  await page.evaluate(() => (window as unknown as { emitMeetingChange(): void }).emitMeetingChange());
  await expect(page.getByRole("status").filter({hasText:"即時轉錄暫存已達容量限制"})).toBeVisible();
  await page.waitForTimeout(600);
  const clock=await page.locator(".meeting-recording-clock strong").textContent();
  await page.waitForTimeout(1600);
  await expect(page.locator(".meeting-recording-clock strong")).toHaveText(clock!);
  await page.getByRole("button",{name:"繼續錄音"}).click();
  await page.waitForTimeout(1300);
  await page.getByRole("button",{name:"停止錄音",exact:true}).click();
  await expect.poll(()=>durationMs).toBeGreaterThan(2000);
  expect(durationMs).toBeLessThan(4200);
  expect(chunks.length).toBeGreaterThanOrEqual(2);
  const encoded=testInfo.outputPath("pause-resume.webm");writeFileSync(encoded,Buffer.concat(chunks));
  if(process.env.MEETING_LIVE_FFMPEG_TEST) {
    const pcm=testInfo.outputPath("pause-resume.pcm");
    execFileSync("ffmpeg",["-v","error","-i",encoded,"-ac","1","-ar","16000","-f","s16le",pcm]);
    const decodedMs=readFileSync(pcm).length/32;
    expect(Math.abs(decodedMs-durationMs),"PAUSE_TIME_MUST_NOT_APPEAR_IN_AUDIO").toBeLessThan(600);
  }
});

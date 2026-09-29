import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { startMeetingCoverage, stopMeetingCoverage } from "./meetingVerificationCoverage";

test.use({ locale: "zh-TW" });
test.beforeEach(async ({ page }) => startMeetingCoverage(page));
test.afterEach(async ({ page }) => stopMeetingCoverage(page));

for (const reload of [false, true]) {
  test(`後端中斷保存完整尾段，${reload ? "重開頁面" : "同一頁面"}續傳原會議而不取消`, async ({ page }) => {
    const sessionId = "81818181-8181-4181-8181-818181818181";
    const session = { sessionId, title: "連線恢復測試", status: "recording", deliveryMode: "one-shot",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), finalizedAt: null,
      durationMs: null, totalSizeBytes: 0,
      tracks: [{ sourceId: "room-mic", mimeType: "audio/webm", chunkCount: 0, sizeBytes: 0, available: false }] };
    let offline = false, created = 0, heartbeats = 0, aborts = 0, finalizes = 0;
    let chunkCount = 0;
    const uploaded = new Map<number, Buffer>();
    await page.addInitScript(() => {
      class Source extends EventTarget { readyState = 1; close() {} }
      window.EventSource = Source as unknown as typeof EventSource;
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => {
        const context = new AudioContext(); await context.resume();
        const oscillator = context.createOscillator(), destination = context.createMediaStreamDestination();
        oscillator.connect(destination); oscillator.start(); return destination.stream;
      } });
    });
    await page.route(url => url.pathname.startsWith("/api/"), async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/one-shot")) return route.fulfill({ json: { data: { mode: "one-shot", available: true,
        deliveryMs: 86400000, admission: { activeMeetings: finalizes ? 1 : 0, maxMeetings: 2 } } } });
      if (url.pathname.endsWith("/current")) return route.fulfill({ json: { data: { source: null, sessionId: created ? sessionId : null } } });
      if (url.pathname.endsWith("/heartbeat")) {
        heartbeats++;
        return route.fulfill({ status: offline ? 503 : 204, ...(offline ? { json: { error: { message: "後端更新中" } } } : {}) });
      }
      if (url.pathname.endsWith("/abort")) { aborts++; return route.fulfill({ status: 204 }); }
      if (url.pathname.includes("/chunks/")) {
        if (offline) return route.fulfill({ status: 503, json: { error: { message: "後端更新中" } } });
        uploaded.set(Number(url.pathname.split("/").at(-1)), route.request().postDataBuffer()!);
        return route.fulfill({ json: { data: {} } });
      }
      if (url.pathname.endsWith("/finalize")) {
        expect(offline, "OFFLINE_RECORDING_MUST_NOT_FINALIZE").toBe(false);
        finalizes++; chunkCount = route.request().postDataJSON().tracks[0].chunkCount;
        return route.fulfill({ json: { data: { ...session, status: "finalized" } } });
      }
      if (url.pathname.endsWith("/delivery")) return route.fulfill({ json: { data: { phase: finalizes ? "processing" : "recording",
        processing: null, transcription: null, minutes: null } } });
      if (url.pathname.endsWith("/recordings") && route.request().method() === "POST") created++;
      return route.fulfill({ json: { data: { ...session, recoveryUntil: new Date(Date.now() + 3600000).toISOString() } } });
    });
    await page.clock.install();
    await page.goto("/meetings/audio-check");
    await page.getByRole("button", { name: "開始錄音", exact: true }).click();
    await page.getByRole("button", { name: "暫停／休息", exact: true }).waitFor();
    await wait(250);
    offline = true;
    for (let index = 0; index < 3; index++) { await page.clock.fastForward(20000); await wait(100); }
    await expect(page.getByRole("button", { name: "重試上傳", exact: true }), "DISCONNECTED_RECORDING_MUST_BE_RECOVERABLE").toBeVisible();
    expect(heartbeats).toBe(3);
    expect(aborts, "DISCONNECTION_MUST_NOT_CANCEL_MEETING").toBe(0);
    expect(finalizes).toBe(0);
    const evidence = await page.evaluate(async () => {
      const store = await import("/src/features/meeting-minutes/audio/meetingRecordingRecoveryStore.ts");
      const [session] = await store.listRecoverySessions();
      const chunks = await store.readRecoveryChunks(session.sessionId);
      const blob = new Blob(chunks.sort((a, b) => a.sequence - b.sequence).map(chunk => chunk.blob));
      const sha = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
      return { session, chunks: chunks.length, sha: Array.from(new Uint8Array(sha), value => value.toString(16).padStart(2, "0")).join("") };
    });
    expect(evidence.session.stopped, "RECOVERY_MUST_HAVE_COMPLETE_STOP_MARKER").toBe(true);
    expect(evidence.session.totalBytes).toBeGreaterThan(0);
    expect(evidence.session.expectedChunks).toEqual([{ sourceId: "room-mic", chunkCount: evidence.chunks }]);
    const downloadEvent = page.waitForEvent("download");
    await page.getByRole("button", { name: /下載本機音軌備份/ }).click();
    expect((await downloadEvent).suggestedFilename()).toBe(`${sessionId}-room-mic.webm`);
    if (reload) await page.reload();
    offline = false;
    await page.getByRole("button", { name: "重試上傳", exact: true }).click();
    await expect.poll(() => finalizes).toBe(1);
    await expect.poll(() => page.evaluate(async () => {
      const store = await import("/src/features/meeting-minutes/audio/meetingRecordingRecoveryStore.ts");
      return (await store.listRecoverySessions()).length;
    })).toBe(0);
    expect(created, "RECOVERY_MUST_KEEP_ORIGINAL_SESSION").toBe(1);
    expect(aborts).toBe(0);
    expect(chunkCount).toBe(evidence.chunks);
    expect(uploaded.size).toBe(evidence.chunks);
    expect(createHash("sha256").update(Buffer.concat([...uploaded].sort(([a], [b]) => a - b).map(([, body]) => body))).digest("hex"),
      "RECOVERED_AUDIO_MUST_MATCH_LOCAL_BYTES").toBe(evidence.sha);
  });
}

test("停止後晚到的第三次心跳失敗不會中斷尾段上傳", async ({ page }) => {
  const sessionId = "82828282-8282-4282-8282-828282828282";
  let heartbeats = 0, finalizes = 0, aborts = 0, uploadCancelled = false;
  let releaseHeartbeat!: () => void, releaseUpload!: () => void;
  const heartbeatGate = new Promise<void>(resolve => { releaseHeartbeat = resolve; });
  const uploadGate = new Promise<void>(resolve => { releaseUpload = resolve; });
  const session = { sessionId, status: "recording", deliveryMode: "one-shot", title: "晚到心跳",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    tracks: [{ sourceId: "room-mic", mimeType: "audio/webm" }] };
  await page.addInitScript(() => {
    class Source extends EventTarget { readyState = 1; close() {} }
    window.EventSource = Source as unknown as typeof EventSource;
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => {
      const context = new AudioContext(); await context.resume();
      const oscillator = context.createOscillator(), destination = context.createMediaStreamDestination();
      oscillator.connect(destination); oscillator.start(); return destination.stream;
    } });
  });
  page.on("requestfailed", request => { if (request.url().includes("/chunks/")) uploadCancelled = true; });
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/one-shot")) return route.fulfill({ json: { data: { mode: "one-shot", available: true,
      deliveryMs: 86400000, admission: { activeMeetings: 0, maxMeetings: 2 } } } });
    if (url.pathname.endsWith("/current")) return route.fulfill({ json: { data: { source: null, sessionId: null } } });
    if (url.pathname.endsWith("/heartbeat")) {
      heartbeats++;
      if (heartbeats === 3) await heartbeatGate;
      return route.fulfill({ status: 503, json: { error: { message: "晚到的連線失敗" } } });
    }
    if (url.pathname.includes("/chunks/")) { await uploadGate; return route.fulfill({ json: { data: {} } }); }
    if (url.pathname.endsWith("/finalize")) { finalizes++; return route.fulfill({ json: { data: { ...session, status: "finalized" } } }); }
    if (url.pathname.endsWith("/abort")) { aborts++; return route.fulfill({ status: 204 }); }
    if (url.pathname.endsWith("/delivery")) return route.fulfill({ json: { data: { phase: finalizes ? "processing" : "recording" } } });
    return route.fulfill({ json: { data: session } });
  });
  await page.clock.install(); await page.goto("/meetings/audio-check");
  await page.getByRole("button", { name: "開始錄音", exact: true }).click();
  await page.getByRole("button", { name: "暫停／休息", exact: true }).waitFor();
  await wait(250);
  for (let index = 0; index < 3; index++) { await page.clock.fastForward(20000); await wait(100); }
  await expect.poll(() => heartbeats).toBe(3);
  await page.getByRole("button", { name: "停止錄音", exact: true }).click();
  await expect.poll(() => page.evaluate(async () => {
    const store = await import("/src/features/meeting-minutes/audio/meetingRecordingRecoveryStore.ts");
    return (await store.listRecoverySessions())[0]?.stopped;
  })).toBe(true);
  releaseHeartbeat(); await wait(100);
  expect(uploadCancelled, "LATE_HEARTBEAT_MUST_NOT_ABORT_STOPPED_RECORDING").toBe(false);
  releaseUpload();
  await expect.poll(() => finalizes, { message: "LATE_HEARTBEAT_MUST_NOT_BLOCK_FINALIZE" }).toBe(1);
  expect(aborts).toBe(0);
});

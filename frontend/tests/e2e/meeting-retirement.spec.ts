import { expect, test } from "@playwright/test";
import { startMeetingCoverage, stopMeetingCoverage } from "./meetingVerificationCoverage";

test.beforeEach(async ({ page }) => startMeetingCoverage(page));
test.afterEach(async ({ page }) => stopMeetingCoverage(page));

test.use({ locale: "zh-TW" });

test("首次 availability 尚未回覆時顯示查詢中，不冒充服務異常或容量", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "EventSource", { configurable: true, value: undefined });
  });
  let availabilityReads = 0;
  let releaseAvailability!: () => void;
  const availabilityGate = new Promise<void>(resolve => { releaseAvailability = resolve; });
  await page.route("**/api/meetings/one-shot", async route => {
    availabilityReads += 1;
    await availabilityGate;
    await route.fulfill({ json: { data: {
      mode: "one-shot",
      available: true,
      reason: null,
      deliveryMs: 86400000,
      admission: { activeMeetings: 0, maxMeetings: 2 },
    } } });
  });

  await page.goto("/meetings/audio-check");
  await expect(page.getByText("正在確認會議服務…", { exact: true })).toBeVisible();
  await expect(page.getByText("會議處理服務尚未就緒，請稍後重試或聯絡開發者。", { exact: false })).toHaveCount(0);
  await expect(page.getByText("目前已占用：0／2", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "開始錄音", exact: true })).toBeDisabled();

  releaseAvailability();
  await expect(page.getByText("目前已占用：0／2", { exact: true })).toBeVisible();
  await expect(page.getByText("正在確認會議服務…", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "開始錄音", exact: true })).toBeEnabled();
  expect(availabilityReads).toBe(1);
});

test("availability 查詢中收到失效事件時完成 trailing reread", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "EventSource", { configurable: true, value: undefined });
  });
  let availabilityReads = 0;
  let releaseStale!: () => void;
  let releaseFresh!: () => void;
  const staleGate = new Promise<void>(resolve => { releaseStale = resolve; });
  const freshGate = new Promise<void>(resolve => { releaseFresh = resolve; });
  await page.route("**/api/meetings/one-shot", async route => {
    availabilityReads += 1;
    if (availabilityReads === 1) {
      await staleGate;
      await route.fulfill({ json: { data: {
        mode: "one-shot",
        available: true,
        reason: null,
        deliveryMs: 86400000,
        admission: { activeMeetings: 2, maxMeetings: 2 },
      } } });
      return;
    }
    await freshGate;
    await route.fulfill({ json: { data: {
      mode: "one-shot",
      available: true,
      reason: null,
      deliveryMs: 86400000,
      admission: { activeMeetings: 0, maxMeetings: 2 },
    } } });
  });

  await page.goto("/meetings/audio-check");
  await expect.poll(() => availabilityReads).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(150);
  releaseStale();

  await expect.poll(() => availabilityReads).toBe(2);
  await expect(page.getByText("正在確認會議服務…", { exact: true })).toBeVisible();
  await expect(page.getByText("目前已占用：2／2", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "開始錄音", exact: true })).toBeDisabled();
  releaseFresh();

  await expect(page.getByText("目前已占用：0／2", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "開始錄音", exact: true })).toBeEnabled();
  expect(availabilityReads).toBe(2);
});

test("availability 重新查詢失敗與重試期間不沿用舊狀態開始錄音", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "EventSource", { configurable: true, value: undefined });
  });
  let availabilityReads = 0;
  let releaseRetry!: () => void;
  const retryGate = new Promise<void>(resolve => { releaseRetry = resolve; });
  await page.route("**/api/meetings/one-shot", async route => {
    availabilityReads += 1;
    if (availabilityReads === 2) {
      await route.fulfill({ status: 503, json: { error: { message: "availability refresh failed" } } });
      return;
    }
    if (availabilityReads === 3) await retryGate;
    await route.fulfill({ json: { data: {
      mode: "one-shot",
      available: true,
      reason: null,
      deliveryMs: 86400000,
      admission: { activeMeetings: 0, maxMeetings: 2 },
    } } });
  });

  await page.goto("/meetings/audio-check");
  const start = page.getByRole("button", { name: "開始錄音", exact: true });
  await expect(start).toBeEnabled();

  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("availability refresh failed", { exact: false })).toBeVisible();
  await expect(start).toBeDisabled();

  await page.getByRole("button", { name: "重新查詢", exact: true }).click();
  await expect(page.getByText("正在確認會議服務…", { exact: true })).toBeVisible();
  await expect(start).toBeDisabled();
  releaseRetry();

  await expect(page.getByText("目前已占用：0／2", { exact: true })).toBeVisible();
  await expect(start).toBeEnabled();
  expect(availabilityReads).toBe(3);
});

test("舊後端不再偷偷切回密碼介面", async ({ page }) => {
  await page.route("**/api/meetings/one-shot", route => route.fulfill({ status: 404, json: {} }));
  await page.goto("/meetings/audio-check");
  await expect(page.getByText("會議服務版本不相容，請更新後端後再重新整理。")).toBeVisible();
  await expect(page.getByRole("button", { name: "開始錄音", exact: true })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: /密碼|Code|存取碼/ })).toHaveCount(0);
});

test("持鎖恢復顯示等待，鎖釋放後可在同一頁重新接手", async ({ page, context }) => {
  const sessionId = "34343434-3434-4434-8434-343434343434";
  let finalizes = 0;
  await context.route("**/api/meetings/one-shot", route => route.fulfill({ json: { data: { mode: "one-shot", available: true, deliveryMs: 86400000, admission: { activeMeetings: 0, maxMeetings: 2 } } } }));
  await context.route("**/api/meetings/recordings**", route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/current")) return route.fulfill({ json: { data: { source: null, sessionId: null } } });
    if (url.pathname.endsWith("/finalize")) { finalizes++; return route.fulfill({ json: { data: { sessionId, status: "finalized", tracks: [] } } }); }
    if (url.pathname.endsWith("/delivery")) return route.fulfill({ json: { data: { phase: "processing" } } });
    return route.fulfill({ json: { data: { sessionId, status: "recording", tracks: [] } } });
  });
  await page.goto("/meetings/audio-check");
  await expect(page.getByRole("button", { name: "開始錄音", exact: true })).toBeEnabled();
  const owner = await context.newPage();
  await owner.goto("/meetings/audio-check");
  await expect(owner.getByRole("button", { name: "開始錄音", exact: true })).toBeEnabled();
  await owner.evaluate(async sessionId => {
    const store = await import("/src/features/meeting-minutes/audio/meetingRecordingRecoveryStore.ts");
    const release = await store.acquireRecoveryLock(sessionId);
    (window as typeof window & { releaseRecordingLock: () => void }).releaseRecordingLock = release!;
    await store.createRecoverySession({ sessionId, title: "等待接手", startedAtMs: Date.now() - 5000, durationMs: 5000, stopped: false, totalBytes: 0, requiresSessionCapability: false, tracks: [{ sourceId: "room-mic", mimeType: "audio/webm" }] });
    await store.saveRecoveryChunk({ sessionId, sourceId: "room-mic", sequence: 0, blob: new Blob(["audio"]) }, 5000);
    await store.stopRecoverySession(sessionId, 5000, [{ sourceId: "room-mic", chunkCount: 1 }]);
  }, sessionId);
  await page.evaluate(sessionId => sessionStorage.setItem("meeting-minutes:recovery-session:v1", sessionId), sessionId);
  await page.reload();
  await expect(page.getByText(/此筆錄音正在其他分頁處理/), "LOCK_CONTENTION_VISIBLE").toBeVisible();
  await expect(page.getByRole("button", { name: "開始錄音", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "重新接手錄音" }).click();
  await expect(page.getByRole("button", { name: "重新接手錄音" })).toBeVisible();
  expect(finalizes).toBe(0);
  await owner.evaluate(() => (window as typeof window & { releaseRecordingLock: () => void }).releaseRecordingLock());
  await page.getByRole("button", { name: "重新接手錄音" }).click();
  await expect(page.getByRole("button", { name: "重試上傳", exact: true }), "LOCK_RELEASE_MUST_ALLOW_RECOVERY").toBeVisible();
  await page.getByRole("button", { name: "重試上傳", exact: true }).click();
  await expect.poll(() => finalizes).toBe(1);
  await owner.close();
});

for (const mode of ["pending", "finalized", "expired", "offline"] as const) {
  test(`既有錄音恢復 ${mode}：不新增、不回舊 UI、不啟動人工摘要`, async ({ page }) => {
    const sessionId = "56565656-5656-4565-8565-565656565656";
    const capability = "a".repeat(43);
    let uploads = 0, finalizes = 0, unexpected = 0;
    const data = { sessionId, title: "舊錄音續傳", status: mode === "finalized" ? "finalized" : "recording", tracks: [{ sourceId: "room-mic", mimeType: "audio/webm", available: true }], recoveryUntil: new Date(Date.now() + (mode === "expired" ? -60_000 : 60_000)).toISOString() };
    await page.route("**/api/meetings/one-shot", route => route.fulfill({ json: { data: { mode: "one-shot", available: true, deliveryMs: 86400000, admission: { activeMeetings: 0, maxMeetings: 2 } } } }));
    await page.route("**/api/meetings/recordings**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/current")) return route.fulfill({ json: { data: { source: null, sessionId: null } } });
      expect(route.request().headers()["x-meeting-session-capability"]).toBe(capability);
      if (url.pathname.endsWith(`/${sessionId}`)) return route.fulfill({ json: { data } });
      if (url.pathname.endsWith("/chunks/0")) { uploads++; return route.fulfill({ json: { data: {} } }); }
      if (url.pathname.endsWith("/finalize")) { finalizes++; return route.fulfill({ json: { data: { ...data, status: "finalized" } } }); }
      if (url.pathname.endsWith("/delivery")) return route.fulfill({ json: { data: { phase: "legacy-saved", session: data, processing: null, transcription: null, minutes: null } } });
      if (url.pathname.endsWith("/tracks/room-mic")) return route.fulfill({ contentType: "audio/webm", body: "audio" });
      unexpected++; return route.fulfill({ status: 410, json: {} });
    });
    await page.goto("/meetings/audio-check");
    await expect(page.getByRole("button", { name: "開始錄音", exact: true })).toBeEnabled();
    await page.evaluate(async ({ sessionId, capability }) => {
      const store = await import("/src/features/meeting-minutes/audio/meetingRecordingRecoveryStore.ts");
      await store.createRecoverySession({ sessionId, title: "舊錄音續傳", startedAtMs: Date.now() - 5000, durationMs: 5000, stopped: true, totalBytes: 0, requiresSessionCapability: true, tracks: [{ sourceId: "room-mic", mimeType: "audio/webm" }] });
      await store.saveRecoveryChunk({ sessionId, sourceId: "room-mic", sequence: 0, blob: new Blob(["audio"], { type: "audio/webm" }) }, 5000);
      sessionStorage.setItem("meeting-minutes:recovery-session:v1", sessionId);
      sessionStorage.setItem(`meeting-minutes:session-capability:v1:${sessionId}`, capability);
    }, { sessionId, capability });
    if (mode === "offline") await page.route("**/api/meetings/one-shot", route => route.fulfill({ status: 503, json: { error: { message: "後端離線" } } }));
    await page.reload();
    if (mode === "offline") {
      await expect(page.getByRole("button", { name: "重試上傳", exact: true })).toBeVisible();
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: /下載本機音軌備份/ }).click();
      expect((await download).suggestedFilename()).toContain(sessionId);
      expect(uploads).toBe(0); expect(finalizes).toBe(0); expect(unexpected).toBe(0);
      return;
    }
    await page.getByRole("button", { name: "重試上傳", exact: true }).click();
    if (mode === "expired") {
      await expect(page.getByText(/後端錄音續傳期限已過/)).toBeVisible();
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: /下載本機音軌備份/ }).click();
      expect((await download).suggestedFilename()).toContain(sessionId);
      expect(uploads).toBe(0); expect(finalizes).toBe(0);
    } else {
      await expect(page.getByText(/這筆舊錄音不會轉入新的自動摘要流程/)).toBeVisible();
      expect(uploads).toBe(mode === "finalized" ? 0 : 1);
      await expect.poll(() => finalizes).toBe(mode === "finalized" ? 0 : 1);
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: "下載 room-mic 音軌" }).click();
      expect((await download).suggestedFilename()).toBe(`${sessionId}-room-mic.webm`);
      await page.reload();
      await expect(page.getByText(/這筆舊錄音不會轉入新的自動摘要流程/)).toBeVisible();
      expect(await page.evaluate(async () => {
        const store = await import("/src/features/meeting-minutes/audio/meetingRecordingRecoveryStore.ts");
        return (await store.listRecoverySessions()).length;
      })).toBe(0);
    }
    expect(unexpected).toBe(0);
    await expect(page).not.toHaveURL(/legacySession/);
    await expect(page.locator(".meeting-processing-panel")).toHaveCount(0);
  });
}


test("錄音中收到會議取消事件會停止麥克風，不會自動建立新會議", async ({ page }) => {
  let created = false;
  let cancelled = false;
  let creations = 0;
  let availabilityReads = 0;
  let currentReads = 0;
  let deliveryReads = 0;
  const sessionId = "72727272-7272-4272-8272-727272727272";
  const session = { sessionId, title: "取消測試", status: "recording", createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), durationMs: null, totalSizeBytes: 0, deliveryMode: "one-shot",
    tracks: [{ sourceId: "room-mic", mimeType: "audio/webm", chunkCount: 0, sizeBytes: 0, available: false }] };
  await page.addInitScript(() => {
    const sources = new Set<EventTarget>();
    class Source extends EventTarget {
      readyState = 1;
      constructor() { super(); sources.add(this); }
      close() { sources.delete(this); }
    }
    window.EventSource = Source as unknown as typeof EventSource;
    Object.assign(window, { emitMeetingChange: () => {
      for (const source of sources) source.dispatchEvent(new MessageEvent("work-report-event", { data: '{"type":"meeting-state-changed"}' }));
    } });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => {
      const context = new AudioContext(); await context.resume();
      const oscillator = context.createOscillator(); const destination = context.createMediaStreamDestination();
      oscillator.connect(destination); oscillator.start();
      Object.assign(window, { recordingTracks: destination.stream.getTracks() });
      return destination.stream;
    } });
  });
  await page.route("**/api/meetings/one-shot", route => {
    availabilityReads += 1;
    return route.fulfill({ json: { data: {
      mode: "one-shot", available: true, reason: null, deliveryMs: 86400000,
      admission: { activeMeetings: cancelled ? 0 : creations, maxMeetings: 2 },
    } } });
  });
  await page.route("**/api/meetings/recordings**", route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/current")) {
      currentReads += 1;
      return route.fulfill({ json: { data: { source: null, sessionId: created && !cancelled ? sessionId : null } } });
    }
    if (url.pathname.endsWith("/delivery")) {
      deliveryReads += 1;
      return route.fulfill({ json: { data: {
      phase: cancelled ? "cancelled" : "recording", expiresAt: null, errorCode: cancelled ? "MEETING_CANCELLED" : null,
      errorMessage: null, processing: null, transcription: null, minutes: null, liveTranscription: [],
      admission: { activeMeetings: cancelled ? 0 : creations, maxMeetings: 2 },
    } } });
    }
    if (route.request().method() === "POST" && url.pathname.endsWith("/recordings")) { created = true; creations++; }
    return route.fulfill({ json: { data: session, meta: { sessionCapability: "a".repeat(43) } } });
  });
  await page.goto("/meetings/audio-check");
  await page.getByRole("button", { name: "開始錄音", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止錄音", exact: true })).toBeVisible();
  await expect.poll(() => deliveryReads).toBeGreaterThan(0);
  await page.waitForTimeout(100);
  const beforeEvent = { availabilityReads, currentReads, deliveryReads };
  cancelled = true;
  await page.evaluate(() => (window as unknown as { emitMeetingChange(): void }).emitMeetingChange());
  await expect(page.getByText("已取消", { exact: true })).toBeVisible();
  await expect.poll(() => deliveryReads).toBe(beforeEvent.deliveryReads + 1);
  expect(currentReads).toBe(beforeEvent.currentReads);
  expect(availabilityReads).toBe(beforeEvent.availabilityReads);
  await expect.poll(() => page.evaluate(() => (window as unknown as { recordingTracks: MediaStreamTrack[] }).recordingTracks.every(track => track.readyState === "ended"))).toBe(true);
  expect(creations).toBe(1);
  await page.getByRole("button", { name: "離開這筆，開始下一場" }).click();
  await expect(page.getByRole("button", { name: "開始錄音", exact: true })).toBeEnabled();
  expect(creations).toBe(1);
});

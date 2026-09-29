import { expect, test } from "@playwright/test";
import { startMeetingCoverage, stopMeetingCoverage } from "./meetingVerificationCoverage";

test.beforeEach(async ({ page }) => startMeetingCoverage(page));
test.afterEach(async ({ page }) => stopMeetingCoverage(page));

async function installMockMeetingAudioSources(
  page: import("@playwright/test").Page,
  options: { remotePermissionDenied?: boolean } = {}
) {
  await page.addInitScript(({ remotePermissionDenied }) => {
    const contexts: AudioContext[] = [];
    const monitoredContexts: AudioContext[] = [];
    const NativeAudioContext = window.AudioContext;
    window.AudioContext = class extends NativeAudioContext {
      constructor(options?: AudioContextOptions) { super(options); monitoredContexts.push(this); }
    };
    const captureState = window as typeof window & {
      __meetingCaptureCalls?: Array<"room-mic" | "remote-tab">;
      __meetingAudioContexts?: AudioContext[];
    };
    captureState.__meetingCaptureCalls = [];
    captureState.__meetingAudioContexts = monitoredContexts;
    const createAudioStream = () => {
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      const oscillator = context.createOscillator();
      oscillator.frequency.value = 220;
      oscillator.connect(destination);
      oscillator.start();
      contexts.push(context);
      return destination.stream;
    };

    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        captureState.__meetingCaptureCalls?.push("room-mic");
        return createAudioStream();
      },
    });
    Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
      configurable: true,
      value: async () => {
        captureState.__meetingCaptureCalls?.push("remote-tab");
        if (remotePermissionDenied) {
          throw new DOMException("remote capture denied", "NotAllowedError");
        }
        return createAudioStream();
      },
    });

    window.addEventListener("pagehide", () => {
      contexts.forEach((context) => void context.close());
    });
  }, options);
}

async function installChunkedMediaRecorder(page: import("@playwright/test").Page, chunkCount = 1, emitDuringRecording = false) {
  await page.addInitScript(({ chunkCount, emitDuringRecording }) => {
    class ChunkedMediaRecorder extends EventTarget {
      static isTypeSupported() {
        return true;
      }

      state: RecordingState = "inactive";
      mimeType = "audio/webm";

      start() {
        this.state = "recording";
        if (emitDuringRecording) this.emitChunks();
      }

      emitChunks() {
        for (let sequence = 0; sequence < chunkCount; sequence += 1) this.dispatchEvent(
          new BlobEvent("dataavailable", {
            data: new Blob([chunkCount === 1 ? "persistent-audio" : `persistent-audio-${sequence}`], { type: this.mimeType }),
          })
        );
      }

      stop() {
        if (this.state === "inactive") return;
        this.state = "inactive";
        if (!emitDuringRecording) this.emitChunks();
        this.dispatchEvent(new Event("stop"));
      }
    }

    Object.defineProperty(window, "MediaRecorder", {
      configurable: true,
      value: ChunkedMediaRecorder,
    });
  }, { chunkCount, emitDuringRecording });
}
const PROCESS_API_PATTERN = "**/api/meetings/recordings/*/process";
async function installSingleTrackRecordingApi(
  page: import("@playwright/test").Page,
  options: {
    sessionId: string;
    deliveryMode?: "one-shot";
    finalizeStatus?: 200 | 401 | 503;
    finalizeErrorCode?: string;
    sessionCapability?: string;
  }
) {
  const calls = {
    createBodies: [] as Array<{
      title?: unknown;
      sourceIds?: unknown;
    }>,
    finalizeSessionIds: [] as string[],
    chunkCapabilities: [] as Array<string | undefined>,
    finalizeCapabilities: [] as Array<string | undefined>,
    abortCount: 0,
    finalizeStatus: options.finalizeStatus ?? 200,
  };
  await page.route("**/api/meetings/recordings", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    calls.createBodies.push(
      route.request().postDataJSON() as {
        title?: unknown;
        sourceIds?: unknown;
        }
    );
    await route.fulfill({
      status: 201,
      headers: { "Set-Cookie": "meeting_recording_owner_v1=fixture; Path=/api/meetings/recordings; HttpOnly; SameSite=Strict" },
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          sessionId: options.sessionId,
          deliveryMode: options.deliveryMode,
          title: "錄音生命週期測試",
          status: "recording",
          createdAt: "2026-07-15T00:00:00.000Z",
          updatedAt: "2026-07-15T00:00:00.000Z",
          finalizedAt: null,
          durationMs: null,
          totalSizeBytes: 0,
          tracks: [],
        },
        meta: { sessionCapability: options.sessionCapability ?? null },
      }),
    });
  });
  await page.route(
    /\/api\/meetings\/recordings\/[^/]+\/tracks\/[^/]+\/chunks\/\d+$/,
    async (route) => {
      calls.chunkCapabilities.push(
        route.request().headers()["x-meeting-session-capability"]
      );
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { sequence: 0, sizeBytes: 16, duplicate: false } }),
      });
    }
  );
  await page.route(/\/api\/meetings\/recordings\/[^/]+\/finalize$/, async (route) => {
    const sessionId = new URL(route.request().url()).pathname.split("/").at(-2)!;
    calls.finalizeSessionIds.push(sessionId);
    calls.finalizeCapabilities.push(
      route.request().headers()["x-meeting-session-capability"]
    );
    if (calls.finalizeStatus !== 200) {
      await route.fulfill({
        status: calls.finalizeStatus,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: options.finalizeErrorCode,
            message:
              calls.finalizeStatus === 401
                ? "錄音 session 權限已失效。"
                : "暫時無法合併音軌",
          },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          sessionId,
          deliveryMode: options.deliveryMode,
          title: "錄音生命週期測試",
          status: "finalized",
          createdAt: "2026-07-15T00:00:00.000Z",
          updatedAt: "2026-07-15T00:01:00.000Z",
          finalizedAt: "2026-07-15T00:01:00.000Z",
          durationMs: 5_000,
          totalSizeBytes: 16,
          tracks: [
            {
              sourceId: "room-mic",
              mimeType: "audio/webm",
              chunkCount: 1,
              sizeBytes: 16,
              available: true,
            },
          ],
        },
      }),
    });
  });
  await page.route(/\/api\/meetings\/recordings\/[^/]+\/abort$/, async (route) => {
    calls.abortCount += 1;
    await route.fulfill({ status: 204 });
  });
  await page.route(PROCESS_API_PATTERN, async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "MEETING_PROCESSING_WORKER_DISABLED",
          message: "錄音後處理 worker 尚未啟用。",
        },
      }),
    });
  });
  return calls;
}


test.describe("one-shot meeting", () => {
  test.use({ locale: "zh-TW" });
  for (const denied of [false, true]) {
    test(`遠端音源${denied ? "拒絕權限不建立錄音" : "與麥克風都完成片段後才 finalize"}`, async ({ page }) => {
      const sessionId = "88888888-8888-4888-8888-888888888888";
      await installMockMeetingAudioSources(page, { remotePermissionDenied: denied });
      await installChunkedMediaRecorder(page);
      const calls = await installSingleTrackRecordingApi(page, { sessionId, deliveryMode: "one-shot" });
      await page.route("**/api/meetings/one-shot", route => route.fulfill({ json: { data: { mode: "one-shot", available: true, deliveryMs: 86400000, admission: { activeMeetings: 0, maxMeetings: 2 } } } }));
      const finalizedTracks: string[][] = [];
      await page.route(`**/api/meetings/recordings/${sessionId}/finalize`, async route => { finalizedTracks.push(route.request().postDataJSON().tracks.map((track: { sourceId: string }) => track.sourceId).sort()); await route.fallback(); });
      await page.route(`**/api/meetings/recordings/${sessionId}/delivery`, route => route.fulfill({ json: { data: { phase: "processing" } } }));
      await page.goto("/meetings/audio-check");
      await page.getByRole("checkbox").check();
      await page.getByRole("button", { name: "開始錄音", exact: true }).click();
      if (denied) {
        await expect(page.getByRole("alert")).toBeVisible();
        expect(calls.createBodies).toHaveLength(0);
      } else {
        await page.getByRole("button", { name: "停止錄音", exact: false }).click();
        await expect.poll(() => finalizedTracks.length).toBe(1);
        expect(finalizedTracks[0]).toEqual(["remote-tab", "room-mic"]);
        expect(calls.createBodies).toHaveLength(1);
      }
    });
  }
  test("no password, upload retry survives reload, automatic summary download and expiry", async ({ page }, testInfo) => {
    const additionalSectionRequest = "請增加風險分析與主管建議";
    const sessionId = "11111111-1111-4111-8111-111111111111";
    await installMockMeetingAudioSources(page);
    await installChunkedMediaRecorder(page);
    const calls = await installSingleTrackRecordingApi(page, { sessionId, deliveryMode: "one-shot" });
    await page.route(`**/api/meetings/recordings/${sessionId}`, route => route.fulfill({ json: { data: { sessionId, title: "續傳測試", status: "recording", deliveryMode: "one-shot", tracks: [], recoveryUntil: null } } }));
    await page.route("**/api/meetings/one-shot", route => route.fulfill({ json: { data: { mode: "one-shot", available: true, reason: null, deliveryMs: 86400000, admission: { activeMeetings: 0, maxMeetings: 2 } } } }));
    let phase = "processing";
    let chunkFailure = true;
    await page.route(/\/api\/meetings\/recordings\/[^/]+\/tracks\/[^/]+\/chunks\/\d+$/, async route => {
      if (chunkFailure) await route.fulfill({ status: 503, json: { error: { code: "OFFLINE", message: "offline" } } });
      else await route.fallback();
    });
    await page.route(`**/api/meetings/recordings/${sessionId}/delivery`, route => {
      if (process.env.VITE_API_BASE_URL === "/api") expect(route.request().headers().cookie, "DELIVERY_COOKIE_PATH").toContain("meeting_recording_owner_v1=fixture");
      return route.fulfill({ json: { data: { phase, additionalSectionRequest, expiresAt: "2026-09-10T01:00:00Z", errorCode: null, errorMessage: null, processing: null, transcription: null, minutes: null } } });
    });
    await page.route(`**/api/meetings/recordings/${sessionId}/delivery/html*`, route => route.fulfill({ contentType: "text/html; charset=utf-8", headers: route.request().url().includes("download=1") ? { "Content-Disposition": "attachment; filename=meeting-summary.html" } : {}, body: "<!doctype html><html><meta charset='utf-8'><body><h1>測試會議摘要</h1><p>已確認決議</p></body></html>" }));
    await page.goto("/meetings/audio-check");
    await expect(page.getByText("請點擊開始錄音", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: /密碼|Code|存取碼/ })).toHaveCount(0);
    const additionalInput = page.getByRole("textbox", { name: "額外段落（選填）" });
    await expect(additionalInput).not.toBeVisible();
    await page.locator("summary").filter({ hasText: "額外段落（選填）" }).click();
    await expect(additionalInput).toBeEnabled();
    await expect(additionalInput).toHaveAttribute("maxlength", "2000");
    await additionalInput.fill(additionalSectionRequest);
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await additionalInput.focus();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`additional-sections-input-${width}.png`), fullPage: true });
    }
    await page.getByRole("button", { name: "開始錄音", exact: true }).click();
    await expect(page.getByRole("button", { name: "停止錄音", exact: false })).toBeVisible();
    await expect(additionalInput).toBeDisabled();
    await expect(page.getByRole("meter", { name: "麥克風音量" })).toBeVisible();
    await expect.poll(() => page.getByRole("meter", { name: "麥克風音量" }).evaluate((element: HTMLMeterElement) => element.value)).toBeGreaterThan(0);
    await page.evaluate(() => (window as typeof window & { __meetingAudioContexts: AudioContext[] }).__meetingAudioContexts[0].suspend());
    await expect(page.getByText("目前安靜", { exact: true })).toBeVisible();
    await page.evaluate(() => (window as typeof window & { __meetingAudioContexts: AudioContext[] }).__meetingAudioContexts[0].resume());
    await expect(page.getByText("收到聲音", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("one-shot-recording-375.png"), fullPage: true });
    await page.getByRole("button", { name: "停止錄音", exact: false }).click();
    await expect(page.getByRole("meter")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => {
      const contexts = (window as typeof window & { __meetingAudioContexts: AudioContext[] }).__meetingAudioContexts;
      return contexts.length >= 2 && contexts[0].state === "running" && contexts.slice(1).every(context => context.state === "closed");
    })).toBe(true);
    await expect(page.getByRole("button", { name: "重試上傳", exact: true })).toBeVisible();
    expect(calls.abortCount).toBe(0);
    expect(calls.finalizeSessionIds).toEqual([]);
    expect(calls.createBodies[0], "ONE_SHOT_MODE_IDENTITY").toMatchObject({ deliveryMode: "one-shot" });
    expect(calls.createBodies[0], "ADDITIONAL_REQUEST_SUBMITTED").toMatchObject({ additionalSectionRequest });
    await page.reload();
    await page.locator("summary").filter({ hasText: "額外段落（選填）" }).click();
    await expect(additionalInput).toHaveValue(additionalSectionRequest);
    await expect(additionalInput).toBeDisabled();
    await expect(page.getByRole("button", { name: "重試上傳", exact: true })).toBeVisible();
    chunkFailure = false;
    await page.getByRole("button", { name: "重試上傳", exact: true }).click();
    await expect.poll(() => calls.finalizeSessionIds.length).toBe(1);
    await expect(page.getByText("正在整理音檔", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "開始錄音", exact: true })).toHaveCount(0);
    phase = "ready";
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("link", { name: "下載 HTML", exact: false })).toBeVisible();
    await expect(page.frameLocator("iframe").getByRole("heading", { name: "測試會議摘要" })).toBeVisible();
    const downloaded = page.waitForEvent("download");
    await page.getByRole("link", { name: "下載 HTML", exact: false }).click();
    expect((await downloaded).suggestedFilename()).toBe("meeting-summary.html");
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.frameLocator("iframe").getByRole("heading", { name: "測試會議摘要" })).toBeVisible();
      await page.evaluate(() => window.scrollTo(0, 0));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`one-shot-ready-${width}.png`), fullPage: true });
      await page.getByRole("button", { name: "放大閱讀" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.frameLocator("dialog iframe").getByRole("heading", { name: "測試會議摘要" })).toBeVisible();
      expect(await page.getByRole("dialog").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`one-shot-expanded-${width}.png`) });
      await page.keyboard.press("Tab");
      expect(await page.getByRole("dialog").evaluate(element => element.contains(document.activeElement))).toBe(true);
      // Sandboxed document key events stay inside the iframe; return to the dialog controls.
      await page.keyboard.press("Shift+Tab");
      await expect(page.getByRole("button", { name: "關閉閱讀" })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).not.toBeVisible();
      await expect(page.getByRole("button", { name: "放大閱讀" })).toBeFocused();
    }
    phase = "expired";
    await page.reload();
    await expect(page.getByText("下載期限已到", { exact: false })).toBeVisible();
    await expect(page.getByRole("link", { name: "下載 HTML", exact: false })).toHaveCount(0);
    expect(calls.createBodies).toHaveLength(1);
  });

  test("尾段本機保存失敗後 reload 不得把連續前綴當完整錄音 finalize", async ({ page }) => {
    const sessionId = "12121212-1212-4212-8212-121212121212";
    await installMockMeetingAudioSources(page);
    await installChunkedMediaRecorder(page, 2);
    const calls = await installSingleTrackRecordingApi(page, { sessionId, deliveryMode: "one-shot" });
    await page.route("**/api/meetings/one-shot", route => route.fulfill({ json: { data: { mode: "one-shot", available: true, deliveryMs: 86400000, admission: { activeMeetings: 0, maxMeetings: 2 } } } }));
    await page.route(`**/api/meetings/recordings/${sessionId}`, route => route.fulfill({ json: { data: { sessionId, status: "recording", tracks: [] } } }));
    await page.route(`**/api/meetings/recordings/${sessionId}/delivery`, route => route.fulfill({ json: { data: { phase: "recording" } } }));
    await page.addInitScript(() => {
      const add = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function(value, key) {
        if (this.name === "chunks" && value.sequence === 1) throw new DOMException("tail quota fault", "QuotaExceededError");
        return add.call(this, value, key);
      };
    });
    await page.goto("/meetings/audio-check");
    await page.getByRole("button", { name: "開始錄音", exact: true }).click();
    await page.getByRole("button", { name: "停止錄音", exact: false }).click();
    await expect(page.getByRole("button", { name: "重試上傳", exact: true })).toBeVisible();
    expect(await page.evaluate(async () => {
      const store = await import("/src/features/meeting-minutes/audio/meetingRecordingRecoveryStore.ts");
      const [session] = await store.listRecoverySessions();
      return { stopped: session.stopped, chunks: (await store.readRecoveryChunks(session.sessionId)).map(chunk => chunk.sequence) };
    })).toEqual({ stopped: false, chunks: [0] });
    await page.reload();
    await expect(page.getByText(/無法確認錄音尾段已完整保存/), "TAIL_STOP_EVIDENCE").toBeVisible();
    await page.getByRole("button", { name: "重試上傳", exact: true }).click();
    await expect(page.getByText(/本機錄音有缺失片段，不能完成收尾/)).toBeVisible();
    expect(calls.finalizeSessionIds, "TAIL_LOSS_MUST_NOT_FINALIZE").toEqual([]);
    expect(calls.abortCount).toBe(0);
    expect(calls.createBodies).toHaveLength(1);
    const backup = page.waitForEvent("download");
    await page.getByRole("button", { name: "下載本機音軌備份" }).click();
    expect((await backup).suggestedFilename()).toContain(sessionId);
  });

  test("capacity failure prevents recording before microphone request", async ({ page }) => {
    await installMockMeetingAudioSources(page);
    await page.route("**/api/meetings/one-shot", route => route.fulfill({ json: { data: { mode: "one-shot", available: false, reason: "MEETING_SUMMARY_ARCHIVE_FULL", deliveryMs: 86400000, admission: { activeMeetings: 0, maxMeetings: 2 } } } }));
    await page.goto("/meetings/audio-check");
    await expect(page.getByText("摘要庫容量已滿，暫停新的錄音。請聯絡開發者處理。", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "開始錄音", exact: true })).toBeDisabled();
    expect(await page.evaluate(() => (window as typeof window & { __meetingCaptureCalls: string[] }).__meetingCaptureCalls)).toEqual([]);
  });

  test("terminal failure can leave the receipt without deleting server data", async ({ page }) => {
    await page.addInitScript(() => { if (!sessionStorage.getItem("fixture-entered")) { sessionStorage.setItem("fixture-entered", "1"); sessionStorage.setItem("meeting-one-shot-session", "failed-session"); } });
    await page.route("**/api/meetings/one-shot", route => route.fulfill({ json: { data: { mode: "one-shot", available: true, deliveryMs: 86400000, admission: { activeMeetings: 0, maxMeetings: 2 } } } }));
    await page.route("**/api/meetings/recordings/failed-session/delivery", route => route.fulfill({ json: { data: { phase: "failed", errorMessage: "處理重試已達上限", processing: { status: "failed", attemptCount: 3, maxAttempts: 3 }, transcription: null, minutes: null } } }));
    let mutationCount = 0;
    let releaseCount = 0;
    await page.route("**/api/meetings/recordings/**", async route => {
      if (route.request().url().endsWith("/failed-session/release-current")) {
        releaseCount += 1;
        return route.fulfill({ status: 204 });
      }
      if (route.request().method() === "GET") return route.fallback();
      mutationCount += 1;
      await route.abort();
    });
    await page.goto("/meetings/audio-check");
    await expect(page.getByText("處理重試已達上限", { exact: false })).toBeVisible();
    await expect(page.getByText("系統會自動接續處理，完成後即可下載保存。", { exact: true })).toHaveCount(0);
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "離開這筆，開始下一場" }).click();
    await expect(page.getByRole("button", { name: "開始錄音", exact: true })).toBeEnabled();
    expect(releaseCount).toBe(1);
    expect(mutationCount).toBe(0);
  });

  test("處理階段使用伺服器時間，重新整理保留等待時間且不顯示假百分比", async ({ page }, testInfo) => {
    await page.addInitScript(() => sessionStorage.setItem("meeting-one-shot-session", "progress-session"));
    await page.route("**/api/meetings/one-shot", route => route.fulfill({ json: { data: { mode: "one-shot", available: true, deliveryMs: 86400000, admission: { activeMeetings: 0, maxMeetings: 2 } } } }));
    const now = new Date("2026-09-10T03:00:00Z");
    await page.clock.setFixedTime(now);
    let phase = "transcribing";
    await page.route("**/api/meetings/recordings/progress-session/delivery", route => route.fulfill({ json: { data: {
      phase, errorCode: null, errorMessage: null,
      processing: { status: "ready", createdAt: "2026-09-10T02:50:00Z" },
      transcription: { status: "running", createdAt: "2026-09-10T02:56:40Z" },
      minutes: phase === "summarizing" ? { status: "running", createdAt: "2026-09-10T02:59:50Z" } : null,
    } } }));
    await page.goto("/meetings/audio-check");
    await expect(page.locator('[aria-current="step"]')).toContainText("產生逐字稿");
    await expect(page.getByText("03:20", { exact: true }), "SERVER_STAGE_ELAPSED").toBeVisible();
    await expect(page.getByRole("progressbar")).toHaveCount(0);
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`one-shot-progress-${width}.png`), fullPage: true });
    }
    await page.reload();
    await expect(page.getByText("03:20", { exact: true })).toBeVisible();
    phase = "summarizing";
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator('[aria-current="step"]')).toContainText("產生摘要");
    await expect(page.getByText("00:10", { exact: true })).toBeVisible();
  });

  test("create pending → route unmount → abort → return 可離開已不存在的結果", async ({ page }) => {
    const sessionId = "77777777-7777-4777-8777-777777777777";
    await installMockMeetingAudioSources(page);
    const calls = await installSingleTrackRecordingApi(page, { sessionId, deliveryMode: "one-shot" });
    await page.route("**/api/meetings/one-shot", route => route.fulfill({ json: { data: { mode: "one-shot", available: true, deliveryMs: 86400000, admission: { activeMeetings: 0, maxMeetings: 2 } } } }));
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let requested = false;
    let currentSessionId: string | null = null;
    await page.route("**/api/meetings/recordings/current", route => route.fulfill({ json: { data: { sessionId: currentSessionId } } }));
    await page.route("**/api/meetings/recordings", async route => { requested = true; await pending; await route.fallback(); });
    await page.route(`**/api/meetings/recordings/${sessionId}/delivery`, route => route.fulfill({ status: 404, json: { error: { code: "MEETING_RECORDING_NOT_FOUND", message: "錄音已不存在" } } }));
    await page.goto("/meetings/audio-check");
    await page.getByRole("button", { name: "開始錄音", exact: true }).click();
    await expect.poll(() => requested).toBe(true);
    await page.evaluate(() => { history.pushState(null, "", "/it/sop"); dispatchEvent(new PopStateEvent("popstate")); });
    await expect(page.locator(".meeting-one-shot")).toHaveCount(0);
    release();
    await expect.poll(() => calls.abortCount).toBe(1);
    currentSessionId = sessionId;
    await page.evaluate(() => { history.pushState(null, "", "/meetings/audio-check"); dispatchEvent(new PopStateEvent("popstate")); });
    await expect(page.getByText("錄音已不存在")).toBeVisible();
    currentSessionId = null;
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "離開這筆，開始下一場" }).click();
    await expect(page.getByRole("button", { name: "開始錄音", exact: true })).toBeEnabled();
    expect(calls.createBodies).toHaveLength(1);
    expect(await page.evaluate(() => sessionStorage.getItem("meeting-one-shot-session"))).toBeNull();
  });
});

test.describe("meeting printing", () => {
  test.use({ locale: "zh-TW" });

test("摘要列印只列印文件，保留 script 隔離並可重試失敗", async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("meeting-one-shot-session", "print-session");
    window.print = () => {
      const top = window.top as Window & { __meetingPrints?: number };
      top.__meetingPrints = (top.__meetingPrints ?? 0) + 1;
    };
  });
  await page.route("**/api/meetings/one-shot", route => route.fulfill({ json: { data: { mode: "one-shot", available: true, deliveryMs: 86400000, admission: { activeMeetings: 0, maxMeetings: 2 } } } }));
  await page.route("**/api/meetings/recordings/print-session/delivery", route => route.fulfill({ json: { data: { phase: "ready", expiresAt: "2026-09-11T00:00:00Z", processing: null, transcription: null, minutes: null } } }));
  let failPrint = false;
  await page.route("**/api/meetings/recordings/print-session/delivery/html", route => failPrint && route.request().resourceType() !== "document"
    ? route.fulfill({ status: 503, body: "unavailable" })
    : route.fulfill({ contentType: "text/html", body: '<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4}</style></head><body><h1>列印會議內容</h1><script>parent.__unsafePrintScript=true</script></body></html>' }));
  await page.goto("/meetings/audio-check");
  const button = page.getByRole("button", { name: "列印／另存 PDF" });
  await expect(button).toBeVisible();
  failPrint = true;
  await button.click();
  await expect(page.getByRole("alert").filter({ hasText: "無法準備列印" })).toBeVisible();
  failPrint = false;
  await button.click();
  await expect.poll(() => page.evaluate(() => (window as Window & { __meetingPrints?: number }).__meetingPrints)).toBe(1);
  await expect(page.locator(".meeting-print-frame")).toHaveAttribute("sandbox", "allow-same-origin allow-modals");
  expect(await page.evaluate(() => (window as Window & { __unsafePrintScript?: boolean }).__unsafePrintScript)).toBeUndefined();
  await expect(button).toBeEnabled();
  await button.click();
  await expect.poll(() => page.evaluate(() => (window as Window & { __meetingPrints?: number }).__meetingPrints)).toBe(2);
});

});

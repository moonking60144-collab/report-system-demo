import { expect, test } from "@playwright/test";

test.use({ locale: "zh-TW" });

for (const width of [1280, 390]) {
  test(`STT ${width}：重試等待、排隊與真正執行分開顯示`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const sessionId = "81818181-8181-4181-8181-818181818181";
    let status = "failed";
    await page.route("**/api/**", route => {
      const url = new URL(route.request().url());
      if (!url.pathname.startsWith("/api/")) return route.fallback();
      if (url.pathname.endsWith("/one-shot")) return route.fulfill({ json: { data: { mode: "one-shot", available: true,
        deliveryMs: 86400000, admission: { activeMeetings: 1, maxMeetings: 2 } } } });
      if (url.pathname.endsWith("/current")) return route.fulfill({ json: { data: { sessionId, source: null } } });
      if (url.pathname.endsWith("/delivery")) return route.fulfill({ json: { data: { phase: "transcribing", processing: null, minutes: null,
        errorMessage: status === "failed" ? "語音轉文字服務暫時無法連線。" : null,
        transcription: { jobId: "transcription", sessionId, status, phase: "transcribing-room-mic", attemptCount: 1, maxAttempts: 3,
          createdAt: new Date(Date.now() - 30000).toISOString(), artifacts: [] } } } });
      return route.fulfill({ status: 404, json: {} });
    });
    await page.goto("/meetings/audio-check");
    const heading = page.locator(".meeting-minutes-panel__heading").getByRole("status");
    const stage = page.locator('.meeting-progress [aria-current="step"]');
    await expect(heading).toHaveText("等待自動重試");
    await expect(stage).toContainText("產生逐字稿等待自動重試");
    await expect(page.getByText("本階段暫時失敗，已嘗試 1／3 次，正在等待自動重試。錄音已保留，無須重新錄製。")).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("語音轉文字服務暫時無法連線。");
    await expect(page.locator(".meeting-minutes-panel .anticon-loading")).toHaveCount(0);
    await page.reload();
    await expect(heading).toHaveText("等待自動重試");
    await page.screenshot({ path: test.info().outputPath(`stt-waiting-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    status = "pending";
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(heading).toHaveText("等待處理");
    await expect(stage).toContainText("產生逐字稿等待處理");
    await expect(page.locator(".meeting-minutes-panel .anticon-loading")).toHaveCount(0);
    status = "running";
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(heading).toHaveText("正在產生逐字稿");
    await expect(stage).toContainText("產生逐字稿進行中");
    await expect(page.locator(".meeting-progress .anticon-loading")).toHaveCount(1);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
}

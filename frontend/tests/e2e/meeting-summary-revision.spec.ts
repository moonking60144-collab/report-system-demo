import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test.use({ locale: "zh-TW" });
const sid = "12121212-1212-4212-8212-121212121212";
const base = `/api/meetings/recordings/${sid}`;

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`完成頁 ${viewport.width}：下載錄音、修訂恢復與採用`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const audioFilename=viewport.width===390?"audio-1.webm":"audio-1.m4a";
    const audioMimeType=viewport.width===390?"audio/webm":"audio/mp4";
    const record = { version: 1, title: "模具會議", date: "2026-09-17", subtitle: "摘要", attendees: [], executiveSummary: "原始摘要",
      discussionPoints: [], confirmedFacts: [], confirmedDecisions: [], systemRequirements: [], pendingItems: [], followUpActions: [], uncertainTerms: [] };
    const version = (n: number) => ({ versionId: `v${n}`, jobId: `job${n}`, sessionId: sid, versionNumber: n, record,
      generatedAt: new Date().toISOString(), artifacts: [{ artifactId: `audio${n}`, type: "minutes-audio",filename:audioFilename,mimeType:audioMimeType, downloadUrl: `${base}/minutes/versions/v${n}/artifacts/audio${n}` }],
      packageUrl: `${base}/minutes/versions/v${n}/package.zip` });
    const job = (n: number) => ({ jobId: `job${n}`, sessionId: sid, input: { revisionRequest: "", revisionConfirmedFacts: "" }, status: "ready", attemptCount: 1, maxAttempts: 3, version: version(n),
      revisionChanges: { baseVersionId: "v1", candidateVersionId: `v${n}`, requiresAcknowledgement: true, acknowledgementToken: "fixture-content-token",
        entries: [{ field: "confirmedDecisions", removed: ["週五交貨"], added: [], requiresAcknowledgement: true }] } });
    let current = job(1);
    let revision: ReturnType<typeof job> | null = null;
    let requests = 0, adopts = 0, discards = 0;
    const deadline = new Date(Date.now() + 86400000).toISOString();
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url());
      if (!url.pathname.startsWith("/api/")) return route.fallback();
      if (route.request().method() === "POST") expect(route.request().headers()["x-meeting-request"]).toBe("1");
      if (url.pathname === "/api/meetings/one-shot") return route.fulfill({ json: { data: { mode: "one-shot", available: true, deliveryMs: 86400000, admission: { activeMeetings: 0, maxMeetings: 2 } } } });
      if (url.pathname.endsWith("/recordings/current")) return route.fulfill({ json: { data: { source: null, sessionId: sid } } });
      if (url.pathname === `${base}/delivery`) return route.fulfill({ json: { data: { phase: "ready", expiresAt: deadline, errorCode: null,
        errorMessage: null, processing: null, transcription: null, minutes: current, revision, admission: { activeMeetings: 0, maxMeetings: 2 } } } });
      if (url.pathname === `${base}/delivery/html`) return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<html><body>${current.version.versionNumber === 1 ? "原始摘要" : "採用後的修訂摘要"}</body></html>` });
      if (url.pathname === `${base}/delivery/revisions` && route.request().method() === "POST") {
        requests++;
        const payload = route.request().postDataJSON();
        expect(payload.baseVersionId).toBe(current.version.versionId); expect(payload.clientRequestKey).toBeTruthy();
        if (requests === 1) expect(payload.confirmedFacts).toBe("模具已交付，這項我已確認。");
        revision = { ...job(current.version.versionNumber + 1), status: "pending", input: { revisionRequest: payload.request, revisionConfirmedFacts: payload.confirmedFacts } };
        return route.fulfill({ status: 202, json: { data: revision } });
      }
      if (url.pathname.endsWith("/delivery/revisions/job2/html")) return route.fulfill({ contentType: "text/html; charset=utf-8", body: "<html><body>修訂草稿：週五尚未確認</body></html>" });
      if (url.pathname.endsWith("/delivery/revisions/job2/adopt")) {
        adopts++; expect(route.request().postDataJSON().expectedVersionId).toBe("v1");
        expect(route.request().postDataJSON().acknowledgementToken).toBe("fixture-content-token");
        current = job(2); revision = null;
        return route.fulfill({ status: 204 });
      }
      if (url.pathname.endsWith("/delivery/revisions/job3/discard")) {
        discards++; revision = null;
        return route.fulfill({ status: 204 });
      }
      if (url.pathname.includes("/artifacts/audio")) return route.fulfill({ contentType: audioMimeType, headers: { "Content-Disposition": `attachment; filename="${audioFilename}"` }, body: "recording-bytes" });
      return route.fulfill({ status: 404, json: {} });
    });
    await page.goto("/meetings/audio-check");
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "下載錄音", exact: true }).click();
    const recording = await download;
    expect(recording.suggestedFilename()).toBe(audioFilename);
    expect((await readFile((await recording.path())!)).toString()).toBe("recording-bytes");
    const currentFrame = page.frameLocator('iframe[title="會議紀錄 HTML 預覽"]');
    await expect(currentFrame.getByText("原始摘要", { exact: true })).toBeVisible();
    await page.getByText("修改／補充摘要", { exact: true }).click();
    const input = page.getByRole("textbox", { name: "需要修改或補充什麼？" });
    await input.fill("週五交貨尚未確認，請移到仍需確認。");
    await page.getByText("補充人工確認事實（選填）", { exact: true }).click();
    const facts = page.getByRole("textbox", { name: "你已確認的事實", exact: true });
    await facts.fill("模具已交付，這項我已確認。");
    await page.getByRole("button", { name: "產生修訂版", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "修訂處理中" })).toBeVisible();
    expect(requests).toBe(1);
    await expect(page.getByRole("link", { name: "下載 HTML", exact: true })).toBeVisible();
    await expect(currentFrame.getByText("原始摘要", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "已自行保存，開始下一場", exact: true })).toBeDisabled();
    await page.reload();
    await expect(input).toHaveValue("週五交貨尚未確認，請移到仍需確認。");
    await expect(input).toBeDisabled();
    await page.getByText("補充人工確認事實（選填）", { exact: true }).click();
    await expect(facts).toHaveValue("模具已交付，這項我已確認。");
    await expect(facts).toBeDisabled();
    expect(requests).toBe(1);
    revision!.status = "ready";
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.frameLocator('iframe[title="修訂版預覽"]').getByText("修訂草稿：週五尚未確認")).toBeVisible();
    await expect(currentFrame.getByText("原始摘要", { exact: true })).toBeVisible();
    const adopt = page.getByRole("button", { name: "採用修訂版", exact: true });
    await expect(page.getByText("週五交貨", { exact: true })).toBeVisible();
    await expect(adopt).toBeDisabled();
    await page.getByRole("checkbox", { name: "我已核對既有內容的移除或改寫，確認採用這些變更。" }).check();
    await expect(adopt).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath(`revision-${viewport.width}.png`), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
    await adopt.click();
    await expect(page.locator('iframe[title="會議紀錄 HTML 預覽"]')).toHaveCount(1);
    await expect(currentFrame.getByText("採用後的修訂摘要", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "已自行保存，開始下一場", exact: true })).toBeEnabled();
    await expect(page.getByRole("link", { name: "下載完整 ZIP", exact: true })).toHaveAttribute("href", /versions\/v2\/package.zip$/);
    expect(adopts).toBe(1); expect(requests).toBe(1);
    await page.getByText("修改／補充摘要", { exact: true }).click();
    await input.fill("模擬第二次修訂失敗");
    await page.getByRole("button", { name: "產生修訂版", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "修訂處理中" })).toBeVisible();
    revision!.status = "failed"; revision!.attemptCount = 3;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("button", { name: "放棄這次修訂", exact: true })).toBeVisible();
    await expect(currentFrame.getByText("採用後的修訂摘要", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "放棄這次修訂", exact: true }).click();
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue("模擬第二次修訂失敗");
    expect(discards).toBe(1); expect(requests).toBe(2);
  });
}

import { expect, test } from "@playwright/test";

for (const width of [375, 768, 1440]) {
  for (const form of [901, 902]) {
    test(`${form} 背景更新徽章不移動表格（${width}px）`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.route(url => url.pathname.startsWith("/api/"), route => route.fulfill({ json: { data: {
        enabled: false, title: "", message: "", linkText: "", linkUrl: "",
        startAt: null, endAt: null, updatedAt: null, level: "info",
      } } }));
      await page.route("**/__refresh-badge__", route => route.fulfill({ contentType: "text/html", body: `
        <html><body><div id="root"></div><script type="module">
        import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
        window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
        window.__vite_plugin_react_preamble_installed__ = true;
        </script><script type="module" src="/tests/fixtures/work-report-refresh-badge-fixture.tsx"></script></body></html>` }));
      await page.goto("/__refresh-badge__");
      await expect(page.locator(".system-notice-panel.is-compact-idle")).toBeVisible();
      await page.getByRole("tab", { name: form === 901 ? "製程 A 報工（901 / PA）" : "製程 B 報工（902 / PB）", exact: true }).click();
      const badge = page.locator(".system-notice-inline-status-pill");
      const table = page.locator(".table-wrap");
      const row = await page.locator('tr[data-row-key="kept-row"]').elementHandle();
      const snapshot = await badge.innerText();
      const position = async () => ({ badge: await badge.boundingBox(), table: await table.boundingBox() });
      const before = await position();
      for (let cycle = 0; cycle < 2; cycle += 1) {
        if (cycle === 1) await page.getByRole("button", { name: "切換全量模式" }).click();
        await page.getByRole("button", { name: "開始背景更新" }).click();
        await expect(badge.locator(".loading-spinner")).toBeVisible();
        await expect(badge).toHaveAccessibleName(/背景更新中/);
        await expect(badge).toContainText("09/08 12:58:54");
        await expect(table).toHaveAttribute("aria-busy", "true");
        await expect(page.locator(".table-background-loading-status")).toHaveCount(0);
        expect(await position()).toEqual(before);
        expect(await row!.evaluate(el => el.isConnected)).toBe(true);
        if (width === 1440 && form === 901 && cycle === 0) {
          await page.screenshot({ path: "/tmp/work-report-refresh-badge.png" });
          await badge.screenshot({ path: "/tmp/work-report-refresh-badge-closeup.png" });
        }
        await page.getByRole("tab", { name: form === 901 ? "製程 B 報工（902 / PB）" : "製程 A 報工（901 / PA）", exact: true }).click();
        await expect(badge.locator(".loading-spinner")).toBeVisible();
        expect(await position()).toEqual(before);
        await page.getByRole("tab", { name: form === 901 ? "製程 A 報工（901 / PA）" : "製程 B 報工（902 / PB）", exact: true }).click();
        await page.getByRole("button", { name: "完成更新" }).click();
        await expect(badge.locator(".loading-spinner")).toHaveCount(0);
        await expect(badge).toHaveText(snapshot);
        expect(await position()).toEqual(before);
      }
      // 重建舊提示列作負向對照，確認幾何斷言能辨識原本的下移。
      await table.evaluate(el => {
        const oldStatus = document.createElement("div");
        oldStatus.id = "old-status-control";
        oldStatus.style.height = "33px";
        el.before(oldStatus);
      });
      expect((await table.boundingBox())!.y - before.table!.y).toBe(33);
      await page.locator("#old-status-control").evaluate(el => el.remove());
      expect(await position()).toEqual(before);
      await page.getByRole("button", { name: "開始背景更新" }).click();
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect(badge.locator(".loading-spinner")).toHaveCSS("animation-name", "none");
      await page.getByRole("button", { name: "更新失敗" }).click();
      await expect(badge).toHaveClass(/--warn/);
      await expect(badge).toContainText("測試錯誤");
      await expect(badge.locator(".loading-spinner")).toHaveCount(0);
      await page.getByRole("button", { name: "切換操作鎖定" }).click();
      await expect(table).toHaveClass(/is-soft-busy/);
      await expect(table.locator(".table-soft-busy-overlay")).toBeVisible();
      await expect(table).toHaveCSS("pointer-events", "none");
    });
  }
}

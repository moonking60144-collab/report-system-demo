import { expect, test } from "@playwright/test";

for (const scenario of ["covered", "newer-event", "invalidated", "failed", "stale", "older-read"] as const) {
  test(`preview refresh coalescing: ${scenario}`, async ({ page }) => {
    let reads = 0;
    let responseMode = "fresh";
    let delayNextRead = false;
    let releaseRead: (() => void) | undefined;
    await page.addInitScript(() => { Math.random = () => 0.99; });
    await page.route("**/api/**", async route => {
      if (!new URL(route.request().url()).pathname.startsWith("/api/")) return route.fallback();
      reads += 1;
      if (delayNextRead) {
        delayNextRead = false;
        await new Promise<void>(resolve => { releaseRead = resolve; });
      }
      return route.fulfill({ status: responseMode === "failed" ? 400 : 200,
        contentType: "application/json", body: JSON.stringify({ data: [], meta: {
          count: 0, totalCount: 0, hasMore: false, cacheSource: "sqlite", cacheState: responseMode,
        } }) });
    });
    await page.route("**/__preview-refresh__", route => route.fulfill({ contentType: "text/html", body: `
      <html><body><div id="root"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      </script><script type="module" src="/tests/fixtures/preview-refresh-coalescing-fixture.tsx"></script></body></html>` }));
    await page.goto("/__preview-refresh__");
    await expect(page.locator("#loading")).toHaveText("false");
    const baseline = reads;
    if (scenario !== "older-read") await page.getByRole("button", { name: "event", exact: true }).click();
    responseMode = scenario === "failed" || scenario === "stale" ? scenario : "fresh";
    delayNextRead = scenario === "older-read";
    await page.getByRole("button", { name: "settlement read" }).click();
    if (scenario === "older-read") {
      await expect.poll(() => reads).toBe(baseline + 1);
      await page.getByRole("button", { name: "event", exact: true }).click();
      releaseRead?.();
    }
    await expect(page.locator("#done")).toHaveText("1");
    expect(reads).toBe(baseline + 1);
    responseMode = "fresh";
    if (scenario === "newer-event") await page.getByRole("button", { name: "event", exact: true }).click();
    if (scenario === "invalidated") await page.getByRole("button", { name: "invalidate", exact: true }).click();
    await page.waitForTimeout(1300);
    expect(reads).toBe(baseline + (scenario === "covered" ? 1 : 2));
  });
}

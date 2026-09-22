import { startMeetingCoverage, stopMeetingCoverage } from "./meetingVerificationCoverage";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => startMeetingCoverage(page));
test.afterEach(async ({ page }) => stopMeetingCoverage(page));

test("編輯中背景刷新不能替換使用者修改前的排序值", async ({ page }) => {
  await page.route("**/__editing-precondition__", route => route.fulfill({ contentType: "text/html", body: `
    <html><body><div id="root"></div><output id="submitted"></output>
    <button id="refresh">background refresh</button>
    <script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script>
    <script type="module">
      import '/tests/fixtures/work-report-editing-precondition-fixture.tsx';
    </script></body></html>` }));
  await page.goto("/__editing-precondition__");
  await page.getByRole("button", { name: "編輯排序" }).click();
  await page.getByLabel("排序", { exact: true }).fill("7");
  // Trigger a rerender without a pointer event that would close the popover.
  await page.evaluate(() => document.getElementById("refresh")!.click());
  await expect(page.locator(".work-report-sort-order-value")).toHaveText("9");
  await page.getByRole("button", { name: "儲存", exact: true }).click();
  await expect(page.locator("#submitted")).toHaveText(JSON.stringify({ previous: 5, value: 7 }));
});

for (const formId of ["901", "902"]) {
  test(`${formId} 明細主機台編輯經刷新、失敗重試後仍使用開始時的原值`, async ({ page }) => {
    const payloads: Array<Record<string, unknown>> = [];
    await page.route("**/api/**", route => {
      if (!new URL(route.request().url()).pathname.startsWith("/api/")) return route.fallback();
      payloads.push(route.request().postDataJSON());
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "ENTRY_FIELD_CONFLICT", message: "changed" } }) });
    });
    await page.route("**/__main-machine-precondition__?*", route => route.fulfill({ contentType: "text/html", body: `
      <html><body><div id="root"></div><script type="module">
        import RefreshRuntime from '/@react-refresh';
        RefreshRuntime.injectIntoGlobalHook(window);
        window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
        window.__vite_plugin_react_preamble_installed__ = true;
      </script><script type="module" src="/tests/fixtures/work-report-main-machine-precondition-fixture.tsx"></script></body></html>` }));
    await page.goto(`/__main-machine-precondition__?form=${formId}`);
    await page.getByRole("button", { name: "open", exact: true }).click();
    await page.getByLabel("machine draft").fill("P12");
    await page.getByRole("button", { name: "refresh", exact: true }).click();
    await expect(page.locator("#machine")).toHaveText("MA51");
    await page.getByRole("button", { name: "save", exact: true }).click();
    await expect.poll(() => payloads.length).toBe(1);
    await expect(page.getByRole("button", { name: "save", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "save", exact: true }).click();
    await expect.poll(() => payloads.length).toBe(2);
    expect(payloads, "IMMUTABLE_EDIT_BASELINE").toEqual([{ machineCode: "P12", expectedMachineCode: "MB50" }, { machineCode: "P12", expectedMachineCode: "MB50" }]);
    await page.getByRole("button", { name: "navigate", exact: true }).click();
    await page.getByRole("button", { name: "save", exact: true }).click();
    expect(payloads).toHaveLength(2);
  });
}

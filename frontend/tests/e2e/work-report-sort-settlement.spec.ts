import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test, type Route } from "@playwright/test";

const output = execFileSync(process.execPath, ["--import", "tsx", resolve("../backend/tests/helpers/create-sort-settlement-data.ts")], {
  cwd: resolve("../backend"),
  encoding: "utf8",
  env: { ...process.env, DEMO_MODE: "true", NODE_ENV: "test" },
});
const data = JSON.parse(output.split("\n").find(line => line.startsWith("FIXTURE:"))!.slice(8));
const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"></head><body><div id="root"></div>
<script type="module">
import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>(type)=>type; window.__vite_plugin_react_preamble_installed__=true;
window.localStorage.setItem('work-reports:901:ui-language','zh');
</script><script type="module">
import {mountSortSettlementFixture} from '/tests/fixtures/work-report-sort-settlement-fixture.tsx';
mountSortSettlementFixture(document.querySelector('#root'));
</script></body></html>`;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    class Source extends EventTarget {
      readyState = 1;
      constructor() { super(); Object.assign(window, { syncSource: this }); }
      close() { this.readyState = 2; }
    }
    window.EventSource = Source as unknown as typeof EventSource;
  });
  await page.route(/^https?:\/\/[^/]+\/api\//, route => route.abort());
  await page.route("**/api/auto-sync/status", route => route.fulfill({ json: { data: { activeFormIds: ["901"] } } }));
  await page.route("**/api/fixture-records", route => route.fulfill({ json: data.before }));
  await page.route("**/__sort-settlement__", route => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("/__sort-settlement__");
});

test("真實 SQLite projection 更新中間工令後，列表位置、頁碼與視窗捲動保持", async ({ page }) => {
  const row = page.locator('tr[data-row-key="10"]');
  await expect(row).toContainText("WO-test-10");
  const beforeIds = await page.locator("tr[data-row-key]").evaluateAll(rows => rows.map(r => r.getAttribute("data-row-key")));
  await row.getByRole("button").click();
  await page.locator('input[type="number"]').fill("6");
  const beforeY = await page.evaluate(() => scrollY);
  let held: Route | undefined;
  await page.route("**/api/fixture-records", route => { held = route; });
  await page.locator(".work-report-editable-actions .is-primary").click();
  await expect.poll(() => Boolean(held)).toBe(true);
  expect(await page.evaluate(() => scrollY)).toBe(beforeY);
  await held!.fulfill({ json: data.after });
  await expect(row.locator(".work-report-sort-order-value")).toHaveText("6");
  const afterIds = await page.locator("tr[data-row-key]").evaluateAll(rows => rows.map(r => r.getAttribute("data-row-key")));
  expect(afterIds, "middle entry must not be appended to page bottom").toEqual(beforeIds);
  await page.waitForTimeout(300);
  expect(Math.abs(await page.evaluate(() => scrollY) - beforeY)).toBeLessThanOrEqual(2);
  await expect(page.getByText("顯示 1–23 · 第 1 頁")).toHaveCount(1);
});

test("通知區初載顯示 auto sync，完成清除且原本資料時間保持", async ({ page }) => {
  await expect(page.getByText("自動同步中（901），寫入可能較慢")).toBeVisible();
  await expect(page.getByText("目前畫面資料時間：09/11 16:56:56。")).toBeVisible();
  await page.evaluate(`window.syncSource.dispatchEvent(new MessageEvent('work-report-event',{data:JSON.stringify({type:'sqlite-auto-sync-status',sqliteAutoSync:{activeFormIds:[]}})}))`);
  await expect(page.getByText("自動同步中（901），寫入可能較慢")).toHaveCount(0);
  await page.evaluate(`window.syncSource.dispatchEvent(new MessageEvent('work-report-event',{data:JSON.stringify({type:'sqlite-auto-sync-status',sqliteAutoSync:{activeFormIds:['903']}})}))`);
  await expect(page.getByText("自動同步中（16），寫入可能較慢")).toBeVisible();
  await page.screenshot({ path: "test-results/auto-sync-notice.png" });
  await page.evaluate(`window.syncSource.dispatchEvent(new Event('error'))`);
  await expect(page.getByText("自動同步中（16），寫入可能較慢")).toHaveCount(0);
  await expect(page.getByText("目前畫面資料時間：09/11 16:56:56。")).toBeVisible();
});

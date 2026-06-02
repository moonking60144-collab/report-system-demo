import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const SHOT = resolve(REPO_ROOT, "docs/screenshot.png");
mkdirSync(resolve(REPO_ROOT, "docs"), { recursive: true });

// .env.demo 內的 DEMO_RESET_KEY
const DEMO_KEY = "demo-reset-please-change-me";

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 950 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
// 萬一 native prompt 還是跳出來，直接回 demo key
page.on("dialog", async (dialog) => {
  try {
    await dialog.accept(DEMO_KEY);
  } catch {
    // ignore
  }
});

// 1. goto
await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
await page.waitForLoadState("load");

// 2. 等 fetch + render
await page.waitForTimeout(2500);

// 3. 清 localStorage、設 sessionStorage demo key，再 reload
await page.evaluate(
  ({ key }) => {
    localStorage.clear();
    sessionStorage.setItem("ragic-demo-key", key);
  },
  { key: DEMO_KEY },
);
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForLoadState("load");
await page.waitForTimeout(2500);

const allDataLocator = page.getByRole("button", { name: /所有資料/ });
const faultButton = page.getByRole("button", { name: "故障模擬" });
const rowLocator = page.locator("button.work-order-cell-button").first();
const panelExpanded = page.getByText(/上游失敗率/);

// 4. 點「所有資料」清空預設 filter
if (await allDataLocator.count()) {
  await allDataLocator.first().click();
  await page.waitForTimeout(1500);
}

// row 可能因 demo seed prodType 與 frontend group filter 不匹配（seed 用 "車削/磨削/銑削"，
// frontend landingPage 期 "TI/HF"）而為 0。不阻斷流程，仍繼續展開 fault panel。
let rowVisible = false;
try {
  await rowLocator.waitFor({ state: "visible", timeout: 5000 });
  rowVisible = true;
} catch {
  // 繼續
}

// 5. 滾到頂部
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(300);

// 6. 點故障模擬展開 panel
await faultButton.click();
await panelExpanded.waitFor({ state: "visible", timeout: 5000 });
await page.waitForTimeout(700); // 等 panel 動畫穩定

// 8. 截圖
await page.screenshot({ path: SHOT, fullPage: false });

const rowsLoaded = await page.locator("button.work-order-cell-button").count();
const panelOk = await panelExpanded.isVisible();

console.log(
  JSON.stringify({
    outputPath: SHOT,
    rowsLoaded,
    panelExpanded: panelOk,
    rowVisible,
    pageErrors: errors,
  }),
);

await browser.close();

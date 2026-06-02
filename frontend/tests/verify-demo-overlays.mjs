// 驗證 DemoBadge + FaultInjectionPanel 真的有掛上 5173 page
// 用法：cd frontend && node tests/verify-demo-overlays.mjs
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOT = resolve(__dirname, "../verify-shot.png");

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
// SSE 連線會讓 networkidle 永不觸發；改成等到 React mount + initial fetch 完成
await page.waitForLoadState("load");
await page.waitForTimeout(3000);

const checks = {
  health: false,
  demoBadge: false,
  faultButton: false,
  workOrders: 0,
};

// 1. /api/health proxy 通
const health = await page.evaluate(async () => {
  const r = await fetch("/api/health");
  return r.json();
});
checks.health = health?.demoMode === true;

// 2. DEMO MODE 徽章在 DOM
checks.demoBadge = (await page.getByText("DEMO MODE", { exact: true }).count()) > 0;

// 3. 故障模擬按鈕在 DOM（可能是「故障模擬」字串）
checks.faultButton = (await page.getByText(/故障模擬/).count()) > 0;

// 4. 列表有資料（要看到 WO-xxx 之類工令編號）
checks.workOrders = await page.getByText(/WO-104-\d+/).count();

await page.screenshot({ path: SHOT, fullPage: false });
await browser.close();

console.log(JSON.stringify({ checks, errors }, null, 2));
console.log(`screenshot saved: ${SHOT}`);

const pass = checks.health && checks.demoBadge && checks.faultButton && checks.workOrders > 0;
process.exit(pass ? 0 : 1);

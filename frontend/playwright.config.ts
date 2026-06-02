import { defineConfig, devices } from "@playwright/test";

/**
 * Frontend e2e config.
 *
 * - Specs at tests/e2e/ — 多數用 Playwright route mocking stub API（不依賴 backend），
 *   所以 webServer 只啟 Vite dev server 即可。
 * - Vite dev server 已透過 vite.config.ts 把 /api 轉到 localhost:3000；
 *   若 spec 需要真實 backend，使用者自行另起 `npm run demo` 即可。
 * - reuseExistingServer 預設打開：本機開發已起 dev server 就不會重啟。
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});

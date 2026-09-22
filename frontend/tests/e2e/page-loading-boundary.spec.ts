import { expect, test } from "@playwright/test";

const TEST_DOCUMENT = `<!doctype html>
<html lang="zh-Hant">
<head><meta charset="utf-8"><title>Page Loading Boundary</title></head>
<body>
  <div id="root"></div>
  <script type="module">
    import RefreshRuntime from "/@react-refresh";
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => undefined;
    window.$RefreshSig$ = () => (type) => type;
    window.__vite_plugin_react_preamble_installed__ = true;
  </script>
  <script type="module">
    import { mountPageLoadingBoundaryFixture } from "/tests/fixtures/page-loading-boundary-fixture.tsx";
    mountPageLoadingBoundaryFixture(document.querySelector("#root"));
  </script>
</body>
</html>`;

test("HTML boot spinner 在 JavaScript 尚未執行時仍可見", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();

  await page.goto("/");

  const boot = page.locator("#app-boot");
  await expect(boot).toBeVisible();
  await expect(boot).toContainText("系統載入中");
  const bootBox = await boot.boundingBox();
  expect(bootBox?.height).toBeGreaterThanOrEqual(page.viewportSize()?.height ?? 0);
  await context.close();
});

test.describe("PageLoadingBoundary presentation contract", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/__page-loading-boundary__", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: TEST_DOCUMENT })
    );
    await page.goto("/__page-loading-boundary__");
  });

  test("初次載入與錯誤狀態不預先呈現內容", async ({ page }) => {
    await expect(page.getByRole("status")).toContainText("資料讀取中");
    await expect(page.getByTestId("existing-content")).toHaveCount(0);

    await page.getByRole("button", { name: "載入失敗" }).click();
    await expect(page.getByRole("alert")).toContainText("測試錯誤");
    await expect(page.getByTestId("existing-content")).toHaveCount(0);
  });

  test("背景更新保留既有資料，只顯示小型 indicator", async ({ page }) => {
    await page.getByRole("button", { name: "背景更新" }).click();

    await expect(page.getByTestId("existing-content")).toBeVisible();
    await expect(page.getByTestId("existing-content")).toContainText("已載入資料");
    await expect(page.locator(".background-loading-indicator")).toContainText("背景更新中");
    await expect(page.locator(".page-loading-boundary")).toHaveCount(0);
  });

  test("窄螢幕不溢出，reduced motion 下停止旋轉", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();

    const boundary = page.locator(".page-loading-boundary");
    const boundaryBox = await boundary.boundingBox();
    expect(boundaryBox?.x).toBeGreaterThanOrEqual(0);
    expect((boundaryBox?.x ?? 0) + (boundaryBox?.width ?? 0)).toBeLessThanOrEqual(390);
    await expect(page.locator(".loading-spinner")).toHaveCSS("animation-name", "none");
  });
});

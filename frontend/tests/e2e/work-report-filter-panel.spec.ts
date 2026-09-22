import { expect, test, type Page } from "@playwright/test";

declare global {
  interface Window {
    __workReportFilterPanelReady?: boolean;
    __workReportFilterPanelApplyCount?: number;
    __workReportFilterPanelSavedApplyCount?: number;
    __workReportFilterPanelGroup?: {
      joinMode: "all" | "any";
      conditions: Array<{ field: string; values: string[] }>;
    };
  }
}

const TEST_DOCUMENT = `<!doctype html>
<html lang="zh-Hant">
<head><meta charset="utf-8"><title>Work Report Filter Panel</title></head>
<body>
  <div id="root"></div>
  <script type="module">
    import RefreshRuntime from "/@react-refresh";
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => undefined;
    window.$RefreshSig$ = () => (type) => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    window.localStorage.setItem("work-reports:901:ui-language", "zh");
  </script>
  <script type="module">
    import { mountWorkReportFilterPanel } from "/tests/fixtures/work-report-filter-panel-fixture.tsx";
    mountWorkReportFilterPanel(document.querySelector("#root"));
  </script>
</body>
</html>`;

async function openFixture(page: Page): Promise<void> {
  await page.goto("/__work-report-filter-panel__");
  await page.waitForFunction(() => window.__workReportFilterPanelReady === true);
}

test.beforeEach(async ({ page }) => {
  await page.route("**/__work-report-filter-panel__*", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html", body: TEST_DOCUMENT });
  });
  await page.goto("/");
  await page.evaluate(() => window.localStorage.clear());
});

test("可新增機台複選條件、切換任一條件並套用", async ({ page }) => {
  await openFixture(page);
  const panel = page.getByRole("region", { name: "工令精確篩選" });

  await expect(panel.locator(".custom-filter-condition-row")).toHaveCount(2);
  const firstValueCounter = panel.locator(".custom-filter-value-cap").first();
  const firstConditionRow = panel.locator(".custom-filter-condition-row").first();
  const [counterBox, rowBox] = await Promise.all([
    firstValueCounter.boundingBox(),
    firstConditionRow.boundingBox(),
  ]);
  expect(counterBox).not.toBeNull();
  expect(rowBox).not.toBeNull();
  expect(counterBox!.y).toBeGreaterThanOrEqual(rowBox!.y);
  expect(counterBox!.y + counterBox!.height).toBeLessThanOrEqual(
    rowBox!.y + rowBox!.height
  );
  await panel.getByRole("button", { name: "新增條件" }).click();
  await expect(panel.locator(".custom-filter-condition-row")).toHaveCount(3);
  await expect(panel.getByRole("alert")).toContainText("請完成所有條件值");
  await expect(panel.getByRole("button", { name: "套用篩選" })).toBeDisabled();

  const machineValues = panel
    .locator(".custom-filter-condition-row")
    .nth(2)
    .locator(".custom-filter-value-control .ant-select");
  await machineValues.click();
  const openDropdown = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)");
  await expect(openDropdown).toBeVisible();
  await openDropdown.locator('.ant-select-item-option[title="MA18"]').click();
  await openDropdown.locator('.ant-select-item-option[title="MA23"]').click();
  await panel.getByRole("button", { name: "任一條件" }).click();

  await expect(panel.getByRole("button", { name: "套用篩選" })).toBeEnabled();
  await panel.getByRole("button", { name: "套用篩選" }).click();
  await expect.poll(() => page.evaluate(() => window.__workReportFilterPanelApplyCount)).toBe(1);
  await expect
    .poll(() => page.evaluate(() => window.__workReportFilterPanelGroup))
    .toMatchObject({
      joinMode: "any",
      conditions: [
        { field: "status", values: ["未結案"] },
        { field: "startSchedule", values: ["yes"] },
        { field: "machineCode", values: ["MA18", "MA23"] },
      ],
    });
});

test("儲存條件後可跨重載保留並還原篩選與排序", async ({ page }) => {
  await openFixture(page);
  await page.getByRole("button", { name: "儲存條件" }).click();
  const modal = page.getByRole("dialog", { name: "儲存目前篩選" });
  await modal.getByLabel("篩選名稱").fill("未結案且已排程");
  await modal.getByRole("button", { name: "儲存條件" }).click();

  const savedPanel = page.getByRole("complementary", { name: "已儲存的篩選" });
  await expect(savedPanel).toContainText("未結案且已排程");
  await expect(savedPanel).toContainText("1 / 8");
  await page.reload();
  await page.waitForFunction(() => window.__workReportFilterPanelReady === true);
  await expect(savedPanel).toContainText("未結案且已排程");
  await savedPanel.getByRole("button", { name: "套用" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__workReportFilterPanelSavedApplyCount))
    .toBe(1);
});

test("localStorage 寫入失敗時保留儲存視窗並顯示錯誤", async ({ page }) => {
  await openFixture(page);
  await page.evaluate(() => {
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(key: string, value: string) {
      if (key === "work-reports:saved-filters:v1") {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      originalSetItem.call(this, key, value);
    };
  });

  await page.getByRole("button", { name: "儲存條件" }).click();
  const saveModal = page.getByRole("dialog", { name: "儲存目前篩選" });
  await saveModal.getByLabel("篩選名稱").fill("不可儲存");
  await saveModal.getByRole("button", { name: "儲存條件" }).click();

  await expect(
    page.getByRole("dialog", { name: "無法儲存篩選條件" })
  ).toContainText("這次變更尚未儲存");
  await expect(saveModal).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "已儲存的篩選" })
  ).toContainText("0 / 8");
  await expect
    .poll(() =>
      page.evaluate(() => window.localStorage.getItem("work-reports:saved-filters:v1"))
    )
    .toBeNull();
});

test("空白篩選名稱按 Enter 不會誤報 localStorage 寫入失敗", async ({ page }) => {
  await openFixture(page);
  await page.getByRole("button", { name: "儲存條件" }).click();
  const saveModal = page.getByRole("dialog", { name: "儲存目前篩選" });
  const nameInput = saveModal.getByLabel("篩選名稱");

  await nameInput.fill("   ");
  await nameInput.press("Enter");

  await expect(saveModal).toBeVisible();
  await expect(saveModal.getByRole("button", { name: "儲存條件" })).toBeDisabled();
  await expect(
    page.getByRole("dialog", { name: "無法儲存篩選條件" })
  ).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => window.localStorage.getItem("work-reports:saved-filters:v1"))
    )
    .toBeNull();
});

test("375px 手機版不產生水平溢位且主要控制維持觸控高度", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openFixture(page);

  const button = page.locator(".custom-filter-add-condition");
  const selectInput = page.getByRole("combobox", { name: "條件 1 欄位" });
  await expect(button).toBeVisible();
  await expect(selectInput).toBeAttached();
  const layout = {
    ...(await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    }))),
    buttonHeight: (await button.boundingBox())?.height ?? 0,
    selectHeight: await selectInput.evaluate((input) => {
      const select = input.closest<HTMLElement>(".ant-select");
      if (!select) throw new Error("missing responsive select root");
      return select.getBoundingClientRect().height;
    }),
  };

  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.buttonHeight).toBeGreaterThanOrEqual(44);
  expect(layout.selectHeight).toBeGreaterThanOrEqual(44);
});

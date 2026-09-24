import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    __workReportListVisualReady?: boolean;
    __workReportListVisualDetailOpenCount?: number;
    __workReportListVisualStartScheduleMutationCount?: number;
    __workReportListVisualMainMachineMutationCount?: number;
    __workReportListVisualUrgentMutationCount?: number;
  }
}

const TEST_DOCUMENT = `<!doctype html>
<html lang="zh-Hant">
<head><meta charset="utf-8"><title>Work Report List Visual Contract</title></head>
<body>
  <div id="root"></div>
  <script type="module">
    import RefreshRuntime from "/@react-refresh";
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => undefined;
    window.$RefreshSig$ = () => (type) => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    window.localStorage.setItem("work-reports:901:ui-language", "zh");
    window.localStorage.removeItem("work-reports:column-mode");
  </script>
  <script type="module">
    import { mountWorkReportListVisualContract } from "/tests/fixtures/work-report-list-visual-contract-fixture.tsx";
    mountWorkReportListVisualContract(document.querySelector("#root"));
  </script>
</body>
</html>`;

test.beforeEach(async ({ page }) => {
  await page.route("**/__work-report-list-visual-contract__*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: TEST_DOCUMENT,
    });
  });
  await page.goto("/__work-report-list-visual-contract__");
  await page.waitForFunction(() => window.__workReportListVisualReady === true);
});

test("欄位模式預設完整並保留精簡／完整 round trip", async ({ page }) => {
  const displayMode = page.locator(".workspace-display-mode");
  const compactButton = displayMode.getByRole("button", { name: "精簡" });
  const fullButton = displayMode.getByRole("button", { name: "完整" });

  await expect(fullButton).toHaveClass(/is-active/);
  await compactButton.click();
  await expect(compactButton).toHaveClass(/is-active/);
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("work-reports:column-mode")))
    .toBe("compact");

  await fullButton.click();
  await expect(fullButton).toHaveClass(/is-active/);
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("work-reports:column-mode")))
    .toBe("fit");
});

test("機台 Chip、狀態列與一行優先兩行保底維持視覺契約", async ({ page }) => {
  const emptyRow = page.locator('tr[data-row-key="empty-previous"]');
  const normalRow = page.locator('tr[data-row-key="normal"]');
  const runningRow = page.locator('tr[data-row-key="running"]');
  const closedRow = page.locator('tr[data-row-key="closed"]');

  await expect(emptyRow.locator(".machine-code-chip--current")).toHaveText("MA51");
  await expect(emptyRow.locator(".machine-code-chip--previous")).toHaveCount(0);
  await expect(normalRow.locator(".machine-code-chip--current")).toHaveText("MA33");
  await expect(normalRow.locator(".machine-code-chip--previous")).toHaveText("MB17");
  await expect(normalRow.locator(".machine-code-chip--current")).toHaveCSS(
    "background-color",
    "rgb(234, 242, 255)"
  );
  await expect(normalRow.locator(".machine-code-chip--previous")).toHaveCSS(
    "background-color",
    "rgb(244, 241, 248)"
  );

  await expect(runningRow.locator("td").first()).toHaveCSS(
    "background-color",
    "rgb(157, 255, 157)"
  );
  await expect(runningRow.locator(".machine-code-chip--current")).toHaveCSS(
    "background-color",
    "rgb(234, 242, 255)"
  );
  await expect(closedRow.locator(".machine-code-chip--current")).toHaveCSS(
    "color",
    "rgb(100, 116, 139)"
  );
  await expect(closedRow.locator(".machine-code-chip--current")).toHaveCSS(
    "border-color",
    "rgb(203, 213, 225)"
  );
  await expect(emptyRow.getByRole("checkbox", { name: "急件" })).toHaveAttribute(
    "aria-checked",
    "false"
  );
  await expect(normalRow.getByRole("checkbox", { name: "急件" })).toHaveText("✓");
  await expect(normalRow.getByRole("checkbox", { name: "急件" })).toHaveCSS(
    "background-color",
    "rgb(255, 241, 242)"
  );
  await expect(normalRow.getByRole("checkbox", { name: "急件" })).toHaveCSS(
    "color",
    "rgb(185, 28, 28)"
  );
  await expect(runningRow.getByRole("checkbox", { name: "急件" })).toHaveText("✓");
  await expect(closedRow.getByRole("checkbox", { name: "急件" })).toBeDisabled();
  await expect(closedRow.getByRole("checkbox", { name: "急件" })).toHaveCSS(
    "color",
    "rgb(100, 116, 139)"
  );
  await expect(emptyRow.locator(".work-order-urgent-flame")).toHaveCount(0);
  await expect(normalRow.locator(".work-order-urgent-flame")).toHaveCount(1);
  await expect(normalRow.locator(".work-order-urgent-flame")).toHaveAttribute(
    "title",
    "急件"
  );
  await expect(
    normalRow.getByRole("button", { name: "DEMO-070335 急件", exact: true })
  ).toHaveCount(1);
  await expect(normalRow.locator(".work-order-cell-button")).toHaveAttribute(
    "title",
    "DEMO-070335"
  );
  await expect(normalRow.locator(".work-order-urgent-flame")).toHaveCSS(
    "color",
    "rgb(194, 65, 12)"
  );
  await expect(normalRow.locator(".work-order-urgent-flame")).toHaveCSS(
    "font-size",
    "9px"
  );
  await expect(runningRow.locator(".work-order-urgent-flame")).toHaveCount(1);
  await expect(closedRow.locator(".work-order-urgent-flame")).toHaveCSS(
    "color",
    "rgb(100, 116, 139)"
  );

  const layoutMetrics = await page.evaluate(() => {
    const rowMetrics = (rowKey: string, value: string) => {
      const row = document.querySelector(`tr[data-row-key="${rowKey}"]`);
      const valueNode = Array.from(
        row?.querySelectorAll<HTMLElement>(".table-cell-text.is-fit") ?? []
      ).find((node) => node.textContent?.trim() === value);
      const chip = row?.querySelector<HTMLElement>(".machine-code-chip--current");
      if (!row || !valueNode || !chip) throw new Error(`missing fixture row ${rowKey}`);
      const rowRect = row.getBoundingClientRect();
      const valueStyle = getComputedStyle(valueNode);
      const chipRect = chip.getBoundingClientRect();
      return {
        valueHeight: valueNode.getBoundingClientRect().height,
        valueLineHeight: Number.parseFloat(valueStyle.lineHeight),
        rowCenterY: rowRect.top + rowRect.height / 2,
        chipCenterY: chipRect.top + chipRect.height / 2,
        verticalAlign: getComputedStyle(valueNode.closest("td")!).verticalAlign,
      };
    };
    return {
      normal: rowMetrics("normal", "PART-003A"),
      running: rowMetrics("running", "DEMO-LONG-PART-004-V01-02"),
    };
  });

  expect(layoutMetrics.normal.valueHeight).toBeCloseTo(
    layoutMetrics.normal.valueLineHeight,
    0
  );
  expect(layoutMetrics.running.valueHeight).toBeGreaterThan(
    layoutMetrics.running.valueLineHeight * 1.5
  );
  expect(layoutMetrics.running.valueHeight).toBeLessThanOrEqual(
    layoutMetrics.running.valueLineHeight * 2 + 1
  );
  expect(layoutMetrics.normal.verticalAlign).toBe("middle");
  expect(
    Math.abs(layoutMetrics.normal.rowCenterY - layoutMetrics.normal.chipCenterY)
  ).toBeLessThan(1);

});

test("排序順位固定置中在文字篩選箭頭下方且仍可開啟選單", async ({ page }) => {
  const machineHeader = page.getByRole("columnheader", { name: /本站機台/ });
  const menuTrigger = machineHeader.locator(".column-header-menu-trigger");
  const alignment = await menuTrigger.evaluate((button) => {
    const icon = button.querySelector<HTMLElement>(".column-header-menu-trigger-icon");
    const priority = button.querySelector<HTMLElement>(
      ".column-header-menu-trigger-priority"
    );
    if (!icon || !priority) throw new Error("missing menu trigger parts");
    const buttonRect = button.getBoundingClientRect();
    const iconRect = icon.getBoundingClientRect();
    const priorityRect = priority.getBoundingClientRect();
    return {
      buttonCenterX: buttonRect.left + buttonRect.width / 2,
      iconCenterX: iconRect.left + iconRect.width / 2,
      priorityCenterX: priorityRect.left + priorityRect.width / 2,
      iconBottom: iconRect.bottom,
      priorityTop: priorityRect.top,
    };
  });

  expect(alignment.iconCenterX).toBeCloseTo(alignment.buttonCenterX, 5);
  expect(alignment.priorityCenterX).toBeCloseTo(alignment.buttonCenterX, 5);
  expect(alignment.priorityTop).toBeCloseTo(alignment.iconBottom, 5);

  await menuTrigger.click();
  const popover = page.locator(
    ".column-menu-popover.ant-popover-placement-bottomLeft"
  );
  await expect(popover).toBeVisible();
  await expect(popover).toContainText("文字篩選");
});

test("布林篩選由單一表頭 owner 控制，連續勾選不關閉也不穿透資料列", async ({ page }) => {
  const urgentHeader = page.getByRole("columnheader", { name: /急件/ });
  await urgentHeader.locator(".column-header-menu-trigger").click();

  const visiblePopovers = page.locator(".column-menu-popover:visible");
  await expect(visiblePopovers).toHaveCount(1);
  const popover = visiblePopovers.first();
  const noCheckbox = popover.getByRole("checkbox", { name: "否" });
  const yesCheckbox = popover.getByRole("checkbox", { name: "是" });

  await noCheckbox.click();
  await expect(popover).toBeVisible();
  await expect(noCheckbox).toBeChecked();
  await expect(popover).toContainText("已選 1");
  await expect
    .poll(() => page.evaluate(() => window.__workReportListVisualDetailOpenCount ?? 0))
    .toBe(0);

  await yesCheckbox.click();
  await expect(popover).toBeVisible();
  await expect(yesCheckbox).toBeChecked();
  await expect(popover).toContainText("已選 2");
  await expect(visiblePopovers).toHaveCount(1);
  await expect
    .poll(() => page.evaluate(() => window.__workReportListVisualDetailOpenCount ?? 0))
    .toBe(0);
});

test("布林欄位在一般與 active 狀態都對齊且控制項不越界", async ({ page }) => {
  const assertAligned = async (
    label: string,
    active: boolean,
    mode: "fit" | "compact"
  ) => {
    const header = page.getByRole("columnheader", { name: new RegExp(label) });
    const sortBadge = header.locator(".column-header-sort-badge");
    const filterBadge = header.locator(".column-header-filter-badge");
    const menuTrigger = header.locator(".column-header-menu-trigger");
    if (active) {
      await expect(sortBadge).toHaveCount(1);
      await expect(filterBadge).toHaveCount(1);
      await expect(sortBadge).toHaveCSS("clip-path", "inset(50%)");
      await expect(filterBadge).toHaveCSS("clip-path", "inset(50%)");
      await expect(menuTrigger).toHaveClass(/is-active/);
    } else {
      await expect(sortBadge).toHaveCount(0);
      await expect(filterBadge).toHaveCount(0);
      await expect(menuTrigger).not.toHaveClass(/is-active/);
    }
    const [headerBox, titleBox, checkboxBox, triggerBox, resizeBox, referenceTriggerBox] =
      await Promise.all([
        header.boundingBox(),
        header.locator(".column-header-menu-title").boundingBox(),
        page.getByRole("checkbox", { name: label }).first().boundingBox(),
        menuTrigger.boundingBox(),
        header.locator(".column-header-resize-handle").boundingBox(),
        page
          .getByRole("columnheader", { name: /工令單號/ })
          .locator(".column-header-menu-trigger")
          .boundingBox(),
      ]);
    expect(headerBox).not.toBeNull();
    expect(titleBox).not.toBeNull();
    expect(checkboxBox).not.toBeNull();
    expect(triggerBox).not.toBeNull();
    expect(resizeBox).not.toBeNull();
    expect(referenceTriggerBox).not.toBeNull();
    expect(titleBox!.width).toBeGreaterThan(0);
    const titleCenter = titleBox!.x + titleBox!.width / 2;
    const checkboxCenter = checkboxBox!.x + checkboxBox!.width / 2;
    expect(Math.abs(titleCenter - checkboxCenter)).toBeLessThan(1.5);
    if (label === "開始排程" && mode === "fit") {
      expect(checkboxBox!.x - headerBox!.x).toBeGreaterThanOrEqual(8);
      await expect(header.locator(".column-header-menu-title")).toHaveText("開始排程");
      const titleLines = header.locator(".column-header-menu-title-line");
      await expect(titleLines).toHaveText(["開始", "排程"]);
      const [firstLineBox, secondLineBox] = await Promise.all([
        titleLines.nth(0).boundingBox(),
        titleLines.nth(1).boundingBox(),
      ]);
      expect(firstLineBox).not.toBeNull();
      expect(secondLineBox).not.toBeNull();
      expect(Math.abs(firstLineBox!.x - secondLineBox!.x)).toBeLessThan(1);
      expect(Math.abs(firstLineBox!.width - secondLineBox!.width)).toBeLessThan(1);
    }
    expect(triggerBox!.x).toBeGreaterThanOrEqual(headerBox!.x);
    expect(triggerBox!.x + triggerBox!.width).toBeLessThanOrEqual(
      headerBox!.x + headerBox!.width
    );
    expect(resizeBox!.x + resizeBox!.width).toBeLessThanOrEqual(
      headerBox!.x + headerBox!.width
    );
    expect(Math.abs(triggerBox!.y - referenceTriggerBox!.y)).toBeLessThan(1);
  };

  for (const active of [false, true]) {
    for (const mode of ["fit", "compact"] as const) {
      await page.goto(
        `/__work-report-list-visual-contract__?formId=901${active ? "&booleanBadges=1" : ""}`
      );
      await page.waitForFunction(() => window.__workReportListVisualReady === true);
      if (mode === "compact") {
        await page.locator(".workspace-display-mode").getByRole("button", { name: "精簡" }).click();
      }
      await assertAligned("開始排程", active, mode);
      if (mode === "fit") await assertAligned("急件", active, mode);
    }

    await page.goto(
      `/__work-report-list-visual-contract__?formId=902${active ? "&booleanBadges=1" : ""}`
    );
    await page.waitForFunction(() => window.__workReportListVisualReady === true);
    await assertAligned("急件", active, "fit");
  }
});

for (const formId of ["901", "902"] as const) {
  test(`Form ${formId} 指定結束日期不穿透資料列，已結案欄位不提供編輯入口`, async ({ page }) => {
    if (formId === "902") {
      await page.goto(`/__work-report-list-visual-contract__?formId=${formId}`);
      await page.waitForFunction(() => window.__workReportListVisualReady === true);
    }

    const row = page.locator('tr[data-row-key="normal"]');
    await expect(row.getByRole("checkbox", { name: "急件" })).toHaveText("✓");
    const editorButton = row.getByRole("button", { name: /編輯工令 DEMO-070335 的指定結束日期/ });
    await editorButton.click();
    const dateInput = page.locator("#planned-end-date-normal");
    await dateInput.fill("2026-09-05");
    await page.getByRole("button", { name: "儲存", exact: true }).click();

    await expect(row.locator(".work-report-planned-end-date-value")).toHaveText("2026/09/05");
    await expect
      .poll(() =>
        page.evaluate(() => window.__workReportListVisualPlannedEndDateMutationCount ?? 0)
      )
      .toBe(1);
    await expect
      .poll(() => page.evaluate(() => window.__workReportListVisualDetailOpenCount ?? 0))
      .toBe(0);

    const closedRow = page.locator('tr[data-row-key="closed"]');
    await expect(closedRow.locator(".work-report-planned-end-date-edit-btn")).toHaveCount(0);
    await expect(closedRow.locator(".work-report-sort-order-edit-btn")).toHaveCount(0);
    await expect(closedRow.locator(".work-report-main-machine-edit-btn")).toHaveCount(0);
  });
}

for (const formId of ["901", "902"] as const) {
  test(`Form ${formId} 列表共用機台與急件編輯，開始排程依實際表單能力開放`, async ({ page }) => {
    await page.goto(`/__work-report-list-visual-contract__?formId=${formId}`);
    await page.waitForFunction(() => window.__workReportListVisualReady === true);
    const row = page.locator('tr[data-row-key="normal"]');

    if (formId === "901") {
      const startSchedule = row.getByRole("checkbox", { name: "開始排程" });
      await expect(startSchedule).toBeEnabled();
      await startSchedule.click();
      await expect(startSchedule).toHaveAttribute("aria-checked", "false");
      await expect
        .poll(() =>
          page.evaluate(() => window.__workReportListVisualStartScheduleMutationCount ?? 0)
        )
        .toBe(1);
    } else {
      await expect(row.getByRole("checkbox", { name: "開始排程" })).toHaveCount(0);
    }

    const urgent = row.getByRole("checkbox", { name: "急件" });
    await urgent.click();
    await expect(urgent).toHaveAttribute("aria-checked", "false");
    await expect
      .poll(() => page.evaluate(() => window.__workReportListVisualUrgentMutationCount ?? 0))
      .toBe(1);

    await row.getByRole("button", { name: /編輯工令 DEMO-070335 的本站機台/ }).click();
    const machineInput = page.locator("#main-machine-normal");
    await machineInput.fill("MA22");
    await page.getByRole("button", { name: "儲存", exact: true }).click();
    await expect(row.locator(".machine-code-chip--current")).toHaveText("MA22");
    await expect
      .poll(() =>
        page.evaluate(() => window.__workReportListVisualMainMachineMutationCount ?? 0)
      )
      .toBe(1);

    await expect
      .poll(() => page.evaluate(() => window.__workReportListVisualDetailOpenCount ?? 0))
      .toBe(0);
  });
}

test("指定結束日期 task 完成 authoritative refresh 前維持同步鎖", async ({ page }) => {
  await page.goto("/__work-report-list-visual-contract__?formId=901&dateSyncing=1");
  await page.waitForFunction(() => window.__workReportListVisualReady === true);

  const row = page.locator('tr[data-row-key="normal"]');
  await expect(row.locator(".work-report-planned-end-date-edit-btn")).toHaveCount(0);
  await expect(row.locator(".work-report-sort-order-edit-btn")).toHaveCount(0);
  await expect(row.locator(".work-report-main-machine-edit-btn")).toHaveCount(0);
  await expect(row.getByRole("checkbox", { name: "開始排程" })).toBeDisabled();
  await expect(row.getByRole("checkbox", { name: "急件" })).toBeDisabled();
  await expect(row.locator(".work-report-editable-status")).toHaveText(["Ragic 確認中"]);
  await expect(
    row.locator(".work-report-planned-end-date-value").locator("..").locator(
      ".work-report-editable-status"
    )
  ).toHaveText("Ragic 確認中");
});

test("排序 task 未收斂前維持同步鎖", async ({ page }) => {
  await page.goto("/__work-report-list-visual-contract__?formId=901&sortSyncing=1");
  await page.waitForFunction(() => window.__workReportListVisualReady === true);

  const row = page.locator('tr[data-row-key="normal"]');
  await expect(row.locator(".work-report-sort-order-edit-btn")).toHaveCount(0);
  await expect(row.locator(".work-report-planned-end-date-edit-btn")).toHaveCount(0);
  await expect(row.locator(".work-report-main-machine-edit-btn")).toHaveCount(0);
  await expect(row.getByRole("checkbox", { name: "開始排程" })).toBeDisabled();
  await expect(row.getByRole("checkbox", { name: "急件" })).toBeDisabled();
  await expect(row.locator(".work-report-editable-status")).toHaveText(["Ragic 確認中"]);
  await expect(
    row.locator(".work-report-sort-order-value").locator("..").locator(
      ".work-report-editable-status"
    )
  ).toHaveText("Ragic 確認中");
});

test("急件火焰在窄視窗仍固定於工令右上角", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const row = page.locator('tr[data-row-key="normal"]');
  const text = row.locator(".work-order-cell-text");
  const flame = row.locator(".work-order-urgent-flame");
  const [textBox, flameBox] = await Promise.all([
    text.boundingBox(),
    flame.boundingBox(),
  ]);

  expect(textBox).not.toBeNull();
  expect(flameBox).not.toBeNull();
  const textMetrics = await text.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    whiteSpace: getComputedStyle(element).whiteSpace,
  }));
  expect(textMetrics.whiteSpace).toBe("nowrap");
  expect(textMetrics.clientWidth).toBeGreaterThanOrEqual(textMetrics.scrollWidth);
  expect(flameBox!.x).toBeGreaterThanOrEqual(textBox!.x + textBox!.width);
  expect(flameBox!.y).toBeLessThan(textBox!.y + textBox!.height / 2);
});

for (const formId of ["901", "902"]) {
  test(`${formId}: 25／50／100 筆切換保留執行中綠底與結案灰底`, async ({ page }) => {
    await page.goto(`/__work-report-list-visual-contract__?statusProbe=1&formId=${formId}`);
    for (const size of [25, 50, 100, 25]) {
      await page.locator(".workspace-page-size .ant-select").click();
      await page.locator(".ant-select-item-option").filter({ hasText: new RegExp(`^${size}$`) }).click();
      await page.mouse.move(0, 0);
      const running = page.locator('[data-row-key="running"]');
      const closed = page.locator('[data-row-key="closed"]');
      const normal = page.locator('[data-row-key="normal"]');
      await expect(running).toHaveClass(/row-running/);
      await expect(closed).toHaveClass(/row-running.*row-closed/);
      await expect(running).toHaveJSProperty("tagName", "TR");
      await expect(running.locator(":scope > .ant-table-cell").first()).toHaveCSS("background-color", "rgb(157, 255, 157)");
      await expect(closed.locator(":scope > .ant-table-cell").first()).toHaveCSS("background-color", "rgb(241, 245, 249)");
      await expect(closed.locator(".work-order-cell-button")).toHaveCSS("color", "rgb(100, 116, 139)");
      await expect(normal).not.toHaveClass(/row-running/);
      await expect(normal.locator(":scope > .ant-table-cell").first()).toHaveCSS("animation-name", "row-return-highlight");
      await running.locator(":scope > .ant-table-cell").first().hover();
      await expect(running.locator(":scope > .ant-table-cell").first()).toHaveCSS("background-color", "rgb(142, 245, 142)");
      await closed.locator(":scope > .ant-table-cell").first().hover();
      await expect(closed.locator(":scope > .ant-table-cell").first()).toHaveCSS("background-color", "rgb(226, 232, 240)");
    }
  });
}

test('右鍵標記一次只保留一筆，保留業務底色並可從固定工具列清除', async ({ page }) => {
  await page.goto('/__work-report-list-visual-contract__?statusProbe=1&formId=901');
  const normal = page.locator('[data-row-key="normal"]');
  const running = page.locator('[data-row-key="running"]');
  const closed = page.locator('[data-row-key="closed"]');
  await normal.locator('.work-order-cell-button').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '標記此工令' }).click();
  await expect(normal).toHaveClass(/row-marked/);
  await running.locator('.work-order-cell-button').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '標記此工令' }).click();
  await expect(normal).not.toHaveClass(/row-marked/);
  await expect(running).toHaveClass(/row-running.*row-marked/);
  await page.mouse.move(0, 0);
  await expect(running.locator('td').first()).toHaveCSS('background-color', 'rgb(157, 255, 157)');
  expect(await running.locator('td').first().evaluate(el => getComputedStyle(el).boxShadow)).toContain('245, 158, 11');
  await closed.locator('.work-order-cell-button').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '標記此工令' }).click();
  await expect(closed).toHaveClass(/row-closed.*row-marked/);
  await page.mouse.move(0, 0);
  await expect(closed.locator('td').first()).toHaveCSS('background-color', 'rgb(241, 245, 249)');
  await page.reload();
  await expect(page.locator('[data-row-key="closed"]')).toHaveClass(/row-marked/);
  await page.goto('/__work-report-list-visual-contract__?statusProbe=1&formId=902');
  await expect(page.locator('[data-row-key="closed"]')).not.toHaveClass(/row-marked/);
  await page.goto('/__work-report-list-visual-contract__?statusProbe=1&formId=901');
  await page.getByRole('button', { name: '清除標記 WO-CLOSED' }).click();
  await expect(page.locator('[data-row-key="closed"]')).not.toHaveClass(/row-marked/);
  expect(await page.evaluate(() => sessionStorage.getItem('work-report:marked-row:901'))).toBeNull();
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 820, height: 560 }, { width: 390, height: 844 }]) {
  test(`報工列表只有外層垂直捲動，工具列與表頭固定 ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/__work-report-list-visual-contract__?statusProbe=1&denseColumns=1&scrollHint=1');
    const outer = page.locator('.ragic-list-main');
    const toolbar = page.locator('.work-report-workspace-toolbar');
    const header = page.locator('.ant-table-sticky-holder');
    const sidebar = page.locator('.fixed-filter-sidebar');
    const sidebarBefore = viewport.width > 960 ? await sidebar.boundingBox() : null;
    for (const size of [25, 50, 100, 25]) {
      await page.locator('.workspace-page-size .ant-select').click();
      await page.locator('.ant-select-item-option').filter({ hasText: new RegExp(`^${size}$`) }).click();
      await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);
      await expect(page.locator('.ragic-table tbody tr[data-row-key]')).toHaveCount(size);
      await expect(page.locator('.ant-table-tbody-virtual-holder')).toHaveCount(0);
      await expect(page.locator('.pager')).toHaveCount(0);
      await expect(page.locator('.workspace-pager')).toBeVisible();
      await expect.poll(() => outer.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(100);
      const innerVerticalRange = await page.locator('.ragic-table .ant-table-body').evaluate(el => el.scrollHeight - el.clientHeight);
      expect(innerVerticalRange).toBeLessThanOrEqual(1);
      await outer.evaluate(el => { el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 2); });
      await expect.poll(() => outer.evaluate(el => el.scrollTop)).toBeGreaterThan(100);
      const [outerBox, toolbarBox, headerBox] = await Promise.all([outer.boundingBox(), toolbar.boundingBox(), header.boundingBox()]);
      expect(Math.abs(toolbarBox!.y - outerBox!.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(headerBox!.y - toolbarBox!.y - toolbarBox!.height)).toBeLessThanOrEqual(1);
      if (sidebarBefore) expect(await sidebar.boundingBox()).toEqual(sidebarBefore);
      const beforeWheel = await outer.evaluate(el => el.scrollTop);
      await page.mouse.move(outerBox!.x + 150, headerBox!.y + headerBox!.height + 100);
      await page.mouse.wheel(0, 120);
      await expect.poll(() => outer.evaluate(el => el.scrollTop)).toBeGreaterThan(beforeWheel);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      await outer.evaluate(el => { el.scrollTop = 0; });
    }
  });
}

test('上方分頁固定可操作，底部沒有重複分頁', async ({ page }) => {
  await page.goto('/__work-report-list-visual-contract__?statusProbe=1');
  const pager = page.locator('.workspace-pager');
  await pager.getByRole('button', { name: '下一頁' }).click();
  await expect(pager).toContainText('第 2 頁');
  await page.locator('.ragic-list-main').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(pager).toBeInViewport();
  await pager.getByRole('button', { name: '上一頁' }).click();
  await expect(pager).toContainText('第 1 頁');
  await expect(page.locator('.pager')).toHaveCount(0);
});

for (const size of [25, 100]) {
  test(`${size} 筆返回明細後恢復外層位置與原工令`, async ({ page }) => {
    const document = TEST_DOCUMENT.replaceAll('mountWorkReportListVisualContract', 'mountWorkReportScrollNavigation')
      .replace('work-report-list-visual-contract-fixture.tsx', 'work-report-scroll-navigation-fixture.tsx');
    await page.route('**/__scroll-navigation__*', route => route.fulfill({ contentType: 'text/html', body: document }));
    await page.goto(`/__scroll-navigation__?pageSize=${size}`);
    const outer = page.locator('.ragic-list-main');
    await outer.evaluate(el => { el.scrollTop = el.scrollHeight; });
    const before = await outer.evaluate(el => el.scrollTop);
    const target = page.locator(`[data-row-key="${size - 1}"]`);
    await expect(target).toBeInViewport();
    await target.click();
    await page.getByRole('button', { name: '返回列表', exact: true }).click();
    await expect(target).toBeInViewport();
    await expect(target).toHaveClass(/row-return-highlight/);
    await expect.poll(() => outer.evaluate(el => el.scrollTop)).toBeGreaterThanOrEqual(before - 2);
  });
}

for (const size of [25, 50, 100]) {
  test(`${size} 筆底部水平捲軸與首末列按鈕不重疊`, async ({ page }) => {
    await page.goto('/__work-report-list-visual-contract__?statusProbe=1&denseColumns=1&scrollHint=1');
    await page.locator('.workspace-page-size .ant-select').click();
    await page.locator('.ant-select-item-option').filter({ hasText: new RegExp(`^${size}$`) }).click();
    await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);
    const outer = page.locator('.ragic-list-main');
    const bar = page.locator('.fixed-h-scrollbar-shell:not(.is-hidden)');
    const hint = page.locator('.detail-scroll-top-btn');
    await expect(bar).toBeVisible();
    const [barBox, hintBox] = await Promise.all([bar.boundingBox(), hint.boundingBox()]);
    expect(barBox!.x + barBox!.width).toBeLessThanOrEqual(hintBox!.x - 8);
    const horizontal = page.locator('.ragic-table .ant-table-body');
    await bar.locator('.fixed-h-scrollbar-viewport').evaluate(el => { el.scrollLeft = el.scrollWidth; });
    await expect.poll(() => horizontal.evaluate(el => Math.abs(el.scrollWidth - el.clientWidth - el.scrollLeft))).toBeLessThanOrEqual(3);
    await page.getByRole('button', { name: '到最底', exact: true }).click();
    await expect.poll(() => outer.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(1);
    await expect(page.locator(`[data-row-key="status-${size - 1}"]`)).toBeInViewport();
    await page.getByRole('button', { name: '回到頂部', exact: true }).click();
    await expect.poll(() => outer.evaluate(el => el.scrollTop)).toBeLessThanOrEqual(1);
  });
}

test('100 筆完整欄位的連續手勢只移動外層容器', async ({ page }) => {
  await page.goto('/__work-report-list-visual-contract__?statusProbe=1&denseColumns=1');
  await page.locator('.workspace-page-size .ant-select').click();
  await page.locator('.ant-select-item-option[title="100"]').click();
  await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);
  const body = page.locator('.ragic-table .ant-table-body');
  const rect = await body.boundingBox();
  const session = await page.context().newCDPSession(page);
  const gesture = { x: rect!.x + 150, y: Math.min(rect!.y + 100, 600), speed: 600, gestureSourceType: 'mouse' as const };
  const outer = page.locator('.ragic-list-main');
  await session.send('Input.synthesizeScrollGesture', { ...gesture, yDistance: -600 });
  await expect.poll(() => outer.evaluate(el => el.scrollTop)).toBeGreaterThanOrEqual(590);
  expect(await body.evaluate(el => el.scrollTop)).toBe(0);
  await session.send('Input.synthesizeScrollGesture', { ...gesture, yDistance: 600 });
  await expect.poll(() => outer.evaluate(el => el.scrollTop)).toBeLessThanOrEqual(2);
});

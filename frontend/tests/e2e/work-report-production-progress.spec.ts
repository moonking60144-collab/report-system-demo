import { expect, test, type Page } from "@playwright/test";

type FormId = "901" | "902";

function buildDetailRow(rowId: string, cumulativeQty: number) {
  return {
    rowId,
    date: "2026/08/04",
    plannedIdle: "No",
    processCode: "TEST",
    processCodeDisplay: "TEST",
    machineId: "TEST-MACHINE",
    machineIdDisplay: "TEST-MACHINE",
    operatorId: "TEST-OPERATOR",
    operatorIdDisplay: "TEST-OPERATOR",
    operatorName: "測試人員",
    inputOptions: "整天",
    shiftType: "正常班Reg",
    startTime: "08:00",
    endTime: "17:00",
    breakTime: 1,
    totalWorkTime: 8,
    productionQty: cumulativeQty,
    cumulativeQty,
  };
}

async function installDetailMocks(
  page: Page,
  options: {
    formId: FormId;
    entryId: string;
    cumulativeValues: number[];
    targetQty: number;
    expandFirstRow?: boolean;
  }
) {
  let closeRequestCount = 0;
  const { formId, entryId, cumulativeValues, targetQty } = options;
  const entryPath = `/api/forms/${formId}/reports/${entryId}`;

  await page.route(`**${entryPath}**`, async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;

    if (pathname === `${entryPath}/editing-presence`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            hasOtherEditors: false,
            otherEditorCount: 0,
            observedAt: "2026-08-04T00:00:00.000Z",
            canEdit: true,
            isCurrentSessionOwner: true,
            lockVersion: 1,
          },
        }),
      });
      return;
    }

    if (pathname === `${entryPath}/close` && request.method() === "POST") {
      closeRequestCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { action: "close" } }),
      });
      return;
    }

    if (pathname === entryPath && request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            id: entryId,
            lastUpdatedAt: "2026-08-04T00:00:00.000Z",
            workOrderNo: `TEST-${formId}-UNDER-TARGET`,
            status: "未結案",
            targetQtyPc: targetQty,
            reportsLoaded: true,
            reports: cumulativeValues.map((value, index) => ({
              ...buildDetailRow(String(index + 1), value),
              ...(index === 0 && options.expandFirstRow
                ? { operatorName: "測試人員長名稱".repeat(12) }
                : {}),
            })),
          },
        }),
      });
      return;
    }

    await route.fallback();
  });

  await page.route(`**/api/forms/${formId}/options**`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: {} }),
    });
  });

  return {
    getCloseRequestCount: () => closeRequestCount,
  };
}

async function dismissSystemNoticeIfPresent(page: Page) {
  const cancelButton = page.getByRole("button", { name: /^(取消|Cancel)$/ });
  if (await cancelButton.count()) {
    await cancelButton.first().click({ force: true });
  }
}

for (const formId of ["901", "902"] as const) {
  test(`${formId} 未達標人工結案需多確認一次，但不阻擋送出`, async ({ page }) => {
    const entryId = formId === "901" ? "990104" : "990105";
    const mocks = await installDetailMocks(page, {
      formId,
      entryId,
      cumulativeValues: [40, 80],
      targetQty: 100,
    });

    await page.goto(
      `/reports/${formId}/${entryId}?landingPage=${
        formId === "901" ? "line-a-901" : "line-b-902"
      }&topView=report`
    );
    await dismissSystemNoticeIfPresent(page);

    await expect(
      page.locator('[data-production-status="below-target"]')
    ).toHaveCount(2);
    await page.getByRole("button", { name: /^(人工結案|Close Order)$/ }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(/生產量尚未達標|Production target not reached/);
    await expect(dialog.locator(".detail-work-order-under-target-metrics")).toContainText("80");
    await expect(dialog.locator(".detail-work-order-under-target-metrics")).toContainText("100");
    await expect(dialog.locator(".detail-work-order-under-target-metrics")).toContainText("20");
    expect(mocks.getCloseRequestCount()).toBe(0);

    await dialog
      .getByRole("button", { name: /我已確認，繼續|I understand, continue/ })
      .click();
    await expect(dialog).toContainText(/確定將工令|Close work order/);
    expect(mocks.getCloseRequestCount()).toBe(0);

    await dialog
      .getByRole("button", { name: /^(確定|確認|OK|Confirm)$/ })
      .evaluate((button) => {
        button.click();
        button.click();
      });
    await expect.poll(mocks.getCloseRequestCount).toBe(1);
  });
}

test("依序累計量未達標為琥珀色，達標後切換為綠色", async ({ page }) => {
  const formId = "901";
  const entryId = "990106";
  await installDetailMocks(page, {
    formId,
    entryId,
    cumulativeValues: [40, 100],
    targetQty: 100,
  });

  await page.goto(
    `/reports/${formId}/${entryId}?landingPage=line-a-901&topView=report`
  );
  await dismissSystemNoticeIfPresent(page);

  const progressCells = page.locator(".detail-progress-cell[data-production-status]");
  await expect(progressCells.nth(0)).toHaveAttribute("data-production-status", "below-target");
  await expect(progressCells.nth(1)).toHaveAttribute("data-production-status", "target-met");
  await expect(progressCells.nth(0).locator(".detail-progress-track")).toHaveCSS(
    "background-color",
    "rgb(254, 243, 199)"
  );
  await expect(progressCells.nth(1).locator(".detail-progress-track")).toHaveCSS(
    "background-color",
    "rgb(209, 250, 229)"
  );

  await page.getByRole("button", { name: /^(人工結案|Close Order)$/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(/確定將工令|Close work order/);
  await expect(dialog).not.toContainText(/生產量尚未達標|Production target not reached/);
});

test("批次新增換列時不會把前一列的延後草稿套到新列", async ({ page }) => {
  const entryId = "990107";
  await installDetailMocks(page, {
    formId: "901",
    entryId,
    cumulativeValues: [10, 20],
    targetQty: 10_000,
  });
  await page.goto(
    `/reports/901/${entryId}?landingPage=line-a-901&topView=report`
  );
  await dismissSystemNoticeIfPresent(page);

  const tableScroll = page.locator(".detail-table-scroll");
  await tableScroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const placeholders = page.locator("tr[data-row-kind='create-placeholder']");
  const firstRow = placeholders.nth(0);
  const secondRow = placeholders.nth(1);
  await firstRow.locator("td").first().click({ force: true });
  await firstRow.locator("[data-inline-editor-key='productionQty']").fill("999");
  await expect(firstRow.locator(".detail-cell-predicted-value")).toBeVisible();

  const samplesPromise = page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const samples: string[] = [];
        let remainingFrames = 30;
        const sample = () => {
          const value = document.querySelector(
            "tr[data-row-id='__inline-create__:1'] .detail-cell-predicted-value"
          );
          samples.push(value?.childNodes[0]?.textContent?.trim() ?? "");
          remainingFrames -= 1;
          if (remainingFrames === 0) {
            resolve(samples);
            return;
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      })
  );
  await secondRow.locator("td").first().click({ force: true });
  const samples = await samplesPromise;
  await expect(secondRow.locator(".detail-cell-predicted-value")).toBeVisible();
  const finalValue = await secondRow.locator(".detail-cell-predicted-value").evaluate(
    (element) => element.childNodes[0]?.textContent?.trim() ?? ""
  );

  const observedValues = samples.filter(Boolean);
  expect(observedValues).toContain(finalValue);
  expect(observedValues.every((value) => value === finalValue)).toBe(true);
});

test("StrictMode 重掛 effects 後虛擬捲動仍採用實測列高", async ({ page }) => {
  const entryId = "990108";
  await installDetailMocks(page, {
    formId: "901",
    entryId,
    cumulativeValues: Array.from({ length: 46 }, (_, index) => index + 1),
    targetQty: 10_000,
    expandFirstRow: true,
  });
  await page.goto(
    `/reports/901/${entryId}?landingPage=line-a-901&topView=report`
  );
  await dismissSystemNoticeIfPresent(page);

  const tableScroll = page.locator(".detail-table-scroll");
  await tableScroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const renderedRows = page.locator(".detail-subtable tbody tr[data-row-id]");
  await expect(renderedRows.first()).toBeVisible();
  await expect(page.locator(".detail-virtual-spacer-row td").first()).toBeVisible();

  const firstRenderedRowId = Number(await renderedRows.first().getAttribute("data-row-id"));
  const topSpacerHeight = await page.locator(".detail-virtual-spacer-row td").first().evaluate(
    (element) => Number.parseFloat((element as HTMLElement).style.height)
  );
  expect(await renderedRows.count()).toBeLessThan(46);
  expect(topSpacerHeight).not.toBe((firstRenderedRowId - 1) * 70);
});

test("同一個明細頁切換工令時會釋放舊列鎖且不會鎖住新工令", async ({
  page,
}) => {
  const lockRequests: Array<{
    entryId: string;
    rowId: string;
    active: boolean;
  }> = [];
  const entries = new Map([
    [
      "entry-a",
      {
        workOrderNo: "TEST-ENTRY-A",
        reports: [buildDetailRow("3", 10)],
      },
    ],
    [
      "entry-b",
      {
        workOrderNo: "TEST-ENTRY-B",
        reports: [buildDetailRow("3", 20)],
      },
    ],
  ]);

  await page.route("**/api/forms/901/reports/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const match = pathname.match(
      /^\/api\/forms\/901\/reports\/([^/]+)(\/editing-presence)?$/
    );
    if (!match) {
      await route.fallback();
      return;
    }

    const entryId = decodeURIComponent(match[1]);
    if (match[2]) {
      if (request.method() === "PUT") {
        const payload = request.postDataJSON() as {
          rowId?: string;
          active?: boolean;
        };
        lockRequests.push({
          entryId,
          rowId: String(payload.rowId ?? ""),
          active: Boolean(payload.active),
        });
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            hasOtherEditors: false,
            otherEditorCount: 0,
            observedAt: "2026-08-24T00:00:00.000Z",
            canEdit: true,
            isCurrentSessionOwner: request.method() === "PUT",
            lockVersion: 1,
          },
        }),
      });
      return;
    }

    const entry = entries.get(entryId);
    if (!entry || request.method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          id: entryId,
          lastUpdatedAt: "2026-08-24T00:00:00.000Z",
          workOrderNo: entry.workOrderNo,
          status: "未結案",
          targetQtyPc: 100,
          reportsLoaded: true,
          reports: entry.reports,
        },
      }),
    });
  });
  await page.route("**/api/forms/901/options**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: {} }),
    });
  });

  await page.goto(
    "/reports/901/entry-a?landingPage=line-a-901&topView=report"
  );
  await dismissSystemNoticeIfPresent(page);
  const firstEntryRow = page.locator(
    ".detail-subtable tbody tr[data-row-id='3']"
  );
  await expect(firstEntryRow).toBeVisible();
  await firstEntryRow.dblclick({ force: true });
  await expect
    .poll(() =>
      lockRequests.some(
        (request) =>
          request.entryId === "entry-a" &&
          request.rowId === "3" &&
          request.active
      )
    )
    .toBe(true);

  await page.evaluate(() => {
    window.history.pushState(
      {},
      "",
      "/reports/901/entry-b?landingPage=line-a-901&topView=report"
    );
    window.dispatchEvent(new PopStateEvent("popstate"));
  });

  await expect(page).toHaveURL(/\/reports\/901\/entry-b/);
  await expect(page.getByText("TEST-ENTRY-B").first()).toBeVisible();
  await expect
    .poll(() =>
      lockRequests.some(
        (request) =>
          request.entryId === "entry-a" &&
          request.rowId === "3" &&
          !request.active
      )
    )
    .toBe(true);
  await page.waitForTimeout(100);
  expect(
    lockRequests.some(
      (request) =>
        request.entryId === "entry-b" &&
        request.rowId === "3" &&
        request.active
    )
  ).toBe(false);
});

test("明細 route 切換時不呈現舊工令，失敗後只允許重試新工令", async ({
  page,
}) => {
  let releaseFirstEntryBRequest!: () => void;
  const firstEntryBRequestGate = new Promise<void>((resolve) => {
    releaseFirstEntryBRequest = resolve;
  });
  let entryBRequestCount = 0;
  let allowEntryBSuccess = false;
  const lockRequests: Array<{ entryId: string; rowId: string }> = [];

  await page.route("**/api/forms/901/reports/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const match = pathname.match(
      /^\/api\/forms\/901\/reports\/([^/]+)(\/editing-presence)?$/
    );
    if (!match) {
      await route.fallback();
      return;
    }

    const entryId = decodeURIComponent(match[1]);
    if (match[2]) {
      if (request.method() === "PUT") {
        const payload = request.postDataJSON() as { rowId?: string; active?: boolean };
        if (payload.active) {
          lockRequests.push({
            entryId,
            rowId: String(payload.rowId ?? ""),
          });
        }
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            hasOtherEditors: false,
            otherEditorCount: 0,
            observedAt: "2026-09-04T00:00:00.000Z",
            canEdit: true,
            isCurrentSessionOwner: request.method() === "PUT",
            lockVersion: 1,
          },
        }),
      });
      return;
    }

    if (request.method() !== "GET") {
      await route.fallback();
      return;
    }
    if (entryId === "entry-b") {
      entryBRequestCount += 1;
      if (!allowEntryBSuccess) {
        await firstEntryBRequestGate;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "TEST_ENTRY_LOAD_FAILED",
              message: "entry-b load failed",
            },
          }),
        });
        return;
      }
    }

    const isEntryA = entryId === "entry-a";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          id: entryId,
          lastUpdatedAt: "2026-09-04T00:00:00.000Z",
          workOrderNo: isEntryA ? "ROUTE-ENTRY-A" : "ROUTE-ENTRY-B",
          status: "未結案",
          targetQtyPc: 100,
          reportsLoaded: true,
          reports: [buildDetailRow(isEntryA ? "row-a" : "row-b", 10)],
        },
      }),
    });
  });
  await page.route("**/api/forms/901/options**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: {} }),
    });
  });

  await page.goto(
    "/reports/901/entry-a?landingPage=line-a-901&topView=report"
  );
  await dismissSystemNoticeIfPresent(page);
  await expect(page.getByText("ROUTE-ENTRY-A").first()).toBeVisible();

  await page.evaluate(() => {
    window.history.pushState(
      {},
      "",
      "/reports/901/entry-b?landingPage=line-a-901&topView=report"
    );
    window.dispatchEvent(new PopStateEvent("popstate"));
  });

  await expect.poll(() => entryBRequestCount).toBeGreaterThan(0);
  await expect(page.getByText("ROUTE-ENTRY-A")).toHaveCount(0);
  await expect(page.locator('.page-loading-boundary[aria-busy="true"]')).toBeVisible();
  expect(lockRequests).toEqual([]);

  releaseFirstEntryBRequest();
  const loadError = page.getByRole("alert").filter({ hasText: "entry-b load failed" });
  await expect(loadError).toBeVisible();
  await expect(page.getByText("ROUTE-ENTRY-A")).toHaveCount(0);
  expect(lockRequests).toEqual([]);

  allowEntryBSuccess = true;
  await loadError.getByRole("button", { name: /重新讀取|Try Again/ }).click();
  await expect(page.getByText("ROUTE-ENTRY-B").first()).toBeVisible();
  await page.locator(".detail-subtable tbody tr[data-row-id='row-b']").dblclick({
    force: true,
  });
  await expect.poll(() => lockRequests).toContainEqual({
    entryId: "entry-b",
    rowId: "row-b",
  });
  expect(lockRequests.some((request) => request.entryId === "entry-a")).toBe(false);
});

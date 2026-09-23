import { expect, test } from "@playwright/test";

const OPERATOR_GROUP_STORAGE_KEY = "work-report:operator-group-preference:v1";
const PENDING_MUTATION_REPLAY_STORAGE_KEY = "work-report:pending-mutation-replay:v1";
const INLINE_EDITABLE_DETAIL_URL =
  "/reports/901/90002?page=1&pageSize=25&landingPage=line-a-901&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes";

const MOCK_OPERATOR_OPTIONS_WITH_GROUPS = [
  {
    value: "EMP101",
    label: "EMP101 - 製程 A甲",
    display: "製程 A甲",
    operatorGroupKey: "P01加工一組",
    operatorGroupLabel: "P01加工一組",
  },
  {
    value: "EMP102",
    label: "EMP102 - 製程 A乙",
    display: "製程 A乙",
    operatorGroupKey: "P01加工一組",
    operatorGroupLabel: "P01加工一組",
  },
  {
    value: "EMP201",
    label: "EMP201 - 製程 B甲",
    display: "製程 B甲",
    operatorGroupKey: "P02加工二組",
    operatorGroupLabel: "P02加工二組",
  },
  {
    value: "EMP301",
    label: "EMP301 - 管理甲",
    display: "管理甲",
    operatorGroupKey: "ADM管理組",
    operatorGroupLabel: "ADM管理組",
  },
] as const;

async function resetOperatorGroupPreference(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.evaluate((storageKey: string) => {
    window.localStorage.removeItem(storageKey);
  }, OPERATOR_GROUP_STORAGE_KEY);
}

async function seedLegacyCreateDefaults(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.evaluate(() => {
    window.sessionStorage.setItem(
      "work-report:form-memory:901:90002:v1",
      JSON.stringify({
        machineId: "LEGACY-MACHINE",
        operatorId: "LEGACY-OPERATOR",
        processCode: "LEGACY-PROCESS",
      })
    );
  });
}

async function mockOperatorOptionsWithGroups(
  page: import("@playwright/test").Page,
  formId: "901" | "902"
) {
  await page.route(`**/api/forms/${formId}/options**`, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }

    const response = await route.fetch();
    const payload = (await response.json()) as {
      data?: Record<string, unknown>;
      meta?: Record<string, unknown>;
    };

    await route.fulfill({
      status: response.status(),
      contentType: "application/json",
      body: JSON.stringify({
        ...payload,
        data: {
          ...(payload.data ?? {}),
          operatorId: MOCK_OPERATOR_OPTIONS_WITH_GROUPS,
        },
      }),
    });
  });
}

async function dismissSystemNoticeIfPresent(page: import("@playwright/test").Page) {
  const dialogCloseButton = page.getByRole("button", { name: /(取消|Cancel)/ });
  if (await dialogCloseButton.count()) {
    await dialogCloseButton.first().click({ force: true });
  }

  const dismissButton = page.getByRole("button", { name: /(隱藏通知|Dismiss)/ });
  if (await dismissButton.count()) {
    await dismissButton.first().click({ force: true });
  }
}

async function mockEditableWorkOrderStatus(
  page: import("@playwright/test").Page,
  entryId = "90001"
) {
  await page.route(`**/api/forms/901/reports/${entryId}**`, async (route) => {
    const requestUrl = new URL(route.request().url());
    if (
      route.request().method() !== "GET" ||
      requestUrl.pathname !== `/api/forms/901/reports/${entryId}`
    ) {
      await route.fallback();
      return;
    }

    const response = await route.fetch();
    const payload = (await response.json()) as {
      data?: Record<string, unknown>;
      meta?: Record<string, unknown>;
    };
    const reports = Array.isArray(payload.data?.reports)
      ? payload.data.reports.map((report) =>
          report && typeof report === "object"
            ? {
                ...(report as Record<string, unknown>),
                operatorId:
                  String((report as Record<string, unknown>).operatorId ?? "").trim() || "EMP001",
              }
            : report
        )
      : payload.data?.reports;
    await route.fulfill({
      status: response.status(),
      contentType: "application/json",
      body: JSON.stringify({
        ...payload,
        data: payload.data
          ? { ...payload.data, status: "未結案", reports }
          : payload.data,
      }),
    });
  });
}

async function mockAvailableRowEditLock(page: import("@playwright/test").Page) {
  await page.route("**/api/forms/901/reports/*/editing-presence**", async (route) => {
    if (route.request().method() !== "GET" && route.request().method() !== "PUT") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          hasOtherEditors: false,
          otherEditorCount: 0,
          observedAt: "2026-09-03T00:00:00.000Z",
          canEdit: true,
          isCurrentSessionOwner: true,
          lockAcquiredAt: "2026-09-03T00:00:00.000Z",
          idleMs: 0,
          lockVersion: 1,
        },
      }),
    });
  });
}

async function chooseConditionSelectOption(
  page: import("@playwright/test").Page,
  conditionRow: import("@playwright/test").Locator,
  selectSelector: string,
  optionLabel: RegExp
) {
  await conditionRow.locator(selectSelector).click();
  const dropdown = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)").last();
  const option = dropdown.locator(".ant-select-item-option").filter({ hasText: optionLabel }).first();
  await expect(option).toBeVisible();
  await option.click();
}

async function scrollDetailTableToBottom(page: import("@playwright/test").Page) {
  const tableScroll = page.locator(".detail-table-scroll");
  await expect(tableScroll).toBeVisible();
  await tableScroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(async () =>
      page.locator(".detail-subtable tbody tr[data-row-kind='create-placeholder']").count()
    )
    .toBeGreaterThan(0);
}

async function getLocatorVerticalBounds(locator: import("@playwright/test").Locator) {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      top: rect.top,
      bottom: rect.bottom,
      height: rect.height,
    };
  });
}

async function getBatchCreateDraftCount(page: import("@playwright/test").Page) {
  const summaryText = await page.locator(".detail-table-head-summary").textContent();
  const matched = (summaryText ?? "").match(/Batch Create \((\d+) rows?\)|批次新增中（(\d+) 列）/);
  return Number(matched?.[1] ?? matched?.[2] ?? 0);
}

async function setColumnCheckbox(
  panel: import("@playwright/test").Locator,
  columnKey: string,
  checked: boolean
) {
  const checkbox = panel.locator(`input[data-column-key="${columnKey}"]`);
  await expect(checkbox).toHaveCount(1);
  await checkbox.evaluate((element, nextChecked) => {
    if (!(element instanceof HTMLInputElement)) {
      throw new Error("column control is not a checkbox input");
    }
    if (element.checked !== nextChecked) {
      element.click();
    }
  }, checked);
  await expect(checkbox).toBeChecked({ checked });
}

async function installMockRealtimeBootReload(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const globalWindow = window as typeof window & {
      __mockEventSourceInstances?: EventTarget[];
      __emitMockRealtimeLifecycle?: (eventName: string, payload: Record<string, unknown>) => boolean;
    };

    globalWindow.__mockEventSourceInstances = [];
    globalWindow.__emitMockRealtimeLifecycle = (eventName, payload) => {
      const activeInstances = (globalWindow.__mockEventSourceInstances ?? []).filter(
        (instance) => (instance as EventTarget & { readyState?: number }).readyState !== 2
      );
      for (const instance of activeInstances) {
        instance.dispatchEvent(
          new MessageEvent(eventName, {
            data: JSON.stringify(payload),
          })
        );
      }
      return activeInstances.length > 0;
    };

    class MockEventSource extends EventTarget {
      url: string;
      withCredentials = false;
      readyState = 1;
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        globalWindow.__mockEventSourceInstances?.push(this);
        window.setTimeout(() => {
          if (typeof this.onopen === "function") {
            this.onopen(new Event("open"));
          }
        }, 0);
      }

      close() {
        this.readyState = 2;
      }
    }

    Object.defineProperty(globalWindow, "EventSource", {
      configurable: true,
      writable: true,
      value: MockEventSource,
    });
  });
}

test.describe("work-report navigation stability", () => {
  test.beforeEach(async ({ page }) => {
    await mockEditableWorkOrderStatus(page);
    await mockAvailableRowEditLock(page);
  });

  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test("斷線頁保留畫面直到 readiness 恢復才重新進入", async ({ page }) => {
    let recovered = false;
    let readinessChecks = 0;
    await page.route("**/api/ready", async (route) => {
      readinessChecks += 1;
      await route.fulfill({
        status: recovered ? 200 : 503,
        contentType: "application/json",
        body: JSON.stringify({
          ready: recovered,
          mode: recovered ? "ready" : "unavailable",
          checkedAt: new Date().toISOString(),
          capabilities: {
            frontend: true,
            workReportRead: true,
            workReportWrite: recovered,
            realtime: true,
          },
          issues: recovered
            ? []
            : ["RAGIC_MUTATION_CIRCUIT_OPEN", "RAGIC_WRITE_CIRCUIT_OPEN"],
        }),
      });
    });
    await page.goto("/system-unavailable?returnTo=%2F&reason=backend-unavailable");

    await expect(
      page.getByRole("heading", { name: /(系統正在重新連線|Reconnecting to the System)/ })
    ).toBeVisible();
    await expect(page.getByText(/開發者正在更新系統|A developer may be updating the system/)).toBeVisible();
    await expect(page.getByText(/後端尚未恢復|backend has not recovered/i)).toBeVisible();
    await expect.poll(() => readinessChecks).toBeGreaterThan(0);

    const reconnectButton = page.getByRole("button", {
      name: /(立即重新連線|Reconnect Now)/,
    });
    await reconnectButton.click();
    await expect(page).toHaveURL(/\/system-unavailable/);

    recovered = true;
    const navigationPromise = page.waitForNavigation({ waitUntil: "load" });
    await reconnectButton.click();
    await navigationPromise;
    expect(new URL(page.url()).pathname).toBe("/");
  });

  test("重新進入前會重查 readiness，不使用已過期的 ready snapshot", async ({ page }) => {
    let recovered = true;
    await page.route("**/api/ready", async (route) => {
      await route.fulfill({
        status: recovered ? 200 : 503,
        contentType: "application/json",
        body: JSON.stringify({
          ready: recovered,
          mode: recovered ? "ready" : "unavailable",
          checkedAt: new Date().toISOString(),
          capabilities: {
            frontend: true,
            workReportRead: recovered,
            workReportWrite: recovered,
            realtime: true,
          },
          issues: recovered ? [] : ["MUTATION_QUEUE_CLOSED"],
        }),
      });
    });
    await page.goto("/system-unavailable?returnTo=%2F&reason=backend-unavailable");
    const reenterButton = page.getByRole("button", {
      name: /(系統已恢復，重新進入|System Restored)/,
    });
    await expect(reenterButton).toBeVisible();

    recovered = false;
    await reenterButton.click();

    await expect(page).toHaveURL(/\/system-unavailable/);
    await expect(page.getByText(/後端尚未恢復|backend has not recovered/i)).toBeVisible();
  });

  test("列表工作區可捲到工令專注狀態，Sidebar 固定且窄螢幕不溢位", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 800 });
    await page.goto(
      "/?page=1&pageSize=25&landingPage=line-a-901&topView=report"
    );
    await dismissSystemNoticeIfPresent(page);

    const stickySearch = page.locator(".workspace-quick-search input");
    await expect(stickySearch).toBeVisible();
    await expect(page.locator(".filter-search-control input")).toHaveCount(0);
    await stickySearch.fill("WO-DEMO");
    await expect(stickySearch).toHaveValue("WO-DEMO");
    await stickySearch.fill("");
    await expect(page.locator(".workspace-pager")).toContainText(/(第 1 頁|Page 1)/);
    await expect(page.locator(".workspace-pager button").first()).toBeDisabled();

    const advancedFilters = page.locator(".work-report-filter-panel");
    const workspaceFilterButton = page.locator(".workspace-filter-btn");
    const workspaceToolbar = page.locator(".work-report-workspace-toolbar");
    const statusSummary = page.locator(".status-summary-strip");
    const toolbarBoundsBeforeOpen = await workspaceToolbar.boundingBox();
    const statusBoundsBeforeOpen = await statusSummary.boundingBox();
    await expect(advancedFilters).toHaveCount(0);
    await workspaceFilterButton.click();
    await expect(advancedFilters).toBeVisible();
    await expect(page.locator(".work-report-filter-drawer .ant-drawer-mask")).toHaveCount(0);
    await expect
      .poll(async () => {
        const workspaceBounds = await workspaceToolbar.boundingBox();
        const statusBounds = await statusSummary.boundingBox();
        const drawerBounds = await page
          .locator(".work-report-filter-drawer .ant-drawer-content-wrapper")
          .boundingBox();
        if (
          !toolbarBoundsBeforeOpen ||
          !statusBoundsBeforeOpen ||
          !workspaceBounds ||
          !statusBounds ||
          !drawerBounds
        ) {
          return false;
        }
        return (
          Math.abs(workspaceBounds.y - toolbarBoundsBeforeOpen.y) <= 1 &&
          Math.abs(workspaceBounds.height - toolbarBoundsBeforeOpen.height) <= 1 &&
          Math.abs(statusBounds.y - statusBoundsBeforeOpen.y) <= 1 &&
          Math.abs(drawerBounds.x + drawerBounds.width - 1440) <= 1 &&
          drawerBounds.width <= 440
        );
      })
      .toBe(true);
    await page.locator(".work-report-filter-drawer .ant-drawer-close").click();
    await expect(advancedFilters).toHaveCount(0);

    for (const width of [1366, 1024, 769]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(stickySearch).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
          )
        )
        .toBe(true);
    }
    await expect(workspaceToolbar).toHaveCSS("position", "static");
    await expect(page.locator(".fixed-filter-sidebar-shell.is-mobile")).toHaveCount(1);
    await page.setViewportSize({ width: 1440, height: 800 });

    const outerScroller = page.locator(".ragic-list-main");
    const sidebarBoundsBeforeFocus = await page.locator(".fixed-filter-sidebar").boundingBox();
    await outerScroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect
      .poll(() => outerScroller.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await expect
      .poll(async () => {
        const outerBounds = await outerScroller.boundingBox();
        const tableHeaderBounds = await page.locator(".ant-table-header").boundingBox();
        return Boolean(
          outerBounds &&
          tableHeaderBounds &&
          tableHeaderBounds.y >= outerBounds.y - 1 &&
          tableHeaderBounds.y <= outerBounds.y + 2
        );
      })
      .toBe(true);
    expect(await page.locator(".fixed-filter-sidebar").boundingBox()).toEqual(sidebarBoundsBeforeFocus);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    await outerScroller.evaluate((element) => { element.scrollTop = 0; });
    await expect
      .poll(() => outerScroller.evaluate((element) => element.scrollTop))
      .toBe(0);
    await page.getByRole("tab", { name: /(製程 B 報工|Process B)/ }).click();
    await expect(page.locator(".work-report-workspace-context strong")).toContainText(
      /(製程 B 報工|Process B Report)/
    );
    await expect(page.locator(".work-report-workspace-context")).toContainText("902 / PB");
    await page.getByRole("tab", { name: /(製程 A 報工|Process A)/ }).click();
    await expect(page.locator(".work-report-workspace-context")).toContainText("901 / PA");

    await page.setViewportSize({ width: 390, height: 800 });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await expect(workspaceToolbar).toHaveCSS("position", "static");
    await expect(page.locator(".work-report-workspace-center")).toBeVisible();
    await expect(stickySearch).toBeVisible();
    await expect(page.locator(".workspace-pager")).toBeHidden();
    await expect(workspaceFilterButton).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
        )
      )
      .toBe(true);
    await expect
      .poll(() =>
        page.locator(".page-view-toolbar").evaluate(
          (element) => element.scrollWidth > element.clientWidth
        )
      )
      .toBe(true);
  });

  test("列表捲動提示可前往底部與返回頂部，並可由本機設定永久隱藏", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(
      "/?page=1&pageSize=25&landingPage=line-a-901&topView=report"
    );
    await dismissSystemNoticeIfPresent(page);

    const hintButton = page.locator(".detail-scroll-top-btn");
    const outerScroller = page.locator(".ragic-list-main");
    const tableScroller = page.locator(
      ".ragic-table .ant-table-tbody-virtual-holder, .ragic-table .ant-table-body"
    );
    await expect(hintButton).toHaveAttribute(
      "aria-label",
      /到最底|Scroll to bottom/
    );
    const fixedHorizontalScrollbar = page.locator(".fixed-h-scrollbar-shell");
    await expect(fixedHorizontalScrollbar).toHaveCount(1);
    await expect(fixedHorizontalScrollbar).toHaveCSS("position", "fixed");
    await expect(fixedHorizontalScrollbar).toBeVisible();
    await expect(hintButton).toHaveCSS("bottom", "12px");
    const hintBounds = await hintButton.boundingBox();
    const nextPageBounds = await page.locator(".pager-actions button").last().boundingBox();
    expect(hintBounds).not.toBeNull();
    expect(nextPageBounds).not.toBeNull();
    expect(nextPageBounds!.x + nextPageBounds!.width).toBeLessThanOrEqual(hintBounds!.x - 8);
    const scrollbarBounds = await fixedHorizontalScrollbar.boundingBox();
    expect(scrollbarBounds).not.toBeNull();
    expect(scrollbarBounds!.x + scrollbarBounds!.width).toBeLessThanOrEqual(hintBounds!.x - 8);
    const pagerBounds = await page.locator(".pager").boundingBox();
    expect(pagerBounds).not.toBeNull();
    const tableBounds = await page.locator(".table-wrap").boundingBox();
    expect(tableBounds).not.toBeNull();
    expect(pagerBounds!.y).toBeGreaterThanOrEqual(tableBounds!.y + tableBounds!.height);
    await expect
      .poll(() => tableScroller.evaluate(element => ({
        display: getComputedStyle(element, "::-webkit-scrollbar").display,
      })))
      .toEqual({ display: "none" });
    await expect
      .poll(async () => {
        const scrollbarBounds = await fixedHorizontalScrollbar.boundingBox();
        const outerBounds = await outerScroller.boundingBox();
        if (!scrollbarBounds || !outerBounds) return Number.POSITIVE_INFINITY;
        return Math.abs(
          scrollbarBounds.y - (outerBounds.y + outerBounds.height)
        );
      })
      .toBeLessThanOrEqual(1);
    const containedScrollbar = fixedHorizontalScrollbar.locator(".fixed-h-scrollbar-viewport");
    await containedScrollbar.hover();
    await page.mouse.wheel(300, 0);
    await expect
      .poll(() => tableScroller.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0);

    await hintButton.click();
    await expect
      .poll(async () => {
        const outerTop = await outerScroller.evaluate((element) => element.scrollTop);
        const tableTop = await tableScroller.evaluate((element) => element.scrollTop);
        return outerTop + tableTop;
      })
      .toBeGreaterThan(0);
    await expect
      .poll(() =>
        tableScroller.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop
        )
      )
      .toBeLessThanOrEqual(2);
    await expect
      .poll(() =>
        tableScroller.evaluate((element) => element.scrollWidth > element.clientWidth)
      )
      .toBe(true);
    await expect(hintButton).toHaveAttribute(
      "aria-label",
      /回到頂部|Back to top/
    );

    await hintButton.click();
    await expect
      .poll(async () => {
        const outerTop = await outerScroller.evaluate((element) => element.scrollTop);
        const tableTop = await tableScroller.evaluate((element) => element.scrollTop);
        return outerTop + tableTop;
      })
      .toBeLessThanOrEqual(2);

    await page.getByRole("tab", { name: /本機設定|Local Settings/ }).click();
    const settingField = page.locator(".local-settings-field").filter({
      hasText: /列表捲動提示按鈕|List Scroll Hint Button/,
    });
    await settingField.locator('[role="combobox"]').click();
    await page
      .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")
      .last()
      .locator(".ant-select-item-option")
      .filter({ hasText: /隱藏捲動提示按鈕|Hide scroll hint button/ })
      .click();
    await page.getByRole("button", { name: /儲存|Save/ }).click();
    await expect(hintButton).toHaveCount(0);

    await page.reload();
    await dismissSystemNoticeIfPresent(page);
    await expect(hintButton).toHaveCount(0);
  });

  test("自訂篩選會送出完整條件與 901 PA scope，並標示尚未套用草稿", async ({ page }) => {
    const listRequests: URL[] = [];
    page.on("request", (request) => {
      const requestUrl = new URL(request.url());
      if (
        request.method() === "GET" &&
        requestUrl.pathname === "/api/forms/901/reports"
      ) {
        listRequests.push(requestUrl);
      }
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(
      "/?page=1&pageSize=25&landingPage=line-a-901&topView=report"
    );
    await dismissSystemNoticeIfPresent(page);

    const filterButton = page.locator(".workspace-filter-btn");
    await expect(filterButton.locator(".filter-count-badge")).toHaveCount(0);
    await filterButton.click();

    const panel = page.locator(".work-report-filter-panel");
    await expect(panel).toBeVisible();
    await expect(panel.locator(".custom-filter-condition-row")).toHaveCount(0);
    await panel.getByRole("button", { name: /新增條件|Add condition/i }).click();
    const workOrderCondition = panel.locator(".custom-filter-condition-row").first();
    await chooseConditionSelectOption(
      page,
      workOrderCondition,
      ".custom-filter-field-select",
      /(工令單號|Work Order No\.)/
    );
    await workOrderCondition.locator(".custom-filter-value-control input").fill("WO-DEMO");
    await expect(filterButton.locator(".filter-draft-badge")).toContainText(
      /(未套用|Not Applied)/
    );
    await expect(filterButton.locator(".filter-count-badge")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /(列印排程|Print Schedule)/ })
    ).toBeDisabled();

    await panel.getByRole("button", { name: /(套用篩選|Apply Filters)/ }).click();
    await expect(filterButton.locator(".filter-draft-badge")).toHaveCount(0);
    await expect(filterButton.locator(".filter-count-badge")).toHaveText("1");
    await expect(page).not.toHaveURL(/fWorkOrder=/);
    await expect
      .poll(() => {
        const requestUrl = [...listRequests]
          .reverse()
          .find((item) => item.searchParams.has("filterGroup"));
        return requestUrl
          ? {
              prodType: requestUrl.searchParams.get("prodType"),
              filterGroup: JSON.parse(requestUrl.searchParams.get("filterGroup") ?? "null"),
            }
          : null;
      })
      .toMatchObject({
        prodType: "PA",
        filterGroup: {
          joinMode: "all",
          conditions: [{ field: "workOrderNo", operator: "contains", values: ["WO-DEMO"] }],
        },
      });

    await filterButton.click();
    await panel.getByRole("button", { name: /^(清除篩選|Clear Filters)$/ }).click();
    await expect(filterButton.locator(".filter-count-badge")).toHaveText("1");
    await expect(filterButton.locator(".filter-draft-badge")).toContainText(
      /(未套用|Not Applied)/
    );
    await expect(panel.locator(".custom-filter-condition-row")).toHaveCount(0);
    await panel.getByRole("button", { name: /(套用篩選|Apply Filters)/ }).click();
    await expect(filterButton.locator(".filter-count-badge")).toHaveCount(0);

    await filterButton.click();
    await panel.getByRole("button", { name: /新增條件|Add condition/i }).click();
    const dateCondition = panel.locator(".custom-filter-condition-row").first();
    await chooseConditionSelectOption(
      page,
      dateCondition,
      ".custom-filter-field-select",
      /(最後更新日期|Last Updated)/
    );
    await chooseConditionSelectOption(
      page,
      dateCondition,
      ".custom-filter-operator-select",
      /(介於|Between)/
    );
    await dateCondition.locator('input[type="date"]').first().fill("2026-08-01");
    await dateCondition.locator('input[type="date"]').last().fill("2026-08-10");
    await panel.getByRole("button", { name: /(套用篩選|Apply Filters)/ }).click();
    await expect(filterButton.locator(".filter-count-badge")).toHaveText("1");
    await expect
      .poll(() => {
        const requestUrl = [...listRequests]
          .reverse()
          .find((item) => {
            const value = item.searchParams.get("filterGroup") ?? "";
            return value.includes("lastUpdatedAt");
          });
        return requestUrl ? JSON.parse(requestUrl.searchParams.get("filterGroup") ?? "null") : null;
      })
      .toMatchObject({
        conditions: [
          {
            field: "lastUpdatedAt",
            operator: "between",
            values: ["2026-08-01", "2026-08-10"],
          },
        ],
      });
  });

  test("902 只送有效條件，並從 authoritative facet 顯示完整狀態與本站機台", async ({ page }) => {
    const previewRequests: URL[] = [];
    let facetFields = "";
    let facetRequestCount = 0;
    await page.route("**/api/forms/902/reports?**", async (route) => {
      const requestUrl = new URL(route.request().url());
      previewRequests.push(requestUrl);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [
            {
              id: "E-902",
              workOrderNo: "WO-902",
              machineCode: "UPSTREAM-CAR",
              filterMachineCode: "MB41",
              status: "未結案",
              reports: [],
            },
          ],
          meta: {
            formId: "902",
            count: 1,
            totalCount: 1,
            hasMore: false,
            limit: 25,
            offset: 0,
            cacheSource: "sqlite",
            cacheState: "fresh",
            snapshotAt: "2026-09-03T00:00:00.000Z",
          },
        }),
      });
    });
    await page.route("**/api/forms/902/reports/facets**", async (route) => {
      const requestUrl = new URL(route.request().url());
      facetFields = requestUrl.searchParams.get("fields") ?? "";
      facetRequestCount += 1;
      if (facetRequestCount === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "temporary failure" }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            status: [
              { token: "未結案", count: 1 },
              { token: "已結案", count: 2 },
              { token: "已作廢", count: 1 },
            ],
            filterMachineCode: [
              { token: "MB41", count: 1 },
              { token: "PA", count: 3 },
            ],
          },
          meta: {
            formId: "902",
            fields: ["status", "filterMachineCode"],
            cacheSource: "sqlite",
            cacheState: "fresh",
            snapshotAt: "2026-09-03T00:00:00.000Z",
          },
        }),
      });
    });

    await page.goto(
      "/?page=1&pageSize=25&landingPage=line-b-902&topView=report&fMachine=MA05&fFilterMachine=MB41&fStartSchedule=yes"
    );
    await dismissSystemNoticeIfPresent(page);
    await expect.poll(() => previewRequests.length).toBeGreaterThan(0);
    for (const requestUrl of previewRequests) {
      expect(requestUrl.searchParams.get("machineCode")).toBeNull();
      expect(requestUrl.searchParams.get("startSchedule")).toBeNull();
    }
    expect(
      previewRequests.some(
        (requestUrl) => requestUrl.searchParams.get("filterMachineCode") === "MB41"
      )
    ).toBe(true);
    await expect.poll(() => facetRequestCount).toBe(2);
    await expect.poll(() => facetFields).toBe("status,filterMachineCode");
    await expect(page).not.toHaveURL(/fMachine=/);
    await expect(page).not.toHaveURL(/fStartSchedule=/);
    await expect(page).toHaveURL(/fFilterMachine=MB41/);

    await page.locator(".workspace-filter-btn").click();
    const panel = page.locator(".work-report-filter-panel");
    await expect(panel.locator(".custom-filter-condition-row")).toHaveCount(1);
    await panel.getByRole("button", { name: /新增條件|Add condition/i }).click();
    const statusCondition = panel.locator(".custom-filter-condition-row").first();
    await statusCondition.locator(".custom-filter-field-select").click();
    const fieldDropdown = page.locator(
      ".ant-select-dropdown:not(.ant-select-dropdown-hidden)"
    ).last();
    await expect(
      fieldDropdown.locator(".ant-select-item-option").filter({
        hasText: /(開始排程|Start Schedule)/,
      })
    ).toHaveCount(0);
    await fieldDropdown
      .locator(".ant-select-item-option")
      .filter({ hasText: /(工令狀態|Work Order Status)/ })
      .click();
    await statusCondition.locator(".custom-filter-value-control .ant-select").click();
    const statusDropdown = page.locator(
      ".ant-select-dropdown:not(.ant-select-dropdown-hidden)"
    ).last();
    await expect(
      statusDropdown.locator(".ant-select-item-option").filter({
        hasText: /(已作廢|Cancelled)/,
      })
    ).toBeVisible();
    await page.keyboard.press("Escape");

    const machineSelect = panel
      .locator(".custom-filter-condition-row")
      .nth(1)
      .locator('.custom-filter-value-control input[role="combobox"]');
    await machineSelect.click();
    await machineSelect.fill("PA");
    await expect(
      page
        .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")
        .last()
        .locator('.ant-select-item-option[title="PA"]')
    ).toBeVisible();
  });

  test("50 與 100 筆完整欄位列表只渲染視窗列且保留捲動與進入明細互動", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("work-reports:column-mode", "fit");
    });
    await page.route("**/api/forms/902/reports?**", async (route) => {
      const requestUrl = new URL(route.request().url());
      const limit = Number(requestUrl.searchParams.get("limit") ?? 25);
      const records = Array.from({ length: limit }, (_, index) => {
        const sequence = index + 1;
        return {
          id: `virtual-${sequence}`,
          workOrderNo: `WO-VIRTUAL-${String(sequence).padStart(3, "0")}`,
          machineCode: `F${(index % 8) + 1}`,
          filterMachineCode: "CH",
          customerPartNo: `PART-${sequence}`,
          sortOrder: String(sequence + 100),
          plannedStartDate: "2026/08/12",
          plannedEndDate: "2026/08/13",
          targetQtyPc: "1000",
          producedQtyStat: "0",
          processName: "CH全檢",
          status: "未結案",
          siteRunning: "No",
          lastUpdatedAt: "2026/08/12 10:30:00",
          reports: [],
        };
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: records,
          meta: {
            formId: "902",
            count: records.length,
            totalCount: records.length,
            hasMore: false,
            limit: 100,
            offset: 0,
            keyword: "",
          },
        }),
      });
    });

    await page.goto(
      "/?page=1&pageSize=25&landingPage=line-b-902&topView=report"
    );
    await dismissSystemNoticeIfPresent(page);

    const virtualBody = page.locator(".ragic-table .ant-table-tbody-virtual");
    await expect(virtualBody).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 500 });
    await page.locator(".workspace-page-size .ant-select").click();
    await page.locator(".ant-select-item-option", { hasText: "50" }).click();
    await expect(virtualBody).toBeVisible();
    await expect(page.locator(".pager")).toContainText(/1-50/);
    await expect
      .poll(() => page.locator(".ragic-table .ant-table-row").count())
      .toBeLessThan(50);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const holder = document.querySelector<HTMLElement>(
            ".ragic-table .ant-table-tbody-virtual-holder"
          );
          const wrapper = document.querySelector<HTMLElement>(".table-wrap");
          const header = wrapper?.querySelector<HTMLElement>(".ant-table-header");
          if (!holder || !wrapper || !header) return null;
          return {
            holderHeight: holder.clientHeight,
            expectedHeight: wrapper.clientHeight - header.offsetHeight - 2,
          };
        })
      )
      .toEqual(expect.objectContaining({ holderHeight: expect.any(Number) }));
    const dynamicHeight = await page.evaluate(() => {
      const holder = document.querySelector<HTMLElement>(
        ".ragic-table .ant-table-tbody-virtual-holder"
      )!;
      const wrapper = document.querySelector<HTMLElement>(".table-wrap")!;
      const header = wrapper.querySelector<HTMLElement>(".ant-table-header")!;
      return {
        holderHeight: holder.clientHeight,
        expectedHeight: wrapper.clientHeight - header.offsetHeight - 2,
      };
    });
    expect(dynamicHeight.holderHeight).toBeGreaterThan(200);
    expect(Math.abs(dynamicHeight.holderHeight - dynamicHeight.expectedHeight)).toBeLessThanOrEqual(2);

    await page.locator(".workspace-page-size .ant-select").click();
    await page.locator(".ant-select-item-option", { hasText: "100" }).click();
    await expect(page.locator(".pager")).toContainText(/1-100/);
    await expect
      .poll(() => page.locator(".ragic-table .ant-table-row").count())
      .toBeLessThan(100);

    const virtualScroller = page.locator(".ragic-table .ant-table-tbody-virtual-holder");
    const lastRow = page.locator(".ragic-table .ant-table-row", {
      hasText: "WO-VIRTUAL-100",
    });
    await expect
      .poll(async () => {
        await virtualScroller.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
          element.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        return lastRow.count();
      })
      .toBeGreaterThan(0);
    await expect(lastRow).toBeVisible();

    const horizontalScrollbar = page.locator(
      ".ragic-table .ant-table-tbody-virtual-scrollbar-horizontal"
    );
    const horizontalThumb = horizontalScrollbar.locator(
      ".ant-table-tbody-virtual-scrollbar-thumb"
    );
    await expect(horizontalScrollbar).toBeVisible();
    const thumbBounds = await horizontalThumb.boundingBox();
    expect(thumbBounds).not.toBeNull();
    await virtualScroller.hover();
    await page.mouse.wheel(300, 0);
    await expect
      .poll(async () => (await horizontalThumb.boundingBox())?.x ?? 0)
      .toBeGreaterThan(thumbBounds?.x ?? 0);
    await expect(page.locator(".fixed-h-scrollbar-shell")).toHaveCount(0);

    await lastRow.click();
    await expect(page).toHaveURL(/\/reports\/902\/virtual-100/);
  });

  test("套用篩選等待新資料時保留既有表格並顯示忙碌遮罩", async ({ page }) => {
    let shouldDelayNextListRequest = false;
    let releaseDelayedResponse: (() => void) | null = null;
    let markDelayedRequestStarted: (() => void) | null = null;
    const delayedRequestStarted = new Promise<void>((resolve) => {
      markDelayedRequestStarted = resolve;
    });
    const delayedResponseReleased = new Promise<void>((resolve) => {
      releaseDelayedResponse = resolve;
    });

    await page.route("**/api/forms/901/reports?**", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (
        !shouldDelayNextListRequest ||
        requestUrl.searchParams.get("keyword") !== "WO"
      ) {
        await route.fallback();
        return;
      }
      shouldDelayNextListRequest = false;
      const response = await route.fetch();
      markDelayedRequestStarted?.();
      await delayedResponseReleased;
      await route.fulfill({ response });
    });

    await page.goto(
      "/?page=1&pageSize=25&landingPage=line-a-901&topView=report"
    );
    await dismissSystemNoticeIfPresent(page);

    const rows = page.locator(".ragic-table tbody tr.ant-table-row");
    await expect(rows.first()).toBeVisible();
    const initialRowCount = await rows.count();

    shouldDelayNextListRequest = true;
    const searchInput = page.locator(".workspace-quick-search input");
    await searchInput.fill("WO");
    await searchInput.press("Enter");
    await delayedRequestStarted;

    await expect(page.locator(".table-wrap.is-soft-busy")).toBeVisible();
    await expect(page.locator(".table-soft-busy-overlay")).toBeVisible();
    await expect(rows).toHaveCount(initialRowCount);

    releaseDelayedResponse?.();
    await expect(page.locator(".table-wrap.is-soft-busy")).toHaveCount(0);
  });

  test("切頁等待新資料時頁碼與保留中的表格維持同一份 snapshot", async ({ page }) => {
    let releaseSecondPage: (() => void) | null = null;
    let markSecondPageStarted: (() => void) | null = null;
    const secondPageStarted = new Promise<void>((resolve) => {
      markSecondPageStarted = resolve;
    });
    const secondPageReleased = new Promise<void>((resolve) => {
      releaseSecondPage = resolve;
    });

    await page.route("**/api/forms/901/reports?**", async (route) => {
      const requestUrl = new URL(route.request().url());
      const offset = Number(requestUrl.searchParams.get("offset") ?? 0);
      if (offset === 25) {
        markSecondPageStarted?.();
        await secondPageReleased;
      }
      const recordId = offset === 25 ? "snapshot-page-2" : "snapshot-page-1";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [
            {
              id: recordId,
              workOrderNo: offset === 25 ? "WO-SNAPSHOT-PAGE-2" : "WO-SNAPSHOT-PAGE-1",
              prodType: "PA",
              status: "未結案",
              customerPartNo: "PART-001",
              erpPartNo: "PART-001",
            },
          ],
          meta: {
            formId: "901",
            count: 1,
            totalCount: 26,
            hasMore: offset === 0,
            limit: 25,
            offset,
            keyword: "",
          },
        }),
      });
    });

    await page.goto(
      "/?page=1&pageSize=25&landingPage=line-a-901&topView=report"
    );
    await dismissSystemNoticeIfPresent(page);

    const rows = page.locator(".ragic-table tbody tr.ant-table-row");
    await expect(rows.first()).toContainText("WO-SNAPSHOT-PAGE-1");
    await page.locator(".workspace-pager button").last().click();
    await secondPageStarted;

    await expect(page.locator(".table-soft-busy-overlay")).toBeVisible();
    await expect(page.locator(".workspace-pager")).toContainText(/第 1 頁|Page 1/);
    await expect(page.locator(".pager")).toContainText(/1-1/);
    await expect(page.locator(".pager")).toContainText(/第 1 頁|Page 1/);
    await expect(rows.first()).toContainText("WO-SNAPSHOT-PAGE-1");

    releaseSecondPage?.();
    await expect(page.locator(".table-soft-busy-overlay")).toHaveCount(0);
    await expect(page.locator(".workspace-pager")).toContainText(/第 2 頁|Page 2/);
    await expect(page.locator(".pager")).toContainText(/26-26/);
    await expect(rows.first()).toContainText("WO-SNAPSHOT-PAGE-2");
  });

  test("精確欄位篩選與任意已知排序維持 paged query，不下載 full dataset", async ({ page }) => {
    await installMockRealtimeBootReload(page);
    let fullRequestCount = 0;
    let capturedColumnFilters = "";
    let capturedSort = "";
    await page.addInitScript(() => {
      const currentState = window.history.state ?? {};
      window.history.replaceState(
        {
          ...currentState,
          usr: {
            listViewState: {
              landingPageKey: "line-a-901",
              page: 1,
              pageSize: 25,
              columnFilterState: {
                previousMachine: { textQuery: "MB17" },
              },
              columnSortRules: [
                { key: "estimatedHours", direction: "desc", type: "number" },
              ],
            },
          },
        },
        "",
        window.location.href
      );
    });
    await page.route("**/api/forms/901/reports/full**", async (route) => {
      fullRequestCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [],
          meta: { formId: "901", count: 0, cacheSource: "sqlite", cacheState: "fresh" },
        }),
      });
    });
    await page.route("**/api/forms/901/reports?**", async (route) => {
      const url = new URL(route.request().url());
      capturedColumnFilters = url.searchParams.get("columnFilters") ?? "";
      capturedSort = url.searchParams.get("sort") ?? "";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [
            {
              id: "precise-filter-entry",
              workOrderNo: "WO-PRECISE",
              prodType: "PA",
              status: "未結案",
              startSchedule: "Yes",
              customerPartNo: "PART-001",
              erpPartNo: "PART-001",
              previousMachine: "MB17",
              estimatedHours: "8.3",
            },
          ],
          meta: {
            formId: "901",
            count: 1,
            totalCount: 1,
            hasMore: false,
            limit: 25,
            offset: 0,
            keyword: "",
            cacheSource: "sqlite",
            cacheState: "fresh",
            snapshotAt: "2026-08-19T00:00:00.000Z",
          },
        }),
      });
    });

    await page.goto(
      "/?page=1&pageSize=25&landingPage=line-a-901&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes"
    );
    await expect(page.locator(".ragic-table tbody tr.ant-table-row").first()).toContainText(
      "WO-PRECISE"
    );

    expect(fullRequestCount).toBe(0);
    expect(JSON.parse(capturedColumnFilters)).toEqual({
      previousMachine: { type: "text", textQuery: "MB17" },
    });
    expect(capturedSort).toBe("estimatedHours:desc");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = window.localStorage.getItem("work-report:frontend-event-log:v1");
          const entries = raw ? JSON.parse(raw) : [];
          return entries.find(
            (entry: { action?: string; phase?: string }) =>
              entry.action === "list-preview-read" && entry.phase === "completed"
          ) ?? null;
        })
      )
      .toMatchObject({
        action: "list-preview-read",
        category: "api",
        phase: "completed",
        meta: {
          mode: "foreground",
          recordCount: 1,
          cacheSource: "sqlite",
        },
      });
  });

  test("切換固定分類會清除舊條件，排序快捷視圖保留目前固定分類", async ({ page }) => {
    await installMockRealtimeBootReload(page);
    const foregroundQueries: Array<{
      status: string | null;
      sort: string | null;
      machineCode: string | null;
      selectedMachines: string[];
      previousMachineQuery: string | null;
      workOrderKeyword: string | null;
    }> = [];
    await page.addInitScript(() => {
      const currentState = window.history.state ?? {};
      window.history.replaceState(
        {
          ...currentState,
          usr: {
            listViewState: {
              landingPageKey: "line-b-902",
              page: 1,
              pageSize: 25,
              columnFilterState: {
                filterMachineCode: { selectedTokens: ["MB41", "PA"] },
                previousMachine: { textQuery: "MB17" },
              },
            },
          },
        },
        "",
        window.location.href
      );
    });
    await page.route("**/api/forms/902/reports/facets**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            status: [
              { token: "未結案", count: 2 },
              { token: "已結案", count: 2 },
            ],
            filterMachineCode: [
              { token: "MB41", count: 1 },
              { token: "PA", count: 1 },
              { token: "MA22", count: 1 },
            ],
          },
          meta: {
            formId: "902",
            fields: ["status", "filterMachineCode"],
            cacheSource: "sqlite",
            cacheState: "fresh",
            snapshotAt: "2026-09-03T00:00:00.000Z",
          },
        }),
      });
    });
    await page.route("**/api/forms/902/reports?**", async (route) => {
      const url = new URL(route.request().url());
      const rawColumnFilters = url.searchParams.get("columnFilters");
      const columnFilters = rawColumnFilters
        ? (JSON.parse(rawColumnFilters) as {
          filterMachineCode?: { selectedTokens?: string[] };
          previousMachine?: { textQuery?: string };
          })
        : {};
      const rawFilterGroup = url.searchParams.get("filterGroup");
      const filterConditions = rawFilterGroup
        ? ((JSON.parse(rawFilterGroup) as {
            conditions?: Array<{ field?: string; values?: string[] }>;
          }).conditions ?? [])
        : [];
      const conditionValue = (field: string) =>
        filterConditions.find((condition) => condition.field === field)?.values?.[0] ?? null;
      const selectedMachines = columnFilters.filterMachineCode?.selectedTokens ?? [];
      const status = url.searchParams.get("status") ?? conditionValue("status");
      const sort = url.searchParams.get("sort");
      const machineCode =
        url.searchParams.get("filterMachineCode") ?? conditionValue("machineCode");
      const previousMachineQuery = columnFilters.previousMachine?.textQuery ?? null;
      const workOrderKeyword =
        url.searchParams.get("workOrderKeyword") ?? conditionValue("workOrderNo");
      foregroundQueries.push({
        status,
        sort,
        machineCode,
        selectedMachines,
        previousMachineQuery,
        workOrderKeyword,
      });
      const returnedMachines = selectedMachines.length > 0
        ? selectedMachines
        : machineCode
          ? [machineCode]
          : ["MB41", "PA", "MA22"];

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: returnedMachines.map((machineCode, index) => ({
            id: `${status ?? "all"}-${machineCode}-${index}`,
            workOrderNo: `KEEP-${machineCode}`,
            machineCode: `UPSTREAM-${machineCode}`,
            filterMachineCode: machineCode,
            previousMachine: "MB17",
            status: status ?? "未結案",
            customerPartNo: "PART-001",
            erpPartNo: "PART-001",
            reports: [],
          })),
          meta: {
            formId: "902",
            count: returnedMachines.length,
            totalCount: returnedMachines.length,
            hasMore: false,
            limit: 25,
            offset: 0,
            cacheSource: "sqlite",
            cacheState: "fresh",
            snapshotAt: "2026-09-03T00:00:00.000Z",
          },
        }),
      });
    });

    await page.goto(
      "/?page=1&pageSize=25&landingPage=line-b-902&topView=report&fWorkOrder=KEEP"
    );
    await dismissSystemNoticeIfPresent(page);
    await expect
      .poll(() =>
        foregroundQueries.some(
          (query) =>
            query.selectedMachines.join(",") === "MB41,PA" &&
            query.previousMachineQuery === "MB17" &&
            query.workOrderKeyword === "KEEP"
        )
      )
      .toBe(true);
    await page.locator(".workspace-filter-btn").click();
    await expect(
      page.locator(".filter-active-chip", { hasText: "MB41、PA" })
    ).toBeVisible();

    const finishedPreset = page.locator(".fixed-filter-item", {
      hasText: /(已結案工令單|Closed)/,
    }).first();
    await finishedPreset.click();
    await expect
      .poll(() =>
        foregroundQueries.some(
          (query) =>
            query.status === "已結案" &&
            query.selectedMachines.length === 0 &&
            query.previousMachineQuery === null &&
            query.workOrderKeyword === null
        )
      )
      .toBe(true);
    await expect(
      page.locator(".filter-active-chip", { hasText: "MB41、PA" })
    ).toHaveCount(0);
    await expect(
      page.locator(".work-report-filter-panel .filter-active-chip", { hasText: "已結案" })
    ).toContainText(/(工令狀態|Work Order Status)/);

    await page.getByRole("button", { name: /(依最後修改時間排序|Sort by Last Updated)/ }).click();
    await expect
      .poll(() =>
        foregroundQueries.some(
          (query) =>
            query.sort?.startsWith("lastUpdatedAt:desc") === true &&
            query.status === "已結案" &&
            query.selectedMachines.length === 0 &&
            query.previousMachineQuery === null &&
            query.workOrderKeyword === null
        )
      )
      .toBe(true);
    await expect(page.locator(".ragic-table tbody")).toContainText("MA22");

    await page.locator(".fixed-filter-item--machine", { hasText: /^MB07/ }).click();
    await expect
      .poll(() =>
        foregroundQueries.some(
          (query) =>
            query.machineCode === "MB07" &&
            query.selectedMachines.length === 0 &&
            query.previousMachineQuery === null &&
            query.workOrderKeyword === null
        )
      )
      .toBe(true);
    await expect(page.locator(".ragic-table tbody")).toContainText("MB07");

    await page.reload();
    await dismissSystemNoticeIfPresent(page);
    await expect
      .poll(() =>
        foregroundQueries.some(
          (query) =>
            query.machineCode === "MB07" &&
            query.selectedMachines.join(",") === "MB41,PA"
        )
      )
      .toBe(true);
    await page.locator(".workspace-filter-btn").click();
    const filterPanel = page.locator(".work-report-filter-panel");
    await expect(
      filterPanel.locator(".filter-active-chip", { hasText: "MB41、PA" })
    ).toBeVisible();
    const queryCountBeforeApply = foregroundQueries.length;
    await filterPanel.getByRole("button", { name: /(套用篩選|Apply Filters)/ }).click();
    await expect
      .poll(() =>
        foregroundQueries
          .slice(queryCountBeforeApply)
          .some(
            (query) => query.machineCode === "MB07" && query.selectedMachines.length === 0
          )
      )
      .toBe(true);
  });

  test("明細 intent 會預載 chunk，返回列表先顯示 route cache 再背景重查", async ({ page }) => {
    await installMockRealtimeBootReload(page);
    let detailModuleRequested = false;
    let currentListRequestCount = 0;
    let delayReturnRevalidation = false;
    let markReturnRevalidationStarted: (() => void) | null = null;
    let releaseReturnRevalidation: (() => void) | null = null;
    const returnRevalidationStarted = new Promise<void>((resolve) => {
      markReturnRevalidationStarted = resolve;
    });
    const returnRevalidationReleased = new Promise<void>((resolve) => {
      releaseReturnRevalidation = resolve;
    });
    page.on("request", (request) => {
      if (request.url().includes("/src/features/work-report/pages/WorkReportDetailPage.tsx")) {
        detailModuleRequested = true;
      }
    });
    await page.route("**/api/forms/901/reports?**", async (route) => {
      const url = new URL(route.request().url());
      const isCurrentView =
        url.searchParams.get("status") === "未結案" &&
        url.searchParams.get("startSchedule") === "yes";
      if (isCurrentView) {
        currentListRequestCount += 1;
        if (delayReturnRevalidation) {
          delayReturnRevalidation = false;
          markReturnRevalidationStarted?.();
          await returnRevalidationReleased;
        }
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [
            {
              id: "cache-entry",
              workOrderNo: "WO-CACHE-RETURN",
              status: "未結案",
              customerPartNo: "PART-CACHE",
              erpPartNo: "PART-CACHE",
              startSchedule: "Yes",
            },
          ],
          meta: {
            formId: "901",
            count: 1,
            totalCount: 1,
            hasMore: false,
            limit: 25,
            offset: 0,
            keyword: "",
            cacheSource: "sqlite",
            cacheState: "fresh",
            snapshotAt: "2026-08-19T00:00:00.000Z",
          },
        }),
      });
    });
    await page.route("**/api/forms/901/reports/cache-entry", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            id: "cache-entry",
            workOrderNo: "WO-CACHE-RETURN",
            status: "未結案",
            customerPartNo: "PART-CACHE",
            erpPartNo: "PART-CACHE",
            reports: [],
          },
          meta: {
            cacheSource: "sqlite",
            cacheState: "fresh",
            snapshotAt: "2026-08-19T00:00:00.000Z",
          },
        }),
      });
    });
    await page.route("**/api/forms/901/options**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { machineId: [], operatorId: [], processCode: [] },
          meta: { formId: "901", fields: ["machineId", "operatorId", "processCode"] },
        }),
      });
    });
    await page.route("**/api/forms/901/reports/cache-entry/editing-presence**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            hasOtherEditors: false,
            otherEditorCount: 0,
            observedAt: "2026-08-19T00:00:00.000Z",
            canEdit: true,
            isCurrentSessionOwner: false,
          },
        }),
      });
    });

    await page.goto(
      "/?page=1&pageSize=25&landingPage=line-a-901&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes"
    );
    const row = page.locator(".ragic-table tbody tr.ant-table-row").first();
    await expect(row).toContainText("WO-CACHE-RETURN");
    await row.hover();
    await expect.poll(() => detailModuleRequested).toBe(true);
    const initialCurrentRequestCount = currentListRequestCount;

    await row.locator(".work-order-cell-button").click();
    await expect(page).toHaveURL(/\/reports\/901\/cache-entry/);
    delayReturnRevalidation = true;
    await page.getByRole("button", { name: /(返回工令列表|Back)/ }).click();

    await expect(page).toHaveURL(/\/$|\/?page=/);
    await expect(page.locator(".ragic-table tbody tr.ant-table-row").first()).toContainText(
      "WO-CACHE-RETURN"
    );
    await returnRevalidationStarted;
    expect(currentListRequestCount).toBeGreaterThanOrEqual(initialCurrentRequestCount + 1);
    expect(currentListRequestCount).toBeLessThanOrEqual(initialCurrentRequestCount + 2);

    releaseReturnRevalidation?.();
    await page.waitForTimeout(100);
    expect(currentListRequestCount).toBeLessThanOrEqual(initialCurrentRequestCount + 2);
  });

  test("背景 preview 被前景換頁取代後會結束 indicator，後續背景失敗保留 stale 資料並顯示警示", async ({
    page,
  }) => {
    await installMockRealtimeBootReload(page);
    let delayCurrentPageBackground = false;
    let failNextPageBackground = false;
    let markDelayedBackgroundStarted: (() => void) | null = null;
    let releaseDelayedBackground: (() => void) | null = null;
    let nextPageRequestCount = 0;
    const delayedBackgroundStarted = new Promise<void>((resolve) => {
      markDelayedBackgroundStarted = resolve;
    });
    const delayedBackgroundReleased = new Promise<void>((resolve) => {
      releaseDelayedBackground = resolve;
    });

    await page.route("**/api/forms/901/reports?**", async (route) => {
      const requestUrl = new URL(route.request().url());
      const offset = Number(requestUrl.searchParams.get("offset") ?? "0");
      const isCurrentView =
        requestUrl.searchParams.get("status") === "未結案" &&
        requestUrl.searchParams.get("startSchedule") === "yes";
      if (!isCurrentView) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: [],
            meta: {
              formId: "901",
              count: 0,
              totalCount: 0,
              hasMore: false,
              limit: 25,
              offset,
              keyword: "",
            },
          }),
        });
        return;
      }

      if (offset === 0 && delayCurrentPageBackground) {
        delayCurrentPageBackground = false;
        markDelayedBackgroundStarted?.();
        await delayedBackgroundReleased;
      }
      if (offset === 25) {
        nextPageRequestCount += 1;
        if (failNextPageBackground) {
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              error: {
                code: "TEST_BACKGROUND_REFRESH_FAILED",
                message: "background preview failed",
              },
            }),
          });
          return;
        }
      }

      const isFirstPage = offset === 0;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [
            {
              id: isFirstPage ? "preview-page-1" : "preview-page-2",
              workOrderNo: isFirstPage ? "WO-PREVIEW-PAGE-1" : "WO-PREVIEW-PAGE-2",
              prodType: "PA",
              status: "未結案",
              startSchedule: "Yes",
              customerPartNo: "PART-PREVIEW",
              erpPartNo: "PART-PREVIEW",
            },
          ],
          meta: {
            formId: "901",
            count: 1,
            totalCount: 26,
            hasMore: isFirstPage,
            limit: 25,
            offset,
            keyword: "",
            cacheSource: "sqlite",
            cacheState: "fresh",
            snapshotAt: "2026-09-04T00:00:00.000Z",
          },
        }),
      });
    });

    await page.goto(
      "/?page=1&pageSize=25&landingPage=line-a-901&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes"
    );
    await dismissSystemNoticeIfPresent(page);
    await expect(page.locator(".ragic-table tbody")).toContainText("WO-PREVIEW-PAGE-1");

    delayCurrentPageBackground = true;
    await expect
      .poll(() =>
        page.evaluate(() => {
          const globalWindow = window as typeof window & {
            __emitMockRealtimeLifecycle?: (
              eventName: string,
              payload: Record<string, unknown>
            ) => boolean;
          };
          return globalWindow.__emitMockRealtimeLifecycle?.("work-report-event", {
            id: "background-overlap-e2e",
            type: "work-report-form-updated",
            occurredAt: new Date().toISOString(),
            formId: "901",
          })
            ? 1
            : 0;
        })
      )
      .toBe(1);
    await delayedBackgroundStarted;
    await expect(page.locator(".system-notice-inline-status-pill .loading-spinner")).toBeVisible();
    await expect(page.locator(".table-wrap")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator(".table-soft-busy-overlay")).toHaveCount(0);
    await expect(page.locator(".status-summary-strip")).toContainText(
      /正在確認最新資料|Checking for newer data/
    );
    await expect(page.locator(".status-summary-strip")).not.toContainText(
      /正在載入資料|Loading data/
    );

    const nextPageButton = page.locator(".workspace-pager button").last();
    await expect(nextPageButton).toBeEnabled();
    await nextPageButton.click();
    await expect(page.locator(".ragic-table tbody")).toContainText("WO-PREVIEW-PAGE-2");
    await expect(page.locator(".system-notice-inline-status-pill .loading-spinner")).toHaveCount(0);

    releaseDelayedBackground?.();
    await expect(page.locator(".system-notice-inline-status-pill .loading-spinner")).toHaveCount(0);

    const requestsBeforeFailure = nextPageRequestCount;
    failNextPageBackground = true;
    await page.evaluate(() => {
      const globalWindow = window as typeof window & {
        __emitMockRealtimeLifecycle?: (
          eventName: string,
          payload: Record<string, unknown>
        ) => boolean;
      };
      globalWindow.__emitMockRealtimeLifecycle?.("work-report-event", {
        id: "background-failure-e2e",
        type: "work-report-form-updated",
        occurredAt: new Date().toISOString(),
        formId: "901",
      });
    });

    await expect.poll(() => nextPageRequestCount).toBeGreaterThan(requestsBeforeFailure);
    await expect(page.locator(".ragic-table tbody")).toContainText("WO-PREVIEW-PAGE-2");
    await expect(page.getByText(/最新資料確認失敗|Latest data check failed/).first()).toBeVisible();
    await expect(page.locator(".table-wrap")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator(".system-notice-inline-status-pill .loading-spinner")).toHaveCount(0);
  });

  test("固定篩選失效後重新預載，命中 cache 時不鎖側欄且相同 query 只送一次", async ({ page }) => {
    await installMockRealtimeBootReload(page);
    let finishedRequestCount = 0;
    let markFinishedPrefetched: (() => void) | null = null;
    let markFinishedRevalidateStarted: (() => void) | null = null;
    let releaseFinishedRevalidate: (() => void) | null = null;
    const finishedPrefetched = new Promise<void>((resolve) => {
      markFinishedPrefetched = resolve;
    });
    const finishedRevalidateStarted = new Promise<void>((resolve) => {
      markFinishedRevalidateStarted = resolve;
    });
    const finishedRevalidateReleased = new Promise<void>((resolve) => {
      releaseFinishedRevalidate = resolve;
    });

    await page.route("**/api/forms/901/reports?**", async (route) => {
      const requestUrl = new URL(route.request().url());
      const status = requestUrl.searchParams.get("status");
      const isFinishedView = status === "已結案";
      if (isFinishedView) {
        finishedRequestCount += 1;
        if (finishedRequestCount === 1) {
          markFinishedPrefetched?.();
        } else {
          markFinishedRevalidateStarted?.();
          await finishedRevalidateReleased;
        }
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [
            {
              id: isFinishedView ? "finished-cached" : "unfinished-current",
              workOrderNo: isFinishedView ? "WO-FINISHED-CACHED" : "WO-UNFINISHED-CURRENT",
              prodType: "PA",
              status: isFinishedView ? "已結案" : "未結案",
              customerPartNo: "PART-001",
              erpPartNo: "PART-001",
            },
          ],
          meta: {
            formId: "901",
            count: 1,
            totalCount: 1,
            hasMore: false,
            limit: 25,
            offset: 0,
            keyword: "",
          },
        }),
      });
    });

    await page.goto(
      "/?page=1&pageSize=25&landingPage=line-a-901&topView=report"
    );
    await dismissSystemNoticeIfPresent(page);
    await expect(page.locator(".ragic-table tbody tr.ant-table-row").first()).toContainText(
      "WO-UNFINISHED-CURRENT"
    );
    await finishedPrefetched;

    await expect
      .poll(() =>
        page.evaluate(() => {
          const globalWindow = window as typeof window & {
            __mockEventSourceInstances?: Array<EventTarget & { readyState?: number }>;
          };
          const activeInstances = (globalWindow.__mockEventSourceInstances ?? []).filter(
            (instance) => instance.readyState === 1
          );
          for (const instance of activeInstances) {
            instance.dispatchEvent(
              new MessageEvent("work-report-event", {
                data: JSON.stringify({
                  id: "cache-invalidation-e2e",
                  type: "work-report-form-updated",
                  occurredAt: new Date().toISOString(),
                  formId: "901",
                }),
              })
            );
          }
          return activeInstances.length;
        })
      )
      .toBeGreaterThan(1);
    await page.waitForTimeout(1_800);
    expect(finishedRequestCount).toBe(1);

    const finishedPreset = page.locator(".fixed-filter-item", {
      hasText: /(已結案工令單|Closed)/,
    }).first();
    await finishedPreset.click();
    await finishedRevalidateStarted;

    await expect(page.locator(".ragic-table tbody tr.ant-table-row").first()).toContainText(
      "WO-FINISHED-CACHED"
    );
    await expect(page.locator(".table-soft-busy-overlay")).toHaveCount(0);
    await expect(finishedPreset).not.toBeDisabled();

    await finishedPreset.click();
    await page.waitForTimeout(100);
    expect(finishedRequestCount).toBe(2);

    releaseFinishedRevalidate?.();
    await expect.poll(() => finishedRequestCount).toBe(2);
  });

  test("未套用的空白草稿在明細返回後會還原為已套用條件", async ({ page }) => {
    await page.goto(
      "/?page=1&pageSize=25&landingPage=line-a-901&topView=report"
    );
    await dismissSystemNoticeIfPresent(page);

    const filterButton = page.locator(".workspace-filter-btn");
    await filterButton.click();
    const panel = page.locator(".work-report-filter-panel");
    await panel.getByRole("button", { name: /新增條件|Add condition/i }).click();
    const conditionRow = panel.locator(".custom-filter-condition-row").first();
    await chooseConditionSelectOption(
      page,
      conditionRow,
      ".custom-filter-field-select",
      /(工令單號|Work Order No\.)/
    );
    await chooseConditionSelectOption(
      page,
      conditionRow,
      ".custom-filter-operator-select",
      /(有值|Has a value)/
    );
    await panel.getByRole("button", { name: /(套用篩選|Apply Filters)/ }).click();
    await expect(filterButton.locator(".filter-count-badge")).toHaveText("1");

    await filterButton.click();
    const appliedConditionRow = panel.locator(".custom-filter-condition-row").first();
    await appliedConditionRow.locator(".custom-filter-remove-condition").click();
    await expect(panel.locator(".custom-filter-condition-row")).toHaveCount(0);
    await expect(filterButton.locator(".filter-draft-badge")).toContainText(
      /(未套用|Not Applied)/
    );

    await page.locator(".ragic-table .work-order-cell-button").first().click({ force: true });
    await page.getByRole("button", { name: /(返回工令列表|Back)/ }).click();

    await filterButton.click();
    await expect(page.locator(".work-report-filter-panel .custom-filter-condition-row")).toHaveCount(1);
    await expect(filterButton.locator(".filter-draft-badge")).toHaveCount(0);
  });

  test("今日修改快速檢視跨過本地午夜後會自動改查新日期", async ({ page }) => {
    const requestedRanges: Array<{ from: string; to: string }> = [];
    page.on("request", (request) => {
      const requestUrl = new URL(request.url());
      if (
        request.method() === "GET" &&
        requestUrl.pathname === "/api/forms/901/reports" &&
        requestUrl.searchParams.has("updatedDateFrom") &&
        requestUrl.searchParams.has("updatedDateTo")
      ) {
        requestedRanges.push({
          from: requestUrl.searchParams.get("updatedDateFrom") ?? "",
          to: requestUrl.searchParams.get("updatedDateTo") ?? "",
        });
      }
    });

    await page.clock.install({ time: new Date("2026-08-10T15:59:58.000Z") });
    await page.goto(
      "/?page=1&pageSize=25&landingPage=line-a-901&topView=report"
    );
    await dismissSystemNoticeIfPresent(page);
    await page.getByRole("button", { name: /(今日修改工令單|Modified Today)/ }).click();

    await expect
      .poll(() => requestedRanges.at(-1))
      .toEqual({
        from: "2026-08-09T16:00:00.000Z",
        to: "2026-08-10T15:59:59.999Z",
      });

    await page.clock.fastForward(3_000);
    await expect
      .poll(() => requestedRanges.at(-1))
      .toEqual({
        from: "2026-08-10T16:00:00.000Z",
        to: "2026-08-11T15:59:59.999Z",
      });
  });

  test("列表欄位版面可調色、排序、隱藏、還原並適應窄螢幕", async ({ page }) => {
    await page.goto(
      "/?page=1&pageSize=25&landingPage=line-a-901&topView=report"
    );
    await dismissSystemNoticeIfPresent(page);

    const displayMode = page.locator(".workspace-display-mode");
    await expect(
      displayMode.getByRole("button", { name: /^完整$|^Full$/ })
    ).toHaveClass(/is-active/);

    await page.getByRole("button", { name: /^(欄位|Columns)$/ }).click();
    const drawer = page.locator(".work-report-column-settings-drawer");
    await expect(drawer).toBeVisible();
    const sortOrderRow = drawer.locator('[data-column-key="sortOrder"]');
    await sortOrderRow.locator(".work-report-column-color-trigger").click();
    await page.getByRole("button", { name: /(柔黃|Soft Amber)/ }).click();

    await expect(
      page.locator(".ragic-table td.work-report-column-tone--amber-soft").first()
    ).toBeVisible();
    await expect(
      page.locator(".ragic-table th.work-report-column-tone--amber-soft").first()
    ).toHaveCSS("background-color", "rgb(255, 245, 199)");
    const storedLayout = await page.evaluate(() => {
      const raw = window.localStorage.getItem(
        "work-report:901:table-layout:fit:v2"
      );
      return raw ? JSON.parse(raw) : null;
    });
    expect(storedLayout?.version).toBe(2);
    expect(storedLayout?.columnColors?.sortOrder).toBe("amber-soft");

    const initialSortOrderIndex = storedLayout.columnOrder.indexOf("sortOrder");
    await sortOrderRow
      .locator(".work-report-column-settings-move-actions button")
      .first()
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = window.localStorage.getItem(
            "work-report:901:table-layout:fit:v2"
          );
          const layout = raw ? JSON.parse(raw) : null;
          return layout?.columnOrder?.indexOf("sortOrder") ?? -1;
        })
      )
      .toBe(initialSortOrderIndex - 1);

    await sortOrderRow.getByRole("checkbox").uncheck();
    await expect(page.locator(".work-report-sort-order-edit-btn")).toHaveCount(0);
    await drawer
      .getByRole("button", { name: /(還原預設|Reset Default)/ })
      .click();
    await expect(sortOrderRow.getByRole("checkbox")).toBeChecked();
    await expect(
      page.locator(".ragic-table td.work-report-column-tone--amber-soft")
    ).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.localStorage.getItem(
            "work-report:901:table-layout:fit:v2"
          )
        )
      )
      .toBeNull();

    await page.setViewportSize({ width: 390, height: 800 });
    await expect
      .poll(() =>
        drawer.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return rect.left >= 0 && rect.right <= 390;
        })
      )
      .toBe(true);
  });

  test("列表排序碼快速連點只送一筆 task，重載後仍會依 terminal task 回讀", async ({ page }) => {
    let capturedSortOrder: unknown = null;
    let capturedMutationId = "";
    let capturedEntryId = "";
    let sortOrderRequestCount = 0;
    let entryRefreshCount = 0;
    let strictEntryRefreshCount = 0;
    let listReloadAfterSuccessCount = 0;
    let allowTaskSuccess = false;
    await page.route("**/api/forms/901/reports/*/sort-order", async (route) => {
      if (route.request().method() !== "PUT") {
        await route.fallback();
        return;
      }
      sortOrderRequestCount += 1;
      capturedSortOrder = route.request().postDataJSON();
      capturedMutationId =
        route.request().headers()["x-client-mutation-id"] ?? "";
      capturedEntryId = new URL(route.request().url()).pathname.split("/").at(-2) ?? "";
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            taskId: "sort-order-e2e",
            status: "pending",
            createdAt: "2026-08-04T00:00:00.000Z",
          },
          meta: { accepted: true },
        }),
      });
    });
    await page.route("**/api/forms/901/reports/**", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (
        route.request().method() !== "GET" ||
        requestUrl.searchParams.get("refresh") !== "1" ||
        requestUrl.pathname.includes("/tasks/")
      ) {
        await route.fallback();
        return;
      }
      entryRefreshCount += 1;
      if (requestUrl.searchParams.get("strictRefresh") === "1") {
        strictEntryRefreshCount += 1;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            id: capturedEntryId,
            workOrderNo: "DEMO-040537",
            status: "未結案",
            sortOrder: 7,
            lastUpdatedAt: "2026-09-03T02:00:02.000Z",
          },
        }),
      });
    });
    await page.route("**/api/forms/901/reports?**", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      if (allowTaskSuccess) {
        listReloadAfterSuccessCount += 1;
      }
      const readModelCaughtUp =
        allowTaskSuccess && listReloadAfterSuccessCount >= 3;
      const settledSortOrder = readModelCaughtUp ? 7 : 5;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [
            {
              id: "90002",
              workOrderNo: "DEMO-040537",
              prodType: "PA",
              machineCode: "MA05",
              status: "未結案",
              startSchedule: "Yes",
              customerPartNo: "PART-001",
              erpPartNo: "PART-001",
              sortOrder: settledSortOrder,
              lastUpdatedAt: readModelCaughtUp
                ? "2026-09-03T02:00:02.000Z"
                : "2026-09-03T02:00:01.000Z",
              reports: [],
            },
          ],
          meta: {
            formId: "901",
            count: 1,
            totalCount: 1,
            hasMore: false,
            limit: 25,
            offset: 0,
            cacheSource: "sqlite",
            cacheState: "fresh",
            snapshotAt: "2026-09-03T00:00:00.000Z",
          },
        }),
      });
    });
    await page.route(
      "**/api/forms/901/reports/tasks/sort-order-e2e",
      async (route) => {
        const status = allowTaskSuccess ? "success" : "pending";
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              taskId: "sort-order-e2e",
              taskType: "update-report",
              formId: "901",
              entryId: capturedEntryId || "90002",
              queueKey: `901:${capturedEntryId || "90002"}`,
              status,
              createdAt: "2026-08-04T00:00:00.000Z",
              updatedAt: allowTaskSuccess
                ? "2026-08-04T00:00:01.000Z"
                : "2026-08-04T00:00:00.500Z",
              ...(allowTaskSuccess ? { result: {} } : {}),
            },
          }),
        });
      }
    );

    await page.goto(
      "/?page=1&pageSize=25&landingPage=line-a-901&topView=report"
    );
    await dismissSystemNoticeIfPresent(page);
    const editButton = page.locator(".work-report-sort-order-edit-btn").first();
    await expect(editButton).toBeVisible();
    await editButton.click();
    const editor = page.locator(".work-report-sort-order-editor");
    await editor.locator('input[type="number"]').fill("7");
    await editor
      .getByRole("button", { name: /(儲存|Save)/ })
      .evaluate((button) => {
        button.click();
        button.click();
      });

    await expect.poll(() => capturedSortOrder).toEqual({ sortOrder: 7, expectedSortOrder: 5 });
    expect(sortOrderRequestCount).toBe(1);
    expect(capturedMutationId).not.toBe("");
    await expect(editor).toBeHidden();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = window.localStorage.getItem("work-reports:task-monitor");
          const monitors = raw ? JSON.parse(raw) : [];
          return monitors.some(
            (monitor: { taskId?: string; status?: string }) =>
              monitor.taskId === "sort-order-e2e" && monitor.status === "pending"
          );
        })
      )
      .toBe(true);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = window.localStorage.getItem(
            "work-report:sort-order-retry-store:v1"
          );
          const records = raw ? Object.values(JSON.parse(raw)) : [];
          return records.some(
            (record) =>
              typeof record === "object" &&
              record !== null &&
              "taskId" in record &&
              record.taskId === "sort-order-e2e"
          );
        })
      )
      .toBe(true);

    allowTaskSuccess = true;
    await page.reload();
    await dismissSystemNoticeIfPresent(page);
    await expect.poll(() => entryRefreshCount).toBe(1);
    expect(strictEntryRefreshCount).toBe(1);
    await expect.poll(() => listReloadAfterSuccessCount).toBeGreaterThanOrEqual(2);
    await expect(
      page.locator(".work-report-sort-order-value").first()
    ).toHaveText("7");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = window.localStorage.getItem(
            "work-report:sort-order-retry-store:v1"
          );
          const records = raw ? Object.values(JSON.parse(raw)) : [];
          return records.some(
            (record) =>
              typeof record === "object" &&
              record !== null &&
              "taskId" in record &&
              record.taskId === "sort-order-e2e"
          );
        })
      )
      .toBe(false);
  });

  test("機台篩選中的工令改到其他機台後立即離開並重查目前列表", async ({ page }) => {
    let allowTaskSuccess = false;
    let selectedMachineReloadAfterSuccessCount = 0;
    let strictEntryRefreshCount = 0;

    await page.route("**/api/forms/901/options**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            machineId: [
              { value: "MA01", label: "MA01", display: "MA01" },
              { value: "MA02", label: "MA02", display: "MA02" },
            ],
          },
          meta: { formId: "901", fields: ["machineId"] },
        }),
      });
    });
    await page.route("**/api/forms/901/reports/*/main-machine**", async (route) => {
      if (route.request().method() !== "PUT") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            taskId: "main-machine-filter-e2e",
            status: "pending",
            createdAt: "2026-09-03T02:00:00.000Z",
          },
          meta: { accepted: true },
        }),
      });
    });
    await page.route(
      "**/api/forms/901/reports/tasks/main-machine-filter-e2e",
      async (route) => {
        const status = allowTaskSuccess ? "success" : "pending";
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              taskId: "main-machine-filter-e2e",
              taskType: "update-report",
              formId: "901",
              entryId: "machine-filter-entry",
              queueKey: "901:machine-filter-entry",
              status,
              createdAt: "2026-09-03T02:00:00.000Z",
              updatedAt: allowTaskSuccess
                ? "2026-09-03T02:00:02.000Z"
                : "2026-09-03T02:00:01.000Z",
              ...(allowTaskSuccess ? { result: {} } : {}),
            },
          }),
        });
      }
    );
    await page.route("**/api/forms/901/reports/**", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (
        route.request().method() !== "GET" ||
        requestUrl.searchParams.get("refresh") !== "1" ||
        requestUrl.pathname.includes("/tasks/")
      ) {
        await route.fallback();
        return;
      }
      if (requestUrl.searchParams.get("strictRefresh") === "1") {
        strictEntryRefreshCount += 1;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            id: "machine-filter-entry",
            workOrderNo: "WO-MACHINE-FILTER",
            prodType: "PA",
            machineCode: "MA02",
            status: "未結案",
            startSchedule: "Yes",
            lastUpdatedAt: "2026-09-03T02:00:02.000Z",
            reports: [],
          },
        }),
      });
    });
    await page.route("**/api/forms/901/reports?**", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      const requestUrl = new URL(route.request().url());
      const selectedMachine = requestUrl.searchParams.get("machineCode");
      if (allowTaskSuccess && selectedMachine === "MA01") {
        selectedMachineReloadAfterSuccessCount += 1;
      }
      const includeRecord = selectedMachine === "MA01" && !allowTaskSuccess;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: includeRecord
            ? [
                {
                  id: "machine-filter-entry",
                  workOrderNo: "WO-MACHINE-FILTER",
                  prodType: "PA",
                  machineCode: "MA01",
                  status: "未結案",
                  startSchedule: "Yes",
                  lastUpdatedAt: "2026-09-03T02:00:01.000Z",
                  reports: [],
                },
              ]
            : [],
          meta: {
            formId: "901",
            count: includeRecord ? 1 : 0,
            totalCount: includeRecord ? 1 : 0,
            hasMore: false,
            limit: 25,
            offset: 0,
            cacheSource: "sqlite",
            cacheState: "fresh",
            snapshotAt: "2026-09-03T02:00:00.000Z",
          },
        }),
      });
    });

    await page.goto(
      "/?page=1&pageSize=25&landingPage=line-a-901&topView=report&fMachine=MA01"
    );
    await dismissSystemNoticeIfPresent(page);
    await expect(page.getByText("WO-MACHINE-FILTER")).toBeVisible();

    await page.locator(".work-report-main-machine-edit-btn").first().click();
    const editor = page.locator(".work-report-main-machine-editor");
    await editor.locator("input").fill("MA02");
    await editor.getByRole("button", { name: /(儲存|Save)/ }).click();

    await expect(page.getByText("WO-MACHINE-FILTER")).toHaveCount(0);
    allowTaskSuccess = true;
    await expect.poll(() => strictEntryRefreshCount).toBe(1);
    await expect.poll(() => selectedMachineReloadAfterSuccessCount).toBeGreaterThanOrEqual(1);
    await expect(page.getByText("WO-MACHINE-FILTER")).toHaveCount(0);
  });

  test("refresh 按鈕需經二次確認，確認後才發送同步請求", async ({ page }) => {
    const now = new Date().toISOString();
    const mockedSyncTask = {
      taskId: "sync-refresh-confirmation-e2e",
      formId: "902",
      status: "running",
      accepted: true,
      triggeredBy: "toolbar-refresh",
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      scannedEntries: 25,
      syncedEntries: 0,
      syncedRows: 0,
      message: "已擷取 25 筆工令",
    };
    let mockedSyncPostCount = 0;
    let mockedSyncStatusCount = 0;
    await page.route(/\/api\/forms\/902\/sync(?:\?.*)?$/, async (route) => {
      mockedSyncPostCount += 1;
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          data: mockedSyncTask,
          meta: { formId: "902", accepted: true, async: true },
        }),
      });
    });
    await page.route(/\/api\/forms\/902\/sync\/status(?:\?.*)?$/, async (route) => {
      mockedSyncStatusCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: mockedSyncTask, meta: { formId: "902" } }),
      });
    });

    await page.goto(
      "/?page=1&pageSize=25&landingPage=line-b-902&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88"
    );
    await dismissSystemNoticeIfPresent(page);

    let syncRequestCount = 0;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().includes("/api/forms/902/sync")
      ) {
        syncRequestCount += 1;
      }
    });

    const refreshButton = page.getByRole("button", { name: /(重新整理|Refresh)/ }).first();
    await refreshButton.click();

    const confirmDialog = page.getByRole("dialog", {
      name: /(重新同步最新資料|Sync the latest data now)/i,
    });
    await expect(confirmDialog).toBeVisible();
    await expect(confirmDialog).toContainText(/重新同步最新資料|Sync the latest data now/i);
    await expect(confirmDialog).toContainText(
      /重新向 Ragic 抓取最新|re-fetch the latest work orders/i
    );

    await confirmDialog.getByRole("button", { name: /(先不要|Not Now)/ }).click();
    await page.waitForTimeout(500);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(syncRequestCount).toBe(0);

    const syncRequestPromise = page.waitForRequest(
      (request) =>
        request.method() === "POST" && request.url().includes("/api/forms/902/sync")
    );
    const syncStatusRequestPromise = page.waitForRequest(
      (request) =>
        request.method() === "GET" && request.url().includes("/api/forms/902/sync/status")
    );

    await refreshButton.click();
    await page.getByRole("dialog").getByRole("button", { name: /(確認開始|Start Sync)/ }).click();

    await syncRequestPromise;
    await syncStatusRequestPromise;
    const progressDialog = page.getByRole("dialog", {
      name: /(資料同步進度|Sync Progress)/,
    });
    await expect(progressDialog).toBeVisible();
    await expect(progressDialog).toContainText(/已擷取工令|Scanned Work Orders/i);
    expect(syncRequestCount).toBeGreaterThan(0);
    expect(mockedSyncPostCount).toBe(1);
    expect(mockedSyncStatusCount).toBeGreaterThan(0);
  });

  test("902 未結案工單 refresh 後保留 active preset", async ({ page }) => {
    await page.goto(
      "/?page=1&pageSize=25&landingPage=line-b-902&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88"
    );
    await dismissSystemNoticeIfPresent(page);

    const unfinishedButton = page.getByRole("button", {
      name: /(未結案工單|Open Work Orders)/,
    });
    await expect(unfinishedButton).toHaveClass(/is-active/);

    await page.reload();

    await expect(unfinishedButton).toHaveClass(/is-active/);
  });

  test("901 MA01 固定機台快捷 refresh 後保留 active 樣式", async ({ page }) => {
    await page.goto(
      "/?page=1&pageSize=25&landingPage=line-a-901&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=MA01"
    );
    await dismissSystemNoticeIfPresent(page);

    const machineShortcut = page.getByRole("button", {
      name: /(MA01未結案|MA01 Open)/,
    });
    await expect(machineShortcut).toHaveClass(/is-active/);

    await page.reload();

    await expect(machineShortcut).toHaveClass(/is-active/);
  });

  test("系統更新時，列表頁會自動重新載入", async ({ page }) => {
    await installMockRealtimeBootReload(page);
    await page.goto(
      "/?page=1&pageSize=25&landingPage=line-a-901&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=MA01"
    );
    await dismissSystemNoticeIfPresent(page);

    const navigationPromise = page.waitForNavigation({ waitUntil: "load" });
    await page.evaluate(() => {
      const globalWindow = window as typeof window & {
        __emitMockRealtimeLifecycle?: (eventName: string, payload: Record<string, unknown>) => boolean;
      };
      globalWindow.__emitMockRealtimeLifecycle?.("ready", {
        status: "ok",
        at: new Date().toISOString(),
        bootId: "boot-a",
        deployVersion: "deploy-a",
      });
      globalWindow.__emitMockRealtimeLifecycle?.("ping", {
        at: new Date().toISOString(),
        bootId: "boot-b",
        deployVersion: "deploy-b",
      });
    });

    await navigationPromise;
    await expect(
      page.getByText(
        /偵測到開發者已進行系統更新|A developer system update was detected/
      )
    ).toBeVisible();
  });

  test("901 / 902 左右切換後 active preset 穩定", async ({ page }) => {
    await page.goto(
      "/?page=1&pageSize=25&landingPage=line-b-902&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88"
    );
    await dismissSystemNoticeIfPresent(page);

    await page.getByRole("tab", { name: /(製程 A 報工|Process A)/ }).click();
    await expect(
      page.getByRole("button", { name: /(未結案可執行|Open Runnable)/ })
    ).toHaveClass(/is-active/);

    await page.getByRole("tab", { name: /(製程 B 報工|Process B)/ }).click();
    await expect(
      page.getByRole("button", { name: /(未結案工單|Open Work Orders)/ })
    ).toHaveClass(/is-active/);
  });

  test("返回列表後高亮對到剛剛進入的工令", async ({ page }) => {
    await page.goto(
      "/?page=1&pageSize=25&landingPage=line-b-902&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88"
    );
    await dismissSystemNoticeIfPresent(page);

    const targetRow = page.locator(".ragic-table .ant-table-tbody tr").nth(3);
    const workOrderButton = targetRow.locator(".work-order-cell-button").first();
    const workOrderNo = (await workOrderButton.textContent())?.trim() ?? "";

    await workOrderButton.click({ force: true });
    await page.getByRole("button", { name: /(返回工令列表|Back)/ }).click();

    const highlightedRow = page
      .locator(".ragic-table .ant-table-tbody tr", { hasText: workOrderNo })
      .first();
    await expect(highlightedRow).toHaveClass(/row-return-highlight/);
  });

  test("902 切到 901 後進明細，detail URL 不應保留舊 landingPage", async ({ page }) => {
    await page.goto(
      "/?page=1&pageSize=25&landingPage=line-b-902&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fFilterMachine=MB07"
    );
    await dismissSystemNoticeIfPresent(page);

    await page.getByRole("tab", { name: /(製程 A 報工|Process A)/ }).click();
    const workOrderButton = page.locator(".ragic-table .ant-table-tbody .work-order-cell-button").first();
    await workOrderButton.click({ force: true });

    await expect(page).toHaveURL(/\/reports\/901\//);
    await expect(page).toHaveURL(/landingPage=line-a-901/);
    await expect(page).not.toHaveURL(/landingPage=line-b-902/);
  });

  test("明細列雙擊後會進入整列 inline 編輯模式", async ({ page }) => {
    await page.goto(
      "/reports/901/90001?page=1&pageSize=25&landingPage=line-a-901&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=MA01"
    );

    const targetRow = page.locator(".detail-subtable tbody tr[data-row-id]").nth(0);
    await expect(targetRow).toBeVisible();

    await targetRow.dblclick({ force: true });

    await expect(targetRow.locator("[data-inline-editor-key='date']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='machineId']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='operatorId']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='processCode']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='inputOptions']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='shiftType']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='countSetupTimeFlag']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='setupTimeStandardHours']")).toHaveCount(0);
    await expect(targetRow.locator("[data-inline-editor-key='setupLossQtyPerPcs']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='processLossQtyPerPcs']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='totalContainerQty']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='containerUnit']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='plannedIdleMinutes']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='startTime']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='endTime']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='productionQty']")).toHaveCount(1);
    await expect(targetRow.getByRole("button", { name: /(儲存|Save)/ })).toBeVisible();
    await expect(targetRow.getByRole("button", { name: /(取消|Cancel)/ })).toBeVisible();
  });

  test("服務重啟後重新載入頁面時，會自動補送剛剛失敗的那筆 mutation", async ({ page }) => {
    const replayPayload = {
      kind: "update",
      formId: "901",
      entryId: "90001",
      rowId: "111762",
      payload: {
        date: "2026-03-16",
        machineId: "MA05",
        operatorId: "RA004",
        operatorName: "示範帳號",
        processCode: "A01",
        startTime: "08:00",
        endTime: "17:00",
        breakTime: "1",
        productionQty: 25,
      },
      clientMutationId: "replay-mutation-001",
      attempts: 0,
      createdAt: "2026-03-17T01:00:00.000Z",
    };

    await page.addInitScript(
      ([storageKey, payload]) => {
        window.sessionStorage.setItem(storageKey, JSON.stringify(payload));
      },
      [PENDING_MUTATION_REPLAY_STORAGE_KEY, replayPayload] as const
    );

    let replayRequestSeen = false;
    let replayMutationHeader = "";
    let taskPollCount = 0;

    await page.route("**/api/forms/901/reports/90001/111762?async=1", async (route) => {
      if (route.request().method() !== "PUT") {
        await route.fallback();
        return;
      }
      replayRequestSeen = true;
      replayMutationHeader = route.request().headers()["x-client-mutation-id"] ?? "";
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            taskId: "replay-task-001",
            status: "pending",
            createdAt: "2026-03-17T01:00:01.000Z",
          },
          meta: {
            formId: "901",
            entryId: "90001",
            rowId: "111762",
            accepted: true,
          },
        }),
      });
    });

    await page.route("**/api/forms/901/reports/tasks/replay-task-001", async (route) => {
      taskPollCount += 1;
      const status = taskPollCount < 2 ? "running" : "success";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            taskId: "replay-task-001",
            formId: "901",
            entryId: "90001",
            queueKey: "901:90001",
            status,
            createdAt: "2026-03-17T01:00:01.000Z",
            updatedAt: "2026-03-17T01:00:02.000Z",
            ...(status === "success" ? { result: { rowId: "111762" } } : {}),
          },
          meta: {
            formId: "901",
            taskId: "replay-task-001",
          },
        }),
      });
    });

    await page.goto(
      "/reports/901/90001?page=1&pageSize=25&landingPage=line-a-901&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=MA01"
    );

    await expect
      .poll(() => (replayRequestSeen ? "seen" : "pending"))
      .toBe("seen");
    expect(replayMutationHeader).toBe("replay-mutation-001");
    await expect(page.locator(".detail-system-status")).toContainText(
      /已完成更新報工明細|Report detail updated/i
    );
  });

  test("其他使用者更新明細時，編輯中的頁面會在結束後自動重查", async ({ page }) => {
    await installMockRealtimeBootReload(page);
    await page.goto(
      "/reports/901/90001?page=1&pageSize=25&landingPage=line-a-901&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=MA01"
    );

    const targetRow = page.locator(".detail-subtable tbody tr[data-row-id]").nth(0);
    await targetRow.dblclick({ force: true });

    let detailRefreshCount = 0;
    await page.route("**/api/forms/901/reports/90001**", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (
        route.request().method() === "GET" &&
        requestUrl.pathname === "/api/forms/901/reports/90001"
      ) {
        detailRefreshCount += 1;
      }
      await route.fallback();
    });

    await expect
      .poll(() =>
        page.evaluate(() => {
          const globalWindow = window as typeof window & {
            __emitMockRealtimeLifecycle?: (
              eventName: string,
              payload: Record<string, unknown>
            ) => boolean;
          };
          return Boolean(
            globalWindow.__emitMockRealtimeLifecycle?.("work-report-event", {
              type: "work-report-entry-updated",
              formId: "901",
              entryId: "90001",
              updatedAt: new Date().toISOString(),
            })
          );
        })
      )
      .toBe(true);

    await expect(page.locator(".detail-system-status")).toContainText(
      /偵測到其他電腦更新|Detected updates from another device/i
    );
    await expect(targetRow.getByRole("button", { name: /(取消|Cancel)/ })).toBeVisible();

    await targetRow.getByRole("button", { name: /(取消|Cancel)/ }).click();
    await expect.poll(() => detailRefreshCount).toBeGreaterThan(0);
  });

  test("明細表底部會保留空白新增列，點一下就進入 inline create", async ({ page }) => {
    await page.goto(INLINE_EDITABLE_DETAIL_URL);
    await scrollDetailTableToBottom(page);

    const placeholderRows = page.locator(".detail-subtable tbody tr[data-row-kind='create-placeholder']");
    await expect(placeholderRows).toHaveCount(3);

    const targetPlaceholderRow = placeholderRows.first();
    await targetPlaceholderRow.locator("td").first().click({ force: true });

    await expect(targetPlaceholderRow).toHaveClass(/is-inline-editing/);
    await expect(targetPlaceholderRow.locator("[data-inline-editor-key='date']")).toHaveCount(1);
    await expect(targetPlaceholderRow.locator("[data-inline-editor-key='machineId']")).toHaveCount(1);
    await expect(targetPlaceholderRow.locator("[data-inline-editor-key='operatorId']")).toHaveCount(1);
    await expect(targetPlaceholderRow.locator("[data-inline-editor-key='productionQty']")).toHaveCount(1);
    await expect(page.locator(".detail-batch-create-save-btn")).toBeVisible();
  });

  test("inline 新增列忽略舊記憶並回到工令源頭機台", async ({ page }) => {
    await seedLegacyCreateDefaults(page);
    await page.goto(INLINE_EDITABLE_DETAIL_URL);
    await scrollDetailTableToBottom(page);

    const targetPlaceholderRow = page
      .locator(".detail-subtable tbody tr[data-row-kind='create-placeholder']")
      .first();
    await targetPlaceholderRow.locator("td").first().click({ force: true });

    await expect(
      targetPlaceholderRow.locator(
        "[data-inline-editor-key='machineId'] .detail-inline-picker-value"
      )
    ).toHaveText("MB50");
    await expect(targetPlaceholderRow).not.toContainText("LEGACY-MACHINE");
    await expect(targetPlaceholderRow).not.toContainText("LEGACY-OPERATOR");
    await expect(targetPlaceholderRow).not.toContainText("LEGACY-PROCESS");
  });

  test("Modal 新增同樣忽略舊記憶並回到工令源頭機台", async ({ page }) => {
    await seedLegacyCreateDefaults(page);
    await page.goto(INLINE_EDITABLE_DETAIL_URL);

    await page.getByRole("button", { name: /(新增報工|Add Report)/ }).click();
    const createDialog = page.getByRole("dialog", {
      name: /(新增報工明細|Add Report Detail)/,
    });
    await expect(createDialog).toBeVisible();
    await expect(
      createDialog.locator(
        "[data-inline-editor-key='modal-machineId'] .detail-inline-picker-value"
      )
    ).toHaveText("MB50");
    await expect(createDialog).not.toContainText("LEGACY-MACHINE");
    await expect(createDialog).not.toContainText("LEGACY-OPERATOR");
    await expect(createDialog).not.toContainText("LEGACY-PROCESS");
  });

  test("底部 inline 新增列選取下拉後不會被 virtual scroll 拉動", async ({ page }) => {
    await page.goto(INLINE_EDITABLE_DETAIL_URL);
    await scrollDetailTableToBottom(page);

    const targetPlaceholderRow = page
      .locator(".detail-subtable tbody tr[data-row-kind='create-placeholder']")
      .first();
    await targetPlaceholderRow.locator("td").first().click({ force: true });
    await expect(targetPlaceholderRow).toHaveClass(/is-inline-editing/);
    await targetPlaceholderRow.locator("[data-inline-editor-key='date']").fill("2222-02-22");
    await targetPlaceholderRow.locator("[data-inline-editor-key='productionQty']").fill("25");

    await page.waitForTimeout(250);
    const before = await getLocatorVerticalBounds(targetPlaceholderRow);
    await targetPlaceholderRow.locator("[data-inline-editor-key='inputOptions']").click();
    const dialog = page.getByRole("dialog", { name: /(選擇預設報工時間|Select Input Option)/ });
    await expect(dialog).toBeVisible();
    await dialog.locator(".detail-picker-option[data-option-value='加班2H']").click();
    await expect(dialog).toHaveCount(0);
    await page.waitForTimeout(250);
    const after = await getLocatorVerticalBounds(targetPlaceholderRow);

    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(2);
    expect(Math.abs(after.bottom - before.bottom)).toBeLessThanOrEqual(2);
  });

  test("底部 inline 新增列 fill handle 往下拖會跟著 scroll 並延伸下方新增列", async ({ page }) => {
    await page.goto(INLINE_EDITABLE_DETAIL_URL);
    await scrollDetailTableToBottom(page);

    const targetPlaceholderRow = page
      .locator(".detail-subtable tbody tr[data-row-kind='create-placeholder']")
      .first();
    await targetPlaceholderRow.locator("td").first().click({ force: true });
    await expect(targetPlaceholderRow).toHaveClass(/is-inline-editing/);
    await targetPlaceholderRow.locator("[data-inline-editor-key='date']").fill("2222-02-22");
    await targetPlaceholderRow.locator("[data-inline-editor-key='productionQty']").fill("25");

    const handle = targetPlaceholderRow.locator("td[data-inline-cell-key='date'] .detail-inline-fill-handle");
    await expect(handle).toBeVisible();
    const handleBox = await handle.boundingBox();
    const tableBox = await page.locator(".detail-table-scroll").boundingBox();
    if (!handleBox || !tableBox) {
      throw new Error("missing fill handle or table bounds");
    }
    const beforeScrollTop = await page.locator(".detail-table-scroll").evaluate((element) => element.scrollTop);

    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    for (let index = 0; index < 10; index += 1) {
      await page.mouse.move(handleBox.x + handleBox.width / 2, tableBox.y + tableBox.height - 10, {
        steps: 3,
      });
      await page.waitForTimeout(120);
    }
    await page.mouse.up();

    const afterScrollTop = await page.locator(".detail-table-scroll").evaluate((element) => element.scrollTop);
    const draftCount = await getBatchCreateDraftCount(page);
    expect(afterScrollTop).toBeGreaterThan(beforeScrollTop);
    expect(draftCount).toBeGreaterThan(1);
    expect(draftCount).toBeLessThanOrEqual(20);
  });

  test("底部 inline 新增列 fill handle 往右拖不會觸發上下抖動", async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 768 });
    await page.goto(INLINE_EDITABLE_DETAIL_URL);
    await scrollDetailTableToBottom(page);

    const targetPlaceholderRow = page
      .locator(".detail-subtable tbody tr[data-row-kind='create-placeholder']")
      .first();
    await targetPlaceholderRow.locator("td").first().click({ force: true });
    await expect(targetPlaceholderRow).toHaveClass(/is-inline-editing/);
    await targetPlaceholderRow.locator("[data-inline-editor-key='date']").fill("2222-02-22");
    await targetPlaceholderRow.locator("[data-inline-editor-key='productionQty']").fill("25");

    const handle = targetPlaceholderRow.locator("td[data-inline-cell-key='date'] .detail-inline-fill-handle");
    await expect(handle).toBeVisible();
    const handleBox = await handle.boundingBox();
    const tableBox = await page.locator(".detail-table-scroll").boundingBox();
    if (!handleBox || !tableBox) {
      throw new Error("missing fill handle or table bounds");
    }
    const beforeBounds = await getLocatorVerticalBounds(targetPlaceholderRow);
    const beforeScrollTop = await page.locator(".detail-table-scroll").evaluate((element) => element.scrollTop);

    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    for (let index = 0; index < 14; index += 1) {
      await page.mouse.move(tableBox.x + tableBox.width - 8, handleBox.y + handleBox.height / 2, {
        steps: 4,
      });
      await page.waitForTimeout(120);
    }
    await page.mouse.up();

    const afterBounds = await getLocatorVerticalBounds(targetPlaceholderRow);
    const afterScrollTop = await page.locator(".detail-table-scroll").evaluate((element) => element.scrollTop);
    const draftCount = await getBatchCreateDraftCount(page);

    expect(afterScrollTop - beforeScrollTop).toBe(0);
    expect(Math.abs(afterBounds.top - beforeBounds.top)).toBeLessThanOrEqual(2);
    expect(Math.abs(afterBounds.bottom - beforeBounds.bottom)).toBeLessThanOrEqual(2);
    expect(draftCount).toBe(1);
  });

  test("底部空白新增列儲存時會走 batch create 背景任務", async ({ page }) => {
    await page.goto(INLINE_EDITABLE_DETAIL_URL);
    await scrollDetailTableToBottom(page);

    const targetPlaceholderRow = page
      .locator(".detail-subtable tbody tr[data-row-kind='create-placeholder']")
      .first();

    const taskId = "batch-create-task-inline-001";
    let createRequestSeen = false;
    let taskPollCount = 0;

    await page.route("**/api/forms/901/reports/90002/batch-create", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }

      createRequestSeen = true;
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            taskId,
            status: "pending",
            createdAt: "2026-03-16T10:00:00.000Z",
            requestedCount: 1,
          },
          meta: {
            formId: "901",
            entryId: "90002",
            accepted: true,
          },
        }),
      });
    });

    await page.route(`**/api/forms/901/tasks/${taskId}`, async (route) => {
      taskPollCount += 1;
      const status = taskPollCount < 2 ? "running" : "success";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            taskId,
            formId: "901",
            entryId: "90002",
            rowId: status === "success" ? "199999" : null,
            taskType: "create-report-batch",
            queueKey: "901:90002",
            status,
            createdAt: "2026-03-16T10:00:00.000Z",
            startedAt: "2026-03-16T10:00:00.500Z",
            finishedAt: status === "success" ? "2026-03-16T10:00:01.000Z" : null,
            updatedAt: "2026-03-16T10:00:01.000Z",
            message: status === "success" ? "批次新增完成（1/1）" : "批次新增背景任務處理中",
            errorCode: null,
            errorMessage: null,
            actorClientId: "e2e-client",
            actorTabId: "e2e-tab",
            actorIp: null,
            actorLabel: null,
            source: null,
            batchCreatedRowIds: status === "success" ? ["199999"] : [],
          },
          meta: {
            formId: "901",
            taskId,
          },
        }),
      });
    });

    await targetPlaceholderRow.click({ force: true });
    await targetPlaceholderRow.locator("[data-inline-editor-key='date']").fill("2026-03-16");

    await targetPlaceholderRow.locator("[data-inline-editor-key='startTime']").fill("08:00");
    await targetPlaceholderRow.locator("[data-inline-editor-key='endTime']").fill("17:00");
    await targetPlaceholderRow.locator("[data-inline-editor-key='productionQty']").fill("25");
    await targetPlaceholderRow.locator("[data-inline-editor-key='operatorId']").click();
    const operatorDialog = page.getByRole("dialog", {
      name: /(選擇操作員|Select Operator)/,
    });
    await expect(operatorDialog).toBeVisible();
    await operatorDialog.locator(".detail-picker-option").first().click();
    const linkedInputDialog = page.getByRole("dialog", {
      name: /(選擇投入選項|Select Input Option)/,
    });
    if (await linkedInputDialog.count()) {
      await linkedInputDialog.locator(".detail-picker-header button").click();
      await expect(linkedInputDialog).toHaveCount(0);
    }
    await page.locator(".detail-batch-create-save-btn").click();

    await expect
      .poll(() => (createRequestSeen ? "seen" : "pending"))
      .toBe("seen");
    await expect
      .poll(() => taskPollCount)
      .toBeGreaterThan(1);
    await expect(page.locator(".detail-system-status")).toContainText(
      /批次新增完成|Batch create/i
    );
  });

  test("明細頁製程欄位顯示子製程代碼而不是製程名稱", async ({ page }) => {
    await page.goto(
      "/reports/901/90001?page=1&pageSize=25&landingPage=line-a-901&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=MA01"
    );

    const firstProcessCell = page.locator(".detail-subtable tbody tr[data-row-id]").nth(0).locator("td.col-process");
    await expect(firstProcessCell).toBeVisible();
    await expect(firstProcessCell).toContainText(/PA\d+/);
    await expect(firstProcessCell).not.toContainText(/Process A/i);
  });

  test("隱藏單一可直編欄位後，不會再出現對應 editor", async ({ page }) => {
    await page.goto(INLINE_EDITABLE_DETAIL_URL);

    await page.getByRole("button", { name: /(欄位|Columns)/ }).click();
    const panel = page.locator(".detail-column-settings-panel");
    await expect(panel).toBeVisible();

    await setColumnCheckbox(panel, "productionQty", false);

    const targetRow = page.locator(".detail-subtable tbody tr[data-row-id]").nth(0);
    await targetRow.dblclick({ force: true });

    await expect(targetRow.locator("[data-inline-editor-key='inputOptions']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='shiftType']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='startTime']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='endTime']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='productionQty']")).toHaveCount(0);
  });

  test("若所有可直編欄位都被隱藏，雙擊列不進半套編輯", async ({ page }) => {
    await page.goto(INLINE_EDITABLE_DETAIL_URL);

    await page.getByRole("button", { name: /(欄位|Columns)/ }).click();
    const panel = page.locator(".detail-column-settings-panel");
    await expect(panel).toBeVisible();

    const editableColumnKeys = [
      "date",
      "plannedIdle",
      "machineId",
      "operatorId",
      "processCode",
      "inputOptions",
      "shiftType",
      "startTime",
      "endTime",
      "breakTime",
      "productionQty",
      "remark",
      "setupAdjustType",
      "setupAdjustMinutes",
      "countSetupTimeFlag",
      "setupLossQtyPerPcs",
      "processLossQtyPerPcs",
      "totalContainerQty",
      "containerUnit",
      "plannedIdleMinutes",
      "unplannedIdleMinutes",
      "absentOrTrainingMinutes",
      "noMaterialMinutes",
      "waitingQcApprovalMinutes",
      "meetingMinutes",
      "cleaningMinutes",
      "rdSamplingMinutes",
      "supportOtherMachinesMinutes",
      "machineBreakdownMinutes",
      "machineAdjustmentMinutes",
      "othersMinutes",
      "waitingForDiesMinutes",
      "testingDiesMinutes",
    ];

    for (const columnKey of editableColumnKeys) {
      await setColumnCheckbox(panel, columnKey, false);
    }

    const targetRow = page.locator(".detail-subtable tbody tr[data-row-id]").nth(0);
    await targetRow.dblclick({ force: true });

    await expect(page.getByText(/目前欄位設定沒有可直接編輯|No directly editable columns are currently visible/)).toBeVisible();
    await expect(targetRow.locator("[data-inline-editor-key='date']")).toHaveCount(0);
    await expect(targetRow.locator("[data-inline-editor-key='machineId']")).toHaveCount(0);
    await expect(targetRow.locator("[data-inline-editor-key='operatorId']")).toHaveCount(0);
    await expect(targetRow.locator("[data-inline-editor-key='processCode']")).toHaveCount(0);
    await expect(targetRow.locator("[data-inline-editor-key='inputOptions']")).toHaveCount(0);
    await expect(targetRow.locator("[data-inline-editor-key='shiftType']")).toHaveCount(0);
    await expect(targetRow.locator("[data-inline-editor-key='startTime']")).toHaveCount(0);
    await expect(targetRow.locator("[data-inline-editor-key='endTime']")).toHaveCount(0);
    await expect(targetRow.locator("[data-inline-editor-key='productionQty']")).toHaveCount(0);
    await expect(targetRow.getByRole("button", { name: /(儲存|Save)/ })).toHaveCount(0);
  });

  test("inputOptions 用獨立選取視窗選取後會自動帶入班別與時間", async ({ page }) => {
    await page.goto(
      "/reports/901/90001?page=1&pageSize=25&landingPage=line-a-901&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=MA01"
    );

    const targetRow = page.locator(".detail-subtable tbody tr[data-row-id]").nth(2);
    await targetRow.dblclick({ force: true });

    const inputOptionsTrigger = targetRow.locator("[data-inline-editor-key='inputOptions']");
    const shiftTrigger = targetRow.locator("[data-inline-editor-key='shiftType']");
    const startTimeInput = targetRow.locator("[data-inline-editor-key='startTime']");
    const endTimeInput = targetRow.locator("[data-inline-editor-key='endTime']");
    const breakTimeInput = targetRow.locator("[data-inline-editor-key='breakTime']");
    const shiftCell = shiftTrigger.locator("xpath=ancestor::td[1]");
    const startTimeCell = startTimeInput.locator("xpath=ancestor::td[1]");
    const endTimeCell = endTimeInput.locator("xpath=ancestor::td[1]");
    const breakTimeCell = breakTimeInput.locator("xpath=ancestor::td[1]");
    await expect(shiftCell).not.toHaveClass(/detail-inline-autofill-highlight/);
    await expect(startTimeCell).not.toHaveClass(/detail-inline-autofill-highlight/);
    await expect(endTimeCell).not.toHaveClass(/detail-inline-autofill-highlight/);
    await expect(breakTimeCell).not.toHaveClass(/detail-inline-autofill-highlight/);
    await inputOptionsTrigger.click();

    const dialog = page.getByRole("dialog", { name: /(選擇預設報工時間|Select Input Option)/ });
    await expect(dialog).toBeVisible();

    const searchInput = dialog.getByRole("textbox", { name: /(搜尋預設報工時間|Search Input Option)/ });
    await searchInput.fill("加班2H");
    await dialog.locator(".detail-picker-option[data-option-value='加班2H']").click();

    await expect(dialog).toHaveCount(0);
    await expect(inputOptionsTrigger.locator(".detail-inline-picker-value")).toHaveText("加班2H");
    await expect(shiftTrigger.locator(".detail-inline-picker-value")).toHaveText("加班OT");
    await expect(startTimeCell).toHaveClass(/detail-inline-autofill-highlight/);
    await expect(endTimeCell).toHaveClass(/detail-inline-autofill-highlight/);
    await expect(breakTimeCell).toHaveClass(/detail-inline-autofill-highlight/);
    await expect(startTimeInput).toHaveValue("17:30");
    await expect(endTimeInput).toHaveValue("19:30");
    await expect(breakTimeInput).toHaveValue("0.00");
  });

  test("明細列儲存會以背景任務方式送出更新", async ({ page }) => {
    await page.goto(
      "/reports/901/90001?page=1&pageSize=25&landingPage=line-a-901&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=MA01"
    );

    const targetRow = page.locator(".detail-subtable tbody tr[data-row-id]").nth(0);
    const rowId = await targetRow.getAttribute("data-row-id");
    expect(rowId).toBeTruthy();

    const taskId = "update-task-inline-001";
    let updateRequestSeen = false;
    let taskPollCount = 0;

    await page.route(`**/api/forms/901/reports/90001/${rowId}?async=1`, async (route) => {
      if (route.request().method() !== "PUT") {
        await route.fallback();
        return;
      }
      updateRequestSeen = true;
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            taskId,
            status: "pending",
            createdAt: "2026-03-16T10:00:00.000Z",
          },
          meta: {
            formId: "901",
            entryId: "90001",
            rowId,
            accepted: true,
          },
        }),
      });
    });

    await page.route(`**/api/forms/901/reports/tasks/${taskId}`, async (route) => {
      taskPollCount += 1;
      const status = taskPollCount < 2 ? "running" : "success";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            taskId,
            formId: "901",
            entryId: "90001",
            queueKey: "901:90001",
            status,
            createdAt: "2026-03-16T10:00:00.000Z",
            updatedAt: "2026-03-16T10:00:01.000Z",
            ...(status === "success" ? { result: { rowId } } : {}),
          },
          meta: {
            formId: "901",
            taskId,
          },
        }),
      });
    });

    await targetRow.dblclick({ force: true });
    await targetRow.locator("[data-inline-editor-key='productionQty']").fill("26");
    await targetRow.getByRole("button", { name: /(儲存|Save)/ }).click();

    await expect
      .poll(() => (updateRequestSeen ? "seen" : "pending"))
      .toBe("seen");
    await expect(page.locator(".detail-system-status")).toContainText(/已受理更新|Update accepted/i);
    await expect
      .poll(() => taskPollCount)
      .toBeGreaterThan(1);
    await expect(page.locator(".detail-system-status")).toContainText(
      /已完成更新報工明細|Report detail updated/i
    );
  });

  test("明細列刪除會先跳出確認視窗，確認後才送出刪除", async ({ page }) => {
    await page.goto(
      "/reports/901/90001?page=1&pageSize=25&landingPage=line-a-901&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=MA01"
    );

    const targetRow = page.locator(".detail-subtable tbody tr[data-row-id]").nth(0);
    const rowId = await targetRow.getAttribute("data-row-id");
    expect(rowId).toBeTruthy();

    let deleteRequestCount = 0;
    let taskPollCount = 0;
    const taskId = "delete-task-inline-001";
    await page.route(`**/api/forms/901/reports/90001/${rowId}`, async (route) => {
      if (route.request().method() !== "DELETE") {
        await route.fallback();
        return;
      }
      deleteRequestCount += 1;
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            taskId,
            status: "pending",
            createdAt: "2026-09-03T00:00:00.000Z",
            requestedCount: 1,
          },
        }),
      });
    });
    await page.route(`**/api/forms/901/tasks/${taskId}`, async (route) => {
      taskPollCount += 1;
      const status = taskPollCount < 2 ? "running" : "success";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            taskId,
            taskType: "delete-report",
            formId: "901",
            entryId: "90001",
            queueKey: "901:90001",
            status,
            createdAt: "2026-09-03T00:00:00.000Z",
            updatedAt: "2026-09-03T00:00:01.000Z",
            ...(status === "success" ? { result: { rowId } } : {}),
          },
        }),
      });
    });

    const deleteButton = targetRow.getByRole("button", { name: /(刪除|Delete)/ });
    await deleteButton.click();

    const confirmDialog = page.locator(".ant-modal-confirm").last();
    await expect(confirmDialog).toBeVisible();
    await expect(confirmDialog).toContainText(
      /確定永久刪除這筆報工明細|Delete this report detail permanently/i
    );
    await confirmDialog.getByRole("button", { name: /(取消|Cancel)/ }).click();

    await page.waitForTimeout(300);
    expect(deleteRequestCount).toBe(0);

    await deleteButton.click();
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.getByRole("button", { name: /^(刪除|Delete)$/ }).click();

    await expect
      .poll(() => deleteRequestCount)
      .toBe(1);
    await expect.poll(() => taskPollCount).toBeGreaterThan(1);
    await expect(
      page.locator(`.detail-subtable tbody tr[data-row-id="${rowId}"]`)
    ).toHaveCount(0);
  });

  test("顯示 remark 與 setup 欄位後，會進入第二階段直編", async ({ page }) => {
    await page.goto(INLINE_EDITABLE_DETAIL_URL);

    await page.getByRole("button", { name: /(欄位|Columns)/ }).click();
    const panel = page.locator(".detail-column-settings-panel");
    await expect(panel).toBeVisible();

    await setColumnCheckbox(panel, "remark", true);
    await setColumnCheckbox(panel, "setupAdjustType", true);
    await setColumnCheckbox(panel, "setupAdjustMinutes", true);

    const targetRow = page.locator(".detail-subtable tbody tr[data-row-id]").nth(0);
    await targetRow.dblclick({ force: true });

    await expect(targetRow.locator("[data-inline-editor-key='remark']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='setupAdjustType']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='setupAdjustMinutes']")).toHaveCount(1);
  });

  test("Enter 會從 inline 欄位開啟 setup 類 picker，取消後焦點留在 trigger", async ({ page }) => {
    await page.goto(INLINE_EDITABLE_DETAIL_URL);

    await page.getByRole("button", { name: /(欄位|Columns)/ }).click();
    const panel = page.locator(".detail-column-settings-panel");
    await expect(panel).toBeVisible();

    await setColumnCheckbox(panel, "remark", true);
    await setColumnCheckbox(panel, "setupAdjustType", true);
    await setColumnCheckbox(panel, "setupAdjustMinutes", true);

    const targetRow = page.locator(".detail-subtable tbody tr[data-row-id]").nth(0);
    await targetRow.dblclick({ force: true });

    const remarkEditor = targetRow.locator("[data-inline-editor-key='remark']");
    const setupAdjustTrigger = targetRow.locator("[data-inline-editor-key='setupAdjustType']");
    const setupAdjustMinutesInput = targetRow.locator("[data-inline-editor-key='setupAdjustMinutes']");
    const countSetupTimeTrigger = targetRow.locator("[data-inline-editor-key='countSetupTimeFlag']");

    await remarkEditor.focus();
    await remarkEditor.press("Enter");

    const setupDialog = page.getByRole("dialog", { name: /(選擇架車或調機|Select Setup or Adjustment)/ });
    await expect(setupDialog).toBeVisible();
    await setupDialog.getByRole("button", { name: /(取消|Cancel)/ }).click();
    await expect(setupDialog).toHaveCount(0);
    await expect(setupAdjustTrigger).toBeFocused();

    await setupAdjustMinutesInput.fill("15");
    await setupAdjustMinutesInput.press("Enter");

    const countSetupDialog = page.getByRole("dialog", {
      name: /(選擇是否計算架車時間|Select Count Setup Time)/,
    });
    await expect(countSetupDialog).toBeVisible();
    await countSetupDialog.getByRole("button", { name: /(取消|Cancel)/ }).click();
    await expect(countSetupDialog).toHaveCount(0);
    await expect(countSetupTimeTrigger).toBeFocused();
  });

  test("中文輸入法確認組字的 Enter 不會移走 inline 焦點", async ({ page }) => {
    await page.goto(INLINE_EDITABLE_DETAIL_URL);

    const targetRow = page.locator(".detail-subtable tbody tr[data-row-id]").nth(0);
    await targetRow.dblclick({ force: true });

    const startTimeInput = targetRow.locator("[data-inline-editor-key='startTime']");
    await startTimeInput.focus();
    await startTimeInput.evaluate((element) => {
      element.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          bubbles: true,
          cancelable: true,
          isComposing: true,
        })
      );
    });

    await page.waitForTimeout(50);
    await expect(startTimeInput).toBeFocused();
  });

  test("Enter 移到右側停機欄位時不會被 sticky 操作欄遮住", async ({ page }) => {
    await page.goto(INLINE_EDITABLE_DETAIL_URL);
    await scrollDetailTableToBottom(page);

    const targetRow = page
      .locator(".detail-subtable tbody tr[data-row-kind='create-placeholder']")
      .first();
    await targetRow.locator("td").first().click({ force: true });
    await expect(targetRow).toHaveClass(/is-inline-editing/);

    const machineBreakdownInput = targetRow.locator(
      "[data-inline-editor-key='machineBreakdownMinutes']"
    );
    const machineAdjustmentInput = targetRow.locator(
      "[data-inline-editor-key='machineAdjustmentMinutes']"
    );
    await machineBreakdownInput.fill("111111");
    await machineBreakdownInput.press("Enter");

    await expect(machineAdjustmentInput).toBeFocused();
    await expect(page.locator(".detail-focus-hint")).toContainText("(K)");

    const bounds = await page.evaluate(() => {
      const scrollRoot = document.querySelector<HTMLElement>(".detail-table-scroll");
      const focusedElement = document.activeElement as HTMLElement | null;
      const focusedCell = focusedElement?.closest<HTMLElement>("td[data-inline-cell-key]") ?? null;
      const actionCell = focusedCell?.parentElement?.querySelector<HTMLElement>("td.col-actions") ?? null;
      if (!scrollRoot || !focusedCell || !actionCell) {
        return null;
      }
      const rootRect = scrollRoot.getBoundingClientRect();
      const focusedRect = focusedCell.getBoundingClientRect();
      const actionRect = actionCell.getBoundingClientRect();
      return {
        rootLeft: rootRect.left,
        focusedLeft: focusedRect.left,
        focusedRight: focusedRect.right,
        actionLeft: actionRect.left,
      };
    });

    expect(bounds).not.toBeNull();
    expect(bounds!.focusedLeft).toBeGreaterThanOrEqual(bounds!.rootLeft);
    expect(bounds!.focusedRight).toBeLessThanOrEqual(bounds!.actionLeft);
  });

  test("日期、計畫停機與 setup/container 欄位會進入後續階段直編", async ({ page }) => {
    await page.goto(INLINE_EDITABLE_DETAIL_URL);

    const targetRow = page.locator(".detail-subtable tbody tr[data-row-id]").nth(0);
    await targetRow.dblclick({ force: true });

    await expect(targetRow.locator("[data-inline-editor-key='date']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='setupTimeStandardHours']")).toHaveCount(0);
    await expect(targetRow.locator("[data-inline-editor-key='setupLossQtyPerPcs']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='processLossQtyPerPcs']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='totalContainerQty']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='containerUnit']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='plannedIdle']")).toHaveCount(1);
  });

  test("linked 欄位會進入第三階段直編，operator 變更時會同步顯示姓名", async ({ page }) => {
    await page.goto(INLINE_EDITABLE_DETAIL_URL);

    const targetRow = page.locator(".detail-subtable tbody tr[data-row-id]").nth(0);
    await targetRow.dblclick({ force: true });

    await expect(targetRow.locator("[data-inline-editor-key='machineId']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='operatorId']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='processCode']")).toHaveCount(1);

    const originalOperatorName = await targetRow.locator("td.col-operator").textContent();
    const operatorTrigger = targetRow.locator("[data-inline-editor-key='operatorId']");
    await operatorTrigger.click();

    const dialog = page.getByRole("dialog", { name: /(選擇操作員|Select Operator)/ });
    await expect(dialog).toBeVisible();

    const searchInput = dialog.getByRole("textbox", { name: /(搜尋操作員|Search Operator)/ });
    await searchInput.fill("FD00");

    const nextOperatorValue = await dialog.locator(".detail-picker-option").evaluateAll((nodes, current) => {
      const currentValue = String(current ?? "").trim();
      const next = nodes.find((node) => {
        const value = (node.getAttribute("data-option-value") ?? "").trim();
        return value && value !== currentValue;
      });
      return next?.getAttribute("data-option-value") ?? null;
    }, ((await operatorTrigger.locator(".detail-inline-picker-value").textContent()) ?? "").trim());

    expect(nextOperatorValue).toBeTruthy();

    await dialog.locator(`.detail-picker-option[data-option-value="${nextOperatorValue}"]`).click();

    await expect(dialog).toHaveCount(0);
    await expect(operatorTrigger.locator(".detail-inline-picker-value")).toHaveText(String(nextOperatorValue));
    await expect(targetRow.locator("td.col-operator")).not.toContainText(originalOperatorName ?? "");
  });

  test("machineId 會用獨立選取視窗搜尋並回填到目前列", async ({ page }) => {
    await page.goto(
      "/reports/901/90001?page=1&pageSize=25&landingPage=line-a-901&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=MA01"
    );

    const targetRow = page.locator(".detail-subtable tbody tr[data-row-id]").nth(0);
    await targetRow.dblclick({ force: true });

    const machineTrigger = targetRow.locator("[data-inline-editor-key='machineId']");
    const selectedValue =
      ((await machineTrigger.locator(".detail-inline-picker-value").textContent()) ?? "").trim();

    await machineTrigger.click();

    const dialog = page.getByRole("dialog", { name: /(選擇機台|Select Machine)/ });
    await expect(dialog).toBeVisible();

    const searchInput = dialog.getByRole("textbox", { name: /(搜尋機台|Search Machine)/ });
    await searchInput.fill("W");

    const nextMachineValue = await dialog.locator(".detail-picker-option").evaluateAll((nodes, current) => {
      const currentValue = String(current ?? "").trim();
      const next = nodes.find((node) => {
        const value = (node.getAttribute("data-option-value") ?? "").trim();
        return value && value !== currentValue;
      });
      return next?.getAttribute("data-option-value") ?? null;
    }, selectedValue);

    expect(nextMachineValue).toBeTruthy();

    await dialog.locator(`.detail-picker-option[data-option-value="${nextMachineValue}"]`).click();

    await expect(dialog).toHaveCount(0);
    await expect(machineTrigger.locator(".detail-inline-picker-value")).toHaveText(String(nextMachineValue));
  });

  test("processCode 會用獨立選取視窗搜尋並回填到目前列", async ({ page }) => {
    await page.goto(
      "/reports/901/90001?page=1&pageSize=25&landingPage=line-a-901&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=MA01"
    );

    const targetRow = page.locator(".detail-subtable tbody tr[data-row-id]").nth(0);
    await targetRow.dblclick({ force: true });

    const processTrigger = targetRow.locator("[data-inline-editor-key='processCode']");
    const selectedValue =
      ((await processTrigger.locator(".detail-inline-picker-value").textContent()) ?? "").trim();

    await processTrigger.click();

    const dialog = page.getByRole("dialog", { name: /(選擇製程|Select Process)/ });
    await expect(dialog).toBeVisible();

    const searchInput = dialog.getByRole("textbox", { name: /(搜尋製程|Search Process)/ });
    await searchInput.fill("PA");

    const nextProcessValue = await dialog.locator(".detail-picker-option").evaluateAll((nodes, current) => {
      const currentValue = String(current ?? "").trim();
      const next = nodes.find((node) => {
        const value = (node.getAttribute("data-option-value") ?? "").trim();
        return value && value !== currentValue;
      });
      return next?.getAttribute("data-option-value") ?? null;
    }, selectedValue);

    expect(nextProcessValue).toBeTruthy();

    await dialog.locator(`.detail-picker-option[data-option-value="${nextProcessValue}"]`).click();

    await expect(dialog).toHaveCount(0);
    await expect(processTrigger.locator(".detail-inline-picker-value")).toHaveText(String(nextProcessValue));
  });

  test("operatorId 會用獨立選取視窗搜尋並回填到目前列", async ({ page }) => {
    await page.goto(
      "/reports/901/90001?page=1&pageSize=25&landingPage=line-a-901&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=MA01"
    );

    const targetRow = page.locator(".detail-subtable tbody tr[data-row-id]").nth(0);
    await targetRow.dblclick({ force: true });

    const operatorTrigger = targetRow.locator("[data-inline-editor-key='operatorId']");
    const selectedValue =
      ((await operatorTrigger.locator(".detail-inline-picker-value").textContent()) ?? "").trim();

    await operatorTrigger.click();

    const dialog = page.getByRole("dialog", { name: /(選擇操作員|Select Operator)/ });
    await expect(dialog).toBeVisible();

    const searchInput = dialog.getByRole("textbox", { name: /(搜尋操作員|Search Operator)/ });
    await searchInput.fill("FD00");

    const nextOperatorValue = await dialog.locator(".detail-picker-option").evaluateAll((nodes, current) => {
      const currentValue = String(current ?? "").trim();
      const next = nodes.find((node) => {
        const value = (node.getAttribute("data-option-value") ?? "").trim();
        return value && value !== currentValue;
      });
      return next?.getAttribute("data-option-value") ?? null;
    }, selectedValue);

    expect(nextOperatorValue).toBeTruthy();

    await dialog.locator(`.detail-picker-option[data-option-value="${nextOperatorValue}"]`).click();

    await expect(dialog).toHaveCount(0);
    await expect(operatorTrigger.locator(".detail-inline-picker-value")).toHaveText(String(nextOperatorValue));
  });

  test("901 操作員群組預設為製程 A組，切換後會記住並同步到新增明細", async ({ page }) => {
    await resetOperatorGroupPreference(page);
    await mockOperatorOptionsWithGroups(page, "901");
    await page.goto(
      "/reports/901/90001?page=1&pageSize=25&landingPage=line-a-901&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=MA01"
    );

    const targetRow = page.locator(".detail-subtable tbody tr[data-row-id]").nth(0);
    await targetRow.dblclick({ force: true });

    const operatorTrigger = targetRow.locator("[data-inline-editor-key='operatorId']");
    await operatorTrigger.click();

    const dialog = page.getByRole("dialog", { name: /(選擇操作員|Select Operator)/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "P01加工一組" })).toHaveClass(/is-active/);
    await expect(dialog.locator(".detail-picker-option")).toHaveCount(3);
    await expect(dialog.locator(".detail-picker-option[data-option-value='EMP101']")).toBeVisible();
    await expect(dialog.locator(".detail-picker-option[data-option-value='EMP102']")).toBeVisible();
    await expect(dialog.locator(".detail-picker-option[data-option-value='EMP201']")).toHaveCount(0);

    await dialog.getByRole("button", { name: "ADM管理組" }).click();
    await expect(dialog.getByRole("button", { name: "ADM管理組" })).toHaveClass(/is-active/);
    await expect(dialog.locator(".detail-picker-option")).toHaveCount(2);
    await expect(dialog.locator(".detail-picker-option[data-option-value='EMP301']")).toBeVisible();

    await dialog.getByRole("button", { name: /(取消|Cancel)/ }).click();
    await expect(dialog).toHaveCount(0);

    await page.reload();

    await page.getByRole("button", { name: /(新增報工|Add Report)/ }).click();

    const createDialog = page.getByRole("dialog", {
      name: /(新增報工明細|Add Report Detail)/,
    });
    await expect(createDialog).toBeVisible();
    const modalOperatorTrigger = createDialog.locator("[data-inline-editor-key='modal-operatorId']");
    await modalOperatorTrigger.click();

    const createPickerDialog = page.getByRole("dialog", { name: /(選擇操作員|Select Operator)/ });
    await expect(createPickerDialog).toBeVisible();
    await expect(createPickerDialog.getByRole("button", { name: "ADM管理組" })).toHaveClass(
      /is-active/
    );
    await expect(createPickerDialog.locator(".detail-picker-option")).toHaveCount(1);
    await expect(
      createPickerDialog.locator(".detail-picker-option[data-option-value='EMP301']")
    ).toBeVisible();
    await expect(createPickerDialog).not.toContainText("EMP101");

    await createPickerDialog
      .locator(".detail-picker-option[data-option-value='EMP301']")
      .click();

    await expect(createPickerDialog).toHaveCount(0);
    await expect(modalOperatorTrigger.locator(".detail-inline-picker-value")).toHaveText("EMP301");
    await expect(createDialog.locator(".modal-field--readonly input").first()).toHaveValue("管理甲");
  });

  test("902 新增報工的操作員群組預設為製程 B組", async ({ page }) => {
    await resetOperatorGroupPreference(page);
    await mockOperatorOptionsWithGroups(page, "902");
    await page.goto(
      "/?page=1&pageSize=25&landingPage=line-b-902&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88"
    );
    await dismissSystemNoticeIfPresent(page);

    await page.locator(".ragic-table .ant-table-tbody .work-order-cell-button").first().click({
      force: true,
    });
    await page.getByRole("button", { name: /(新增報工|Add Report)/ }).click();

    const createDialog = page.getByRole("dialog", {
      name: /(新增報工明細|Add Report Detail)/,
    });
    await expect(createDialog).toBeVisible();
    await createDialog.locator("[data-inline-editor-key='modal-operatorId']").click();

    const createPickerDialog = page.getByRole("dialog", { name: /(選擇操作員|Select Operator)/ });
    await expect(createPickerDialog).toBeVisible();
    await expect(createPickerDialog.getByRole("button", { name: "P02加工二組" })).toHaveClass(
      /is-active/
    );
    await expect(
      createPickerDialog.locator(".detail-picker-option[data-option-value='EMP201']")
    ).toBeVisible();
  });

  test("新增報工的架調車 / 損耗 / 容器區塊預設展開", async ({ page }) => {
    await page.goto(
      "/reports/901/90001?page=1&pageSize=25&landingPage=line-a-901&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=MA01"
    );

    await page.getByRole("button", { name: /(新增報工|Add Report)/ }).click();

    const createDialog = page.getByRole("dialog", {
      name: /(新增報工明細|Add Report Detail)/,
    });
    await expect(createDialog).toBeVisible();
    await expect(
      createDialog.getByRole("heading", { name: /架調車 \/ 損耗 \/ 容器|Setup \/ Loss \/ Container/ })
    ).toBeVisible();
    await expect(
      createDialog.getByRole("combobox", {
        name: /(架車\(BA\)or調機\(SA\)|Setup\/Adjust Type \(BA\/SA\))/,
      })
    ).toBeVisible();
    await expect(
      createDialog.getByRole("combobox", {
        name: /(計算架車時間\? \(v\)|Count Setup Time\? \(v\))/,
      })
    ).toBeVisible();
    await expect(
      createDialog.getByRole("button", {
        name: /架調車 \/ 損耗 \/ 容器|Setup \/ Loss \/ Container/,
      })
    ).toHaveCount(0);
  });

  test("shiftType 會用獨立選取視窗搜尋並回填到目前列", async ({ page }) => {
    await page.goto(
      "/reports/901/90001?page=1&pageSize=25&landingPage=line-a-901&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=MA01"
    );

    const targetRow = page.locator(".detail-subtable tbody tr[data-row-id]").nth(0);
    await targetRow.dblclick({ force: true });

    const shiftTypeTrigger = targetRow.locator("[data-inline-editor-key='shiftType']");
    const selectedValue =
      ((await shiftTypeTrigger.locator(".detail-inline-picker-value").textContent()) ?? "").trim();

    await shiftTypeTrigger.click();

    const dialog = page.getByRole("dialog", { name: /(選擇班別|Select Shift Type)/ });
    await expect(dialog).toBeVisible();

    const searchInput = dialog.getByRole("textbox", { name: /(搜尋班別|Search Shift Type)/ });
    await searchInput.fill("加班");

    const nextShiftValue = await dialog.locator(".detail-picker-option").evaluateAll((nodes, current) => {
      const currentValue = String(current ?? "").trim();
      const next = nodes.find((node) => {
        const value = (node.getAttribute("data-option-value") ?? "").trim();
        return value && value !== currentValue;
      });
      return next?.getAttribute("data-option-value") ?? null;
    }, selectedValue);

    expect(nextShiftValue).toBeTruthy();

    await dialog.locator(`.detail-picker-option[data-option-value="${nextShiftValue}"]`).click();

    await expect(dialog).toHaveCount(0);
    await expect(shiftTypeTrigger.locator(".detail-inline-picker-value")).toHaveText(String(nextShiftValue));
  });

  test("明細欄位設定面板在寬窄桌面都不會超出視窗", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(
      "/reports/901/90001?page=1&pageSize=25&landingPage=line-a-901&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=MA01"
    );

    await page.getByRole("button", { name: /(欄位|Columns)/ }).click();

    const panel = page.locator(".detail-column-settings-panel");
    await expect(panel).toBeVisible();

    const expectPanelWithinViewport = async (anchor: "left" | "right") => {
      const bounds = await panel.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const triggerRect = element.parentElement
          ?.querySelector(".detail-column-settings-btn")
          ?.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          width: rect.width,
          triggerLeft: triggerRect?.left ?? Number.NaN,
          triggerRight: triggerRect?.right ?? Number.NaN,
          viewportWidth: window.innerWidth,
        };
      });

      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth);
      expect(bounds.width).toBeGreaterThan(0);
      expect(Math.abs(bounds[anchor] - bounds[anchor === "left" ? "triggerLeft" : "triggerRight"]))
        .toBeLessThanOrEqual(2);
    };

    await expectPanelWithinViewport("right");

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(panel).toBeVisible();
    await expectPanelWithinViewport("left");
  });

  test("欄位顯示設定變動後，底部橫向 scrollbar 會重新量測寬度", async ({ page }) => {
    await page.goto(
      "/reports/901/90001?page=1&pageSize=25&landingPage=line-a-901&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=MA01"
    );

    const spacer = page.locator(".fixed-h-scrollbar-spacer");
    await expect(spacer).toBeVisible();

    const beforeWidth = await spacer.evaluate((element) =>
      Number.parseFloat(window.getComputedStyle(element).width)
    );

    await page.getByRole("button", { name: /(欄位|Columns)/ }).click();
    const panel = page.locator(".detail-column-settings-panel");
    await expect(panel).toBeVisible();

    const hiddenColumnCheckbox = panel.getByRole("checkbox", {
      name: /^\[Assigned\]Efficiency Standard\[指定\]製程標準識別碼$/,
    });
    await hiddenColumnCheckbox.check();

    await expect
      .poll(async () =>
        spacer.evaluate((element) =>
          Number.parseFloat(window.getComputedStyle(element).width)
        )
      )
      .toBeGreaterThan(beforeWidth);
  });

  test("欄位設定的預設勾選符合指定欄位，其他欄位仍保留在清單中", async ({ page }) => {
    await page.goto(
      "/reports/901/90001?page=1&pageSize=25&landingPage=line-a-901&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=MA01"
    );

    await page.getByRole("button", { name: /(欄位|Columns)/ }).click();
    const panel = page.locator(".detail-column-settings-panel");
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: /(還原預設|Reset Default)/ }).click();

    const hiddenByDefault = new Set([
      "reportType",
      "rowId",
      "demo_prod_type",
      "demo_process_name",
      "demo_report_type",
      "demo_created_at",
      "demo_department_group",
      "demo_efficiency_default_active",
      "demo_efficiency_default_code",
      "demo_efficiency_assigned_code",
      "demo_category_qty_a",
      "demo_category_qty_b",
      "demo_test_value",
      "demo_cumulative_qty_a",
      "demo_cumulative_qty_b",
      "demo_part_no",
      "demo_primary_operator_id",
    ]);
    const columnStates = await panel
      .locator('input[type="checkbox"][data-column-key]')
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const input = node as HTMLInputElement;
          return {
            key: input.dataset.columnKey ?? "",
            checked: input.checked,
          };
        })
      );

    expect(columnStates.length).toBeGreaterThan(hiddenByDefault.size);
    for (const column of columnStates) {
      expect(column.checked, column.key).toBe(!hiddenByDefault.has(column.key));
    }
  });
});

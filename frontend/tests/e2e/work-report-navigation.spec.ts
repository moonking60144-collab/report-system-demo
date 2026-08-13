import { expect, test, type Page } from "@playwright/test";

const OPERATOR_GROUP_STORAGE_KEY = "work-report:operator-group-preference:v1";
const PENDING_MUTATION_REPLAY_STORAGE_KEY = "work-report:pending-mutation-replay:v1";
const EDITING_PRESENCE_SESSION_STORAGE_KEY = "work-report:editing-presence-session:v1";
const E2E_API_BASE_URL = process.env.PLAYWRIGHT_API_BASE_URL ?? "http://127.0.0.1:3310/api";
const INLINE_EDITABLE_DETAIL_URL =
  "/reports/104/800000?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes";

type EditingPresenceLease = {
  url: string;
  sessionId: string;
  rowId: string;
};

const activePresenceLeasesByPage = new WeakMap<Page, Map<string, EditingPresenceLease>>();

const MOCK_OPERATOR_OPTIONS_WITH_GROUPS = [
  {
    value: "TR0001",
    label: "TR0001 - 搓牙甲",
    display: "搓牙甲",
    operatorGroupKey: "C02搓牙組",
    operatorGroupLabel: "C02搓牙組",
  },
  {
    value: "TR0002",
    label: "TR0002 - 搓牙乙",
    display: "搓牙乙",
    operatorGroupKey: "C02搓牙組",
    operatorGroupLabel: "C02搓牙組",
  },
  {
    value: "HD0001",
    label: "HD0001 - 鍛造甲",
    display: "鍛造甲",
    operatorGroupKey: "C01鍛造組",
    operatorGroupLabel: "C01鍛造組",
  },
  {
    value: "MG0001",
    label: "MG0001 - 管理甲",
    display: "管理甲",
    operatorGroupKey: "A管理課",
    operatorGroupLabel: "A管理課",
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
      "work-report:form-memory:104:800000:v1",
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
  formId: "104" | "105"
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

async function getLocatorVerticalBoundsRelativeTo(
  locator: import("@playwright/test").Locator,
  container: import("@playwright/test").Locator
) {
  const [bounds, containerBounds] = await Promise.all([
    locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height };
    }),
    container.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top };
    }),
  ]);
  return {
    top: bounds.top - containerBounds.top,
    bottom: bounds.bottom - containerBounds.top,
    height: bounds.height,
  };
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
      const instances = globalWindow.__mockEventSourceInstances ?? [];
      if (instances.length === 0) {
        return false;
      }
      for (const instance of instances) {
        instance.dispatchEvent(
          new MessageEvent(eventName, {
            data: JSON.stringify(payload),
          })
        );
      }
      return true;
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
    const activeLeases = new Map<string, EditingPresenceLease>();
    activePresenceLeasesByPage.set(page, activeLeases);

    page.on("response", (response) => {
      const request = response.request();
      if (
        !response.ok() ||
        request.method() !== "PUT" ||
        !/\/editing-presence(?:\?|$)/.test(request.url())
      ) {
        return;
      }

      try {
        const payload = request.postDataJSON() as {
          active?: unknown;
          rowId?: unknown;
          sessionId?: unknown;
        };
        const rowId = String(payload.rowId ?? "").trim();
        const sessionId = String(payload.sessionId ?? "").trim();
        if (!rowId || !sessionId) {
          return;
        }

        const leaseKey = `${request.url()}\u0000${sessionId}\u0000${rowId}`;
        if (payload.active === true) {
          activeLeases.set(leaseKey, { url: request.url(), sessionId, rowId });
        } else if (payload.active === false) {
          activeLeases.delete(leaseKey);
        }
      } catch {
        // Ignore non-JSON requests; the production endpoint always uses JSON.
      }
    });
  });

  test.afterEach(async ({ page }) => {
    if (page.isClosed()) {
      return;
    }

    const visibleInlineLeases = await page.evaluate(
      ({ storageKey, apiBaseUrl }) => {
        const sessionId = window.sessionStorage.getItem(storageKey);
        const route = window.location.pathname.match(/^\/reports\/(104|105)\/([^/]+)/);
        if (!sessionId || !route) {
          return [];
        }

        return Array.from(
          document.querySelectorAll<HTMLElement>(
            ".detail-subtable tbody tr.is-inline-editing[data-row-id]"
          )
        )
          .map((element) => element.dataset.rowId ?? "")
          .filter(Boolean)
          .map((rowId) => ({
            url: `${apiBaseUrl}/forms/${route[1]}/reports/${route[2]}/editing-presence`,
            sessionId,
            rowId,
          }));
      },
      {
        storageKey: EDITING_PRESENCE_SESSION_STORAGE_KEY,
        apiBaseUrl: E2E_API_BASE_URL,
      }
    ).catch(() => [] as EditingPresenceLease[]);

    const pickerCancel = page
      .locator(".detail-picker-backdrop")
      .getByRole("button", { name: /(取消|Cancel)/ })
      .first();
    if (await pickerCancel.isVisible().catch(() => false)) {
      await pickerCancel.click({ force: true });
    }

    const modalCancel = page
      .locator(".modal-backdrop[role='dialog'] .modal-footer")
      .getByRole("button", { name: /(取消|Cancel)/ })
      .first();
    if (await modalCancel.isVisible().catch(() => false)) {
      await modalCancel.click({ force: true });
    }

    const inlineCancel = page
      .locator(".detail-subtable tbody tr.is-inline-editing .action-cell")
      .getByRole("button", { name: /(取消|Cancel)/ })
      .first();
    if (await inlineCancel.isVisible().catch(() => false)) {
      await inlineCancel.click({ force: true });
    }

    const batchCreateCancel = page.locator(".detail-batch-create-cancel-btn");
    if (await batchCreateCancel.isVisible().catch(() => false)) {
      await batchCreateCancel.click({ force: true });
    }

    await page.waitForTimeout(50);
    const activeLeases = new Map<string, EditingPresenceLease>();
    for (const lease of [
      ...Array.from(activePresenceLeasesByPage.get(page)?.values() ?? []),
      ...visibleInlineLeases,
    ]) {
      activeLeases.set(`${lease.url}\u0000${lease.sessionId}\u0000${lease.rowId}`, lease);
    }
    await page.evaluate(async (leases) => {
      for (const lease of leases) {
        await fetch(lease.url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: lease.sessionId,
            rowId: lease.rowId,
            active: false,
          }),
        });
      }
    }, Array.from(activeLeases.values())).catch(() => undefined);

    activePresenceLeasesByPage.delete(page);
  });

  test("列表工作區在桌面固定操作列，窄螢幕則保持單一路徑且不溢位", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 800 });
    await page.goto(
      "/?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report"
    );
    await dismissSystemNoticeIfPresent(page);

    const stickySearch = page.locator(".workspace-quick-search input");
    await expect(stickySearch).toBeVisible();
    await expect(page.locator(".filter-search-control input")).toHaveCount(0);
    await stickySearch.fill("WO-2605");
    await expect(stickySearch).toHaveValue("WO-2605");
    await stickySearch.fill("");
    await expect(page.locator(".workspace-pager")).toContainText(/(第 1 頁|Page 1)/);
    await expect(page.locator(".workspace-pager button").first()).toBeDisabled();

    const advancedFilters = page.locator(".filter-advanced-panel");
    const workspaceFilterButton = page.locator(".workspace-filter-btn");
    const workspaceToolbar = page.locator(".work-report-workspace-toolbar");
    const filterPanel = page.locator(".work-report-filter-panel");
    await expect(advancedFilters).toHaveCount(0);
    await workspaceFilterButton.click();
    await expect(advancedFilters).toBeVisible();
    await expect
      .poll(async () => {
        const workspaceBounds = await workspaceToolbar.boundingBox();
        const filterPanelBounds = await filterPanel.boundingBox();
        if (!workspaceBounds || !filterPanelBounds) {
          return false;
        }
        return Math.abs(filterPanelBounds.y - (workspaceBounds.y + workspaceBounds.height)) <= 1;
      })
      .toBe(true);
    await workspaceFilterButton.click();
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

    await page.evaluate(() => window.scrollTo({ top: 650, behavior: "instant" }));
    const stickyTableHeader = page.locator(".ant-table-sticky-holder");
    await expect
      .poll(async () => {
        const workspaceBounds = await workspaceToolbar.boundingBox();
        const tableHeaderBounds = await stickyTableHeader.boundingBox();
        if (!workspaceBounds || !tableHeaderBounds) {
          return false;
        }
        const seam =
          tableHeaderBounds.y - (workspaceBounds.y + workspaceBounds.height);
        return workspaceBounds.y <= 1 && seam >= -2.5 && seam <= 16;
      })
      .toBe(true);

    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await page.getByRole("tab", { name: /(打頭報工|Heading)/ }).click();
    await expect(page.locator(".work-report-workspace-context strong")).toContainText(
      /(打頭報工|Heading Report)/
    );
    await expect(page.locator(".work-report-workspace-context")).toContainText("105 / HF");
    await page.getByRole("tab", { name: /(搓牙報工|Thread Rolling)/ }).click();
    await expect(page.locator(".work-report-workspace-context")).toContainText("104 / TI");

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

  test("精確篩選顯示完整常用條件、正確計數並標示尚未套用草稿", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(
      "/?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report"
    );
    await dismissSystemNoticeIfPresent(page);

    const filterButton = page.locator(".workspace-filter-btn");
    await expect(filterButton.locator(".filter-count-badge")).toHaveCount(0);
    await filterButton.click();

    const panel = page.locator(".work-report-filter-panel");
    await expect(panel).toBeVisible();
    await expect(panel.locator("[data-filter-key]")).toHaveCount(8);
    await expect(panel.locator('[data-filter-key="machineCode"]')).toBeVisible();
    await expect(panel.locator('[data-filter-key="startSchedule"]')).toBeVisible();
    await expect(panel.locator('[data-filter-key="updatedDateFrom"]')).toBeVisible();
    await expect(panel.locator('[data-filter-key="updatedDateTo"]')).toBeVisible();

    await panel.locator('[data-filter-key="workOrderKeyword"] input').fill("WO-2605");
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
    await expect(page).toHaveURL(/fWorkOrder=WO-2605/);

    await panel.getByRole("button", { name: /^(清除篩選|Clear Filters)$/ }).click();
    await expect(filterButton.locator(".filter-count-badge")).toHaveCount(0);
    await expect(page).not.toHaveURL(/fWorkOrder=/);

    await panel.locator('[data-filter-key="updatedDateFrom"] input').fill("2026-08-01");
    await panel.locator('[data-filter-key="updatedDateTo"] input').fill("2026-08-10");
    await panel.getByRole("button", { name: /(套用篩選|Apply Filters)/ }).click();
    await expect(filterButton.locator(".filter-count-badge")).toHaveText("2");
    await expect(page).toHaveURL(/fUpdatedFrom=2026-08-01/);
    await expect(page).toHaveURL(/fUpdatedTo=2026-08-10/);
  });

  test("50 與 100 筆完整欄位列表只渲染視窗列且保留捲動與進入明細互動", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("work-reports:column-mode", "fit");
    });
    await page.route("**/api/forms/105/reports?**", async (route) => {
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
          sortOrder: String(sequence),
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
            formId: "105",
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
      "/?page=1&pageSize=25&landingPage=heading-105&topView=report"
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
        page.locator(".ragic-table .ant-table-tbody-virtual-holder").evaluate(
          (element) => element.clientHeight
        )
      )
      .toBe(360);

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
    if (thumbBounds) {
      await page.mouse.move(
        thumbBounds.x + thumbBounds.width / 2,
        thumbBounds.y + thumbBounds.height / 2
      );
      await page.mouse.down();
      await page.mouse.move(
        thumbBounds.x + thumbBounds.width / 2 + 200,
        thumbBounds.y + thumbBounds.height / 2,
        { steps: 5 }
      );
      await page.mouse.up();
    }
    await expect
      .poll(() =>
        page.locator(".ragic-table .ant-table-tbody-virtual-holder-inner").evaluate(
          (element) => Number.parseFloat(window.getComputedStyle(element).marginLeft)
        )
      )
      .toBeLessThan(0);
    await expect(page.locator(".fixed-h-scrollbar-shell")).toHaveCount(0);

    await lastRow.click();
    await expect(page).toHaveURL(/\/reports\/105\/virtual-100/);
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

    await page.route("**/api/forms/104/reports?**", async (route) => {
      if (!shouldDelayNextListRequest) {
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
      "/?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report"
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

    await page.route("**/api/forms/104/reports?**", async (route) => {
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
              prodType: "TI",
              status: "未結案",
              customerPartNo: "PART-001",
              erpPartNo: "PART-001",
            },
          ],
          meta: {
            formId: "104",
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
      "/?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report"
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

  test("移除已套用條件與明細返回都會保留其他尚未套用的草稿", async ({ page }) => {
    await page.goto(
      "/?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88"
    );
    await dismissSystemNoticeIfPresent(page);

    const filterButton = page.locator(".workspace-filter-btn");
    await filterButton.click();
    const panel = page.locator(".work-report-filter-panel");
    const workOrderDraft = panel.locator('[data-filter-key="workOrderKeyword"] input');
    await workOrderDraft.fill("DRAFT-WO-KEEP");

    const statusChip = panel.locator(".filter-active-chip", {
      hasText: /(工令狀態|Work Order Status)/,
    });
    await statusChip.locator(".filter-active-chip-remove").click();
    await expect(workOrderDraft).toHaveValue("DRAFT-WO-KEEP");
    await expect(filterButton.locator(".filter-draft-badge")).toContainText(
      /(未套用|Not Applied)/
    );
    await expect(page).not.toHaveURL(/fStatus=/);

    await filterButton.click();
    await page.locator(".ragic-table .work-order-cell-button").first().click({ force: true });
    await page.getByRole("button", { name: /(返回工令列表|Back)/ }).click();

    await filterButton.click();
    await expect(
      page.locator('.work-report-filter-panel [data-filter-key="workOrderKeyword"] input')
    ).toHaveValue("DRAFT-WO-KEEP");
    await expect(filterButton.locator(".filter-draft-badge")).toContainText(
      /(未套用|Not Applied)/
    );

    await panel.getByRole("button", { name: /^(清除篩選|Clear Filters)$/ }).click();
    await page.getByRole("button", { name: /(今日修改工令單|Modified Today)/ }).click();
    await workOrderDraft.fill("DRAFT-QUICK-VIEW-KEEP");
    const quickViewChip = panel.locator(".filter-active-chip", {
      hasText: /(今日修改|Today)/,
    });
    await quickViewChip.locator(".filter-active-chip-remove").click();
    await expect(workOrderDraft).toHaveValue("DRAFT-QUICK-VIEW-KEEP");
    await expect(filterButton.locator(".filter-draft-badge")).toContainText(
      /(未套用|Not Applied)/
    );
  });

  test("今日修改快速檢視跨過本地午夜後會自動改查新日期", async ({ page }) => {
    const requestedRanges: Array<{ from: string; to: string }> = [];
    page.on("request", (request) => {
      const requestUrl = new URL(request.url());
      if (
        request.method() === "GET" &&
        requestUrl.pathname === "/api/forms/104/reports" &&
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
      "/?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report"
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
      "/?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report"
    );
    await dismissSystemNoticeIfPresent(page);

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
    await expect(
      page.locator(
        ".ragic-table .row-running > td.work-report-column-tone--amber-soft"
      ).first()
    ).toHaveCSS("background-color", "rgb(157, 255, 157)");
    const storedLayout = await page.evaluate(() => {
      const raw = window.localStorage.getItem(
        "work-report:104:table-layout:compact:v2"
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
            "work-report:104:table-layout:compact:v2"
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
    await expect(page.locator(".work-report-sort-order-edit-btn").first()).toBeVisible();
    await expect(
      page.locator(".ragic-table td.work-report-column-tone--amber-soft")
    ).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.localStorage.getItem(
            "work-report:104:table-layout:compact:v2"
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
    await page.route("**/api/forms/104/reports/*/sort-order", async (route) => {
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
    await page.route("**/api/forms/104/reports/**", async (route) => {
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
            workOrderNo: "WO-25040537",
            status: "未結案",
            sortOrder: 7,
          },
        }),
      });
    });
    await page.route("**/api/forms/104/reports?**", async (route) => {
      if (route.request().method() !== "GET" || !allowTaskSuccess) {
        await route.fallback();
        return;
      }
      listReloadAfterSuccessCount += 1;
      const response = await route.fetch();
      const payload = (await response.json()) as {
        data?: Array<Record<string, unknown>>;
      };
      await route.fulfill({
        response,
        contentType: "application/json",
        body: JSON.stringify({
          ...payload,
          data: (payload.data ?? []).map((record) =>
            String(record.id) === capturedEntryId && listReloadAfterSuccessCount >= 2
              ? { ...record, sortOrder: 7 }
              : record
          ),
        }),
      });
    });
    await page.route(
      "**/api/forms/104/reports/tasks/sort-order-e2e",
      async (route) => {
        const status = allowTaskSuccess ? "success" : "pending";
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              taskId: "sort-order-e2e",
              taskType: "update-report",
              formId: "104",
              entryId: capturedEntryId || "800000",
              queueKey: `104:${capturedEntryId || "800000"}`,
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
      "/?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report"
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

    await expect.poll(() => capturedSortOrder).toEqual({ sortOrder: 7 });
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

  test("refresh 按鈕需經二次確認，確認後才發送同步請求", async ({ page }) => {
    const now = new Date().toISOString();
    const mockedSyncTask = {
      taskId: "sync-refresh-confirmation-e2e",
      formId: "105",
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
    await page.route(/\/api\/forms\/105\/sync(?:\?.*)?$/, async (route) => {
      mockedSyncPostCount += 1;
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          data: mockedSyncTask,
          meta: { formId: "105", accepted: true, async: true },
        }),
      });
    });
    await page.route(/\/api\/forms\/105\/sync\/status(?:\?.*)?$/, async (route) => {
      mockedSyncStatusCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: mockedSyncTask, meta: { formId: "105" } }),
      });
    });

    await page.goto(
      "/?page=1&pageSize=25&landingPage=heading-105&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88"
    );
    await dismissSystemNoticeIfPresent(page);

    let syncRequestCount = 0;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().includes("/api/forms/105/sync")
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
        request.method() === "POST" && request.url().includes("/api/forms/105/sync")
    );
    const syncStatusRequestPromise = page.waitForRequest(
      (request) =>
        request.method() === "GET" && request.url().includes("/api/forms/105/sync/status")
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

  test("105 未結案工單 refresh 後保留 active preset", async ({ page }) => {
    await page.goto(
      "/?page=1&pageSize=25&landingPage=heading-105&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88"
    );
    await dismissSystemNoticeIfPresent(page);

    const unfinishedButton = page.getByRole("button", {
      name: /(未結案工單|Open Work Orders)/,
    });
    await expect(unfinishedButton).toHaveClass(/is-active/);

    await page.reload();

    await expect(unfinishedButton).toHaveClass(/is-active/);
  });

  test("104 W1 固定機台快捷 refresh 後保留 active 樣式", async ({ page }) => {
    await page.goto(
      "/?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
    );
    await dismissSystemNoticeIfPresent(page);

    const machineShortcut = page.getByRole("button", {
      name: /(W1未結案|W1 Open)/,
    });
    await expect(machineShortcut).toHaveClass(/is-active/);

    await page.reload();

    await expect(machineShortcut).toHaveClass(/is-active/);
  });

  test("系統更新時，列表頁會自動重新載入", async ({ page }) => {
    await installMockRealtimeBootReload(page);
    await page.goto(
      "/?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
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
  });

  test("104 / 105 左右切換後 active preset 穩定", async ({ page }) => {
    await page.goto(
      "/?page=1&pageSize=25&landingPage=heading-105&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88"
    );
    await dismissSystemNoticeIfPresent(page);

    await page.getByRole("tab", { name: /(搓牙報工|Thread Rolling)/ }).click();
    await expect(
      page.getByRole("button", { name: /(未結案可執行|Open Runnable)/ })
    ).toHaveClass(/is-active/);

    await page.getByRole("tab", { name: /(打頭報工|Heading)/ }).click();
    await expect(
      page.getByRole("button", { name: /(未結案工單|Open Work Orders)/ })
    ).toHaveClass(/is-active/);
  });

  test("返回列表後高亮對到剛剛進入的工令", async ({ page }) => {
    await page.goto(
      "/?page=1&pageSize=25&landingPage=heading-105&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88"
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

  test("105 切到 104 後進明細，detail URL 不應保留舊 landingPage", async ({ page }) => {
    await page.goto(
      "/?page=1&pageSize=25&landingPage=heading-105&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fFilterMachine=F7"
    );
    await dismissSystemNoticeIfPresent(page);

    await page.getByRole("tab", { name: /(搓牙報工|Thread Rolling)/ }).click();
    const workOrderButton = page.locator(".ragic-table .ant-table-tbody .work-order-cell-button").first();
    await workOrderButton.click({ force: true });

    await expect(page).toHaveURL(/\/reports\/104\//);
    await expect(page).toHaveURL(/landingPage=thread-rolling-104/);
    await expect(page).not.toHaveURL(/landingPage=heading-105/);
  });

  test("明細列雙擊後會進入整列 inline 編輯模式", async ({ page }) => {
    await page.goto(
      "/reports/104/800000?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
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
      formId: "104",
      entryId: "800000",
      rowId: "20000",
      payload: {
        date: "2026-03-16",
        machineId: "W5",
        operatorId: "RA004",
        operatorName: "羅智加",
        processCode: "TI01",
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

    await page.route("**/api/forms/104/reports/800000/20000?async=1", async (route) => {
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
            formId: "104",
            entryId: "800000",
            rowId: "20000",
            accepted: true,
          },
        }),
      });
    });

    await page.route("**/api/forms/104/reports/tasks/replay-task-001", async (route) => {
      taskPollCount += 1;
      const status = taskPollCount < 2 ? "running" : "success";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            taskId: "replay-task-001",
            formId: "104",
            entryId: "800000",
            queueKey: "104:800000",
            status,
            createdAt: "2026-03-17T01:00:01.000Z",
            updatedAt: "2026-03-17T01:00:02.000Z",
            ...(status === "success" ? { result: { rowId: "20000" } } : {}),
          },
          meta: {
            formId: "104",
            taskId: "replay-task-001",
          },
        }),
      });
    });

    await page.goto(
      "/reports/104/800000?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
    );

    await expect
      .poll(() => (replayRequestSeen ? "seen" : "pending"))
      .toBe("seen");
    expect(replayMutationHeader).toBe("replay-mutation-001");
    await expect(page.locator(".detail-system-status")).toContainText(
      /已完成更新報工明細|Report detail updated/i
    );
  });

  test("系統更新時，明細頁依全域 boot guard 導回首頁", async ({ page }) => {
    await installMockRealtimeBootReload(page);
    await page.goto(
      "/reports/104/800000?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
    );

    const targetRow = page.locator(".detail-subtable tbody tr[data-row-id]").nth(0);
    await targetRow.dblclick({ force: true });

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
    expect(new URL(page.url()).pathname).toBe("/");
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
    ).toHaveText("A01");
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
    ).toHaveText("A01");
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

  test("底部 inline 新增列 fill handle 往下拖會延伸下方新增列並保持結果可見", async ({ page }) => {
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
    await handle.hover();
    const handleBox = await handle.boundingBox();
    const tableBox = await page.locator(".detail-table-scroll").boundingBox();
    if (!handleBox || !tableBox) {
      throw new Error("missing fill handle or table bounds");
    }
    const viewportHeight = page.viewportSize()?.height ?? 720;
    const dragTargetY = Math.min(tableBox.y + tableBox.height - 2, viewportHeight - 70);
    await page.mouse.down();
    await page.waitForTimeout(50);
    for (let index = 0; index < 10; index += 1) {
      await page.mouse.move(handleBox.x + handleBox.width / 2, dragTargetY, {
        steps: 3,
      });
      await page.waitForTimeout(120);
    }
    await page.mouse.up();

    await expect.poll(() => getBatchCreateDraftCount(page)).toBeGreaterThan(1);
    const draftCount = await getBatchCreateDraftCount(page);
    expect(draftCount).toBeLessThanOrEqual(20);
    await expect(
      page.locator(
        `.detail-subtable tbody tr[data-row-id='__inline-create__:${draftCount - 1}']`
      )
    ).toBeVisible();
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
    await handle.hover();
    const handleBox = await handle.boundingBox();
    const tableBox = await page.locator(".detail-table-scroll").boundingBox();
    if (!handleBox || !tableBox) {
      throw new Error("missing fill handle or table bounds");
    }
    const tableScroll = page.locator(".detail-table-scroll");
    const beforeBounds = await getLocatorVerticalBoundsRelativeTo(targetPlaceholderRow, tableScroll);
    const beforeScrollTop = await page.locator(".detail-table-scroll").evaluate((element) => element.scrollTop);

    await page.mouse.down();
    await page.waitForTimeout(50);
    for (let index = 0; index < 14; index += 1) {
      await page.mouse.move(tableBox.x + tableBox.width - 8, handleBox.y + handleBox.height / 2, {
        steps: 4,
      });
      await page.waitForTimeout(120);
    }
    await page.mouse.up();

    const afterBounds = await getLocatorVerticalBoundsRelativeTo(targetPlaceholderRow, tableScroll);
    const afterScrollTop = await page.locator(".detail-table-scroll").evaluate((element) => element.scrollTop);
    const draftCount = await getBatchCreateDraftCount(page);

    expect(afterScrollTop - beforeScrollTop).toBe(0);
    expect(Math.abs(afterBounds.top - beforeBounds.top)).toBeLessThanOrEqual(2);
    expect(Math.abs(afterBounds.bottom - beforeBounds.bottom)).toBeLessThanOrEqual(2);
    expect(Math.abs(afterBounds.height - beforeBounds.height)).toBeLessThanOrEqual(2);
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

    await page.route("**/api/forms/104/reports/800000/batch-create**", async (route) => {
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
            formId: "104",
            entryId: "800000",
            accepted: true,
          },
        }),
      });
    });

    await page.route(`**/api/forms/104/tasks/${taskId}`, async (route) => {
      taskPollCount += 1;
      const status = taskPollCount < 2 ? "running" : "success";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            taskId,
            formId: "104",
            entryId: "800000",
            rowId: status === "success" ? "199999" : null,
            taskType: "create-report-batch",
            queueKey: "104:800000",
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
            formId: "104",
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
    await page
      .getByRole("dialog", { name: /(選擇操作員|Select Operator)/ })
      .locator(".detail-picker-option[data-option-value='E001']")
      .click();
    const inputOptionDialog = page.getByRole("dialog", {
      name: /(選擇預設報工時間|Select Input Option)/,
    });
    await expect(inputOptionDialog).toBeVisible();
    await inputOptionDialog.getByRole("button", { name: /(取消|Cancel)/ }).click();
    await expect(inputOptionDialog).toHaveCount(0);
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
      "/reports/104/800000?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
    );

    const firstProcessCell = page.locator(".detail-subtable tbody tr[data-row-id]").nth(0).locator("td.col-process");
    await expect(firstProcessCell).toBeVisible();
    await expect(firstProcessCell).toContainText(/TI\d+/);
    await expect(firstProcessCell).not.toContainText(/Thread Rolling/i);
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
      "/reports/104/800000?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
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
      "/reports/104/800000?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
    );

    const targetRow = page.locator(".detail-subtable tbody tr[data-row-id]").nth(0);
    const rowId = await targetRow.getAttribute("data-row-id");
    expect(rowId).toBeTruthy();

    const taskId = "update-task-inline-001";
    let updateRequestSeen = false;
    let taskPollCount = 0;

    await page.route(`**/api/forms/104/reports/800000/${rowId}?async=1`, async (route) => {
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
            formId: "104",
            entryId: "800000",
            rowId,
            accepted: true,
          },
        }),
      });
    });

    await page.route(`**/api/forms/104/reports/tasks/${taskId}`, async (route) => {
      taskPollCount += 1;
      const status = taskPollCount < 2 ? "running" : "success";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            taskId,
            formId: "104",
            entryId: "800000",
            queueKey: "104:800000",
            status,
            createdAt: "2026-03-16T10:00:00.000Z",
            updatedAt: "2026-03-16T10:00:01.000Z",
            ...(status === "success" ? { result: { rowId } } : {}),
          },
          meta: {
            formId: "104",
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
    await expect
      .poll(() => taskPollCount)
      .toBeGreaterThan(1);
    await expect(page.locator(".detail-system-status")).toContainText(
      /背景處理完成|Background processing completed|已完成更新報工明細|Report detail updated/i
    );
  });

  test("明細列刪除會先跳出確認視窗，確認後才送出刪除", async ({ page }) => {
    await page.goto(
      "/reports/104/800000?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
    );

    const targetRow = page.locator(".detail-subtable tbody tr[data-row-id]").nth(0);
    const rowId = await targetRow.getAttribute("data-row-id");
    expect(rowId).toBeTruthy();

    let deleteRequestCount = 0;
    const taskId = "delete-task-inline-001";
    let taskPollCount = 0;
    await page.route(`**/api/forms/104/reports/800000/${rowId}`, async (route) => {
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
            createdAt: "2026-03-16T10:00:00.000Z",
          },
          meta: {
            formId: "104",
            entryId: "800000",
            rowId,
            accepted: true,
          },
        }),
      });
    });

    await page.route(`**/api/forms/104/tasks/${taskId}`, async (route) => {
      taskPollCount += 1;
      const status = taskPollCount < 2 ? "running" : "success";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            taskId,
            formId: "104",
            entryId: "800000",
            queueKey: "104:800000",
            status,
            createdAt: "2026-03-16T10:00:00.000Z",
            updatedAt: "2026-03-16T10:00:01.000Z",
            ...(status === "success" ? { result: { rowId } } : {}),
          },
          meta: {
            formId: "104",
            taskId,
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
    await expect(page.locator(".detail-system-status")).toContainText(
      /背景處理完成|Background processing completed|已永久刪除報工明細|Report detail deleted permanently/i
    );
    await expect
      .poll(() => taskPollCount)
      .toBeGreaterThan(1);
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

    await setupAdjustTrigger.click();
    const initialSetupDialog = page.getByRole("dialog", {
      name: /(選擇架車或調機|Select Setup or Adjustment)/,
    });
    await expect(initialSetupDialog).toBeVisible();
    await initialSetupDialog.locator(".detail-picker-option[data-option-value='']").click();
    await expect(initialSetupDialog).toHaveCount(0);

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
    await searchInput.fill("E00");

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
      "/reports/104/800000?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
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
    await searchInput.fill("A");

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
      "/reports/104/800000?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
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
    await searchInput.fill("TI");

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
      "/reports/104/800000?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
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
    await searchInput.fill("E00");

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

  test("104 操作員群組預設為搓牙組，切換後會記住並同步到新增明細", async ({ page }) => {
    await resetOperatorGroupPreference(page);
    await mockOperatorOptionsWithGroups(page, "104");
    await page.goto(
      "/reports/104/800000?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
    );

    const targetRow = page.locator(".detail-subtable tbody tr[data-row-id]").nth(0);
    await targetRow.dblclick({ force: true });

    const operatorTrigger = targetRow.locator("[data-inline-editor-key='operatorId']");
    await operatorTrigger.click();

    const dialog = page.getByRole("dialog", { name: /(選擇操作員|Select Operator)/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "C02搓牙組" })).toHaveClass(/is-active/);
    await expect(dialog.locator(".detail-picker-option")).toHaveCount(3);
    await expect(dialog.locator(".detail-picker-option[data-option-value='TR0001']")).toBeVisible();
    await expect(dialog.locator(".detail-picker-option[data-option-value='TR0002']")).toBeVisible();
    await expect(dialog.locator(".detail-picker-option[data-option-value='HD0001']")).toHaveCount(0);

    await dialog.getByRole("button", { name: "A管理課" }).click();
    await expect(dialog.getByRole("button", { name: "A管理課" })).toHaveClass(/is-active/);
    await expect(dialog.locator(".detail-picker-option")).toHaveCount(2);
    await expect(dialog.locator(".detail-picker-option[data-option-value='MG0001']")).toBeVisible();

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
    await expect(createPickerDialog.getByRole("button", { name: "A管理課" })).toHaveClass(
      /is-active/
    );
    await expect(createPickerDialog.locator(".detail-picker-option")).toHaveCount(1);
    await expect(
      createPickerDialog.locator(".detail-picker-option[data-option-value='MG0001']")
    ).toBeVisible();
    await expect(createPickerDialog).not.toContainText("TR0001");

    await createPickerDialog
      .locator(".detail-picker-option[data-option-value='MG0001']")
      .click();

    await expect(createPickerDialog).toHaveCount(0);
    await expect(modalOperatorTrigger.locator(".detail-inline-picker-value")).toHaveText("MG0001");
    await expect(createDialog.locator(".modal-field--readonly input").first()).toHaveValue("管理甲");
  });

  test("105 新增報工的操作員群組預設為鍛造組", async ({ page }) => {
    await resetOperatorGroupPreference(page);
    await mockOperatorOptionsWithGroups(page, "105");
    await page.goto(
      "/?page=1&pageSize=25&landingPage=heading-105&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88"
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
    await expect(createPickerDialog.getByRole("button", { name: "C01鍛造組" })).toHaveClass(
      /is-active/
    );
    await expect(
      createPickerDialog.locator(".detail-picker-option[data-option-value='HD0001']")
    ).toBeVisible();
  });

  test("新增報工的架調車 / 損耗 / 容器區塊預設展開", async ({ page }) => {
    await page.goto(
      "/reports/104/800000?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
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
      createDialog.locator("[data-inline-editor-key='modal-setupAdjustType']")
    ).toBeVisible();
    await expect(
      createDialog.locator("[data-inline-editor-key='modal-countSetupTimeFlag']")
    ).toBeVisible();
    await expect(
      createDialog.locator("[data-inline-editor-key='modal-setupLossQtyPerPcs']")
    ).toBeVisible();
    await expect(
      createDialog.locator("[data-inline-editor-key='modal-processLossQtyPerPcs']")
    ).toBeVisible();
    await expect(
      createDialog.locator("[data-inline-editor-key='modal-totalContainerQty']")
    ).toBeVisible();
    await expect(
      createDialog.locator("[data-inline-editor-key='modal-containerUnit']")
    ).toBeVisible();
    await expect(
      createDialog.getByRole("button", {
        name: /架調車 \/ 損耗 \/ 容器|Setup \/ Loss \/ Container/,
      })
    ).toHaveCount(0);
  });

  test("shiftType 會用獨立選取視窗搜尋並回填到目前列", async ({ page }) => {
    await page.goto(
      "/reports/104/800000?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
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

  test("明細欄位設定面板不會超出視窗右側", async ({ page }) => {
    await page.goto(
      "/reports/104/800000?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
    );

    await page.getByRole("button", { name: /(欄位|Columns)/ }).click();

    const panel = page.locator(".detail-column-settings-panel");
    await expect(panel).toBeVisible();

    const bounds = await panel.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        width: rect.width,
        viewportWidth: window.innerWidth,
      };
    });

    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth);
    expect(bounds.width).toBeGreaterThan(0);
  });

  test("欄位顯示設定變動後，底部橫向 scrollbar 會重新量測寬度", async ({ page }) => {
    await page.goto(
      "/reports/104/800000?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
    );

    const spacer = page.locator(".fixed-h-scrollbar-spacer");
    await expect(spacer).toBeVisible();

    const beforeWidth = await spacer.evaluate((element) =>
      Number.parseFloat(window.getComputedStyle(element).width)
    );

    await page.getByRole("button", { name: /(欄位|Columns)/ }).click();
    const panel = page.locator(".detail-column-settings-panel");
    await expect(panel).toBeVisible();

    await setColumnCheckbox(panel, "[Assigned]Efficiency Standard[指定]製程標準識別碼", true);

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
      "/reports/104/800000?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
    );

    await page.getByRole("button", { name: /(欄位|Columns)/ }).click();
    const panel = page.locator(".detail-column-settings-panel");
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: /(還原預設|Reset Default)/ }).click();

    await expect(panel.getByRole("checkbox", { name: /^(日期|Date)$/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^(計畫停機|Planned Idle)$/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^(製程|Process)$/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^(機台|Machine)$/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^(操作員工號|Operator ID)$/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^(操作者|Operator)$/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^(預設報工時間|Input Options)$/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^(班別|Shift)$/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^(開工時間|Start Time)$/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^(完工時間|End Time)$/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^(扣除休息時間|Break Time)$/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^(總工時|Total Work Time)$/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^(產量|Qty)$/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^(依序累計量|Cumulative Qty)$/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^(備註|Remark)$/ })).toBeChecked();
    const checkedColumnKeys = [
      "setupAdjustType", "setupAdjustMinutes", "countSetupTimeFlag", "setupTimeStandardHours",
      "setupLossQtyPerPcs", "processLossQtyPerPcs", "totalContainerQty", "containerUnit",
      "plannedIdleMinutes", "unplannedIdleMinutes", "absentOrTrainingMinutes", "noMaterialMinutes",
      "waitingQcApprovalMinutes", "meetingMinutes", "cleaningMinutes", "rdSamplingMinutes",
      "supportOtherMachinesMinutes", "machineBreakdownMinutes", "machineAdjustmentMinutes",
      "othersMinutes", "waitingForDiesMinutes", "testingDiesMinutes",
      "(1012831)[實際]生產時間(分) (總時數-架調車-非擔當)",
      "Time Used %工時耗用率%1", "開單者帳號",
    ];
    for (const columnKey of checkedColumnKeys) {
      await expect(panel.locator(`input[data-column-key="${columnKey}"]`)).toBeChecked();
    }

    const uncheckedColumnKeys = [
      "rowId", "Type報工類別", "Created建立日期時間", "Dep.報工單位別",
      "[Default]Efficiency Code[預設]製程標準識別碼",
      "[Assigned]Efficiency Standard[指定]製程標準識別碼",
      "[分類生產產量]HF01", "[分類生產產量]HF02", "組成測試[可刪]",
    ];
    for (const columnKey of uncheckedColumnKeys) {
      await expect(panel.locator(`input[data-column-key="${columnKey}"]`)).not.toBeChecked();
    }
  });
});

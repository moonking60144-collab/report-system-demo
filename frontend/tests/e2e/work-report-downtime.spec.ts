import { expect, test, type Page, type Route } from "@playwright/test";

interface DowntimeApiMockOptions {
  handleCreateRecord?: (route: Route) => Promise<void>;
  getTasks?: () => unknown[];
  getTask?: (taskId: string) => unknown | null;
  onApiRequest?: (request: {
    method: string;
    pathname: string;
    searchParams: URLSearchParams;
  }) => void;
}

function createMockTask(
  patch: Partial<{
    taskId: string;
    taskType: string;
    status: string;
    formId: string;
    workOrderNo: string | null;
    entryId: string | null;
    rowId: string | null;
    queueKey: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    updatedAt: string;
    message: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    actorClientId: string | null;
    actorTabId: string | null;
    actorIp: string | null;
    actorLabel: string | null;
    source: string | null;
  }> = {}
) {
  const now = "2026-07-06T00:00:00.000Z";
  return {
    taskId: "task-1",
    taskType: "create-downtime",
    status: "pending",
    formId: "16",
    workOrderNo: null,
    entryId: null,
    rowId: null,
    queueKey: "16:downtime:create",
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
    message: null,
    errorCode: null,
    errorMessage: null,
    actorClientId: null,
    actorTabId: null,
    actorIp: "::1",
    actorLabel: null,
    source: null,
    ...patch,
  };
}

async function installDowntimeApiMocks(
  page: Page,
  options: DowntimeApiMockOptions = {}
) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method().toUpperCase();
    if (!url.pathname.startsWith("/api/")) {
      await route.fallback();
      return;
    }
    options.onApiRequest?.({
      method,
      pathname: url.pathname,
      searchParams: url.searchParams,
    });

    if (url.pathname === "/api/downtime/options") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            machineId: [
              {
                value: "W1",
                label: "W1 - 搓牙機",
                display: "搓牙機",
              },
            ],
            processCode: [
              {
                value: "BU01",
                label: "BU01 - 搓牙",
                display: "搓牙",
                processGroupKey: "thread",
                processGroupLabel: "搓牙",
              },
              {
                value: "TI01",
                label: "TI01 - 搓牙",
                display: "搓牙",
                processGroupKey: "thread",
                processGroupLabel: "搓牙",
              },
            ],
            operatorId: [
              {
                value: "TR0001",
                label: "TR0001 - 搓牙甲",
                display: "搓牙甲",
              },
            ],
          },
        }),
      });
      return;
    }

    if (url.pathname === "/api/downtime/records" && method === "POST") {
      if (options.handleCreateRecord) {
        await options.handleCreateRecord(route);
        return;
      }
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            taskId: "task-1",
            status: "pending",
            createdAt: "2026-07-06T00:00:00.000Z",
          },
        }),
      });
      return;
    }

    if (url.pathname === "/api/downtime/records" && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [],
          meta: {
            count: 0,
            totalCount: 0,
            limit: 20,
            offset: 0,
            hasMore: false,
            source: "sqlite",
            refreshed: false,
            refreshTriggered: false,
          },
        }),
      });
      return;
    }

    if (url.pathname === "/api/downtime/tasks") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: options.getTasks ? options.getTasks() : [],
        }),
      });
      return;
    }

    if (url.pathname.startsWith("/api/downtime/tasks/")) {
      const taskId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      const task = options.getTask ? options.getTask(taskId) : null;
      await route.fulfill({
        status: task ? 200 : 404,
        contentType: "application/json",
        body: JSON.stringify(task ? { data: task } : { error: { message: "not found" } }),
      });
      return;
    }

    if (url.pathname === "/api/downtime/planned-idle-summary") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [],
          meta: {
            month: "2026/07",
            machineCount: 0,
            source: "sqlite",
          },
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: null, meta: {} }),
    });
  });
}

test.describe("downtime page", () => {
  test("停機建立任務佇列顯示在右側可收合 sidebar", async ({ page }) => {
    let recordsRefreshRequests = 0;
    let taskListRequests = 0;
    const taskListActorClientIds: Array<string | null> = [];
    let optionRequests = 0;
    let chartRefreshRequests = 0;
    await installDowntimeApiMocks(page, {
      onApiRequest: ({ method, pathname, searchParams }) => {
        if (method === "GET" && pathname === "/api/downtime/options") {
          optionRequests += 1;
        }
        if (method === "GET" && pathname === "/api/downtime/tasks") {
          taskListRequests += 1;
          taskListActorClientIds.push(searchParams.get("actorClientId"));
        }
        if (
          method === "GET" &&
          pathname === "/api/downtime/records" &&
          searchParams.get("refresh") === "1"
        ) {
          recordsRefreshRequests += 1;
        }
        if (
          method === "GET" &&
          pathname === "/api/downtime/planned-idle-summary" &&
          searchParams.get("refresh") === "1"
        ) {
          chartRefreshRequests += 1;
        }
      },
    });
    await page.goto("/downtime");

    const workspace = page.locator(".downtime-workspace");
    const mainPanel = page.locator(".local-settings-panel");
    const taskSidebar = page.locator(".downtime-task-sidebar");
    await expect(workspace).toBeVisible();
    await expect(taskSidebar).toBeVisible();

    const mainBox = await mainPanel.boundingBox();
    const sidebarBox = await taskSidebar.boundingBox();
    expect(mainBox).not.toBeNull();
    expect(sidebarBox).not.toBeNull();
    expect(sidebarBox!.x).toBeGreaterThan(mainBox!.x);
    await expect(page.locator(".downtime-task-sidebar-refresh")).toBeVisible();
    await expect(taskSidebar.locator(".downtime-task-sidebar-header")).toHaveCSS("position", "sticky");
    await expect.poll(() => taskListActorClientIds.some(Boolean)).toBe(true);

    await page.locator(".downtime-task-sidebar-collapse").click();
    await expect(workspace).toHaveClass(/is-task-sidebar-collapsed/);
    await expect(taskSidebar).toHaveClass(/is-collapsed/);
    await expect(page.locator(".downtime-task-sidebar-rail-main")).toBeVisible();
    await expect
      .poll(async () => {
        const collapsedBox = await taskSidebar.boundingBox();
        return collapsedBox?.width ?? 0;
      })
      .toBeLessThan(90);

    const requestsBeforeSidebarRefresh = {
      options: optionRequests,
      tasks: taskListRequests,
      recordsRefresh: recordsRefreshRequests,
      chartRefresh: chartRefreshRequests,
    };
    const sidebarRefresh = page.locator(
      ".downtime-task-sidebar-rail-actions .downtime-task-sidebar-refresh"
    );
    await expect(sidebarRefresh).toBeEnabled();
    await sidebarRefresh.click();
    await expect.poll(() => recordsRefreshRequests).toBeGreaterThan(
      requestsBeforeSidebarRefresh.recordsRefresh
    );
    await expect.poll(() => taskListRequests).toBeGreaterThan(
      requestsBeforeSidebarRefresh.tasks
    );
    await expect.poll(() => optionRequests).toBeGreaterThan(
      requestsBeforeSidebarRefresh.options
    );
    await expect.poll(() => chartRefreshRequests).toBeGreaterThan(
      requestsBeforeSidebarRefresh.chartRefresh
    );

    await page.locator(".downtime-task-sidebar-rail-main").click();
    await expect(taskSidebar).not.toHaveClass(/is-collapsed/);
  });

  test("process picker 由 DetailLinkedPicker 自帶 CSS 置中顯示", async ({ page }) => {
    await installDowntimeApiMocks(page);
    await page.goto("/downtime");

    const processTrigger = page.locator('[data-inline-editor-key="downtime-processCode"]');
    await expect(processTrigger).toBeVisible();
    await processTrigger.click();

    const dialog = page.getByRole("dialog", { name: /(選擇製程|Select Process)/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".detail-picker-option")).toHaveCount(2);

    const backdropPosition = await page
      .locator(".detail-picker-backdrop")
      .evaluate((element) => getComputedStyle(element).position);
    const dialogDisplay = await dialog.evaluate((element) => getComputedStyle(element).display);
    const dialogBox = await dialog.boundingBox();
    const viewport = page.viewportSize();

    expect(backdropPosition).toBe("fixed");
    expect(dialogDisplay).toBe("grid");
    expect(dialogBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(dialogBox!.y).toBeLessThan(viewport!.height * 0.35);
  });

  test("新增停機排隊失敗後可用同一個 clientRowKey 重送", async ({ page }) => {
    const terminalTasks = new Map<string, ReturnType<typeof createMockTask>>();
    const postedClientRowKeys: string[] = [];
    let createCount = 0;

    await installDowntimeApiMocks(page, {
      handleCreateRecord: async (route) => {
        const request = route.request();
        const payload = request.postDataJSON() as { clientRowKey?: string };
        const actorClientId = request.headers()["x-debug-client-id"] ?? null;
        createCount += 1;
        const taskId = `downtime-task-${createCount}`;
        const createdAt = `2026-07-06T00:00:0${createCount}.000Z`;

        postedClientRowKeys.push(String(payload.clientRowKey ?? ""));
        terminalTasks.set(
          taskId,
          createCount === 1
            ? createMockTask({
                taskId,
                status: "failed",
                createdAt,
                finishedAt: "2026-07-06T00:00:03.000Z",
                updatedAt: "2026-07-06T00:00:03.000Z",
                errorCode: "CREATE_DOWNTIME_FAILED",
                errorMessage: "Ragic validation failed",
                actorClientId,
              })
            : createMockTask({
                taskId,
                status: "success",
                entryId: "16-1001",
                createdAt,
                finishedAt: "2026-07-06T00:00:05.000Z",
                updatedAt: "2026-07-06T00:00:05.000Z",
                message: "created",
                actorClientId,
              })
        );

        await route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              taskId,
              status: "pending",
              createdAt,
            },
          }),
        });
      },
      getTasks: () => Array.from(terminalTasks.values()),
      getTask: (taskId) => terminalTasks.get(taskId) ?? null,
    });

    await page.goto("/downtime");

    await page.locator('[data-inline-editor-key="downtime-machineId"]').click();
    await page.locator('.detail-picker-option[data-option-value="W1"]').click();
    await page.locator('[data-inline-editor-key="downtime-processCode"]').click();
    await page.locator('.detail-picker-option[data-option-value="TI01"]').click();
    await page.getByRole("button", { name: /新增停機紀錄|Create Downtime Record/ }).click();

    await expect(
      page.locator(".downtime-page-notice.is-info").filter({ hasText: /已排隊建立|queued/ })
    ).toBeVisible();
    await expect(page.getByText("Ragic validation failed")).toBeVisible();
    await page.getByRole("button", { name: /重送|Retry/ }).click();

    await expect.poll(() => postedClientRowKeys.length).toBe(2);
    expect(postedClientRowKeys[0]).toBeTruthy();
    expect(postedClientRowKeys[1]).toBe(postedClientRowKeys[0]);
    await expect(page.getByText("16-1001")).toBeVisible();
  });
});

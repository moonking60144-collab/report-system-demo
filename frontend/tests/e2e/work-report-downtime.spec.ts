import { expect, test, type Page, type Route } from "@playwright/test";

interface DowntimeApiMockOptions {
  handleCreateRecord?: (route: Route) => Promise<void>;
  handleUpdateRecord?: (route: Route, entryId: string) => Promise<void>;
  handleDeleteRecord?: (route: Route, entryId: string) => Promise<void>;
  handleEfficiencyCsvExport?: (route: Route) => Promise<void>;
  handlePlannedIdleSummary?: (route: Route, url: URL) => Promise<void>;
  getTasks?: () => unknown[];
  getTask?: (taskId: string) => unknown | null;
  getRecords?: () => unknown[];
  getEfficiencyReports?: () => unknown[];
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
    lifecycleState: string;
    acceptedAt: string | null;
    confirmedAt: string | null;
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
    queueKey: "16:downtime:mutation",
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
    lifecycleState: "accepted",
    acceptedAt: now,
    confirmedAt: null,
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
      const records = options.getRecords ? options.getRecords() : [];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: records,
          meta: {
            count: records.length,
            totalCount: records.length,
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

    const recordMutationMatch = url.pathname.match(/^\/api\/downtime\/records\/([^/]+)$/);
    if (recordMutationMatch && method === "PATCH" && options.handleUpdateRecord) {
      await options.handleUpdateRecord(route, decodeURIComponent(recordMutationMatch[1]));
      return;
    }
    if (recordMutationMatch && method === "DELETE" && options.handleDeleteRecord) {
      await options.handleDeleteRecord(route, decodeURIComponent(recordMutationMatch[1]));
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

    if (url.pathname === "/api/downtime/efficiency-reports") {
      const records = options.getEfficiencyReports ? options.getEfficiencyReports() : [];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: records,
          meta: {
            count: records.length,
            totalCount: records.length,
            limit: 20,
            offset: 0,
            hasMore: false,
          },
        }),
      });
      return;
    }

    if (url.pathname === "/api/downtime/export/monthly-csv") {
      if (options.handleEfficiencyCsvExport) {
        await options.handleEfficiencyCsvExport(route);
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "text/csv",
        body: "header\nvalue",
      });
      return;
    }

    if (url.pathname.startsWith("/api/downtime/tasks/")) {
      const taskId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      const task = options.getTask ? options.getTask(taskId) : null;
      await route.fulfill({
        status: task ? 200 : 404,
        contentType: "application/json",
        body: JSON.stringify(
          task
            ? { data: task }
            : { error: { code: "TASK_NOT_FOUND", message: "not found" } }
        ),
      });
      return;
    }

    if (url.pathname === "/api/downtime/planned-idle-summary") {
      if (options.handlePlannedIdleSummary) {
        await options.handlePlannedIdleSummary(route, url);
        return;
      }
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
  test("效率統計可開啟獨立歷史報表並顯示封存版本", async ({ page }) => {
    await installDowntimeApiMocks(page, {
      getEfficiencyReports: () => [
        {
          id: "snapshot-1",
          periodMonth: "2026-06",
          version: 2,
          status: "ready",
          sourceHash: "hash-1",
          sourceRowCount: 12,
          sourceSizeBytes: 1200,
          csvRelativePath: "2026-06/v2/source.csv",
          generatedBy: "client-a",
          createdAt: "2026-07-13T00:00:00.000Z",
          finalizedAt: null,
          artifacts: [],
        },
      ],
    });
    await page.goto("/downtime");

    await page.getByRole("tab", { name: /效率統計|Efficiency Stats/ }).click();
    await page
      .locator(".efficiency-stats-row")
      .filter({ hasText: /查看歷史報表|View Report History/ })
      .click();

    const historyModal = page.locator(".efficiency-history-modal");
    await expect(historyModal).toBeVisible();
    await expect(historyModal).toContainText("2026-06");
    await expect(historyModal).toContainText("v2");
    await expect(historyModal.locator(".efficiency-history-item")).toContainText("12");
    await expect(
      historyModal.getByRole("button", { name: /期間 CSV|Period CSV/ })
    ).toBeVisible();
  });

  test("效率 CSV 匯出尚未完成時停用歷史入口", async ({ page }) => {
    let markExportStarted: (() => void) | undefined;
    const exportStarted = new Promise<void>((resolve) => {
      markExportStarted = resolve;
    });
    let releaseExport: (() => void) | undefined;
    const exportRelease = new Promise<void>((resolve) => {
      releaseExport = resolve;
    });
    await installDowntimeApiMocks(page, {
      handleEfficiencyCsvExport: async (route) => {
        markExportStarted?.();
        await exportRelease;
        await route.fulfill({
          status: 200,
          contentType: "text/csv",
          body: "header\nvalue",
        });
      },
    });
    await page.goto("/downtime");
    await page.getByRole("tab", { name: /效率統計|Efficiency Stats/ }).click();

    const csvButton = page
      .locator(".efficiency-stats-row")
      .filter({ hasText: /下載期間統計 CSV|Download Period Stats CSV/ });
    const historyButton = page
      .locator(".efficiency-stats-row")
      .filter({ hasText: /查看歷史報表|View Report History/ });
    await csvButton.click();
    await exportStarted;
    await expect(historyButton).toBeDisabled();

    releaseExport?.();
    await expect(historyButton).toBeEnabled();
  });

  test("計畫停機重新整理立即進入背景狀態並在快照提交後更新圖表", async ({ page }) => {
    let refreshAccepted = false;
    await installDowntimeApiMocks(page, {
      handlePlannedIdleSummary: async (route, url) => {
        const isRefresh = url.searchParams.get("refresh") === "1";
        if (isRefresh) {
          refreshAccepted = true;
        }
        const committed = refreshAccepted && !isRefresh;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: [
              {
                machineId: committed ? "P20" : "P10",
                prodType: "TI",
                totalMinutes: committed ? 480 : 60,
                totalDays: committed ? 1 : 0.13,
                count: 1,
              },
            ],
            meta: {
              month: "2026/07",
              machineCount: 1,
              source: "sqlite",
              refreshed: false,
              refreshTriggered: isRefresh,
              snapshotAt: committed
                ? "2026-07-20T01:00:00.000Z"
                : "2026-07-20T00:00:00.000Z",
            },
          }),
        });
      },
    });
    await page.goto("/downtime");

    await expect(page.locator(".planned-idle-chart")).toContainText("P10");
    const refreshButton = page.locator(".downtime-chart-refresh-btn");
    await refreshButton.click();
    await expect(refreshButton).toContainText(
      /背景更新中|Refreshing in background/
    );
    await expect(page.locator(".planned-idle-chart")).toContainText("P20", {
      timeout: 10_000,
    });
    await expect(refreshButton).toContainText(/^重新整理$|^Refresh$/);
    await expect(refreshButton).toBeEnabled();
  });

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

  test("Form16 update/delete 在 accepted 後 2 秒內反映，terminal conflict 會 rollback", async ({ page }) => {
    let authoritativeRecord = {
      id: "160001",
      snapshotHash: "snapshot-1",
      date: "2026/08/12",
      machineId: "W1",
      processCode: "TI01",
      operatorId: "TR0001",
      operatorName: "搓牙甲",
      reportType: "TI搓牙",
      startTime: "08:00",
      endTime: "17:00",
      breakTime: "1.00",
      plannedIdleMinutes: 480,
      remark: "before",
      workOrderNo: null,
    };
    let updateSucceeded = false;
    let deleteFailed = false;
    const taskMap = new Map<string, ReturnType<typeof createMockTask>>();

    await installDowntimeApiMocks(page, {
      getRecords: () => [authoritativeRecord],
      handleUpdateRecord: async (route, entryId) => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        taskMap.set(
          "update-task-1",
          createMockTask({
            taskId: "update-task-1",
            taskType: "update-downtime",
            status: "running",
            entryId,
            lifecycleState: "running",
          })
        );
        await route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              taskId: "update-task-1",
              status: "pending",
              createdAt: "2026-08-12T08:00:00.000Z",
              acceptedAt: "2026-08-12T08:00:00.000Z",
              lifecycleState: "accepted",
              confirmedAt: null,
              entryId,
            },
          }),
        });
      },
      handleDeleteRecord: async (route, entryId) => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        taskMap.set(
          "delete-task-1",
          createMockTask({
            taskId: "delete-task-1",
            taskType: "delete-downtime",
            status: "running",
            entryId,
            lifecycleState: "running",
          })
        );
        await route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              taskId: "delete-task-1",
              status: "pending",
              createdAt: "2026-08-12T08:00:01.000Z",
              acceptedAt: "2026-08-12T08:00:01.000Z",
              lifecycleState: "accepted",
              confirmedAt: null,
              entryId,
            },
          }),
        });
      },
      getTasks: () => Array.from(taskMap.values()),
      getTask: (taskId) => {
        const task = taskMap.get(taskId);
        if (!task) return null;
        if (taskId === "update-task-1" && updateSucceeded) {
          authoritativeRecord = { ...authoritativeRecord, remark: "after" };
          return {
            ...task,
            status: "success",
            lifecycleState: "success",
            confirmedAt: "2026-08-12T08:00:02.000Z",
          };
        }
        if (taskId === "delete-task-1" && deleteFailed) {
          return {
            ...task,
            status: "failed",
            lifecycleState: "conflict",
            errorCode: "DOWNTIME_RECORD_STALE",
            errorMessage: "snapshot conflict",
            confirmedAt: "2026-08-12T08:00:03.000Z",
          };
        }
        return task;
      },
    });

    await page.goto("/downtime");
    const tableRows = page.locator(".downtime-record-table tbody tr");
    await expect(tableRows).toHaveCount(1);
    const row = tableRows.first();
    await row.getByRole("button", { name: /^編輯$|^Edit$/ }).click();
    await row.locator('input[type="text"]').fill("after");

    const updateStartedAt = Date.now();
    await row.getByRole("button", { name: /^儲存$|^Save$/ }).click();
    await expect(row).toContainText("after", { timeout: 2_000 });
    await expect(row).toContainText(/待確認|Pending/);
    expect(Date.now() - updateStartedAt).toBeLessThan(2_000);

    updateSucceeded = true;
    await expect(row).not.toHaveClass(/is-optimistic/, { timeout: 10_000 });
    await expect(row).toContainText("after");

    await row.getByRole("button", { name: /^刪除$|^Delete$/ }).click();
    const deleteStartedAt = Date.now();
    await page
      .locator(".ant-modal-confirm")
      .getByRole("button", { name: /^刪除$|^Delete$/ })
      .click();
    await expect(tableRows).toHaveCount(0, { timeout: 2_000 });
    expect(Date.now() - deleteStartedAt).toBeLessThan(2_000);

    deleteFailed = true;
    await expect(tableRows).toHaveCount(1, { timeout: 10_000 });
    await expect(tableRows.first()).toContainText("after");
    await expect(page.locator(".downtime-task-message.is-error")).toContainText(
      "snapshot conflict"
    );
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
        const createdAt = new Date(Date.now() - 1_000 + createCount).toISOString();
        const finishedAt = new Date(Date.parse(createdAt) + 500).toISOString();

        postedClientRowKeys.push(String(payload.clientRowKey ?? ""));
        terminalTasks.set(
          taskId,
          createCount === 1
            ? createMockTask({
                taskId,
                status: "failed",
                createdAt,
                finishedAt,
                updatedAt: finishedAt,
                errorCode: "CREATE_DOWNTIME_FAILED",
                errorMessage: "Ragic validation failed",
                actorClientId,
              })
            : createMockTask({
                taskId,
                status: "success",
                entryId: "16-1001",
                createdAt,
                finishedAt,
                updatedAt: finishedAt,
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

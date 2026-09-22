import { startMeetingCoverage, stopMeetingCoverage } from "./meetingVerificationCoverage";
import { expect, test, type Page, type Route } from "@playwright/test";

test.beforeEach(async ({ page }) => startMeetingCoverage(page));
test.afterEach(async ({ page }) => stopMeetingCoverage(page));
import { mockTaskEvents } from "../helpers/mock-task-events";

interface DowntimeApiMockOptions {
  handleCreateRecord?: (route: Route) => Promise<void>;
  handleUpdateRecord?: (route: Route, entryId: string) => Promise<void>;
  handleDeleteRecord?: (route: Route, entryId: string) => Promise<void>;
  handleEfficiencyCsvExport?: (route: Route) => Promise<void>;
  handlePlannedIdleSummary?: (route: Route, url: URL) => Promise<void>;
  handleTasks?: (route: Route, url: URL) => Promise<void>;
  getTasks?: (url: URL) => unknown[];
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
    formId: "903",
    workOrderNo: null,
    entryId: null,
    rowId: null,
    queueKey: "903:downtime:mutation",
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
                value: "MA01",
                label: "MA01 - 製程 A機",
                display: "製程 A機",
              },
            ],
            processCode: [
              {
                value: "A03",
                label: "A03 - 製程 A",
                display: "製程 A",
                processGroupKey: "thread",
                processGroupLabel: "製程 A",
              },
              {
                value: "A01",
                label: "A01 - 製程 A",
                display: "製程 A",
                processGroupKey: "thread",
                processGroupLabel: "製程 A",
              },
            ],
            operatorId: [
              {
                value: "EMP101",
                label: "EMP101 - 製程 A甲",
                display: "製程 A甲",
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
      if (options.handleTasks) {
        await options.handleTasks(route, url);
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: options.getTasks ? options.getTasks(url) : [],
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
                machineId: committed ? "P20" : "MB50",
                prodType: "PA",
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

    await expect(page.locator(".planned-idle-chart")).toContainText("MB50");
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
    const localClientId = "client-e2e-local-device";
    const taskList = [
      createMockTask({
        taskId: "task-local-device",
        status: "success",
        actorClientId: localClientId,
        actorLabel: "現場平板 A",
        actorIp: "203.0.113.21",
      }),
      createMockTask({
        taskId: "task-other-device",
        taskType: "update-downtime",
        status: "failed",
        actorClientId: "client-e2e-other-device",
        actorLabel: "辦公室電腦",
        actorIp: "203.0.113.35",
      }),
    ];
    await page.addInitScript((clientId) => {
      window.localStorage.setItem("work-report:client-id:v1", clientId);
    }, localClientId);
    let recordsRefreshRequests = 0;
    let recordsListRequests = 0;
    let taskListRequests = 0;
    const taskListActorClientIds: Array<string | null> = [];
    const taskListScopes: Array<string | null> = [];
    let optionRequests = 0;
    let chartRefreshRequests = 0;
    await installDowntimeApiMocks(page, {
      getTasks: (url) =>
        url.searchParams.get("scope") === "mine"
          ? taskList.filter((task) => task.actorClientId === localClientId)
          : taskList,
      onApiRequest: ({ method, pathname, searchParams }) => {
        if (method === "GET" && pathname === "/api/downtime/options") {
          optionRequests += 1;
        }
        if (method === "GET" && pathname === "/api/downtime/tasks") {
          taskListRequests += 1;
          taskListActorClientIds.push(searchParams.get("actorClientId"));
          taskListScopes.push(searchParams.get("scope"));
        }
        if (
          method === "GET" &&
          pathname === "/api/downtime/records"
        ) {
          recordsListRequests += 1;
          if (searchParams.get("refresh") === "1") {
            recordsRefreshRequests += 1;
          }
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
    await expect.poll(() => taskListScopes.includes("all")).toBe(true);
    await expect(taskSidebar.locator(".downtime-task-item")).toHaveCount(2);
    await expect(
      taskSidebar.locator(".downtime-task-item.is-local-device .downtime-task-device-badge")
    ).toHaveText(/本機|This device/);
    await expect(
      taskSidebar.locator(".downtime-task-item.is-local-device .downtime-task-device-detail")
    ).toContainText("現場平板 A");
    await expect(
      taskSidebar.locator(".downtime-task-item.is-other-device .downtime-task-device-badge")
    ).toHaveText(/其他裝置|Other device/);
    await expect(
      taskSidebar.locator(".downtime-task-item.is-other-device .downtime-task-device-detail")
    ).toContainText("辦公室電腦");

    await taskSidebar.getByRole("button", { name: /本機|This device/ }).click();
    await expect.poll(() => taskListScopes.includes("mine")).toBe(true);
    await expect(taskSidebar.locator(".downtime-task-item")).toHaveCount(1);
    await taskSidebar.getByRole("button", { name: /^全部$|^All$/ }).click();
    await expect(taskSidebar.locator(".downtime-task-item")).toHaveCount(2);

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
    const recordsRequestsBeforeScopeChange = recordsListRequests;
    await taskSidebar.getByRole("button", { name: /本機|This device/ }).click();
    await expect.poll(() => recordsListRequests, { timeout: 7_000 }).toBeGreaterThan(
      recordsRequestsBeforeScopeChange
    );
  });

  test("切換本機時延遲的全部回應不能覆蓋新 scope", async ({ page }) => {
    const localClientId = "client-e2e-scope-race";
    const localTask = createMockTask({
      taskId: "task-scope-local",
      status: "success",
      actorClientId: localClientId,
    });
    const otherTask = createMockTask({
      taskId: "task-scope-other",
      status: "success",
      actorClientId: "client-e2e-scope-other",
    });
    let markAllRequestStarted: (() => void) | undefined;
    const allRequestStarted = new Promise<void>((resolve) => {
      markAllRequestStarted = resolve;
    });
    let releaseAllRequest: (() => void) | undefined;
    const allRequestRelease = new Promise<void>((resolve) => {
      releaseAllRequest = resolve;
    });

    await page.addInitScript((clientId) => {
      window.localStorage.setItem("work-report:client-id:v1", clientId);
    }, localClientId);
    await installDowntimeApiMocks(page, {
      handleTasks: async (route, url) => {
        const scope = url.searchParams.get("scope");
        if (scope === "all") {
          markAllRequestStarted?.();
          await allRequestRelease;
          await route
            .fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ data: [localTask, otherTask] }),
            })
            .catch(() => {});
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data: [localTask] }),
        });
      },
    });

    await page.goto("/downtime");
    await allRequestStarted;
    const taskSidebar = page.locator(".downtime-task-sidebar");
    await taskSidebar.getByRole("button", { name: /本機|This device/ }).click();
    await expect(taskSidebar.locator(".downtime-task-item")).toHaveCount(1);
    await expect(taskSidebar).toContainText("task-scope-local");
    await expect(taskSidebar).not.toContainText("task-scope-other");

    releaseAllRequest?.();
    await page.waitForTimeout(300);
    await expect(taskSidebar.getByRole("button", { name: /本機|This device/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(taskSidebar.locator(".downtime-task-item")).toHaveCount(1);
    await expect(taskSidebar).not.toContainText("task-scope-other");
  });

  test("全域 50 筆清單插入本機 accepted task 後不會裁回 20 筆", async ({ page }) => {
    const oldRecentlyUpdatedTask = createMockTask({
      taskId: "task-old-recently-updated",
      status: "success",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-08-26T08:01:00.000Z",
    });
    const taskList = [
      oldRecentlyUpdatedTask,
      ...Array.from({ length: 49 }, (_, index) =>
        createMockTask({
          taskId: `task-history-${String(index).padStart(2, "0")}`,
          status: "success",
          createdAt: new Date(Date.UTC(2026, 6, 1, 0, 0, index)).toISOString(),
          updatedAt: new Date(Date.UTC(2026, 6, 1, 0, 0, index)).toISOString(),
        })
      ),
    ];
    let taskListRequestCount = 0;
    let holdTaskListReload = false;
    let releaseReload: (() => void) | undefined;
    const reloadRelease = new Promise<void>((resolve) => {
      releaseReload = resolve;
    });

    await installDowntimeApiMocks(page, {
      handleCreateRecord: async (route) => {
        holdTaskListReload = true;
        await route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              taskId: "task-new-local",
              status: "pending",
              createdAt: "2026-08-26T08:00:00.000Z",
              acceptedAt: "2026-08-26T08:00:00.000Z",
            },
          }),
        });
      },
      handleTasks: async (route) => {
        taskListRequestCount += 1;
        if (holdTaskListReload) {
          await reloadRelease;
        }
        await route
          .fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ data: taskList }),
          })
          .catch(() => {});
      },
    });

    await page.goto("/downtime");
    const taskSidebar = page.locator(".downtime-task-sidebar");
    await expect(taskSidebar.locator(".downtime-task-item")).toHaveCount(50);

    await page.locator('[data-inline-editor-key="downtime-machineId"]').click();
    await page.locator('.detail-picker-option[data-option-value="MA01"]').click();
    await page.locator('[data-inline-editor-key="downtime-processCode"]').click();
    await page.locator('.detail-picker-option[data-option-value="A01"]').click();
    await page.getByRole("button", { name: /新增停機紀錄|Create Downtime Record/ }).click();

    await expect(taskSidebar).toContainText("task-new-local");
    await expect(taskSidebar.locator(".downtime-task-item")).toHaveCount(50);
    await expect(taskSidebar).toContainText("task-old-recently-updated");
    await expect(taskSidebar).not.toContainText("task-history-00");
    releaseReload?.();
    await expect.poll(() => taskListRequestCount).toBeGreaterThan(1);
  });

  test("其他裝置 running task 只更新卡片，不觸發本機 mutation lifecycle", async ({ page }) => {
    const localClientId = "client-e2e-observer-local";
    let remoteTaskFinished = false;
    let taskDetailRequests = 0;
    let recordsRequests = 0;
    let chartRequests = 0;

    await page.addInitScript((clientId) => {
      window.localStorage.setItem("work-report:client-id:v1", clientId);
    }, localClientId);
    await installDowntimeApiMocks(page, {
      getTasks: () => [
        createMockTask({
          taskId: "task-remote-running",
          taskType: "update-downtime",
          status: remoteTaskFinished ? "success" : "running",
          lifecycleState: remoteTaskFinished ? "success" : "running",
          actorClientId: "client-e2e-observer-remote",
          actorLabel: "遠端平板",
          confirmedAt: remoteTaskFinished ? "2026-08-26T08:00:03.000Z" : null,
        }),
      ],
      onApiRequest: ({ method, pathname }) => {
        if (method !== "GET") {
          return;
        }
        if (pathname === "/api/downtime/records") {
          recordsRequests += 1;
        } else if (pathname === "/api/downtime/planned-idle-summary") {
          chartRequests += 1;
        } else if (pathname === "/api/downtime/tasks/task-remote-running") {
          taskDetailRequests += 1;
        }
      },
    });

    await page.goto("/downtime");
    const remoteTask = page.locator(".downtime-task-item.is-other-device");
    await expect(remoteTask).toContainText(/執行中|Running/);
    const baselineRecordsRequests = recordsRequests;
    const baselineChartRequests = chartRequests;

    remoteTaskFinished = true;
    await expect(remoteTask).toContainText(/成功|Done/, { timeout: 8_000 });
    expect(taskDetailRequests).toBe(0);
    expect(recordsRequests).toBe(baselineRecordsRequests);
    expect(chartRequests).toBe(baselineChartRequests);
    await expect(page.locator(".ant-message-notice")).toHaveCount(0);
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

  test("ActivityLog update/delete 在 accepted 後 2 秒內反映，terminal conflict 會 rollback", async ({ page }) => {
    let authoritativeRecord = {
      id: "160001",
      snapshotHash: "snapshot-1",
      date: "2026/08/12",
      machineId: "MA01",
      processCode: "A01",
      operatorId: "EMP101",
      operatorName: "製程 A甲",
      reportType: "PROC-A",
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
        expect(route.request().postDataJSON()).toEqual({
          remark: "after", fieldPreconditionVersion: 1, expectedValues: { remark: "before" },
        });
        const actorClientId = route.request().headers()["x-debug-client-id"] ?? null;
        await new Promise((resolve) => setTimeout(resolve, 250));
        taskMap.set(
          "update-task-1",
          createMockTask({
            taskId: "update-task-1",
            taskType: "update-downtime",
            status: "running",
            entryId,
            lifecycleState: "running",
            actorClientId,
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
        const actorClientId = route.request().headers()["x-debug-client-id"] ?? null;
        await new Promise((resolve) => setTimeout(resolve, 250));
        taskMap.set(
          "delete-task-1",
          createMockTask({
            taskId: "delete-task-1",
            taskType: "delete-downtime",
            status: "running",
            entryId,
            lifecycleState: "running",
            actorClientId,
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
          authoritativeRecord = { ...authoritativeRecord, machineId: "MA02", remark: "after" };
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
    await expect(row).toContainText("MA02");
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
    await mockTaskEvents(page);
    const terminalTasks = new Map<string, ReturnType<typeof createMockTask>>();
    const postedClientRowKeys: string[] = [];
    let createCount = 0;
    let allowTerminal = false;

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
      getTasks: () => Array.from(terminalTasks.values()).map((task) => allowTerminal ? task : { ...task, status: "pending" }),
      getTask: (taskId) => {
        const task = terminalTasks.get(taskId);
        return task ? allowTerminal ? task : { ...task, status: "pending" } : null;
      },
    });

    await page.goto("/downtime");

    await page.locator('[data-inline-editor-key="downtime-machineId"]').click();
    await page.locator('.detail-picker-option[data-option-value="MA01"]').click();
    await page.locator('[data-inline-editor-key="downtime-processCode"]').click();
    await page.locator('.detail-picker-option[data-option-value="A01"]').click();
    await page.getByRole("button", { name: /新增停機紀錄|Create Downtime Record/ }).click();

    await expect(
      page.locator(".downtime-page-notice.is-info").filter({ hasText: /已排隊建立|queued/ })
    ).toBeVisible();
    allowTerminal = true;
    await page.evaluate("window.taskEventsOpen();window.taskEventsSend('failed-task','903','downtime-task-1')");
    await expect(page.getByText("Ragic validation failed")).toBeVisible({ timeout: 2_000 });
    await page.getByRole("button", { name: /重送|Retry/ }).click();

    await expect.poll(() => postedClientRowKeys.length).toBe(2);
    expect(postedClientRowKeys[0]).toBeTruthy();
    expect(postedClientRowKeys[1]).toBe(postedClientRowKeys[0]);
    await expect(page.getByText("16-1001", { exact: true })).toBeVisible();
  });
});

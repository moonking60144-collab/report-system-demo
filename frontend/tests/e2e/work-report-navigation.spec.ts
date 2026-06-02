import { expect, test } from "@playwright/test";

const OPERATOR_GROUP_STORAGE_KEY = "work-report:operator-group-preference:v1";
const PENDING_MUTATION_REPLAY_STORAGE_KEY = "work-report:pending-mutation-replay:v1";

const MOCK_OPERATOR_OPTIONS_WITH_GROUPS = [
  {
    value: "TR0001",
    label: "TR0001 - Process A #1",
    display: "Process A #1",
    operatorGroupKey: "DEPT-PROCA",
    operatorGroupLabel: "DEPT-PROCA",
  },
  {
    value: "TR0002",
    label: "TR0002 - Process A #2",
    display: "Process A #2",
    operatorGroupKey: "DEPT-PROCA",
    operatorGroupLabel: "DEPT-PROCA",
  },
  {
    value: "HD0001",
    label: "HD0001 - 鍛造甲",
    display: "鍛造甲",
    operatorGroupKey: "DEPT-FORGE",
    operatorGroupLabel: "DEPT-FORGE",
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

async function installMockRealtimeBootReload(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const globalWindow = window as typeof window & {
      __mockEventSourceInstances?: EventTarget[];
      __emitMockRealtimeLifecycle?: (eventName: string, payload: Record<string, unknown>) => boolean;
    };

    globalWindow.__mockEventSourceInstances = [];
    globalWindow.__emitMockRealtimeLifecycle = (eventName, payload) => {
      const instances = globalWindow.__mockEventSourceInstances ?? [];
      const instance = instances[instances.length - 1];
      if (!instance) {
        return false;
      }
      instance.dispatchEvent(
        new MessageEvent(eventName, {
          data: JSON.stringify(payload),
        })
      );
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
  test("refresh 按鈕需經二次確認，確認後才發送同步請求", async ({ page }) => {
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
      });
      globalWindow.__emitMockRealtimeLifecycle?.("ping", {
        at: new Date().toISOString(),
        bootId: "boot-b",
      });
    });

    await navigationPromise;
  });

  test("104 / 105 左右切換後 active preset 穩定", async ({ page }) => {
    await page.goto(
      "/?page=1&pageSize=25&landingPage=heading-105&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88"
    );
    await dismissSystemNoticeIfPresent(page);

    await page.getByRole("tab", { name: /(Process A Report|Thread Rolling)/ }).click();
    await expect(
      page.getByRole("button", { name: /(未結案可執行|Open Runnable)/ })
    ).toHaveClass(/is-active/);

    await page.getByRole("tab", { name: /(Process B Report|Heading)/ }).click();
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

    await page.getByRole("tab", { name: /(Process A Report|Thread Rolling)/ }).click();
    const workOrderButton = page.locator(".ragic-table .ant-table-tbody .work-order-cell-button").first();
    await workOrderButton.click({ force: true });

    await expect(page).toHaveURL(/\/reports\/104\//);
    await expect(page).toHaveURL(/landingPage=thread-rolling-104/);
    await expect(page).not.toHaveURL(/landingPage=heading-105/);
  });

  test("明細列雙擊後會進入整列 inline 編輯模式", async ({ page }) => {
    await page.goto(
      "/reports/104/26187?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
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
    await expect(targetRow.locator("[data-inline-editor-key='setupTimeStandardHours']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='setupLossQtyPerPcs']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='processLossQtyPerPcs']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='totalContainerQty']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='containerUnit']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='plannedIdleMinutes']")).toHaveCount(1);
    await expect(targetRow.locator("input[type='time']")).toHaveCount(2);
    await expect(targetRow.locator("[data-inline-editor-key='productionQty']")).toHaveCount(1);
    await expect(targetRow.getByRole("button", { name: /(儲存|Save)/ })).toBeVisible();
    await expect(targetRow.getByRole("button", { name: /(取消|Cancel)/ })).toBeVisible();
  });

  test("服務重啟後重新載入頁面時，會自動補送剛剛失敗的那筆 mutation", async ({ page }) => {
    const replayPayload = {
      kind: "update",
      formId: "104",
      entryId: "26187",
      rowId: "111762",
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

    await page.route("**/api/forms/104/reports/26187/111762?async=1", async (route) => {
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
            entryId: "26187",
            rowId: "111762",
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
            entryId: "26187",
            queueKey: "104:26187",
            status,
            createdAt: "2026-03-17T01:00:01.000Z",
            updatedAt: "2026-03-17T01:00:02.000Z",
            ...(status === "success" ? { result: { rowId: "111762" } } : {}),
          },
          meta: {
            formId: "104",
            taskId: "replay-task-001",
          },
        }),
      });
    });

    await page.goto(
      "/reports/104/26187?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
    );

    await expect
      .poll(() => (replayRequestSeen ? "seen" : "pending"))
      .toBe("seen");
    expect(replayMutationHeader).toBe("replay-mutation-001");
    await expect(page.locator(".detail-system-status")).toContainText(
      /已完成更新報工明細|Report detail updated/i
    );
  });

  test("系統更新時，明細頁若正在編輯會在結束後自動重新載入", async ({ page }) => {
    await installMockRealtimeBootReload(page);
    await page.goto(
      "/reports/104/26187?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
    );

    const targetRow = page.locator(".detail-subtable tbody tr[data-row-id]").nth(0);
    await targetRow.dblclick({ force: true });

    await page.evaluate(() => {
      const globalWindow = window as typeof window & {
        __emitMockRealtimeLifecycle?: (eventName: string, payload: Record<string, unknown>) => boolean;
      };
      globalWindow.__emitMockRealtimeLifecycle?.("ready", {
        status: "ok",
        at: new Date().toISOString(),
        bootId: "boot-a",
      });
      globalWindow.__emitMockRealtimeLifecycle?.("ping", {
        at: new Date().toISOString(),
        bootId: "boot-b",
      });
    });

    await expect(page.locator(".detail-system-status")).toContainText(
      /系統已更新，完成目前操作後將自動重新載入頁面|System update detected/i
    );
    await expect(targetRow.getByRole("button", { name: /(取消|Cancel)/ })).toBeVisible();

    const navigationPromise = page.waitForNavigation({ waitUntil: "load" });
    await targetRow.getByRole("button", { name: /(取消|Cancel)/ }).click();
    await navigationPromise;
  });

  test("明細表底部會保留空白新增列，點一下就進入 inline create", async ({ page }) => {
    await page.goto(
      "/reports/104/26187?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
    );

    const placeholderRows = page.locator(".detail-subtable tbody tr[data-row-kind='create-placeholder']");
    await expect(placeholderRows).toHaveCount(3);

    const targetPlaceholderRow = placeholderRows.first();
    await targetPlaceholderRow.locator("td").first().click({ force: true });

    await expect(targetPlaceholderRow).toHaveClass(/is-inline-editing/);
    await expect(targetPlaceholderRow.locator("[data-inline-editor-key='date']")).toHaveCount(1);
    await expect(targetPlaceholderRow.locator("[data-inline-editor-key='machineId']")).toHaveCount(1);
    await expect(targetPlaceholderRow.locator("[data-inline-editor-key='operatorId']")).toHaveCount(1);
    await expect(targetPlaceholderRow.locator("[data-inline-editor-key='productionQty']")).toHaveCount(1);
    await expect(targetPlaceholderRow.getByRole("button", { name: /(儲存|Save)/ })).toBeVisible();
  });

  test("底部空白新增列儲存時會走 create 背景任務", async ({ page }) => {
    await page.goto(
      "/reports/104/26187?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
    );

    const targetPlaceholderRow = page
      .locator(".detail-subtable tbody tr[data-row-kind='create-placeholder']")
      .first();

    const taskId = "create-task-inline-001";
    let createRequestSeen = false;
    let taskPollCount = 0;

    await page.route("**/api/forms/104/reports/26187?async=1", async (route) => {
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
          },
          meta: {
            formId: "104",
            entryId: "26187",
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
            entryId: "26187",
            queueKey: "104:26187",
            status,
            createdAt: "2026-03-16T10:00:00.000Z",
            updatedAt: "2026-03-16T10:00:01.000Z",
            ...(status === "success" ? { result: { rowId: "199999" } } : {}),
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

    const machineTrigger = targetPlaceholderRow.locator("[data-inline-editor-key='machineId']");
    await machineTrigger.click();
    const machineDialog = page.getByRole("dialog", { name: /(選擇機台|Select Machine)/ });
    await expect(machineDialog).toBeVisible();
    await machineDialog.locator(".detail-picker-option").first().click();
    await expect(machineDialog).toHaveCount(0);

    const operatorTrigger = targetPlaceholderRow.locator("[data-inline-editor-key='operatorId']");
    await operatorTrigger.click();
    const operatorDialog = page.getByRole("dialog", { name: /(選擇操作員|Select Operator)/ });
    await expect(operatorDialog).toBeVisible();
    await operatorDialog.locator(".detail-picker-option").first().click();
    await expect(operatorDialog).toHaveCount(0);

    await targetPlaceholderRow.locator("[data-inline-editor-key='startTime']").fill("08:00");
    await targetPlaceholderRow.locator("[data-inline-editor-key='endTime']").fill("17:00");
    await targetPlaceholderRow.locator("[data-inline-editor-key='productionQty']").fill("25");
    await targetPlaceholderRow.getByRole("button", { name: /(儲存|Save)/ }).click();

    await expect
      .poll(() => (createRequestSeen ? "seen" : "pending"))
      .toBe("seen");
    await expect(page.locator(".detail-system-status")).toContainText(/已受理新增|Create accepted/i);
    await expect
      .poll(() => taskPollCount)
      .toBeGreaterThan(1);
    await expect(page.locator(".detail-system-status")).toContainText(
      /已完成新增報工明細|Report detail created/i
    );
  });

  test("明細頁製程欄位顯示子製程代碼而不是製程名稱", async ({ page }) => {
    await page.goto(
      "/reports/104/26187?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
    );

    const firstProcessCell = page.locator(".detail-subtable tbody tr[data-row-id]").nth(0).locator("td.col-process");
    await expect(firstProcessCell).toBeVisible();
    await expect(firstProcessCell).toContainText(/TI\d+/);
    await expect(firstProcessCell).not.toContainText(/Thread Rolling/i);
  });

  test("隱藏單一可直編欄位後，不會再出現對應 editor", async ({ page }) => {
    await page.goto(
      "/reports/104/26187?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
    );

    await page.getByRole("button", { name: /(欄位|Columns)/ }).click();
    const panel = page.locator(".detail-column-settings-panel");
    await expect(panel).toBeVisible();

    const qtyCheckbox = panel
      .getByRole("checkbox", { name: /^(產量|Qty)$/ });
    await qtyCheckbox.uncheck();

    const targetRow = page.locator(".detail-subtable tbody tr[data-row-id]").nth(0);
    await targetRow.dblclick({ force: true });

    await expect(targetRow.locator("[data-inline-editor-key='inputOptions']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='shiftType']")).toHaveCount(1);
    await expect(targetRow.locator("input[type='time']")).toHaveCount(2);
    await expect(targetRow.locator("[data-inline-editor-key='productionQty']")).toHaveCount(0);
  });

  test("若所有可直編欄位都被隱藏，雙擊列不進半套編輯", async ({ page }) => {
    await page.goto(
      "/reports/104/26187?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
    );

    await page.getByRole("button", { name: /(欄位|Columns)/ }).click();
    const panel = page.locator(".detail-column-settings-panel");
    await expect(panel).toBeVisible();

    const editableLabels = [
      /^(日期|Date)$/,
      /^(機台|Machine)$/,
      /^(操作員工號|Operator ID)$/,
      /^(製程|Process)$/,
      /^(預設報工時間|Input Options)$/,
      /^(班別|Shift)$/,
      /^(開工時間|Start Time)$/,
      /^(完工時間|End Time)$/,
      /^(扣除休息時間|Break Time)$/,
      /^(產量|Qty)$/,
      /^Count Setup Time計算架車時間\? \(v\)$/,
      /^\[標準\]架車時間 \(Hr\)$/,
      /^Setup Loss架車損耗\/PCS$/,
      /^Process Loss製程損耗\/PCS$/,
      /^Total Container Qty結案容器數$/,
      /^Container Unit結案容器單位$/,
      /^\(P\)Planned Idle計劃停機\/分$/,
      /^\(S\)Unplanned Idle自主停機\/分$/,
      /^\(M\)Absent or Training人員請假\.上課\/分$/,
      /^\(C\)待料No Material\/分$/,
      /^\(E\)Waiting for QC Approval 待判\/分$/,
      /^\(Q\)Meeting 開會\/分$/,
      /^\(N\)Cleaning打掃\/分$/,
      /^RD SamplingRD件試樣\/分$/,
      /^\(H\)Support Other Machines支援其他車台\/分$/,
      /^\(D\)Machine Breakdown 機台損壞\/分$/,
      /^\(K\)Machine Adjustment 機台調機\/分$/,
      /^\(F\)Others 其他\/分$/,
      /^\(B\)Waiting for Dies 待模\/分$/,
      /^\(R\)Testing Dies 試模\/分$/,
    ];

    for (const labelPattern of editableLabels) {
      const checkbox = panel.getByRole("checkbox", { name: labelPattern });
      await checkbox.uncheck();
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
    await expect(targetRow.locator("input[type='time']")).toHaveCount(0);
    await expect(targetRow.locator("[data-inline-editor-key='productionQty']")).toHaveCount(0);
    await expect(targetRow.getByRole("button", { name: /(儲存|Save)/ })).toHaveCount(0);
  });

  test("inputOptions 用獨立選取視窗選取後會自動帶入班別與時間", async ({ page }) => {
    await page.goto(
      "/reports/104/26187?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
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
      "/reports/104/26187?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
    );

    const targetRow = page.locator(".detail-subtable tbody tr[data-row-id]").nth(0);
    const rowId = await targetRow.getAttribute("data-row-id");
    expect(rowId).toBeTruthy();

    const taskId = "update-task-inline-001";
    let updateRequestSeen = false;
    let taskPollCount = 0;

    await page.route(`**/api/forms/104/reports/26187/${rowId}?async=1`, async (route) => {
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
            entryId: "26187",
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
            entryId: "26187",
            queueKey: "104:26187",
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
      "/reports/104/26187?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
    );

    const targetRow = page.locator(".detail-subtable tbody tr[data-row-id]").nth(0);
    const rowId = await targetRow.getAttribute("data-row-id");
    expect(rowId).toBeTruthy();

    let deleteRequestCount = 0;
    await page.route(`**/api/forms/104/reports/26187/${rowId}`, async (route) => {
      if (route.request().method() !== "DELETE") {
        await route.fallback();
        return;
      }
      deleteRequestCount += 1;
      await route.fulfill({
        status: 204,
        body: "",
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
      /已永久刪除報工明細|Report detail deleted permanently/i
    );
  });

  test("顯示 remark 與 setup 欄位後，會進入第二階段直編", async ({ page }) => {
    await page.goto(
      "/reports/104/26187?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
    );

    await page.getByRole("button", { name: /(欄位|Columns)/ }).click();
    const panel = page.locator(".detail-column-settings-panel");
    await expect(panel).toBeVisible();

    await panel.getByRole("checkbox", { name: /^(備註|Remark)$/ }).check();
    await panel.getByRole("checkbox", { name: /^Setup\/Adjust架車\(BA\)or調機\(SA\)$/ }).check();
    await panel.getByRole("checkbox", { name: /^Setup\/Adjust \(Min\)架\.調車\/分鐘$/ }).check();

    const targetRow = page.locator(".detail-subtable tbody tr[data-row-id]").nth(0);
    await targetRow.dblclick({ force: true });

    await expect(targetRow.locator("[data-inline-editor-key='remark']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='setupAdjustType']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='setupAdjustMinutes']")).toHaveCount(1);
  });

  test("日期與 setup/container 欄位會進入後續階段直編，計畫停機維持 display-only", async ({ page }) => {
    await page.goto(
      "/reports/104/26187?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
    );

    const targetRow = page.locator(".detail-subtable tbody tr[data-row-id]").nth(0);
    await targetRow.dblclick({ force: true });

    await expect(targetRow.locator("[data-inline-editor-key='date']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='setupTimeStandardHours']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='setupLossQtyPerPcs']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='processLossQtyPerPcs']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='totalContainerQty']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='containerUnit']")).toHaveCount(1);
    await expect(targetRow.locator("[data-inline-editor-key='plannedIdle']")).toHaveCount(0);
  });

  test("linked 欄位會進入第三階段直編，operator 變更時會同步顯示姓名", async ({ page }) => {
    await page.goto(
      "/reports/104/26187?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
    );

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
      "/reports/104/26187?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
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
      "/reports/104/26187?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
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
      "/reports/104/26187?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
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

  test("104 操作員群組預設為 Process A 組，切換後會記住並同步到新增明細", async ({ page }) => {
    await resetOperatorGroupPreference(page);
    await mockOperatorOptionsWithGroups(page, "104");
    await page.goto(
      "/reports/104/26187?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
    );

    const targetRow = page.locator(".detail-subtable tbody tr[data-row-id]").nth(0);
    await targetRow.dblclick({ force: true });

    const operatorTrigger = targetRow.locator("[data-inline-editor-key='operatorId']");
    await operatorTrigger.click();

    const dialog = page.getByRole("dialog", { name: /(選擇操作員|Select Operator)/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "DEPT-PROCA" })).toHaveClass(/is-active/);
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
    await expect(createPickerDialog.getByRole("button", { name: "DEPT-FORGE" })).toHaveClass(
      /is-active/
    );
    await expect(
      createPickerDialog.locator(".detail-picker-option[data-option-value='HD0001']")
    ).toBeVisible();
  });

  test("新增報工的架調車 / 損耗 / 容器區塊預設展開", async ({ page }) => {
    await page.goto(
      "/reports/104/26187?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
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
      createDialog.getByText(/Setup\/Adjust架車\(BA\)or調機\(SA\)/)
    ).toBeVisible();
    await expect(
      createDialog.getByText(/Count Setup Time計算架車時間\? \(v\)/)
    ).toBeVisible();
    await expect(
      createDialog.getByRole("button", {
        name: /架調車 \/ 損耗 \/ 容器|Setup \/ Loss \/ Container/,
      })
    ).toHaveCount(0);
  });

  test("shiftType 會用獨立選取視窗搜尋並回填到目前列", async ({ page }) => {
    await page.goto(
      "/reports/104/26187?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
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
      "/reports/104/26187?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
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
      "/reports/104/26187?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
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
      "/reports/104/26187?page=1&pageSize=25&landingPage=thread-rolling-104&topView=report&fStatus=%E6%9C%AA%E7%B5%90%E6%A1%88&fStartSchedule=yes&fMachine=W1"
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
    await expect(
      panel.getByRole("checkbox", { name: /^Setup\/Adjust架車\(BA\)or調機\(SA\)$/ })
    ).toBeChecked();
    await expect(
      panel.getByRole("checkbox", { name: /^Setup\/Adjust \(Min\)架\.調車\/分鐘$/ })
    ).toBeChecked();
    await expect(
      panel.getByRole("checkbox", { name: /^Count Setup Time計算架車時間\? \(v\)$/ })
    ).toBeChecked();
    await expect(
      panel.getByRole("checkbox", { name: /^\[標準\]架車時間 \(Hr\)$/ })
    ).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^Setup Loss架車損耗\/PCS$/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^Process Loss製程損耗\/PCS$/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^Total Container Qty結案容器數$/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^Container Unit結案容器單位$/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^\(P\)Planned Idle計劃停機\/分$/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^\(S\)Unplanned Idle自主停機\/分$/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^\(M\)Absent or Training人員請假\.上課\/分$/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^\(C\)待料No Material\/分$/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^\(E\)Waiting for QC Approval 待判\/分$/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^\(Q\)Meeting 開會\/分$/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^\(N\)Cleaning打掃\/分$/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^RD SamplingRD件試樣\/分$/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^\(H\)Support Other Machines支援其他車台\/分$/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^\(D\)Machine Breakdown 機台損壞\/分$/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^\(K\)Machine Adjustment 機台調機\/分$/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^\(F\)Others 其他\/分$/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^\(B\)Waiting for Dies 待模\/分$/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^\(R\)Testing Dies 試模\/分$/ })).toBeChecked();
    await expect(
      panel.getByRole("checkbox", { name: /^\(1012831\)\[實際\]生產時間\(分\) \(總時數-架調車-非擔當\)$/ })
    ).toBeChecked();
    await expect(
      panel.getByRole("checkbox", { name: /^Time Used %工時耗用率%1$/ })
    ).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^開單者帳號$/ })).toBeChecked();

    await expect(panel.getByRole("checkbox", { name: /^rowId$/ })).not.toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^Type報工類別$/ })).not.toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^Created建立日期時間$/ })).not.toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /^Dep\.報工單位別$/ })).not.toBeChecked();
    await expect(
      panel.getByRole("checkbox", { name: /^\[Default\]Efficiency Code\[預設\]製程標準識別碼$/ })
    ).not.toBeChecked();
    await expect(
      panel.getByRole("checkbox", { name: /^\[Assigned\]Efficiency Standard\[指定\]製程標準識別碼$/ })
    ).not.toBeChecked();
    await expect(
      panel.getByRole("checkbox", { name: /^\[分類生產產量\]HF01$/ })
    ).not.toBeChecked();
    await expect(
      panel.getByRole("checkbox", { name: /^\[分類生產產量\]HF02$/ })
    ).not.toBeChecked();
    await expect(
      panel.getByRole("checkbox", { name: /^組成測試\[可刪\]$/ })
    ).not.toBeChecked();
  });
});

import { mockTaskEvents } from "../helpers/mock-task-events";
import { expect, test, type Page, type Route } from "@playwright/test";

const TEST_DOCUMENT = `<!doctype html><html lang="zh-Hant"><head>
<meta charset="utf-8"><title>Task Queue</title></head><body><div id="root"></div>
<script type="module">
import RefreshRuntime from "/@react-refresh";
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => undefined;
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
window.localStorage.setItem("work-reports:901:ui-language", "zh");
</script><script type="module">
import { mountTaskQueueFixture } from "/tests/fixtures/work-report-task-queue-fixture.tsx";
mountTaskQueueFixture(document.querySelector("#root"));
</script></body></html>`;

const task = {
  taskId: "task-other-device",
  taskType: "create-report",
  formId: "901",
  entryId: "entry-other",
  status: "success",
  workOrderNo: "WO-OTHER-DEVICE",
  createdAt: "2026-09-11T00:00:00Z",
  finishedAt: "2026-09-11T00:00:01Z",
  actorClientId: "other-device",
};

const reply = (route: Route, tasks: unknown[] = []) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ data: tasks }),
});


test("SSE 合併完成事件立即刷新，連線正常時使用低頻補查，關閉後不查詢", async ({ page }) => {
  await mockTaskEvents(page);
  let reads = 0;
  let completed = false;
  await mount(page, async (route) => { reads += 1; await reply(route, completed ? [task] : []); });
  const drawer = page.getByRole("dialog", { name: "任務中心" });
  await expect(drawer.getByText("目前沒有任務紀錄")).toBeVisible();
  await page.evaluate("window.taskEventsOpen()");
  await page.clock.runFor(150);
  await expect.poll(() => reads).toBe(2);
  completed = true;
  await page.evaluate("for(let i=0;i<5;i++)window.taskEventsSend('event-'+i)");
  await page.clock.runFor(150);
  await expect(drawer.getByText("WO-OTHER-DEVICE", { exact: false })).toBeVisible();
  expect(reads).toBe(3);
  await page.clock.runFor(10_000);
  expect(reads).toBe(3);
  await drawer.getByRole("button", { name: "關閉", exact: true }).click();
  await page.evaluate("window.taskEventsSend('after-close')");
  await page.clock.runFor(35_000);
  expect(reads).toBe(3);
});

test("SSE 在舊查詢飛行中到達時，完成後補查一次且不混入其他表單事件", async ({ page }) => {
  await mockTaskEvents(page);
  let reads = 0;
  let held: Route | undefined;
  await mount(page, async (route) => {
    reads += 1;
    if (reads === 2) held = route;
    else await reply(route, reads >= 3 ? [task] : []);
  });
  const drawer = page.getByRole("dialog", { name: "任務中心" });
  await expect(drawer.getByText("目前沒有任務紀錄")).toBeVisible();
  await page.evaluate("window.taskEventsOpen()");
  await page.clock.runFor(150);
  await expect.poll(() => Boolean(held)).toBe(true);
  await page.evaluate("window.taskEventsSend('other-form','902')");
  await page.clock.runFor(150);
  expect(reads).toBe(2);
  await page.evaluate("window.taskEventsSend('terminal')");
  await page.clock.runFor(150);
  expect(reads).toBe(2);
  await reply(held!);
  await expect(drawer.getByText("WO-OTHER-DEVICE", { exact: false })).toBeVisible();
  expect(reads).toBe(3);
});

async function mount(page: Page, handler: (route: Route) => Promise<void>, deferred = false) {
  await page.clock.install();
  await page.route("**/__task-queue__*", (route) =>
    route.fulfill({ contentType: "text/html", body: TEST_DOCUMENT })
  );
  // Every API request stays inside the fixture, including unexpected requests.
  await page.route(/^https?:\/\/[^/]+\/api\//, (route) => route.abort());
  await page.route(/\/api\/forms\/\d+\/tasks\?/, handler);
  await page.goto(deferred ? "/__task-queue__?deferred" : "/__task-queue__");
  if (!deferred) await page.getByRole("button", { name: "開啟任務中心" }).click();
}

test("關閉重開保留範圍與失敗篩選，同範圍更新保留既有資料", async ({ page }) => {
  let held: Route | undefined;
  let allReads = 0;
  await mount(page, async (route) => {
    if (new URL(route.request().url()).searchParams.has("taskTypes")) {
      allReads += 1;
      if (allReads > 1) { held = route; return; }
      await reply(route, [{ ...task, status: "failed" }]);
    } else await reply(route);
  });
  const drawer = page.getByRole("dialog", { name: "任務中心" });
  await expect(drawer.getByText("目前沒有任務紀錄")).toBeVisible();
  await drawer.getByRole("button", { name: "全部新增", exact: true }).click();
  await expect(drawer.getByText("WO-OTHER-DEVICE", { exact: false })).toBeVisible();
  await drawer.getByRole("checkbox", { name: "僅顯示失敗" }).check();
  await drawer.getByRole("button", { name: "關閉", exact: true }).click();
  await expect(drawer).not.toBeVisible();
  await page.getByRole("button", { name: "開啟任務中心" }).click();
  await expect.poll(() => Boolean(held)).toBe(true);
  await expect(drawer.getByRole("button", { name: "全部新增", exact: true })).toHaveClass(/is-active/);
  await expect(drawer.getByRole("checkbox", { name: "僅顯示失敗" })).toBeChecked();
  await expect(drawer.getByText("WO-OTHER-DEVICE", { exact: false })).toBeVisible();
  await expect(drawer.getByText("資料讀取中...")).toHaveCount(0);
  await reply(held!, [{ ...task, status: "failed" }]);
});

test("切換範圍立即移除別的裝置資料，慢回應不會覆蓋目前範圍", async ({ page }) => {
  let heldAll: Route | undefined;
  let allReads = 0;
  await mount(page, async (route) => {
    const mine = new URL(route.request().url()).searchParams.has("actorClientId");
    if (mine) await reply(route);
    else if (++allReads === 1) await reply(route, [task]);
    else heldAll = route;
  });
  const drawer = page.getByRole("dialog", { name: "任務中心" });
  await expect(drawer.getByText("目前沒有任務紀錄")).toBeVisible();
  await drawer.getByRole("button", { name: "全部", exact: true }).click();
  await expect(drawer.getByText("WO-OTHER-DEVICE", { exact: false })).toBeVisible();
  await drawer.getByRole("button", { name: "重新整理", exact: true }).click();
  await expect.poll(() => Boolean(heldAll)).toBe(true);
  await drawer.getByRole("button", { name: "我的裝置", exact: true }).click();
  await expect(drawer.getByText("WO-OTHER-DEVICE", { exact: false })).toHaveCount(0);
  await expect(drawer.getByText("目前沒有任務紀錄")).toBeVisible();
  await reply(heldAll!, [task]);
  await expect(drawer.getByText("WO-OTHER-DEVICE", { exact: false })).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: "我的裝置", exact: true })).toHaveClass(/is-active/);
});

test("任務中心以工作結果為主，並顯示批次進度與動態更新頻率", async ({ page }) => {
  let reads = 0;
  let completed = false;
  await mount(page, async (route) => {
    reads += 1;
    await reply(route, [
      {
        ...task,
        taskId: "12345678-abcd-efgh-ijkl-1234567890ab",
        taskType: "create-report-batch",
        status: completed ? "success" : "running",
        workOrderNo: "WO-BATCH-UX",
        batchRequestedCount: 6,
        batchCreatedCount: completed ? 6 : 3,
        batchFailedCount: 0,
      },
    ]);
  });

  const drawer = page.getByRole("dialog", { name: "任務中心" });
  await expect(drawer.getByText("批次新增", { exact: true })).toBeVisible();
  await expect(drawer.getByText("工令單號: WO-BATCH-UX", { exact: true })).toBeVisible();
  await expect(drawer.getByText("任務編號: 12345678", { exact: true })).toBeVisible();
  await expect(drawer.getByText("寫入中", { exact: true })).toBeVisible();
  await expect(drawer.getByText("處理中 1", { exact: true })).toBeVisible();
  await expect(drawer.getByText("已完成 0", { exact: true })).toHaveCount(0);
  await expect(drawer.getByText("需處理 0", { exact: true })).toHaveCount(0);
  await expect(drawer.getByText("處理進度 3 / 6", { exact: true })).toBeVisible();
  await expect(drawer.getByRole("progressbar", { name: "批次新增處理進度" })).toHaveAttribute(
    "aria-valuenow",
    "3"
  );

  await page.clock.runFor(5_100);
  expect(reads).toBe(2);
  completed = true;
  await page.clock.runFor(5_100);
  await expect(drawer.getByText("已寫入", { exact: true })).toBeVisible();
  await expect(drawer.getByText("已完成 1", { exact: true })).toBeVisible();
  await expect(drawer.getByText("處理進度 6 / 6", { exact: true })).toBeVisible();
  const completedReads = reads;

  await page.clock.runFor(1_000);
  expect(reads).toBe(completedReads);
});

test("空結果背景輪詢不閃爍，失敗仍保留空結果且允許重試", async ({ page }) => {
  let reads = 0;
  let held: Route | undefined;
  await mount(page, async (route) => {
    if (++reads === 1) await reply(route);
    else held = route;
  });
  const drawer = page.getByRole("dialog", { name: "任務中心" });
  await expect(drawer.getByText("目前沒有任務紀錄")).toBeVisible();
  await page.clock.runFor(10100);
  await expect.poll(() => Boolean(held)).toBe(true);
  await expect(drawer.getByText("目前沒有任務紀錄")).toBeVisible();
  await expect(drawer.getByText("資料讀取中...")).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: "更新中…" })).toBeDisabled();
  await page.clock.runFor(10000);
  expect(reads).toBe(2);
  await held!.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "unavailable" }) });
  await expect(drawer.getByRole("alert")).toBeVisible();
  await expect(drawer.getByText("目前沒有任務紀錄")).toBeVisible();
  await expect(drawer.getByRole("button", { name: "重新整理", exact: true })).toBeEnabled();
});

test("回到前景立即更新，focus 與輪詢共用請求，關閉後停止輪詢", async ({ page }) => {
  let reads = 0;
  let held: Route | undefined;
  await mount(page, async (route) => {
    if (++reads === 1) await reply(route);
    else held = route;
  });
  const drawer = page.getByRole("dialog", { name: "任務中心" });
  await expect(drawer.getByText("目前沒有任務紀錄")).toBeVisible();
  await page.evaluate(() => Object.defineProperty(document, "hidden", { configurable: true, value: true }));
  await page.clock.runFor(10000);
  expect(reads).toBe(1);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
  await expect.poll(() => Boolean(held)).toBe(true);
  expect(reads).toBe(2);
  await page.clock.runFor(10000);
  expect(reads).toBe(2);
  await drawer.getByRole("button", { name: "關閉", exact: true }).click();
  await page.clock.runFor(10000);
  expect(reads).toBe(2);
  await reply(held!);
});

test("延遲操作完成時更新目前範圍，關閉後不重新發出查詢", async ({ page }) => {
  let mineReads = 0;
  let allReads = 0;
  let held: Route | undefined;
  await mount(page, async (route) => {
    if (new URL(route.request().url()).searchParams.has("actorClientId")) {
      mineReads += 1;
      await reply(route, [{ ...task, taskId: "mine-task" }]);
    } else {
      allReads += 1;
      if (allReads === 1) held = route;
      else await reply(route, [task]);
    }
  }, true);
  await expect(page.getByRole("status")).toHaveText("mine-task");
  const initialMineReads = mineReads;
  await page.getByRole("button", { name: "保留更新回呼" }).click();
  await page.getByRole("button", { name: "切換全部" }).click();
  await expect.poll(() => Boolean(held)).toBe(true);
  await page.getByRole("button", { name: "完成延遲操作" }).click();
  await reply(held!, [task]);
  await expect(page.getByRole("status")).toHaveText("task-other-device");
  expect(mineReads).toBe(initialMineReads);
  await expect.poll(() => allReads).toBe(2);
  await page.getByRole("button", { name: "關閉查詢" }).click();
  await page.getByRole("button", { name: "完成延遲操作" }).click();
  await page.clock.runFor(10000);
  expect(mineReads).toBe(initialMineReads);
  expect(allReads).toBe(2);
});

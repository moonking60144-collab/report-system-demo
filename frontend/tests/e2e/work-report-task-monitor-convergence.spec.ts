import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    __workReportTaskConvergenceReady?: boolean;
    __workReportTaskConvergenceState?: {
      status: string | null;
      lifecycleState: string | null;
      optimisticState: string | null;
      retryCount: number;
    };
  }
}

const TEST_DOCUMENT = `<!doctype html>
<html lang="zh-Hant">
<head><meta charset="utf-8"><title>Task Monitor Convergence</title></head>
<body>
  <div id="root"></div>
  <script type="module">
    import RefreshRuntime from "/@react-refresh";
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => undefined;
    window.$RefreshSig$ = () => (type) => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    window.localStorage.clear();
  </script>
  <script type="module">
    import { mountWorkReportTaskMonitorConvergence } from "/tests/fixtures/work-report-task-monitor-convergence-fixture.tsx";
    mountWorkReportTaskMonitorConvergence(document.querySelector("#root"));
  </script>
</body>
</html>`;

test("離開列表後 indeterminate schedule task 仍由全域 provider strict reconcile", async ({
  page,
}) => {
  let taskReadCount = 0;
  let strictReadCount = 0;
  await page.route("**/__work-report-task-monitor-convergence__", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: TEST_DOCUMENT })
  );
  await page.route("**/api/forms/901/reports/tasks/task-global", (route) => {
    taskReadCount += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          taskId: "task-global",
          taskType: "update-report",
          formId: "901",
          entryId: "E-GLOBAL",
          queueKey: "901:E-GLOBAL",
          status: "failed",
          lifecycleState: "indeterminate",
          acceptedAt: "2026-08-31T00:00:00.000Z",
          confirmedAt: null,
          writeIndeterminate: true,
          createdAt: "2026-08-31T00:00:00.000Z",
          updatedAt: "2026-08-31T00:00:01.000Z",
          error: {
            code: "TASK_REGISTRY_RECOVERED_AFTER_RESTART",
            message: "寫入結果尚未確認",
          },
        },
      }),
    });
  });
  await page.route("**/api/forms/901/reports/E-GLOBAL?*", (route) => {
    strictReadCount += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("refresh")).toBe("1");
    expect(url.searchParams.get("strictRefresh")).toBe("1");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          id: "E-GLOBAL",
          workOrderNo: "WO-GLOBAL",
          status: "未結案",
          customerPartNo: null,
          erpPartNo: null,
          sortOrder: 11,
          reports: [],
        },
        meta: { cacheSource: "ragic-live", cacheState: "fresh" },
      }),
    });
  });

  await page.goto("/__work-report-task-monitor-convergence__");
  await page.waitForFunction(() => window.__workReportTaskConvergenceReady === true);
  await expect
    .poll(() => page.evaluate(() => window.__workReportTaskConvergenceState))
    .toEqual({
      status: "success",
      lifecycleState: "success",
      optimisticState: "confirmed",
      retryCount: 0,
    });
  expect(taskReadCount).toBeGreaterThanOrEqual(1);
  expect(strictReadCount).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId("surface")).toHaveText(
    "detail-without-list-controller"
  );
});

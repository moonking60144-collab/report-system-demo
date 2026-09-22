import { expect, test } from "@playwright/test";
import { startMeetingCoverage, stopMeetingCoverage } from "./meetingVerificationCoverage";

test.beforeEach(async ({ page }) => startMeetingCoverage(page));
test.afterEach(async ({ page }) => stopMeetingCoverage(page));

for (const status of ["success", "failed"] as const) {
  test(`${status}: 五筆任務保留結果、遵守冷卻、reload 後確認且不重新寫入`, async ({ page }) => {
    await page.clock.install();
    let allowConfirmation = false;
    let reads = 0;
    let taskReads = 0;
    let writes = 0;
    await page.route("**/api/**", async route => {
      const req = route.request();
      const url = new URL(req.url());
      if (!url.pathname.startsWith("/api/")) return route.fallback();
      if (req.method() !== "GET") { writes++; return route.fulfill({ status: 500 }); }
      const task = url.pathname.match(/\/reports\/tasks\/task-(\d)$/);
      if (task) {
        taskReads++;
        return route.fulfill({ json: { data: {
          taskId: `task-${task[1]}`, taskType: "update-report", formId: "901", entryId: task[1],
          status, updatedAt: new Date().toISOString(), errorCode: status === "failed" ? "ENTRY_CONFLICT" : null,
          errorMessage: status === "failed" ? "original conflict reason" : null,
        } } });
      }
      const entry = url.pathname.match(/\/reports\/(\d)$/);
      if (entry) {
        reads++;
        expect(url.searchParams.get("strictRefresh")).toBe("1");
        if (!allowConfirmation) return route.fulfill({ status: 503, headers: { "Retry-After": "30" },
          json: { error: { code: "RAGIC_CIRCUIT_OPEN", message: "unavailable", retryAfterMs: 30000 } } });
        return route.fulfill({ json: { data: {
          id: entry[1], workOrderNo: `WO-${entry[1]}`, sortOrder: status === "success" ? 11 : 9, reports: [],
        } } });
      }
      return route.fulfill({ json: { data: [] } });
    });
    await page.route("**/__confirmation__", route => route.fulfill({ contentType: "text/html", body: `
      <html><body><div id="root"></div><script type="module">
      import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
      </script><script type="module" src="/tests/fixtures/work-report-confirmation-retry-fixture.tsx"></script></body></html>` }));
    await page.goto("/__confirmation__");
    await expect(page.locator(".task-status", { hasText: "待確認" })).toHaveCount(6);
    await expect(page.getByRole("button", { name: "edit", exact: true })).toBeDisabled();
    await expect(page.getByTestId("detail-status")).toContainText(status === "success" ? "已寫入，等待資料確認" : "等待確認資料現況");
    if (status === "failed") {
      await expect(page.locator(".task-message").first(), "ORIGINAL_FAILURE_VISIBLE_WHILE_CONFIRMING").toContainText("original conflict reason");
      await expect(page.getByTestId("detail-status")).toContainText("original conflict reason");
    }
    await expect(page.locator(".ant-message-warning")).toHaveCount(1);
    const initialReads = reads;
    expect(initialReads).toBeGreaterThan(0);
    expect(taskReads).toBe(5);
    await page.getByRole("button", { name: "rerender", exact: true }).click();
    await page.getByRole("button", { name: "clear", exact: true }).click();
    await page.clock.fastForward(29000);
    expect(reads, "NO_READ_DURING_COOLDOWN").toBe(initialReads);
    await page.reload();
    await expect(page.locator(".task-status", { hasText: "待確認" })).toHaveCount(6);
    expect(taskReads, "TERMINAL_RESULT_SURVIVES_RELOAD").toBe(5);
    expect(reads).toBe(initialReads);
    await page.clock.fastForward(181000);
    await expect.poll(() => reads).toBeGreaterThan(initialReads);
    const state = JSON.parse(await page.getByTestId("state").textContent() ?? "[]");
    expect(state).toHaveLength(5);
    expect(state.every((m: { status: string; outcome: unknown }) => m.status === status && m.outcome === null),
      "KNOWN_TERMINAL_MUST_NOT_BECOME_UNKNOWN").toBe(true);
    allowConfirmation = true;
    await page.clock.fastForward(31000);
    await expect.poll(async () => JSON.parse(await page.getByTestId("state").textContent() ?? "[]")
      .filter((m: { outcome: unknown }) => m.outcome === "settled").length).toBe(5);
    await expect(page.getByRole("button", { name: "edit", exact: true })).toBeEnabled();
    if (status === "failed") await expect(page.locator(".task-message").first()).toContainText("original conflict reason");
    expect(writes, "CONFIRMATION_NEVER_REPEATS_WRITE").toBe(0);
    expect(taskReads).toBe(5);
  });
}

for (const missing of ["task", "entry"] as const) {
  test(`${missing}: 未知結果與停止自動確認可恢復，保持證據及編輯保護`, async ({ page }) => {
    await page.clock.install();
    let allowConfirmation = false;
    let reads = 0;
    let writes = 0;
    await page.route("**/api/**", async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (!url.pathname.startsWith("/api/")) return route.fallback();
      if (request.method() !== "GET") { writes++; return route.fulfill({ status: 500 }); }
      const task = url.pathname.match(/\/reports\/tasks\/task-(\d)$/);
      if (task) {
        if (missing === "task") return route.fulfill({ status: 404,
          json: { error: { code: "TASK_NOT_FOUND", message: "registry missing" } } });
        return route.fulfill({ json: { data: { taskId: `task-${task[1]}`, taskType: "update-report",
          formId: "901", entryId: task[1], status: "success", updatedAt: new Date().toISOString() } } });
      }
      const entry = url.pathname.match(/\/reports\/(\d)$/);
      if (entry) {
        reads++;
        if (allowConfirmation) return route.fulfill({ json: { data: {
          id: entry[1], workOrderNo: `WO-${entry[1]}`, sortOrder: 11, reports: [],
        } } });
        return missing === "entry" ? route.fulfill({ status: 404,
          json: { error: { code: "REPORT_NOT_FOUND", message: "work order missing" } } })
          : route.fulfill({ status: 503, headers: { "Retry-After": "30" },
            json: { error: { code: "RAGIC_CIRCUIT_OPEN", retryAfterMs: 30000 } } });
      }
      return route.fulfill({ json: { data: [] } });
    });
    await page.route("**/__confirmation__", route => route.fulfill({ contentType: "text/html", body: `
      <html><body><div id="root"></div><script type="module">
      import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
      </script><script type="module" src="/tests/fixtures/work-report-confirmation-retry-fixture.tsx"></script></body></html>` }));
    await page.goto("/__confirmation__");
    if (missing === "entry") await expect.poll(() => reads).toBe(5);
    else await expect.poll(() => reads).toBeGreaterThan(0);
    await expect(page.getByRole("button", { name: "edit", exact: true })).toBeDisabled();
    if (missing === "task") {
      expect(reads, "COOLDOWN_STOPS_QUEUED_CONFIRMATIONS").toBeLessThanOrEqual(2);
      await expect(page.locator(".task-status", { hasText: "狀態未知" })).toHaveCount(6);
      await expect(page.getByTestId("detail-status"), "UNKNOWN_MUST_REMAIN_UNKNOWN").toContainText("寫入結果未知");
      await expect(page.getByTestId("detail-status")).toContainText("找不到任務狀態");
      await expect(page.getByTestId("detail-status")).not.toContainText("任務未成功");
      allowConfirmation = true;
      await page.clock.fastForward(31000);
    } else {
      const retryButtons = page.getByRole("button", { name: "重新確認資料", exact: true });
      await expect(retryButtons).toHaveCount(5);
      await expect(page.getByTestId("detail-status")).toContainText("已暫停自動確認");
      await page.clock.fastForward(217000);
      await page.getByRole("button", { name: "rerender", exact: true }).click();
      await page.getByRole("button", { name: "clear", exact: true }).click();
      await page.reload();
      await expect(retryButtons).toHaveCount(5);
      expect(reads, "MISSING_ENTRY_MUST_NOT_LOOP_AFTER_RELOAD").toBe(5);
      await expect(page.getByRole("button", { name: "edit", exact: true })).toBeDisabled();
      await page.getByRole("button", { name: "detail retry", exact: true }).click();
      await expect.poll(() => reads).toBe(6);
      await expect(retryButtons).toHaveCount(5);
      await page.clock.fastForward(31000);
      expect(reads).toBe(6);
      allowConfirmation = true;
      await page.getByRole("button", { name: "detail retry", exact: true }).click();
      await expect(retryButtons).toHaveCount(4);
      for (let remaining = 4; remaining > 0; remaining--) {
        await retryButtons.first().click();
        await expect(retryButtons).toHaveCount(remaining - 1);
      }
    }
    await expect.poll(async () => JSON.parse(await page.getByTestId("state").textContent() ?? "[]")
      .filter((task: { outcome: unknown }) => task.outcome === "settled").length).toBe(5);
    await expect(page.getByRole("button", { name: "edit", exact: true })).toBeEnabled();
    expect(writes, "MANUAL_CONFIRMATION_NEVER_WRITES").toBe(0);
  });
}

for (const count of [20, 50]) {
  test(`恢復 ${count} 筆 terminal tasks 時，strict reads 最多兩筆並持續排空`, async ({ page }) => {
    await page.addInitScript(count => {
      localStorage.setItem("work-reports:task-monitor", JSON.stringify(Array.from({ length: count }, (_, i) => ({
        taskId: `restored-${i}`, kind: "update", formId: "901", entryId: String(i), workOrderNo: `WO-${i}`,
        status: "success", message: "saved", entryFieldOperation: "work-report-sort-order",
        updatedAt: new Date(Date.now() - count + i).toISOString(),
      }))));
    }, count);
    let active = 0;
    let peak = 0;
    let writes = 0;
    let completed = 0;
    const reads: string[] = [];
    const release: (() => void)[] = [];
    let drain = false;
    await page.route("**/api/**", async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (!url.pathname.startsWith("/api/")) return route.fallback();
      if (request.method() !== "GET") { writes++; return route.fulfill({ status: 500 }); }
      const entry = url.pathname.match(/\/reports\/(\d+)$/);
      if (!entry) return route.fulfill({ json: { data: [] } });
      expect(url.searchParams.get("strictRefresh"), "AUTHORITY_MUST_REMAIN_STRICT").toBe("1");
      reads.push(entry[1]);
      active++;
      peak = Math.max(peak, active);
      if (!drain) await new Promise<void>(resolve => release.push(resolve));
      await route.fulfill({ json: { data: { id: entry[1], workOrderNo: `WO-${entry[1]}`,
        sortOrder: count === 50 && entry[1] === "0" ? 12 : 11, reports: [] } } });
      active--;
      completed++;
    });
    await page.route("**/__confirmation__*", route => route.fulfill({ contentType: "text/html", body: `
      <html><body><div id="root"></div><script type="module">
      import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
      </script><script type="module" src="/tests/fixtures/work-report-confirmation-retry-fixture.tsx"></script></body></html>` }));
    await page.goto(count === 50 ? "/__confirmation__?boundRetries=1" : "/__confirmation__");
    await expect.poll(() => reads.length).toBe(2);
    expect(reads, "RECOVERY_FIFO").toEqual(["0", "1"]);
    await page.getByRole("button", { name: "rerender", exact: true }).click();
    await page.getByRole("button", { name: "clear", exact: true }).click();
    if (count === 20) await page.getByRole("button", { name: "later terminal", exact: true }).click();
    expect(reads.length, "SETTLEMENT_CONCURRENCY_LIMIT").toBe(2);
    await expect(page.getByRole("button", { name: "edit", exact: true })).toBeDisabled();
    expect(JSON.parse(await page.getByTestId("state").textContent() ?? "[]"), "ALL_PENDING_MONITORS_RESTORED")
      .toHaveLength(count + (count === 20 ? 1 : 0));
    drain = true;
    for (const resolve of release) resolve();
    await expect.poll(() => completed, "ALL_RESTORED_TASKS_MUST_DRAIN").toBe(count + (count === 20 ? 1 : 0));
    await expect(page.getByRole("button", { name: "edit", exact: true }), "SUPERSEDED_EVIDENCE_MUST_NOT_RESTORE_PENDING").toBeEnabled();
    const monitors = JSON.parse(await page.getByTestId("state").textContent() ?? "[]") as { outcome: string }[];
    expect(monitors.length, "TERMINAL_HISTORY_REMAINS_BOUNDED").toBeLessThanOrEqual(12);
    expect(monitors.every(task => task.outcome === "settled" || task.outcome === "superseded"), "NO_ACTIONABLE_CONFIRMATION_REMAINS").toBe(true);
    if (count === 50) {
      expect(JSON.parse(await page.getByTestId("retry-evidence").textContent() ?? "[]"), "SUPERSEDED_EVIDENCE_SURVIVES_HISTORY_CAP")
        .toEqual([{ entryId: "0", outcome: "superseded", blocking: false }]);
      await page.getByRole("button", { name: "rerender", exact: true }).click();
      await expect(page.getByRole("button", { name: "edit", exact: true })).toBeEnabled();
    }
    expect(peak, "SETTLEMENT_CONCURRENCY_LIMIT").toBeLessThanOrEqual(2);
    expect(reads, "ALL_RESTORED_TASKS_MUST_DRAIN").toEqual([
      ...Array.from({ length: count }, (_, i) => String(i)), ...(count === 20 ? ["0"] : []),
    ]);
    expect(writes).toBe(0);
    await expect(page.getByRole("button", { name: "edit", exact: true })).toBeEnabled();
  });
}

test("同一輪恢復的同工令不同欄位共用讀取，晚到 terminal task 仍重新確認", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("work-reports:task-monitor", JSON.stringify(["work-report-sort-order", "work-report-urgent"].map((operation, i) => ({
      taskId: `same-entry-${i}`, kind: "update", formId: "901", entryId: "0", workOrderNo: "WO-0", status: "success",
      message: "saved", entryFieldOperation: operation, updatedAt: new Date().toISOString(),
    }))));
  });
  let reads = 0;
  let release!: () => void;
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.fallback();
    if (url.pathname.endsWith("/reports/0")) {
      reads++;
      if (reads === 1) await new Promise<void>(resolve => { release = resolve; });
      return route.fulfill({ json: { data: { id: "0", workOrderNo: "WO-0", sortOrder: 11, urgent: false, reports: [] } } });
    }
    return route.fulfill({ json: { data: [] } });
  });
  await page.route("**/__confirmation__", route => route.fulfill({ contentType: "text/html", body: `
    <html><body><div id="root"></div><script type="module">
    import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
    </script><script type="module" src="/tests/fixtures/work-report-confirmation-retry-fixture.tsx"></script></body></html>` }));
  await page.goto("/__confirmation__");
  await expect.poll(() => reads).toBe(1);
  await page.getByRole("button", { name: "rerender", exact: true }).click();
  expect(reads, "SAME_ENTRY_SINGLE_FLIGHT").toBe(1);
  release();
  await expect.poll(async () => JSON.parse(await page.getByTestId("state").textContent() ?? "[]")
    .filter((task: { outcome: string }) => task.outcome === "settled").length).toBe(2);
  await page.getByRole("button", { name: "later terminal", exact: true }).click();
  await expect.poll(() => reads, "LATER_TERMINAL_REQUIRES_FRESH_OBSERVATION").toBe(2);
  await expect.poll(async () => JSON.parse(await page.getByTestId("state").textContent() ?? "[]")
    .filter((task: { outcome: string }) => task.outcome === "settled").length).toBe(3);
});

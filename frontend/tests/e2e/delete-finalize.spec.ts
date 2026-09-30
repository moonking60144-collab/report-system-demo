import { expect, test } from "../fixtures/verified-test";

test.use({ locale: "zh-TW" });

test("沒有本機刪除 payload 仍可由任務中心重試收尾，成功後不再提供重複操作", async ({ page }) => {
  let retried = false;
  await page.route(/^https?:\/\/[^/]+\/api\//, async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "POST") {
      expect(path).toBe("/api/forms/901/reports/1/batch-delete/failed-delete/retry-finalize");
      retried = true;
      await route.fulfill({ json: { data: { taskId: "recovery", status: "pending", createdAt: new Date().toISOString() } } });
      return;
    }
    const actorClientId = await page.evaluate(() => Reflect.get(window, "fixtureClientId"));
    const source = { taskId: "failed-delete", taskType: "delete-report", formId: "901", entryId: "1", status: "failed", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), actorClientId, deletedCount: 1, deletedRowIds: ["42"], deleteFinalizeFailed: true, errorCode: "DELETE_REPORT_FINALIZE_FAILED", message: "fixture failure" };
    await route.fulfill({ json: { data: path.endsWith("/tasks") ? [source, ...(retried ? [{ ...source, taskId: "recovery", status: "success", retriedFromTaskId: source.taskId, deleteFinalizeFailed: false, errorCode: null }] : [])] : null } });
  });
  await page.route("**/__delete-finalize__", route => route.fulfill({ contentType: "text/html", body: `
    <div id="root"></div><script type="module">
    import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => undefined; window.$RefreshSig$ = () => type => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    </script><script type="module">
    import { mountDeleteFinalizeFixture } from "/tests/fixtures/delete-finalize-fixture.tsx";
    mountDeleteFinalizeFixture(document.querySelector("#root"));</script>` }));
  await page.goto("/__delete-finalize__");
  const button = page.getByRole("button", { name: "重試收尾", exact: true });
  await expect(button, "DELETE_FINALIZE_UI").toBeVisible();
  await button.click();
  await expect.poll(() => retried).toBe(true);
  await expect(button).not.toBeVisible();
});

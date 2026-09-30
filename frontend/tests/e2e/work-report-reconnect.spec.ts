import { expect, test, type Route } from "../fixtures/verified-test";

test("短暫斷線重連補讀一次，編輯中延後至結束再同步", async ({ page }) => {
  await page.route("**/__reconnect__", route => route.fulfill({ contentType: "text/html", body: `
    <div id="root"></div><script type="module">
    import RefreshRuntime from "/@react-refresh";
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => undefined; window.$RefreshSig$ = () => type => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    </script><script type="module">
    import { mountReconnectFixture } from "/tests/fixtures/work-report-reconnect-fixture.tsx";
    mountReconnectFixture(document.querySelector("#root"));</script>` }));
  await page.goto("/__reconnect__");
  const loads = page.getByTestId("loads");
  await page.getByRole("button", { name: "連線", exact: true }).click();
  await expect(loads).toHaveText("0");
  await page.getByRole("button", { name: "斷線", exact: true }).click();
  await page.getByRole("button", { name: "連線", exact: true }).click();
  await expect(loads, "RECONNECT_CONVERGENCE").toHaveText("1");
  await page.getByRole("button", { name: "連線", exact: true }).click();
  await expect(loads).toHaveText("1");
  await page.getByRole("button", { name: "開始編輯" }).click();
  await page.getByRole("button", { name: "斷線", exact: true }).click();
  await page.getByRole("button", { name: "連線", exact: true }).click();
  await expect(loads).toHaveText("1");
  await page.getByRole("button", { name: "結束編輯" }).click();
  await expect(loads).toHaveText("2");
});

test("列表忙碌時保留重連需求，切換表單後補讀最新表單", async ({ page }) => {
  await page.route(/^https?:\/\/[^/]+\/api\//, route => route.fulfill({ json: { data: null } }));
  await page.route("**/__list-reconnect__", route => route.fulfill({ contentType: "text/html", body: `
    <div id="root"></div><script type="module">
    import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => undefined; window.$RefreshSig$ = () => type => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    </script><script type="module">
    import { mountListReconnectFixture } from "/tests/fixtures/work-report-reconnect-fixture.tsx";
    mountListReconnectFixture(document.querySelector("#root"));</script>` }));
  await page.goto("/__list-reconnect__");
  const reads = page.getByTestId("reads");
  const reconnect = async () => {
    await page.getByRole("button", { name: "斷線", exact: true }).click();
    await page.getByRole("button", { name: "連線", exact: true }).click();
  };
  await page.getByRole("button", { name: "連線", exact: true }).click();
  await reconnect();
  await expect(reads).toHaveText("");
  await page.getByRole("button", { name: "完成前景讀取" }).click();
  await expect(reads).toHaveText("901");
  await page.getByRole("button", { name: "延遲下一次讀取" }).click();
  await reconnect();
  await expect(reads).toHaveText("901,901");
  await page.getByRole("button", { name: "切換表單" }).click();
  await reconnect();
  await page.getByRole("button", { name: "完成背景讀取" }).click();
  await expect(reads).toHaveText("901,901,902");
});

for (const trigger of ["reconnect", "background"]) {
  test(`快取頁面 revalidation 中的 ${trigger} 需求最終讀到新資料`, async ({ page }) => {
    let reads = 0, pending: Route | undefined;
    const response = (value: string) => ({ data: [{ id: "1", workOrderNo: value, reports: [] }], count: 1, totalCount: 1, hasMore: false, meta: { cacheSource: "sqlite", cacheState: "fresh" } });
    await page.route(/^https?:\/\/[^/]+\/api\//, async route => {
      if (new URL(route.request().url()).pathname === "/api/forms/901/reports") {
        reads++;
        if (reads === 2) { pending = route; return; }
        await route.fulfill({ json: response(reads === 1 ? "old" : "new") });
      } else await route.fulfill({ json: { data: null } });
    });
    await page.route("**/__cached-reconnect__", route => route.fulfill({ contentType: "text/html", body: `
      <div id="root"></div><script type="module">
      import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => undefined; window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      </script><script type="module">
      import { mountCachedReconnectFixture } from "/tests/fixtures/work-report-reconnect-fixture.tsx";
      mountCachedReconnectFixture(document.querySelector("#root"));</script>` }));
    await page.goto("/__cached-reconnect__");
    await page.getByRole("button", { name: "連線", exact: true }).click();
    await page.getByRole("button", { name: "前景讀取" }).click();
    await expect(page.getByTestId("value")).toHaveText("old");
    await expect(page.getByTestId("busy")).toHaveText("false:false");
    await page.getByRole("button", { name: "前景讀取" }).click();
    await expect(page.getByTestId("busy")).toHaveText("false:true");
    await expect.poll(() => Boolean(pending)).toBe(true);
    if (trigger === "reconnect") {
      await page.getByRole("button", { name: "斷線", exact: true }).click();
      await page.getByRole("button", { name: "連線", exact: true }).click();
    } else await page.getByRole("button", { name: "背景補讀" }).click();
    await pending!.fulfill({ json: response("old") });
    await expect(page.getByTestId("value")).toHaveText("new");
    expect(reads).toBe(3);
  });
}

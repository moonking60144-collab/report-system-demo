import { expect, test } from "@playwright/test";

const documentHtml = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"></head><body>
<div id="root"></div><script type="module">
import RefreshRuntime from "/@react-refresh";
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => undefined;
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
</script><script type="module">
import { mountDevAiAutoScrollFixture } from "/tests/fixtures/dev-ai-auto-scroll-fixture.tsx";
mountDevAiAutoScrollFixture(document.querySelector("#root"));
</script></body></html>`;

test("對話在底部時跟隨新訊息，手動離開底部後保持位置，換對話再回到底部", async ({ page }) => {
  await page.route("**/__dev-ai-auto-scroll__*", route => route.fulfill({
    status: 200, contentType: "text/html", body: documentHtml,
  }));
  await page.goto("/__dev-ai-auto-scroll__");
  const scroller = page.getByTestId("conversation");
  const position = () => scroller.evaluate(element => ({
    top: element.scrollTop,
    bottom: element.scrollHeight - element.clientHeight,
  }));
  await expect.poll(async () => { const { top, bottom } = await position(); return bottom - top; },
    { message: "AUTO_SCROLL_FOLLOW_CONTRACT" }).toBe(0);

  await page.getByRole("button", { name: "新增訊息" }).click();
  await expect.poll(async () => { const { top, bottom } = await position(); return bottom - top; }).toBe(0);

  await scroller.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
  await page.getByRole("button", { name: "新增訊息" }).click();
  await expect.poll(async () => (await position()).top).toBe(0);

  await page.getByRole("button", { name: "切換對話" }).click();
  await expect.poll(async () => { const { top, bottom } = await position(); return bottom - top; }).toBe(0);
  await expect(scroller).toContainText("second：0");
});

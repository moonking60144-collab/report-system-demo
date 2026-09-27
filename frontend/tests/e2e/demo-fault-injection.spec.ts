import { expect, test } from "@playwright/test";

test("故障模擬在初始狀態載入後才可操作", async ({ page }) => {
  let releaseRead!: () => void;
  let readStarted!: () => void;
  const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
  const readRequest = new Promise<void>((resolve) => { readStarted = resolve; });
  const updates: Array<{ enabled: boolean }> = [];

  await page.route("**/api/__demo/fault-injection", async (route) => {
    if (route.request().method() === "GET") {
      readStarted();
      await readGate;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { enabled: false, failureRate: 0, latencyMs: 0, dropFieldRate: 0 },
        }),
      });
      return;
    }
    updates.push(route.request().postDataJSON() as { enabled: boolean });
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await readRequest;
  const trigger = page.getByRole("button", { name: "故障模擬" });
  await expect(trigger).toHaveCount(0);

  releaseRead();
  await expect(trigger).toBeVisible();
  await trigger.click();
  await page.locator(".demo-fault-injection-panel .ant-switch").click();
  await expect.poll(() => updates.length).toBe(1);
  expect(updates[0].enabled).toBe(true);
});

test("公開 Demo 未掛載故障控制端點時不顯示面板", async ({ page }) => {
  await page.route("**/api/__demo/fault-injection", (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: "{}" })
  );
  const unavailable = page.waitForResponse((response) =>
    response.url().endsWith("/api/__demo/fault-injection") && response.status() === 404
  );
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await unavailable;
  await expect(page.getByRole("button", { name: "故障模擬" })).toHaveCount(0);
});

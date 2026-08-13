import { expect, test, type Page, type Route } from "@playwright/test";

const TOKEN_KEY = "work-report:system-notice-admin-token:v1";
const TOKEN = "dev-admin-token";
const LAUNCHER_STORAGE_KEY = "ragic-report:dev-ai-launcher-position:v1";

const definitionsState = {
  definitionsRoot: "/tmp/ragic-definitions",
  exists: true,
  manifest: {
    schemaVersion: 1,
    revision: `sha256:${"a".repeat(64)}`,
    revisionAlgorithm: "sha256-path-content-v1",
    artifactCount: 0,
    namespaceFilter: { mode: "all" },
    counts: { forms: 0, fields: 0, formulas: 0, workflows: 0 },
  },
  snapshot: null,
  gitStatus: { available: true, clean: true, entries: [], error: null },
};

const versionStatus = {
  gitAvailable: true,
  repoRoot: "/tmp/repo",
  definitionsRoot: "/tmp/ragic-definitions",
  definitionsPathspec: "ragic-definitions",
  branch: "main",
  lastCommit: "abcdef12",
  remoteTrackingBranch: "origin/main",
  ahead: 0,
  behind: 0,
  clean: true,
  definitionsClean: true,
  canCommit: false,
  canPush: false,
  canAutoSyncPush: false,
  entries: [],
  definitionsEntries: [],
  outsideEntries: [],
  blockers: [],
  warnings: [],
  error: null,
};

async function installDevDefinitionsMocks(
  page: Page,
  options: { blockLauncherStorage?: boolean } = {}
) {
  await page.addInitScript(
    ([tokenKey, token, launcherStorageKey, blockLauncherStorage]) => {
      window.localStorage.setItem(tokenKey, token);
      Object.defineProperty(window, "EventSource", { value: undefined, configurable: true });
      if (!blockLauncherStorage) return;
      const originalGetItem = Storage.prototype.getItem;
      const originalSetItem = Storage.prototype.setItem;
      Storage.prototype.getItem = function getItem(key: string) {
        if (key === launcherStorageKey) throw new DOMException("blocked", "SecurityError");
        return originalGetItem.call(this, key);
      };
      Storage.prototype.setItem = function setItem(key: string, value: string) {
        if (key === launcherStorageKey) throw new DOMException("blocked", "SecurityError");
        return originalSetItem.call(this, key, value);
      };
    },
    [TOKEN_KEY, TOKEN, LAUNCHER_STORAGE_KEY, Boolean(options.blockLauncherStorage)] as const
  );

  await page.route(/^https?:\/\/[^/]+\/api\//, async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/api/system-notice/config") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { maxUsers: 5, minPasswordLength: 6 } }),
      });
      return;
    }
    if (path === "/api/system-notice/session") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { username: "admin", expiresAt: "2027-08-03T00:00:00.000Z" },
        }),
      });
      return;
    }
    if (path === "/api/dev/ragic-fields/state") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            status: "ready",
            refreshedAt: "2026-08-03T00:00:00.000Z",
            totalForms: 0,
            totalFields: 0,
            message: null,
            updatedAt: "2026-08-03T00:00:00.000Z",
            progress: null,
          },
        }),
      });
      return;
    }
    if (path === "/api/dev/ragic-definitions/state") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: definitionsState }),
      });
      return;
    }
    if (path === "/api/dev/ragic-definitions/forms") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [],
          meta: { count: 0, limit: 300, truncated: false, revision: null },
        }),
      });
      return;
    }
    if (path === "/api/dev/ragic-definitions/version-control/status") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: versionStatus }),
      });
      return;
    }
    if (path === "/api/debug/clients" && route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [] }),
      });
      return;
    }
    if (path === "/api/debug/clients/presence") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { presence: { maintenanceMessage: null, blocked: false } } }),
      });
      return;
    }
    if (path === "/api/debug/clients/commands/fetch") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { commands: [] } }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: {} }),
    });
  });
}

async function openDefinitionsAi(page: Page) {
  await page.goto("/dev/definitions");
  const launcher = page.getByRole("button", { name: "開啟 Funda Dev AI" });
  await expect(launcher).toBeVisible();
  await launcher.click();
  const activeLauncher = page.locator(".ragic-defs-ai-bot__launcher");
  const panel = page.getByRole("dialog", { name: "AI 公式助手" });
  await expect(panel).toBeVisible();
  await panel.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished))
  );
  return { launcher: activeLauncher, panel };
}

test("pointercancel 會讓 launcher 與 panel 一起回到拖曳起點", async ({ page }) => {
  await installDevDefinitionsMocks(page);
  const { launcher, panel } = await openDefinitionsAi(page);
  const launcherBefore = await launcher.boundingBox();
  if (!launcherBefore) throw new Error("Dev AI launcher 未完成 layout");

  await launcher.evaluate((element) => {
    element.addEventListener(
      "pointerdown",
      (event) => {
        element.dataset.activePointerId = String(event.pointerId);
      },
      { once: true }
    );
  });
  await page.mouse.move(
    launcherBefore.x + launcherBefore.width / 2,
    launcherBefore.y + launcherBefore.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(launcherBefore.x + 180, launcherBefore.y - 120, { steps: 4 });
  await expect.poll(async () => (await launcher.boundingBox())?.x).not.toBeCloseTo(launcherBefore.x, 0);
  await launcher.evaluate((element) => {
    const pointerId = Number(element.dataset.activePointerId);
    element.dispatchEvent(new PointerEvent("pointercancel", {
      bubbles: true,
      isPrimary: true,
      pointerId,
      pointerType: "mouse",
    }));
  });
  await page.mouse.up();

  await expect.poll(async () =>
    Math.abs(((await launcher.boundingBox())?.x ?? Number.POSITIVE_INFINITY) - launcherBefore.x)
  ).toBeLessThanOrEqual(1.5);
  await expect.poll(async () =>
    Math.abs(((await launcher.boundingBox())?.y ?? Number.POSITIVE_INFINITY) - launcherBefore.y)
  ).toBeLessThanOrEqual(1.5);
  await expect.poll(async () => {
    const launcherBox = await launcher.boundingBox();
    const panelBox = await panel.boundingBox();
    if (!launcherBox || !panelBox) return Number.POSITIVE_INFINITY;
    return Math.abs(panelBox.x - launcherBox.x);
  }).toBeLessThanOrEqual(1.5);
  await expect.poll(async () => {
    const launcherBox = await launcher.boundingBox();
    const panelBox = await panel.boundingBox();
    if (!launcherBox || !panelBox) return Number.POSITIVE_INFINITY;
    return Math.abs(panelBox.y + panelBox.height + 12 - launcherBox.y);
  }).toBeLessThanOrEqual(1.5);
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), LAUNCHER_STORAGE_KEY))
    .toBeNull();
});

test("窄螢幕拖曳定位後仍保留 panel 左右安全邊界", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installDevDefinitionsMocks(page);
  const { panel } = await openDefinitionsAi(page);
  const box = await panel.boundingBox();
  if (!box) throw new Error("Dev AI panel 未完成 layout");

  expect(box.x).toBeGreaterThanOrEqual(11.5);
  expect(box.x + box.width).toBeLessThanOrEqual(378.5);
});

test("launcher storage 被瀏覽器拒絕時 NUI GUI 仍可掛載與拖曳", async ({ page }) => {
  await installDevDefinitionsMocks(page, { blockLauncherStorage: true });
  await page.goto("/dev/definitions");
  const launcher = page.getByRole("button", { name: "開啟 Funda Dev AI" });
  await expect(launcher).toBeVisible();
  const before = await launcher.boundingBox();
  if (!before) throw new Error("Dev AI launcher 未完成 layout");

  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + 160, before.y - 100, { steps: 4 });
  await page.mouse.up();

  await expect.poll(async () => (await launcher.boundingBox())?.x).not.toBeCloseTo(before.x, 0);
  await expect(page.getByText("頁面發生未預期錯誤")).toHaveCount(0);
});

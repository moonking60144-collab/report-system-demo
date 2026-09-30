import { expect, test, type Page, type Route } from "../fixtures/verified-test";

const thread = {
  id: "ui-fixture", title: "認識 Ragic 與表單設計", mode: "auto", context: {},
  createdAt: "2026-09-30T00:00:00Z", updatedAt: "2026-09-30T00:00:00Z",
  lastMessagePreview: "可以從資料欄位與表單關聯開始。", summary: null,
};
const userMessage = {
  id: "user-1", threadId: thread.id, role: "user", content: "什麼是 Ragic？",
  metadata: {}, createdAt: thread.createdAt, status: "completed",
};
const assistantMessage = {
  ...userMessage, id: "assistant-1", role: "assistant",
  content: "Ragic 是用來建立資料庫應用的工具，可以用熟悉的表格介面管理資料。\n\n**可以從這些功能開始：**\n\n- 建立欄位與表單，整理工作資料。\n- 串聯不同表單，減少重複輸入。\n- 使用公式與工作流程，處理例行作業。",
  metadata: { answerFormat: "markdown" },
};
const artifacts = [{
  id: "evidence-1", threadId: thread.id, messageId: assistantMessage.id,
  type: "chat-result", createdAt: thread.createdAt,
  payload: {
    citedEvidence: [{ sourceId: "official:overview", title: "Ragic 功能介紹", kind: "official", excerpt: "公開說明", score: 1 }],
    contextSources: [{ sourceId: "context-only", title: "未引用的檢索結果", kind: "official", excerpt: "內部 context", score: 1 }],
    assumptions: ["實際可用功能依表單設定而定。"],
    followUps: ["你想先建立新表單，還是調整既有欄位？"],
  },
}];

async function installWorkspaceMocks(page: Page, empty = false) {
  let pendingSend: Route | undefined;
  await page.addInitScript(() => {
    localStorage.setItem("work-report:system-notice-admin-token:v1", "ui-test-token");
    Object.defineProperty(window, "EventSource", { value: undefined, configurable: true });
  });
  await page.route(/^https?:\/\/[^/]+\/api\//, async route => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = {};
    if (path === "/api/system-notice/config") data = { maxUsers: 5, minPasswordLength: 6 };
    if (path === "/api/system-notice/session") data = { username: "demo", expiresAt: "2027-09-30T00:00:00Z" };
    if (path === "/api/dev/ragic-fields/state") data = { status: "ready", totalForms: 0, totalFields: 0, progress: null };
    if (path === "/api/dev/ai/readiness") data = {
      chatAvailable: true, knowledge: { available: true, state: "ready" },
      conversation: { enabled: true }, provider: { enabled: true, configured: true, name: "google" },
      retrieval: { mode: "lexical" }, reason: "ready",
    };
    if (path === "/api/dev/ai/threads") {
      data = route.request().method() === "POST" ? thread : empty ? [] : [thread];
    }
    if (path === `/api/dev/ai/threads/${thread.id}`) {
      data = { thread, messages: empty ? [] : [userMessage, assistantMessage], artifacts: empty ? [] : artifacts };
    }
    if (path === `/api/dev/ai/threads/${thread.id}/messages`) {
      pendingSend = route;
      return;
    }
    if (path === "/api/debug/clients") data = [];
    if (path === "/api/debug/clients/presence") data = { presence: { maintenanceMessage: null, blocked: false } };
    if (path === "/api/debug/clients/commands/fetch") data = { commands: [] };
    await route.fulfill({ json: { data } });
  });
  return {
    pending: () => pendingSend,
    complete: async (failed = false) => {
      if (!pendingSend) throw new Error("No pending message request");
      const request = pendingSend;
      pendingSend = undefined;
      await request.fulfill(failed
        ? { status: 503, json: { error: { message: "暫時無法回答，請稍後重試" } } }
        : { json: { data: { thread, userMessage, assistantMessage, artifacts } } });
    },
  };
}

test("回答依據由圖示開啟，保留引用邊界、鍵盤焦點與窄螢幕可讀性", async ({ page, context }, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await installWorkspaceMocks(page);
  await page.goto(`/dev/ai/threads/${thread.id}`);
  const evidence = page.getByRole("button", { name: "查看回答依據", exact: true });
  const dialog = page.getByRole("dialog", { name: "回答依據", exact: true });
  await expect(evidence).toBeVisible();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText("Ragic 功能介紹", { exact: false })).not.toBeVisible();
  expect((await evidence.boundingBox())!.width).toBeLessThanOrEqual(44);
  await page.screenshot({ path: testInfo.outputPath("workspace-desktop.png"), fullPage: true });

  await evidence.focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Ragic 功能介紹");
  await expect(dialog).not.toContainText("未引用的檢索結果");
  await expect(dialog).toContainText("使用提醒");
  await expect(dialog).toContainText("建議補充");
  await page.screenshot({ path: testInfo.outputPath("workspace-evidence.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(evidence).toBeFocused();

  await page.getByRole("button", { name: "複製回答", exact: true }).click();
  await expect.poll(async () => (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n"))
    .toBe(assistantMessage.content);
  await page.getByRole("button", { name: "送交知識審核", exact: true }).click();
  await expect(page.getByText("已送交知識審核", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await evidence.click();
  await expect(dialog).toBeVisible();
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(15);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(375);
  await page.screenshot({ path: testInfo.outputPath("workspace-mobile-evidence.png"), fullPage: true });
  await page.getByRole("button", { name: "關閉回答依據" }).click();
  await expect(evidence).toBeFocused();
  const composer = page.getByRole("region", { name: "送出 Dev AI 訊息" });
  await composer.scrollIntoViewIfNeeded();
  await expect(composer.getByRole("button", { name: "送出", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("workspace-mobile.png"), fullPage: true });
});

test("新對話可送出，等待只顯示漸層思考中；失敗保留草稿且 reduced motion 停止動畫", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const requests = await installWorkspaceMocks(page, true);
  await page.goto("/dev/ai");
  await expect(page.getByText("今天想了解什麼？")).toBeVisible();
  await page.getByRole("button", { name: "我的 AI 資料流怎麼處理？", exact: true }).click();
  const input = page.getByRole("textbox", { name: "訊息", exact: true });
  await expect(input).toHaveValue("我的 AI 資料流怎麼處理？");
  await input.fill("什麼是 Ragic？");
  await input.press("Control+Enter");
  await expect.poll(() => Boolean(requests.pending())).toBe(true);
  const thinking = page.getByRole("status").filter({ hasText: "思考中" });
  await expect(thinking).toHaveText("思考中");
  await expect(input).not.toBeEditable();
  await expect(input).toBeFocused();
  await page.keyboard.type("pending-edit");
  await expect(input).toHaveValue("什麼是 Ragic？");
  await expect(page.getByRole("button", { name: "思考中", exact: true })).toBeDisabled();
  expect((await thinking.boundingBox())!.height).toBeLessThan(40);
  await expect(thinking.locator("span")).toHaveCSS("animation-name", "dev-ai-thinking-shimmer");
  await page.screenshot({ path: testInfo.outputPath("workspace-thinking.png"), fullPage: true });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(thinking.locator("span")).toHaveCSS("animation-name", "none");

  await requests.complete(true);
  await expect(thinking).not.toBeVisible();
  await expect(input).toBeEditable();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("什麼是 Ragic？");
  await expect(page.getByRole("button", { name: "送出", exact: true })).toBeEnabled();
  await page.keyboard.press("Meta+Enter");
  await expect(thinking).toBeVisible();
  await expect.poll(() => requests.pending()?.request().postDataJSON().message).toBe("什麼是 Ragic？");
  await requests.complete();
  await expect(thinking).not.toBeVisible();
  await expect(input).toHaveValue("");
  await expect(input).toBeEditable();
  await expect(input).toBeFocused();
  await page.keyboard.type("follow-up");
  await expect(input).toHaveValue("follow-up");
  await expect(page.getByRole("button", { name: "查看回答依據", exact: true })).toBeVisible();
});

test("切換對話載入中不會把訊息送到舊對話", async ({ page }) => {
  const requests = await installWorkspaceMocks(page);
  const other = { ...thread, id: "thread-b", title: "對話 B" };
  await page.route("**/api/dev/ai/threads", route => route.fulfill({ json: { data: [thread, other] } }));
  let pendingDetail: Route | undefined;
  let postedTo = "";
  await page.route("**/api/dev/ai/threads/thread-b", route => { pendingDetail = route; });
  await page.route("**/api/dev/ai/threads/thread-b/messages", async route => {
    postedTo = new URL(route.request().url()).pathname;
    await route.fulfill({ status: 503, json: { error: { message: "fixture" } } });
  });
  await page.goto(`/dev/ai/threads/${thread.id}`);
  const input = page.getByRole("textbox", { name: "訊息", exact: true });
  await expect(input).toBeEditable();
  await input.fill("這題屬於 B");
  await page.getByRole("link", { name: "對話 B", exact: false }).click();
  await expect(input).toBeDisabled();
  expect(requests.pending()).toBeUndefined();
  await expect.poll(() => Boolean(pendingDetail)).toBe(true);
  await pendingDetail!.fulfill({ json: { data: { thread: other, messages: [], artifacts: [] } } });
  await expect(input).toBeEditable();
  await input.press("Control+Enter");
  await expect.poll(() => postedTo).toBe("/api/dev/ai/threads/thread-b/messages");
  expect(requests.pending()).toBeUndefined();
});

for (const failed of [false, true]) {
  test(`A 的晚到${failed ? "錯誤" : "回答"}不污染 B 對話`, async ({ page }) => {
    const requests = await installWorkspaceMocks(page);
    const other = { ...thread, id: "thread-b", title: "對話 B" };
    await page.route("**/api/dev/ai/threads", route => route.fulfill({ json: { data: [thread, other] } }));
    await page.route("**/api/dev/ai/threads/thread-b", route => route.fulfill({ json: { data: {
      thread: other, messages: [{ ...assistantMessage, id: "b-message", threadId: other.id, content: "B 專屬回答" }], artifacts: [],
    } } }));
    await page.goto(`/dev/ai/threads/${thread.id}`);
    const input = page.getByRole("textbox", { name: "訊息", exact: true });
    await input.fill("A 的問題");
    await input.press("Control+Enter");
    await expect.poll(() => Boolean(requests.pending())).toBe(true);
    await page.getByRole("link", { name: "對話 B", exact: false }).click();
    await expect(page.getByText("B 專屬回答")).toBeVisible();
    await requests.complete(failed);
    await expect(input).toBeEditable();
    await expect(page).toHaveURL(/\/thread-b$/);
    await expect(page.locator(".dev-ai-workspace__panel").getByText("對話 B", { exact: true }), "THREAD_OWNERSHIP").toBeVisible();
    await expect(page.getByLabel("對話內容", { exact: true })).toHaveText(/B 專屬回答/);
    await expect(page.getByLabel("對話內容", { exact: true })).not.toContainText("A 的問題");
    await expect(page.getByText("暫時無法回答，請稍後重試", { exact: true })).not.toBeVisible();
  });
}

for (const snapshotFirst of [false, true]) {
  test(`返回 A 時${snapshotFirst ? "snapshot 先到" : "POST 先到"}仍保留歷史且不重複訊息`, async ({ page }) => {
    const requests = await installWorkspaceMocks(page);
    const other = { ...thread, id: "thread-b", title: "對話 B" };
    const history = { ...assistantMessage, id: "history", content: "A 的既有歷史" };
    const completeDetail = { thread, messages: [history, userMessage, assistantMessage], artifacts };
    await page.route("**/api/dev/ai/threads", route => route.fulfill({ json: { data: [thread, other] } }));
    await page.route("**/api/dev/ai/threads/thread-b", route => route.fulfill({ json: { data: { thread: other, messages: [], artifacts: [] } } }));
    let reads = 0;
    let stale: Route | undefined;
    await page.route(`**/api/dev/ai/threads/${thread.id}`, async route => {
      reads++;
      if (reads === 2 && !snapshotFirst) { stale = route; return; }
      await route.fulfill({ json: { data: reads === 1 ? { thread, messages: [history], artifacts: [] } : completeDetail } });
    });
    await page.goto(`/dev/ai/threads/${thread.id}`);
    const input = page.getByRole("textbox", { name: "訊息", exact: true });
    await input.fill("什麼是 Ragic？"); await input.press("Control+Enter");
    await expect.poll(() => Boolean(requests.pending())).toBe(true);
    await page.getByRole("link", { name: "對話 B", exact: false }).click();
    await expect(page.locator(".dev-ai-workspace__panel").getByText("對話 B", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: thread.title, exact: false }).click();
    await expect.poll(() => reads).toBe(2);
    if (snapshotFirst) await expect(page.getByLabel("對話內容", { exact: true }).locator("article")).toHaveCount(3);
    await requests.complete();
    await expect(input).toBeEditable();
    await expect(page.getByLabel("對話內容", { exact: true }).locator("article")).toHaveCount(3);
    await expect(page.getByText("A 的既有歷史", { exact: true })).toBeVisible();
    if (stale) await stale.fulfill({ json: { data: { thread, messages: [history], artifacts: [] } } });
    await expect(page.getByLabel("對話內容", { exact: true }).locator("article")).toHaveCount(3);
  });
}

for (const operation of ["archive", "create"]) {
  test(`${operation} 晚到結果不改變新選取的對話`, async ({ page }) => {
    await installWorkspaceMocks(page);
    const other = { ...thread, id: "thread-b", title: "對話 B" };
    let pending: Route | undefined;
    await page.route("**/api/dev/ai/threads", async route => {
      if (route.request().method() === "POST") { pending = route; return; }
      await route.fulfill({ json: { data: [thread, other] } });
    });
    await page.route(`**/api/dev/ai/threads/${thread.id}/archive`, route => { pending = route; });
    await page.route("**/api/dev/ai/threads/thread-b", route => route.fulfill({ json: { data: { thread: other, messages: [], artifacts: [] } } }));
    await page.goto(`/dev/ai/threads/${thread.id}`);
    await page.getByRole("button", { name: operation === "archive" ? /封存/ : /新對話/ }).click();
    await expect.poll(() => Boolean(pending)).toBe(true);
    await page.getByRole("link", { name: "對話 B", exact: false }).click();
    await expect(page.locator(".dev-ai-workspace__panel").getByText("對話 B", { exact: true })).toBeVisible();
    await pending!.fulfill({ json: { data: { ...thread, id: operation === "create" ? "new-thread" : thread.id } } });
    await expect(page).toHaveURL(/\/thread-b$/);
    await expect(page.locator(".dev-ai-workspace__panel").getByText("對話 B", { exact: true })).toBeVisible();
  });
}

for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }, { width: 1280, height: 480 }]) {
  test(`長摘要展開仍可閱讀訊息與操作輸入框 ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await installWorkspaceMocks(page);
    const summaryText = "使用者詢問表單設計與公式檢查，AI 整理欄位與資料來源。".repeat(75).slice(0, 2000);
    await page.route(`**/api/dev/ai/threads/${thread.id}`, route => route.fulfill({ json: { data: {
      thread: { ...thread, summary: summaryText },
      messages: Array.from({ length: 12 }, (_, index) => ({
        ...(index % 2 ? assistantMessage : userMessage), id: `message-${index}`,
      })),
      artifacts: [],
    } } }));
    await page.goto(`/dev/ai/threads/${thread.id}`);
    await page.getByText("對話摘要", { exact: true }).click();
    const summary = page.locator(".dev-ai-workspace__summary p");
    const messages = page.getByLabel("對話內容", { exact: true });
    expect((await messages.boundingBox())!.height, "長摘要不能壓縮訊息區至不可閱讀").toBeGreaterThanOrEqual(120);
    expect(await summary.evaluate(element => element.scrollHeight > element.clientHeight), "長摘要需要獨立捲動").toBe(true);
    await summary.focus();
    await page.keyboard.press("Control+End");
    await expect.poll(() => summary.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await messages.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect.poll(() => messages.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    const composer = page.getByRole("region", { name: "送出 Dev AI 訊息" });
    await composer.scrollIntoViewIfNeeded();
    const composerBounds = (await composer.boundingBox())!;
    const panelBounds = (await page.locator(".dev-ai-workspace__panel").boundingBox())!;
    expect(composerBounds.y + composerBounds.height).toBeLessThanOrEqual(panelBounds.y + panelBounds.height + 1);
    await expect(composer.getByRole("button", { name: "送出", exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("expanded-summary.png"), fullPage: true });
    await page.getByText("對話摘要", { exact: true }).click();
    await expect(summary).not.toBeVisible();
    expect((await messages.boundingBox())!.height).toBeGreaterThanOrEqual(120);
  });
}

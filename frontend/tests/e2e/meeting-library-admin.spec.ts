import { expect, test } from "@playwright/test";

const TOKEN_KEY = "work-report:system-notice-admin-token:v1";
const TOKEN = "dev-admin-token";
const LIBRARY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND_LIBRARY_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("Dev admin 可搜尋、重設一次性 Code 並以 viewer 身分開啟錄音庫", async ({ page }) => {
  const calls = { list: 0, open: 0, rotate: 0 };
  let rotated = false;
  let qualityListCount = 0;
  let missingListCount = 0;
  let releaseStaleQualityList!: () => void;
  const staleQualityListRelease = new Promise<void>((resolve) => {
    releaseStaleQualityList = resolve;
  });
  let releaseRotateResponse!: () => void;
  const rotateResponseRelease = new Promise<void>((resolve) => {
    releaseRotateResponse = resolve;
  });
  await page.addInitScript(
    ([key, token]) => window.localStorage.setItem(key, token),
    [TOKEN_KEY, TOKEN]
  );

  await page.route("**/api/system-notice/config", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { maxUsers: 5, minPasswordLength: 6 } }),
    })
  );
  await page.route("**/api/system-notice/session", async (route) => {
    expect(route.request().headers().authorization).toBe(`Bearer ${TOKEN}`);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { username: "admin", expiresAt: "2027-07-16T00:00:00.000Z" } }),
    });
  });
  await page.route("**/api/dev/ragic-fields/state", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          status: "ready",
          refreshedAt: "2026-07-16T00:00:00.000Z",
          totalForms: 0,
          totalFields: 0,
          message: null,
          updatedAt: "2026-07-16T00:00:00.000Z",
          progress: null,
        },
      }),
    })
  );
  await page.route("**/api/meetings/admin/libraries?*", async (route) => {
    calls.list += 1;
    expect(route.request().headers().authorization).toBe(`Bearer ${TOKEN}`);
    const url = new URL(route.request().url());
    const query = url.searchParams.get("query");
    const cursor = url.searchParams.get("cursor");
    const accessVersion = rotated ? 2 : 1;
    if (query === "品質") {
      qualityListCount += 1;
      if (qualityListCount === 1) await staleQualityListRelease;
    }
    if (query === "找不到") missingListCount += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: cursor === "next-page"
          ? [{
              libraryId: SECOND_LIBRARY_ID,
              accessVersion: 1,
              createdAt: "2026-07-15T01:00:00.000Z",
              codeRotatedAt: "2026-07-15T01:00:00.000Z",
              recordingCount: 2,
              latestRecording: null,
            }]
          : query && query !== "品質"
            ? []
            : [{
              libraryId: LIBRARY_ID,
              accessVersion,
              createdAt: "2026-07-16T01:00:00.000Z",
              codeRotatedAt:
                accessVersion === 2
                  ? "2026-07-16T03:00:00.000Z"
                  : "2026-07-16T01:00:00.000Z",
              recordingCount: 3,
              latestRecording: {
                sessionId: "11111111-1111-4111-8111-111111111111",
                title: "品質月會",
                status: "finalized",
                createdAt: "2026-07-16T02:00:00.000Z",
                updatedAt: "2026-07-16T02:30:00.000Z",
                finalizedAt: "2026-07-16T02:30:00.000Z",
                durationMs: 120000,
                totalSizeBytes: 1024,
                tracks: [],
              },
            }],
        meta: {
          nextCursor: !query && !cursor ? "next-page" : null,
          hasMore: !query && !cursor,
          totalCount: query && query !== "品質" ? 0 : query ? 1 : 2,
          totalRecordingCount: query && query !== "品質" ? 0 : query ? 3 : 5,
        },
      }),
    });
  });
  await page.route(`**/api/meetings/admin/libraries/${LIBRARY_ID}/rotate-code`, async (route) => {
    calls.rotate += 1;
    expect(route.request().headers().authorization).toBe(`Bearer ${TOKEN}`);
    expect(route.request().headers()["x-meeting-request"]).toBe("1");
    await rotateResponseRelease;
    rotated = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          library: {
            libraryId: LIBRARY_ID,
            accessVersion: 2,
            createdAt: "2026-07-16T01:00:00.000Z",
            codeRotatedAt: "2026-07-16T03:00:00.000Z",
          },
          code: "NW8-K9Q",
        },
      }),
    });
  });
  await page.route(`**/api/meetings/admin/libraries/${LIBRARY_ID}/open`, async (route) => {
    calls.open += 1;
    expect(route.request().headers().authorization).toBe(`Bearer ${TOKEN}`);
    expect(route.request().headers()["x-meeting-request"]).toBe("1");
    await new Promise((resolve) => setTimeout(resolve, 80));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          libraryId: LIBRARY_ID,
          accessVersion: 2,
          createdAt: "2026-07-16T01:00:00.000Z",
          codeRotatedAt: "2026-07-16T03:00:00.000Z",
        },
      }),
    });
  });
  await page.route("**/api/meetings/library", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          libraryId: LIBRARY_ID,
          accessVersion: 2,
          createdAt: "2026-07-16T01:00:00.000Z",
          codeRotatedAt: "2026-07-16T03:00:00.000Z",
        },
      }),
    })
  );
  await page.route("**/api/meetings/library/recordings?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [], meta: { nextCursor: null, hasMore: false } }),
    })
  );

  await page.goto("/dev/meeting-libraries");
  await expect(page.getByRole("heading", { name: "會議錄音庫管理" })).toBeVisible();
  await expect(page.getByText("品質月會", { exact: true })).toBeVisible();
  await expect(page.getByText("錄音庫", { exact: true }).locator("..").getByText("2", { exact: true })).toBeVisible();
  await expect(page.getByText("錄音", { exact: true }).locator("..").getByText("5", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "載入更多錄音庫" }).click();
  await expect(page.getByText(SECOND_LIBRARY_ID, { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "搜尋會議錄音庫" }).fill("品質");
  await expect.poll(() => qualityListCount).toBe(1);

  const qualityLibraryRow = page.locator(".dev-meeting-libraries__rows > li").filter({
    hasText: LIBRARY_ID,
  });
  await page.getByRole("textbox", { name: "搜尋會議錄音庫" }).fill("找不到");
  await expect(
    qualityLibraryRow.getByRole("button", { name: "唯讀開啟" })
  ).toBeDisabled();
  await expect(
    qualityLibraryRow.getByRole("button", { name: "重設 Code" })
  ).toBeDisabled();
  releaseStaleQualityList();
  await expect.poll(() => missingListCount).toBe(1);
  await expect(page.getByText("找不到符合條件的錄音庫")).toBeVisible();
  expect(calls.open).toBe(0);
  expect(calls.rotate).toBe(0);

  await page.getByRole("textbox", { name: "搜尋會議錄音庫" }).fill("品質");
  await expect(qualityLibraryRow).toBeVisible();
  await qualityLibraryRow.getByRole("button", { name: "重設 Code" }).click();
  const confirm = page.getByRole("button", { name: "確認重設" });
  await confirm.evaluate((button) => {
    button.click();
    button.click();
  });
  await expect.poll(() => calls.rotate).toBe(1);
  await page.getByRole("textbox", { name: "搜尋會議錄音庫" }).fill("找不到");
  await expect.poll(() => missingListCount).toBe(1);
  await expect(page.getByText("找不到符合條件的錄音庫")).toBeVisible();
  releaseRotateResponse();
  await expect(page.getByText("NW8-K9Q", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "搜尋會議錄音庫" })).toHaveValue(
    "找不到"
  );
  await expect(qualityLibraryRow).toHaveCount(0);
  await page.getByRole("textbox", { name: "搜尋會議錄音庫" }).fill("品質");
  await expect(page.getByText("第 2 版", { exact: true })).toBeVisible();
  expect(calls.rotate).toBe(1);
  expect(
    await page.evaluate(() => `${JSON.stringify(localStorage)}${JSON.stringify(sessionStorage)}`)
  ).not.toContain("NW8-K9Q");

  const open = qualityLibraryRow.getByRole("button", { name: "唯讀開啟" });
  await open.evaluate((button) => {
    button.click();
    button.click();
  });
  await expect(page).toHaveURL(/\/meetings\/library$/);
  const backToAdmin = page.getByRole("button", {
    name: /^(?:返回會議錄音庫管理|Back to meeting library management)$/,
  });
  await expect(backToAdmin).toBeVisible();
  await backToAdmin.click();
  await expect(page).toHaveURL(/\/dev\/meeting-libraries$/);
  expect(calls.open).toBe(1);
  expect(calls.list).toBeGreaterThan(0);
});

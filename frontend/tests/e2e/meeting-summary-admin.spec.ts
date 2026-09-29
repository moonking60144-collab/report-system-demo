import { expect, test } from "@playwright/test";

test("Demo keeps recording-library management and exposes the new meeting summary view", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("work-report:system-notice-admin-token:v1", "demo-admin-token");
  });
  await page.route("**/api/system-notice/config", route => route.fulfill({ json: { data: { maxUsers: 5, minPasswordLength: 6 } } }));
  await page.route("**/api/system-notice/session", route => route.fulfill({ json: { data: { username: "demo", expiresAt: "2027-09-29T00:00:00.000Z" } } }));
  await page.route("**/api/dev/ragic-fields/state", route => route.fulfill({ json: { data: { status: "ready", refreshedAt: null, totalForms: 0, totalFields: 0, message: null, updatedAt: null, progress: null } } }));
  await page.route("**/api/meetings/admin/meetings", route => route.fulfill({ json: { data: { meetings: [], stats: { activeMeetings: 0, maxMeetings: 2 } } } }));
  await page.route("**/api/meetings/admin/summaries?*", route => route.fulfill({ json: { data: { items: [], stats: { count: 0, bytes: 0, maxBytes: 268435456 }, admission: { available: false, reason: "MEETING_ONE_SHOT_PROVIDER_NOT_READY" } } } }));

  await page.goto("/dev/meeting-summaries");
  await expect(page.getByRole("heading", { name: "會議摘要庫" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "進行中會議" })).toBeVisible();
  await expect(page.getByText("會議處理服務尚未啟用，新的錄音已暫停。")).toBeVisible();
  await expect(page.getByRole("link", { name: /會議錄音庫/ })).toHaveAttribute("href", "/dev/meeting-libraries");
});

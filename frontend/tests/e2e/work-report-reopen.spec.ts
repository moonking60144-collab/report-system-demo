import { expect, test } from "@playwright/test";

test.use({ locale: "zh-TW" });

for (const formId of ["901", "902"] as const) {
  test(`${formId} 重新開啟會送出原明細版本，內部 hash 不顯示為欄位`, async ({ page }) => {
    const entryId = `990${formId}`;
    const entryPath = `/api/forms/${formId}/reports/${entryId}`;
    const taskId = `reopen-${formId}`;
    let writes = 0;
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (!url.pathname.startsWith("/api/")) return route.fallback();
      if (url.pathname === `${entryPath}/editing-presence`) {
        return route.fulfill({ json: { data: {
          hasOtherEditors: false, otherEditorCount: 0, canEdit: true,
          isCurrentSessionOwner: true, lockVersion: 1, observedAt: new Date().toISOString(),
        } } });
      }
      if (request.method() === "POST" && url.pathname === `${entryPath}/reopen`) {
        writes += 1;
        expect(url.searchParams.get("async")).toBe("1");
        expect(request.headers()["x-entry-snapshot-hash"]).toBe(`sha256:${"a".repeat(64)}`);
        return route.fulfill({ status: 202, json: { data: {
          taskId, status: "pending", lifecycleState: "accepted", createdAt: new Date().toISOString(),
        } } });
      }
      if (request.method() !== "GET") return route.fulfill({ status: 400 });
      if (url.pathname === `/api/forms/${formId}/reports/tasks/${taskId}`) {
        return route.fulfill({ json: { data: {
          taskId, formId, entryId, taskType: "update-report", operationKind: "reopen-work-order",
          status: "running", lifecycleState: "running", updatedAt: new Date().toISOString(),
        } } });
      }
      if (url.pathname === entryPath) {
        return route.fulfill({ json: { data: {
          id: entryId, workOrderNo: `WO-DEMO-${formId}`, status: "已結案",
          lastUpdatedAt: "2026-09-17T05:27:33.000Z", targetQtyPc: 100,
          entrySnapshotHash: `sha256:${"a".repeat(64)}`,
          reportsLoaded: true, reports: [{ rowId: "1", date: "2026/09/17", snapshotHash: "b".repeat(64) }],
        } } });
      }
      if (url.pathname.endsWith("/options")) return route.fulfill({ json: { data: {} } });
      return route.fulfill({ json: { data: [] } });
    });
    await page.goto(`/reports/${formId}/${entryId}?topView=report`);
    const noticeCancel = page.getByRole("button", { name: /^(取消|Cancel)$/ });
    if (await noticeCancel.count()) await noticeCancel.first().click();
    await expect(page.locator(".context-badge.is-closed")).toContainText("已結案");
    await expect(page.locator(".detail-subtable th").filter({ hasText: "snapshotHash" })).toHaveCount(0);
    await expect(page.getByText("b".repeat(64), { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: /^(取消結案|Reopen Order)$/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: /^(確定|確認|OK|Confirm)$/ }).click();
    await expect(page.getByRole("status").first()).toContainText("已受理更新，背景處理中");
    expect(writes).toBe(1);
  });
}

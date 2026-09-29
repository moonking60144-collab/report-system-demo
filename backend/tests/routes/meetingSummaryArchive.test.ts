import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { createMeetingSummaryArchiveRouter } from "../../src/routes/meetingSummaryArchive";
import { MeetingSummaryArchiveRepository } from "../../src/storage/meeting-minutes/meetingSummaryArchiveRepository";
import { errorHandler } from "../../src/middleware/errorHandler";
import { HttpError } from "../../src/utils/httpError";

test("摘要清單與 HTML 都驗證 developer bearer，owner cookie 或前端 dev 標記不能取代", async () => {
  const repo = new MeetingSummaryArchiveRepository(":memory:", 1000);
  await repo.publish({ sessionId: "session-a", versionNumber: 1, title: "測試會議", meetingDate: null,
    generatedAt: "2026-09-09T00:00:00.000Z", html: "<!doctype html><html>摘要</html>" }, "2026-09-09T00:00:00.000Z");
  const app = express();
  app.use("/api", createMeetingSummaryArchiveRouter(repo, authorization => {
    if (authorization !== "Bearer developer-test") throw new HttpError(401, "developer required", "DEV_AUTH_REQUIRED");
  }));
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/meetings/admin/summaries`;
  try {
    for (const suffix of ["", "/session-a/html", "/session-a/html?download=1"]) {
      const response = await fetch(base + suffix, { headers: { Cookie: "meeting_owner=ordinary-user", "X-Dev-Mode": "true" } });
      assert.equal(response.status, 401);
      assert.doesNotMatch(await response.text(), /測試會議|<html>/);
    }
    const headers = { Authorization: "Bearer developer-test" };
    const listing = await fetch(base, { headers });
    assert.equal(listing.status, 200);
    const result = await listing.json() as { data: { items: Array<{ sessionId: string; html?: string }> } };
    assert.equal(result.data.items[0].sessionId, "session-a");
    assert.equal(result.data.items[0].html, undefined);
    const html = await fetch(`${base}/session-a/html`, { headers });
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-security-policy") ?? "", /sandbox; default-src 'none'/);
    assert.equal(html.headers.get("cache-control"), "no-store");
    assert.equal(html.headers.get("content-disposition"), 'inline; filename="meeting-summary.html"');
    assert.equal(await html.text(), "<!doctype html><html>摘要</html>");
    const download = await fetch(`${base}/session-a/html?download=1`, { headers });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-disposition"), 'attachment; filename="meeting-summary.html"');
    assert.equal(download.headers.get("cache-control"), "no-store");
    assert.match(download.headers.get("content-security-policy") ?? "", /sandbox; default-src 'none'/);
    assert.equal(await download.text(), "<!doctype html><html>摘要</html>");
    assert.equal((await fetch(`${base}/missing/html`, { headers })).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await repo.close();
  }
});

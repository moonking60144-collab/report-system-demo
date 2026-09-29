import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MeetingSummaryArchiveRepository } from "../../src/storage/meeting-minutes/meetingSummaryArchiveRepository";

const input = { sessionId: "session-a", versionNumber: 1, title: "生產會議", meetingDate: "2026-09-09",
  generatedAt: "2026-09-09T01:00:00.000Z", html: "<html>摘要</html>" };

test("HTML 歸檔只保留最新成功版本，重播與舊版本不覆蓋", async () => {
  const repo = new MeetingSummaryArchiveRepository(":memory:", 1000);
  try {
    const first = await repo.publish(input, input.generatedAt);
    assert.equal(first.sizeBytes, 19);
    await repo.publish({ ...input, versionNumber: 2, html: "<html>新版</html>" }, "2026-09-10T01:00:00.000Z");
    await repo.publish(input, input.generatedAt);
    const current = await repo.get(input.sessionId);
    assert.equal(current?.html, "<html>新版</html>");
    assert.equal(current?.versionNumber, 2);
    assert.equal(current?.archivedAt, first.archivedAt);
    assert.deepEqual(await repo.stats(), { count: 1, bytes: 19, maxBytes: 1000 });
    assert.equal("html" in (await repo.list())[0], false);
    assert.equal((await repo.list(50, 0, "生產")).length, 1);
    await assert.rejects(repo.publish({ ...input, versionNumber: 2, html: "different" }, input.generatedAt),
      (error: { code?: string }) => error.code === "MEETING_SUMMARY_ARCHIVE_CONFLICT");
    assert.equal((await repo.get(input.sessionId))?.html, "<html>新版</html>");
  } finally { await repo.close(); }
});

test("容量不足時保留舊 HTML，不清掉既有摘要", async () => {
  const repo = new MeetingSummaryArchiveRepository(":memory:", 20);
  try {
    await repo.publish(input, input.generatedAt);
    await assert.rejects(repo.publish({ ...input, versionNumber: 2, html: "x".repeat(21) }, input.generatedAt),
      (error: { code?: string }) => error.code === "MEETING_SUMMARY_ARCHIVE_FULL");
    assert.equal((await repo.get(input.sessionId))?.html, input.html);
    assert.deepEqual(await repo.stats(), { count: 1, bytes: 19, maxBytes: 20 });
  } finally { await repo.close(); }
});

test("兩個 connection 同時歸檔不能穿透總容量，重啟後仍可讀 HTML", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "meeting-summary-archive-"));
  const file = path.join(root, "archive.sqlite3");
  const first = new MeetingSummaryArchiveRepository(file, 20);
  const second = new MeetingSummaryArchiveRepository(file, 20);
  try {
    await first.stats();
    await second.stats();
    const results = await Promise.allSettled([
      first.publish(input, input.generatedAt),
      second.publish({ ...input, sessionId: "session-b" }, input.generatedAt),
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected").length, 1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.equal(rejected?.reason.code, "MEETING_SUMMARY_ARCHIVE_FULL");
    assert.deepEqual(await first.stats(), { count: 1, bytes: 19, maxBytes: 20 });
    const [winner] = await first.list();
    await Promise.all([
      first.publish({ ...input, sessionId: winner.sessionId, versionNumber: 3 }, input.generatedAt),
      second.publish({ ...input, sessionId: winner.sessionId, versionNumber: 2, html: "<html>新版</html>" }, input.generatedAt),
    ]);
    assert.equal((await first.get(winner.sessionId))?.versionNumber, 3);
    await first.close();
    await second.close();
    const reloaded = new MeetingSummaryArchiveRepository(file, 20);
    try {
      const items = await reloaded.list();
      assert.equal(items.length, 1);
      assert.equal((await reloaded.get(items[0].sessionId))?.html, input.html);
    } finally { await reloaded.close(); }
  } finally {
    await first.close(); await second.close();
    await rm(root, { recursive: true, force: true });
  }
});

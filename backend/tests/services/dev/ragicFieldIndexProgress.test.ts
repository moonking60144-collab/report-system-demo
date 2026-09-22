import test from "node:test";
import assert from "node:assert/strict";
import { createProgressTracker } from "../../../src/services/dev/ragicFieldIndexProgress";

test("set downloading + patch downloadedBytes 取大值（monotonic）", () => {
  const t = createProgressTracker();
  t.set({
    phase: "downloading",
    downloadedBytes: 0,
    totalBytes: 100,
    startedAt: "2026-06-02T00:00:00.000Z",
  });
  t.patch({ phase: "downloading", downloadedBytes: 80 });
  // 模擬 retry：onDownloadProgress reset loaded=0
  t.patch({ phase: "downloading", downloadedBytes: 0 });
  const cur = t.get();
  assert.ok(cur && cur.phase === "downloading");
  if (cur.phase === "downloading") {
    assert.equal(cur.downloadedBytes, 80);
  }
});

test("set parsing 後 patch downloading 是 no-op（phase 不同）", () => {
  const t = createProgressTracker();
  t.set({
    phase: "parsing",
    parsedForms: 0,
    totalForms: 10,
    startedAt: "2026-06-02T00:00:00.000Z",
  });
  t.patch({ phase: "downloading", downloadedBytes: 999 });
  const cur = t.get();
  assert.ok(cur && cur.phase === "parsing");
});

test("writing 階段 patch writtenFields 取大值", () => {
  const t = createProgressTracker();
  t.set({
    phase: "writing",
    writtenFields: 0,
    totalFields: 50,
    startedAt: "2026-06-02T00:00:00.000Z",
  });
  t.patch({ phase: "writing", writtenFields: 30 });
  t.patch({ phase: "writing", writtenFields: 10 });
  const cur = t.get();
  assert.ok(cur && cur.phase === "writing");
  if (cur.phase === "writing") {
    assert.equal(cur.writtenFields, 30);
  }
});

test("reset 清空 current", () => {
  const t = createProgressTracker();
  t.set({
    phase: "downloading",
    downloadedBytes: 5,
    totalBytes: 10,
    startedAt: "2026-06-02T00:00:00.000Z",
  });
  t.reset();
  assert.equal(t.get(), null);
});

test("無 current 時 patch 是 no-op", () => {
  const t = createProgressTracker();
  t.patch({ phase: "downloading", downloadedBytes: 50 });
  assert.equal(t.get(), null);
});

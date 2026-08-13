import assert from "node:assert/strict";
import test from "node:test";
import { collectRuntimeHealthSnapshot } from "../../src/observability/runtimeHealthLogger";

test("runtime health 同時偵測 event loop、heap 與 mutation queue 壓力", async () => {
  const snapshot = await collectRuntimeHealthSnapshot({
    now: () => new Date("2026-08-13T00:00:00.000Z"),
    getEventLoopLagStats: () => ({ mean: 20, p95: 1_000, max: 1_200 }),
    getMemoryUsage: () => ({
      rss: 1_000,
      heapTotal: 1_000,
      heapUsed: 900,
      external: 50,
      arrayBuffers: 25,
    }),
    getMutationQueueStats: () => ({
      accepting: true,
      activeKeyCount: 10,
      pendingTaskCount: 450,
      oldestPendingTaskAgeMs: 100,
      highestPendingTaskCountPerKey: 2,
      maxPendingTaskCount: 500,
      maxPendingTaskCountPerKey: 25,
      maxOldestPendingTaskAgeMs: 600_000,
    }),
  });

  assert.equal(snapshot.at, "2026-08-13T00:00:00.000Z");
  assert.equal(snapshot.memory.heapUsedRatio, 0.9);
  assert.deepEqual(snapshot.warnings, [
    "EVENT_LOOP_LAG_HIGH",
    "HEAP_USAGE_HIGH",
    "WORK_REPORT_MUTATION_QUEUE_PRESSURE",
  ]);
});

test("runtime health 無壓力時保留 Node 與 mutation queue snapshot", async () => {
  const snapshot = await collectRuntimeHealthSnapshot({
    getEventLoopLagStats: () => ({ mean: 2, p95: 3, max: 4 }),
    getMutationQueueStats: () => ({
      accepting: true,
      activeKeyCount: 0,
      pendingTaskCount: 0,
      oldestPendingTaskAgeMs: 0,
      highestPendingTaskCountPerKey: 0,
      maxPendingTaskCount: 500,
      maxPendingTaskCountPerKey: 25,
      maxOldestPendingTaskAgeMs: 600_000,
    }),
  });

  assert.equal(snapshot.eventLoopLagMs.p95, 3);
  assert.equal(snapshot.workReportMutationQueue.pendingTaskCount, 0);
  assert.ok(snapshot.memory.rssBytes > 0);
  assert.deepEqual(snapshot.warnings, []);
});

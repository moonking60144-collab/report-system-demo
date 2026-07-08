import test from "node:test";
import assert from "node:assert/strict";
import { ragicRequestScheduler } from "../../src/infra/ragicRequestScheduler";

test("runRead 正常回傳任務結果", async () => {
  const result = await ragicRequestScheduler.runRead("test-ok", async () => "ok");
  assert.equal(result, "ok");
});

test("runRead 任務丟 error 會向外重拋", async () => {
  await assert.rejects(
    () => ragicRequestScheduler.runRead("test-err", async () => {
      throw new Error("boom");
    }),
    /boom/
  );
});

test("priority=mutation / sync / background 走不同 lane", async () => {
  // 同時塞四種 priority 的任務，用 getStats 觀察 active 分佈
  const blockers: Array<() => void> = [];
  const makeTask = () =>
    new Promise<void>((resolve) => {
      blockers.push(resolve);
    });

  const userTask = ragicRequestScheduler.runRead("u", makeTask, "user");
  const mutationTask = ragicRequestScheduler.runRead("m", makeTask, "mutation");
  const syncTask = ragicRequestScheduler.runRead("s", makeTask, "sync");
  const bgTask = ragicRequestScheduler.runRead("b", makeTask, "background");

  // 等 microtask queue 讓任務進入 lane
  await new Promise((r) => setTimeout(r, 10));

  const stats = ragicRequestScheduler.getStats();
  assert.ok(stats.readActive >= 1, "user lane 應有 active");
  assert.ok(stats.mutationActive >= 1, "mutation lane 應有 active");
  assert.ok(stats.syncActive >= 1, "sync lane 應有 active");
  assert.ok(stats.backgroundActive >= 1, "background lane 應有 active");

  // 釋放所有任務
  blockers.forEach((release) => release());
  await Promise.all([userTask, mutationTask, syncTask, bgTask]);
});

test("getStats 會帶 circuit state", () => {
  const stats = ragicRequestScheduler.getStats();
  assert.ok(["closed", "open", "half-open"].includes(stats.readCircuitState));
  assert.ok(["closed", "open", "half-open"].includes(stats.mutationCircuitState));
  assert.ok(["closed", "open", "half-open"].includes(stats.syncCircuitState));
  assert.ok(["closed", "open", "half-open"].includes(stats.backgroundCircuitState));
  assert.ok(["closed", "open", "half-open"].includes(stats.writeCircuitState));
});

test("getStats 會拆出前景與背景 token bucket，並保留 aggregate 欄位", () => {
  const stats = ragicRequestScheduler.getStats();

  assert.ok(stats.foregroundRateLimiterCapacity >= 1);
  assert.ok(stats.mutationRateLimiterCapacity >= 1);
  assert.ok(stats.backgroundRateLimiterCapacity >= 1);
  assert.equal(
    stats.globalRateLimiterCapacity,
    stats.foregroundRateLimiterCapacity +
      stats.mutationRateLimiterCapacity +
      stats.backgroundRateLimiterCapacity
  );
  assert.equal(
    stats.globalRateLimiterRefillPerSecond,
    stats.foregroundRateLimiterRefillPerSecond +
      stats.mutationRateLimiterRefillPerSecond +
      stats.backgroundRateLimiterRefillPerSecond
  );
});

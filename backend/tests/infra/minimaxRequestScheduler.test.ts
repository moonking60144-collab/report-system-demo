import assert from "node:assert/strict";
import test from "node:test";
import {
  MiniMaxRequestQueueAbortedError,
  MiniMaxRequestQueueTimeoutError,
  MiniMaxRequestScheduler,
} from "../../src/infra/minimaxRequestScheduler";

test("MiniMax scheduler 以設定的 concurrency 串行執行", async () => {
  const scheduler = new MiniMaxRequestScheduler(1);
  let releaseFirst: (() => void) | undefined;
  let active = 0;
  let maxActive = 0;

  const first = scheduler.run(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    active -= 1;
    return "first";
  });
  const second = scheduler.run(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    active -= 1;
    return "second";
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(scheduler.getStats(), {
    active: 1,
    pending: 1,
    maxConcurrency: 1,
  });
  releaseFirst?.();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.equal(maxActive, 1);
  assert.equal(scheduler.getStats().active, 0);
});
test("MiniMax scheduler 將排隊逾時與取消分開回報", async () => {
  const scheduler = new MiniMaxRequestScheduler(1);
  let releaseFirst: (() => void) | undefined;
  const first = scheduler.run(
    () =>
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      })
  );

  await assert.rejects(
    scheduler.run(async () => undefined, { queueTimeoutMs: 5 }),
    MiniMaxRequestQueueTimeoutError
  );

  const controller = new AbortController();
  const aborted = scheduler.run(async () => undefined, {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(aborted, MiniMaxRequestQueueAbortedError);

  releaseFirst?.();
  await first;
  assert.deepEqual(scheduler.getStats(), {
    active: 0,
    pending: 0,
    maxConcurrency: 1,
  });
});

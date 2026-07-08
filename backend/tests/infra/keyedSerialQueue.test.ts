import assert from "node:assert/strict";
import test from "node:test";
import { createKeyedSerialQueue } from "../../src/utils/keyedSerialQueue";

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("同 key 任務依排入順序串行執行，不會並行", async () => {
  const queue = createKeyedSerialQueue();
  const order: string[] = [];
  const firstGate = deferred();

  const first = queue.enqueue("k1", async () => {
    order.push("first-start");
    await firstGate.promise;
    order.push("first-end");
  });
  const second = queue.enqueue("k1", async () => {
    order.push("second-start");
  });

  // second 已排入但 first 還沒放行 → second 不得開始
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first-start"]);

  firstGate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
});

test("不同 key 互不阻塞", async () => {
  const queue = createKeyedSerialQueue();
  const order: string[] = [];
  const slowGate = deferred();

  const slow = queue.enqueue("slow", async () => {
    await slowGate.promise;
    order.push("slow-done");
  });
  const fast = queue.enqueue("fast", async () => {
    order.push("fast-done");
  });

  await fast;
  assert.deepEqual(order, ["fast-done"]);

  slowGate.resolve();
  await slow;
  assert.deepEqual(order, ["fast-done", "slow-done"]);
});

test("前一筆失敗不阻塞後續任務（queue 保持可用）", async () => {
  const queue = createKeyedSerialQueue();
  const order: string[] = [];

  const failing = queue.enqueue("k1", async () => {
    throw new Error("task-failed");
  });
  const following = queue.enqueue("k1", async () => {
    order.push("following-ran");
  });

  await assert.rejects(() => failing, /task-failed/);
  await following;
  assert.deepEqual(order, ["following-ran"]);
});

test("chain 跑完自動清掉 key，activeKeyCount 歸零", async () => {
  const queue = createKeyedSerialQueue();
  const gate = deferred();

  const task = queue.enqueue("k1", async () => {
    await gate.promise;
  });
  assert.equal(queue.activeKeyCount, 1);

  gate.resolve();
  await task;
  // finally 清理排在 task settle 之後的 microtask
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queue.activeKeyCount, 0);
});

test("清理後同 key 再排新任務可正常執行（Map 不殘留舊 chain）", async () => {
  const queue = createKeyedSerialQueue();
  const order: string[] = [];

  await queue.enqueue("k1", async () => {
    order.push("round-1");
  });
  await new Promise((resolve) => setImmediate(resolve));

  await queue.enqueue("k1", async () => {
    order.push("round-2");
  });
  assert.deepEqual(order, ["round-1", "round-2"]);
});

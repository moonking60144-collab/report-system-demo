import assert from "node:assert/strict";
import test from "node:test";
import {
  createKeyedSerialQueue,
  KeyedSerialQueueAbortedError,
  KeyedSerialQueueCapacityError,
  KeyedSerialQueueClosedError,
} from "../../src/utils/keyedSerialQueue";

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

test("超過全域 pending 上限時拒絕新任務", async () => {
  const queue = createKeyedSerialQueue({ maxPendingTaskCount: 2 });
  const gate = deferred();
  const first = queue.enqueue("a", () => gate.promise);
  const second = queue.enqueue("b", () => gate.promise);

  assert.throws(
    () => queue.enqueue("c", async () => {}),
    (error: unknown) =>
      error instanceof KeyedSerialQueueCapacityError && error.reason === "total"
  );

  gate.resolve();
  await Promise.all([first, second]);
});

test("超過同 key pending 上限時只拒絕該 key", async () => {
  const queue = createKeyedSerialQueue({ maxPendingTaskCountPerKey: 2 });
  const gate = deferred();
  const first = queue.enqueue("same", () => gate.promise);
  const second = queue.enqueue("same", async () => {});

  assert.throws(
    () => queue.assertAccepting("same"),
    (error: unknown) =>
      error instanceof KeyedSerialQueueCapacityError && error.reason === "key"
  );
  await queue.enqueue("other", async () => {});

  gate.resolve();
  await Promise.all([first, second]);
});

test("最老 pending 任務超過門檻時拒絕新增並提供等待時間", async () => {
  let now = 1_000;
  const queue = createKeyedSerialQueue({
    maxOldestPendingTaskAgeMs: 5_000,
    now: () => now,
  });
  const gate = deferred();
  const first = queue.enqueue("slow", () => gate.promise);
  now = 6_000;

  assert.throws(
    () => queue.enqueue("new", async () => {}),
    (error: unknown) =>
      error instanceof KeyedSerialQueueCapacityError &&
      error.reason === "age" &&
      error.oldestPendingTaskAgeMs === 5_000
  );
  assert.equal(queue.getOldestPendingTaskAgeMs(), 5_000);

  gate.resolve();
  await first;
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

test("尚未開始的同 key 任務 abort 後不會執行且不阻塞後續任務", async () => {
  const queue = createKeyedSerialQueue();
  const firstGate = deferred();
  const controller = new AbortController();
  let abortedTaskRan = false;
  let followingTaskRan = false;

  const first = queue.enqueue("k1", async () => {
    await firstGate.promise;
  });
  const aborted = queue.enqueue(
    "k1",
    async () => {
      abortedTaskRan = true;
    },
    { signal: controller.signal }
  );
  const following = queue.enqueue("k1", async () => {
    followingTaskRan = true;
  });

  controller.abort();
  firstGate.resolve();

  await first;
  await assert.rejects(
    () => aborted,
    (error: unknown) => error instanceof KeyedSerialQueueAbortedError
  );
  await following;
  assert.equal(abortedTaskRan, false);
  assert.equal(followingTaskRan, true);
});

test("close admission 後新任務會明確拒絕，既有 queue stats 保持可觀測", () => {
  const queue = createKeyedSerialQueue();

  queue.closeAdmission();

  assert.deepEqual(queue.getStats(), {
    accepting: false,
    activeKeyCount: 0,
    pendingTaskCount: 0,
  });
  assert.throws(
    () => queue.assertAccepting(),
    (error: unknown) => error instanceof KeyedSerialQueueClosedError
  );
  assert.throws(
    () => queue.enqueue("closed", async () => {}),
    (error: unknown) => error instanceof KeyedSerialQueueClosedError
  );
});

test("drain 會等待 close admission 前已接受的所有 key 任務 settle", async () => {
  const queue = createKeyedSerialQueue();
  const firstGate = deferred();
  const otherGate = deferred();
  const failingGate = deferred();

  const first = queue.enqueue("same", async () => {
    await firstGate.promise;
  });
  const second = queue.enqueue("same", async () => {});
  const other = queue.enqueue("other", async () => {
    await otherGate.promise;
  });
  const failing = queue.enqueue("failing", async () => {
    await failingGate.promise;
    throw new Error("accepted-task-failed");
  });
  const failingResult = assert.rejects(failing, /accepted-task-failed/);

  queue.closeAdmission();
  let drained = false;
  const drain = queue.drain().then(() => {
    drained = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  assert.deepEqual(queue.getStats(), {
    accepting: false,
    activeKeyCount: 3,
    pendingTaskCount: 4,
  });
  assert.throws(
    () => queue.enqueue("late", async () => {}),
    (error: unknown) => error instanceof KeyedSerialQueueClosedError
  );

  firstGate.resolve();
  otherGate.resolve();
  failingGate.resolve();
  await Promise.all([first, second, other]);
  await failingResult;
  await drain;

  assert.equal(drained, true);
  assert.deepEqual(queue.getStats(), {
    accepting: false,
    activeKeyCount: 0,
    pendingTaskCount: 0,
  });
});

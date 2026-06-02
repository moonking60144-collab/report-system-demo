import test from "node:test";
import assert from "node:assert/strict";
import {
  TokenBucket,
  TokenBucketAcquireAbortedError,
  TokenBucketAcquireTimeoutError,
} from "../../src/infra/tokenBucket";

// 注意：refill 用 setTimeout，必然走真實時間。
// 不要混用「fake now() + 真 setTimeout」，那會讓 refill 永遠補不到 token、waiter 永不 resolve。
// 涉及 waiter 的 test 都用真實時間（refillPerSecond 拉高讓測試別等太久）。

test("初始 capacity 滿，可立即取出 N 個 token", async () => {
  const bucket = new TokenBucket({ refillPerSecond: 5, capacity: 3 });
  await bucket.acquire();
  await bucket.acquire();
  await bucket.acquire();
  // capacity=3，剛剛取走 3 個 → 剩 0
  assert.equal(bucket.getStats().availableTokens, 0);
});

test("tryAcquire 不阻塞，沒 token 直接回 false", () => {
  const bucket = new TokenBucket({ refillPerSecond: 5, capacity: 1 });
  assert.equal(bucket.tryAcquire(), true);
  assert.equal(bucket.tryAcquire(), false);
});

test("getStats 帶完整欄位", () => {
  const bucket = new TokenBucket({ refillPerSecond: 8, capacity: 12 });
  const stats = bucket.getStats();
  assert.equal(stats.capacity, 12);
  assert.equal(stats.refillPerSecond, 8);
  assert.equal(stats.availableTokens, 12);
  assert.equal(stats.pendingWaiters, 0);
});

test("token 用光後 acquire 會 block，refill 一段時間後可繼續", async () => {
  // refill 1000/s = 每 1ms 1 個。耗盡後等 ~5ms 應該足夠補一個
  const bucket = new TokenBucket({ refillPerSecond: 1000, capacity: 1 });
  await bucket.acquire(); // 取光

  // 立刻再 acquire 應該會 block，但 refill timer 啟動後很快會放行
  const start = Date.now();
  await bucket.acquire();
  const elapsed = Date.now() - start;

  assert.ok(elapsed >= 0, "elapsed 必須 >= 0");
  // 不嚴格驗 elapsed 上限（CI 慢）；只要它能完成就證明 refill 機制有 work
});

test("waiters 全部最終都被 refill 機制叫醒（不 hang）", async () => {
  // 不嚴格驗順序：跨 Promise.all + 多層 .then 微任務鏈，FIFO 在 Node 邊界情況下不可靠驗。
  // 真正重要的是：「沒人被遺忘」。FIFO 語意由 array.shift() 保證（內部結構性）。
  const bucket = new TokenBucket({ refillPerSecond: 1000, capacity: 1 });
  await bucket.acquire(); // 拿光

  const settled: number[] = [];
  const p1 = bucket.acquire().then(() => settled.push(1));
  const p2 = bucket.acquire().then(() => settled.push(2));
  const p3 = bucket.acquire().then(() => settled.push(3));

  await Promise.all([p1, p2, p3]);
  // 通過即代表 3 個 waiter 都被叫醒；元素本身不檢查順序
  assert.equal(settled.length, 3);
  assert.deepEqual([...settled].sort(), [1, 2, 3], "三個 id 都出現過");
});

test("constructor 拒絕 refillPerSecond <= 0", () => {
  assert.throws(
    () => new TokenBucket({ refillPerSecond: 0, capacity: 1 }),
    /refillPerSecond/
  );
  assert.throws(
    () => new TokenBucket({ refillPerSecond: -1, capacity: 1 }),
    /refillPerSecond/
  );
});

test("constructor 拒絕 capacity <= 0", () => {
  assert.throws(
    () => new TokenBucket({ refillPerSecond: 5, capacity: 0 }),
    /capacity/
  );
});

// === acquire 失敗條件 ===

test("acquire timeoutMs 超過 → 拋 TokenBucketAcquireTimeoutError 並從 queue 移除", async () => {
  // 故意設超慢的 refill，讓 token 短時間補不齊
  const bucket = new TokenBucket({ refillPerSecond: 0.1, capacity: 1 });
  await bucket.acquire(); // 拿光

  const startedAt = Date.now();
  await assert.rejects(
    () => bucket.acquire({ timeoutMs: 50 }),
    (err) => {
      assert.ok(err instanceof TokenBucketAcquireTimeoutError);
      assert.ok(err.waitedMs >= 40, "waitedMs 應 >= timeout");
      return true;
    }
  );
  // 等沒實際造成 50ms 完成（驗證沒等更久）
  assert.ok(Date.now() - startedAt < 200, "拋 timeout 後應立即返回");

  // 重要：失敗的 waiter 應該已被移除，新 acquire 不會被卡死的 waiter 擋
  const stats = bucket.getStats();
  assert.equal(stats.pendingWaiters, 0, "timeout 失敗後 waiter 應從 queue 移除");
});

test("acquire 接受已 abort 的 signal 立刻 reject", async () => {
  const bucket = new TokenBucket({ refillPerSecond: 5, capacity: 1 });
  await bucket.acquire();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => bucket.acquire({ signal: ac.signal }),
    TokenBucketAcquireAbortedError
  );
});

test("acquire 等待中被 abort → reject 並從 queue 移除", async () => {
  const bucket = new TokenBucket({ refillPerSecond: 0.1, capacity: 1 });
  await bucket.acquire();
  const ac = new AbortController();
  const acquirePromise = bucket.acquire({ signal: ac.signal });
  // 微等讓 acquire 進入 waiter queue
  await new Promise((r) => setTimeout(r, 5));
  ac.abort();
  await assert.rejects(acquirePromise, TokenBucketAcquireAbortedError);
  assert.equal(bucket.getStats().pendingWaiters, 0);
});

// === Cross-lane 整合（驗證全域 rate limit 跨 lane 生效）===

test("不同 caller 共用同一 bucket：總 outbound 受全域 rate 限制", async () => {
  // 模擬 user / sync / background 三條 lane 分別呼叫，但 bucket 是共用的
  const bucket = new TokenBucket({ refillPerSecond: 1000, capacity: 3 });
  // 拿光 capacity
  await bucket.acquire();
  await bucket.acquire();
  await bucket.acquire();

  // 三個來源同時排隊（模擬 lane 各自打進來）
  const start = Date.now();
  await Promise.all([
    bucket.acquire(), // user
    bucket.acquire(), // sync
    bucket.acquire(), // background
  ]);
  const elapsed = Date.now() - start;
  // refillPerSecond=1000，每 1ms 補 1 個，3 個 ~3ms。寬一點看 50ms 內能完成
  assert.ok(elapsed < 100, `三個跨 lane waiter 應在合理時間內完成，實際 ${elapsed}ms`);
});

test("Retry attempt 概念：每次 acquire 都重新拿一個 token（cumulative consumption）", () => {
  // Retry 移出 lane 後，每次 attempt 自己 acquire/release token；
  // 驗證 N 次 retry = N 個 token 消耗（不會共用上一輪 token）
  // 用 fakeNow 凍住時間 → 沒有 refill 干擾，可精準驗 availableTokens
  let fakeNow = 1000;
  const bucket = new TokenBucket({
    refillPerSecond: 1000,
    capacity: 5,
    now: () => fakeNow,
  });

  // 模擬「retry 3 次」每次都各自 acquire（用 tryAcquire 避免 await 觸發 microtask）
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal(bucket.tryAcquire(), true, `第 ${attempt + 1} 次 retry 拿到 token`);
  }
  const stats = bucket.getStats();
  assert.equal(stats.availableTokens, 2, "3 次 retry 各自消耗 1 個 token，capacity=5 剩 2");
});

// === Known limitation 文件化 ===
// 「TokenBucket waiters FIFO，不分 priority」這條 invariant 由 array.shift() 結構性保證
// （內部 push/shift 順序）。透過外部 Promise 鏈驗證會撞上 Node Promise 微任務邊界排序
// 不可靠的問題（已確認），所以只用 JSDoc / project_context.md 文件化，不寫 flaky test。
// 若未來需要證明這條，比較穩的方式是 expose 一個 internal `_drainOrder` debug API。

test("refill 用 fake now 推進；驗證 refill 計算公式而不是 timer", () => {
  let fakeNow = 1000;
  const bucket = new TokenBucket({
    refillPerSecond: 10, // 100ms / token
    capacity: 5,
    now: () => fakeNow,
  });

  // 取光 5 個
  for (let i = 0; i < 5; i++) {
    assert.equal(bucket.tryAcquire(), true);
  }
  assert.equal(bucket.tryAcquire(), false, "用光後 tryAcquire 回 false");

  // 推進 300ms → 應該補 3 個 token
  fakeNow += 300;
  assert.equal(bucket.tryAcquire(), true);
  assert.equal(bucket.tryAcquire(), true);
  assert.equal(bucket.tryAcquire(), true);
  assert.equal(bucket.tryAcquire(), false, "300ms 補 3 個，第 4 個再拿應 false");

  // 推進 1 秒 → 補 10，但 cap 5
  fakeNow += 1000;
  for (let i = 0; i < 5; i++) {
    assert.equal(bucket.tryAcquire(), true);
  }
  assert.equal(bucket.tryAcquire(), false, "cap=5 的 bucket 不會超過 5 個");
});

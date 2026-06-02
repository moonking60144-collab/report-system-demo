import test from "node:test";
import assert from "node:assert/strict";
import { CircuitBreaker, CircuitBreakerOpenError } from "../../src/infra/circuitBreaker";

function buildBreaker(opts?: { failureThreshold?: number; cooldownMs?: number; now?: () => number }) {
  return new CircuitBreaker("test", {
    failureThreshold: opts?.failureThreshold ?? 3,
    cooldownMs: opts?.cooldownMs ?? 1000,
    now: opts?.now ?? (() => 0),
  });
}

test("CLOSED 狀態 checkBeforeRun 不丟錯", () => {
  const breaker = buildBreaker();
  assert.doesNotThrow(() => breaker.checkBeforeRun());
  assert.equal(breaker.getState(), "closed");
});

test("連續失敗達 threshold 會 OPEN", () => {
  const breaker = buildBreaker({ failureThreshold: 3 });
  breaker.recordFailure();
  assert.equal(breaker.getState(), "closed");
  breaker.recordFailure();
  assert.equal(breaker.getState(), "closed");
  breaker.recordFailure();
  assert.equal(breaker.getState(), "open");
});

test("成功會重置連續失敗計數", () => {
  const breaker = buildBreaker({ failureThreshold: 3 });
  breaker.recordFailure();
  breaker.recordFailure();
  breaker.recordSuccess();
  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.getState(), "closed");
});

test("OPEN 狀態 cooldown 期間會丟 CircuitBreakerOpenError", () => {
  let now = 0;
  const breaker = buildBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => now });
  breaker.recordFailure();
  assert.equal(breaker.getState(), "open");
  now = 500;
  assert.throws(() => breaker.checkBeforeRun(), CircuitBreakerOpenError);
});

test("cooldown 過後進入 HALF_OPEN，成功會回 CLOSED", () => {
  let now = 0;
  const breaker = buildBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => now });
  breaker.recordFailure();
  now = 1001;
  breaker.checkBeforeRun();
  assert.equal(breaker.getState(), "half-open");
  breaker.recordSuccess();
  assert.equal(breaker.getState(), "closed");
});

test("HALF_OPEN 失敗會立刻回 OPEN", () => {
  let now = 0;
  const breaker = buildBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => now });
  breaker.recordFailure();
  now = 1001;
  breaker.checkBeforeRun();
  assert.equal(breaker.getState(), "half-open");
  breaker.recordFailure();
  assert.equal(breaker.getState(), "open");
  now = 1500;
  assert.throws(() => breaker.checkBeforeRun(), CircuitBreakerOpenError);
});

test("CircuitBreakerOpenError 帶 retryAfterMs 資訊", () => {
  let now = 0;
  const breaker = buildBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => now });
  breaker.recordFailure();
  now = 300;
  try {
    breaker.checkBeforeRun();
    assert.fail("should have thrown");
  } catch (err) {
    if (!(err instanceof CircuitBreakerOpenError)) {
      assert.fail(`expected CircuitBreakerOpenError, got ${String(err)}`);
    }
    assert.equal(err.retryAfterMs, 700);
  }
});

// Lane 隔離保證：多個 breaker 實例彼此獨立
// 這是 RagicRequestScheduler 4 條 lane（user/sync/background/write）各自保護的基礎。
// 若未來誤把 breaker 共用（singleton 化）會直接被這條抓到。
test("不同 breaker 實例的狀態互相獨立", () => {
  const laneA = buildBreaker({ failureThreshold: 2 });
  const laneB = buildBreaker({ failureThreshold: 2 });

  // laneA 連續失敗打到 OPEN
  laneA.recordFailure();
  laneA.recordFailure();
  assert.equal(laneA.getState(), "open", "laneA 應該 OPEN");

  // laneB 完全不受影響
  assert.equal(laneB.getState(), "closed", "laneB 不該因 laneA OPEN 而變動");
  assert.doesNotThrow(() => laneB.checkBeforeRun(), "laneB 應該可正常通過 checkBeforeRun");
});

// onStateChange listener：state 轉換時觸發、payload 有 lane name / 前後狀態 / 失敗計數 / cooldown
test("closed → open 觸發 onStateChange，payload 帶 cooldownEndsAt", () => {
  const events: Array<{ from: string; to: string; consecutiveFailures: number; cooldownEndsAt: number }> = [];
  let now = 1000;
  const breaker = new CircuitBreaker("test-lane", {
    failureThreshold: 2,
    cooldownMs: 5000,
    now: () => now,
    onStateChange: (change) => {
      events.push({
        from: change.from,
        to: change.to,
        consecutiveFailures: change.consecutiveFailures,
        cooldownEndsAt: change.cooldownEndsAt,
      });
    },
  });

  breaker.recordFailure();
  assert.equal(events.length, 0, "未達 threshold 不該觸發");

  breaker.recordFailure();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.from, "closed");
  assert.equal(events[0]?.to, "open");
  assert.equal(events[0]?.consecutiveFailures, 2);
  assert.equal(events[0]?.cooldownEndsAt, 1000 + 5000);
});

test("open → half-open（cooldown 過後 checkBeforeRun）→ closed（success）連續觸發兩次", () => {
  const events: Array<{ from: string; to: string }> = [];
  let now = 1000;
  const breaker = new CircuitBreaker("test-lane", {
    failureThreshold: 1,
    cooldownMs: 1000,
    now: () => now,
    onStateChange: (change) => events.push({ from: change.from, to: change.to }),
  });

  breaker.recordFailure();
  assert.equal(events.at(-1)?.to, "open");

  now = 2001;
  breaker.checkBeforeRun(); // open → half-open
  assert.equal(events.length, 2);
  assert.equal(events.at(-1)?.from, "open");
  assert.equal(events.at(-1)?.to, "half-open");

  breaker.recordSuccess(); // half-open → closed
  assert.equal(events.length, 3);
  assert.equal(events.at(-1)?.from, "half-open");
  assert.equal(events.at(-1)?.to, "closed");
});

test("half-open → open（探測請求又失敗）也會觸發", () => {
  const events: Array<{ from: string; to: string }> = [];
  let now = 1000;
  const breaker = new CircuitBreaker("test-lane", {
    failureThreshold: 1,
    cooldownMs: 1000,
    now: () => now,
    onStateChange: (change) => events.push({ from: change.from, to: change.to }),
  });

  breaker.recordFailure(); // closed → open
  now = 2001;
  breaker.checkBeforeRun(); // open → half-open
  breaker.recordFailure(); // half-open → open

  assert.equal(events.length, 3);
  assert.equal(events.at(-1)?.from, "half-open");
  assert.equal(events.at(-1)?.to, "open");
});

test("已 open 狀態 recordFailure 不重複觸發 listener（concurrent 失敗去重）", () => {
  // 情境：ConcurrencyLane 有 N 個 in-flight task 同時失敗
  // → 第一個失敗讓 breaker OPEN
  // → 後續失敗的任務也會 call recordFailure，但不該再 emit 同一個 OPEN 事件
  const events: Array<{ from: string; to: string }> = [];
  let now = 1000;
  const breaker = new CircuitBreaker("test-lane", {
    failureThreshold: 1,
    cooldownMs: 5000,
    now: () => now,
    onStateChange: (change) => events.push({ from: change.from, to: change.to }),
  });

  breaker.recordFailure(); // closed → open，emit 1
  assert.equal(events.length, 1);

  // 同一個 OPEN 視窗內的後續失敗
  breaker.recordFailure();
  breaker.recordFailure();
  breaker.recordFailure();

  assert.equal(events.length, 1, "已 open 狀態的後續失敗不該重複 emit state-change 事件");
});

test("已 closed 狀態 recordSuccess 不重複觸發 listener", () => {
  let count = 0;
  const breaker = new CircuitBreaker("test-lane", {
    failureThreshold: 5,
    cooldownMs: 1000,
    now: () => 0,
    onStateChange: () => {
      count += 1;
    },
  });

  breaker.recordSuccess();
  breaker.recordSuccess();
  breaker.recordFailure();
  breaker.recordSuccess(); // failures 清掉但 state 一直是 closed

  assert.equal(count, 0, "從頭到尾沒離開 closed，不該觸發任何狀態事件");
});

// === 上層 ConcurrencyLane integration（透過 CircuitBreaker 行為驗證）===

test("breaker 在 cooldown 期間直接 throw CircuitBreakerOpenError", () => {
  let now = 1000;
  const breaker = new CircuitBreaker("test", {
    failureThreshold: 1,
    cooldownMs: 1000,
    now: () => now,
  });

  breaker.recordFailure(); // → open
  // cooldown 內 checkBeforeRun 應 throw CircuitBreakerOpenError，
  // 對應 ConcurrencyLane 在 acquire 之後 re-check 時的 fast-fail 路徑
  now = 500;
  assert.throws(
    () => breaker.checkBeforeRun(),
    (err) => {
      assert.ok(err instanceof CircuitBreakerOpenError);
      return true;
    }
  );
});

test("transition payload 對非 OPEN 狀態，cooldownEndsAt 為 0", () => {
  const events: Array<{ to: string; cooldownEndsAt: number }> = [];
  let now = 1000;
  const breaker = new CircuitBreaker("test-lane", {
    failureThreshold: 1,
    cooldownMs: 1000,
    now: () => now,
    onStateChange: (change) =>
      events.push({ to: change.to, cooldownEndsAt: change.cooldownEndsAt }),
  });

  breaker.recordFailure();
  now = 2001;
  breaker.checkBeforeRun(); // → half-open
  breaker.recordSuccess(); // → closed

  const halfOpenEvent = events.find((e) => e.to === "half-open");
  const closedEvent = events.find((e) => e.to === "closed");
  assert.equal(halfOpenEvent?.cooldownEndsAt, 0);
  assert.equal(closedEvent?.cooldownEndsAt, 0);
});

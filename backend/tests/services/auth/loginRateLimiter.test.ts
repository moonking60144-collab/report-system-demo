import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLoginRateLimitKey,
  LoginRateLimiter,
} from "../../../src/services/auth/loginRateLimiter";

test("login rate limiter：同一 key 連續失敗達上限後會被限制", () => {
  let now = 1_000;
  const limiter = new LoginRateLimiter({
    maxFailures: 3,
    windowMs: 10_000,
    lockMs: 30_000,
    now: () => now,
  });
  const key = "127.0.0.1|admin";

  assert.equal(limiter.recordFailure(key).limited, false);
  assert.equal(limiter.recordFailure(key).limited, false);
  const limited = limiter.recordFailure(key);

  assert.equal(limited.limited, true);
  assert.equal(limited.retryAfterMs, 30_000);
  assert.equal(limiter.check(key).limited, true);

  now += 30_001;
  assert.equal(limiter.check(key).limited, false);
});

test("login rate limiter：成功登入會清除既有失敗紀錄", () => {
  const limiter = new LoginRateLimiter({
    maxFailures: 2,
    windowMs: 10_000,
    lockMs: 30_000,
  });
  const key = "127.0.0.1|admin";

  assert.equal(limiter.recordFailure(key).failedCount, 1);
  limiter.recordSuccess(key);

  const next = limiter.recordFailure(key);
  assert.equal(next.failedCount, 1);
  assert.equal(next.limited, false);
});

test("login rate limiter：失敗時間窗過後重新計數", () => {
  let now = 1_000;
  const limiter = new LoginRateLimiter({
    maxFailures: 2,
    windowMs: 1_000,
    lockMs: 30_000,
    now: () => now,
  });
  const key = "127.0.0.1|admin";

  assert.equal(limiter.recordFailure(key).failedCount, 1);
  now += 1_001;

  const next = limiter.recordFailure(key);
  assert.equal(next.failedCount, 1);
  assert.equal(next.limited, false);
});

test("login rate limiter：key 會正規化 username，避免大小寫繞過", () => {
  assert.equal(
    buildLoginRateLimitKey({ clientKey: "127.0.0.1", username: " Admin " }),
    "127.0.0.1|admin"
  );
});

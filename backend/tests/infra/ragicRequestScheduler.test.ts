import test from "node:test";
import assert from "node:assert/strict";
import { AxiosError } from "axios";
import { env } from "../../src/config/env";
import {
  RagicRequestScheduler,
  ragicRequestScheduler,
} from "../../src/infra/ragicRequestScheduler";
import { TokenBucketAcquireTimeoutError } from "../../src/infra/tokenBucket";

function responseError(status: number): AxiosError {
  const error = new AxiosError(`HTTP ${status}`);
  Object.defineProperty(error, "response", {
    value: { status },
    configurable: true,
  });
  return error;
}

function networkError(code?: string): AxiosError {
  return new AxiosError(code ? `network ${code}` : "network failure", code);
}

async function assertReadFailureCounted(error: Error, expectedCounted: boolean): Promise<void> {
  const scheduler = new RagicRequestScheduler({
    globalRatePerSecond: 100,
    globalBurstCapacity: 2,
  });

  await assert.rejects(
    () => scheduler.runRead("classifier-test", async () => {
      throw error;
    }),
    (actual: unknown) => actual === error
  );
  assert.equal(scheduler.getStats().readTotalFailures, expectedCounted ? 1 : 0);
}

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

test("getStats 會拆出 lane token bucket，並回傳真正 global cap", () => {
  const stats = ragicRequestScheduler.getStats();

  assert.ok(stats.foregroundRateLimiterCapacity >= 1);
  assert.ok(stats.mutationRateLimiterCapacity >= 1);
  assert.ok(stats.backgroundRateLimiterCapacity >= 1);
  assert.equal(stats.globalRateLimiterCapacity, env.RAGIC_GLOBAL_BURST_CAPACITY);
  assert.equal(stats.globalRateLimiterRefillPerSecond, env.RAGIC_GLOBAL_RATE_PER_SECOND);
});

test("TokenBucket acquire timeout 不計入 breaker failure", async () => {
  await assertReadFailureCounted(new TokenBucketAcquireTimeoutError(30_000), false);
});

test("deterministic HTTP 4xx 不計入 breaker failure", async () => {
  for (const status of [400, 401, 403, 404, 409, 422]) {
    await assertReadFailureCounted(responseError(status), false);
  }
});

test("transient HTTP 4xx 與 HTTP 5xx 仍計入 breaker failure", async () => {
  for (const status of [408, 425, 429, 500, 503, 599]) {
    await assertReadFailureCounted(responseError(status), true);
  }
});

test("network、timeout 與 reset error 仍計入 breaker failure", async () => {
  for (const error of [
    networkError(),
    networkError("ECONNABORTED"),
    networkError("ETIMEDOUT"),
    networkError("ECONNRESET"),
  ]) {
    await assertReadFailureCounted(error, true);
  }
});

test("runWrite 使用相同 breaker failure classifier", async () => {
  const deterministicScheduler = new RagicRequestScheduler();
  await assert.rejects(
    () => deterministicScheduler.runWrite("write-422", async () => {
      throw responseError(422);
    }),
    /HTTP 422/
  );
  assert.equal(deterministicScheduler.getStats().writeTotalFailures, 0);

  const transientScheduler = new RagicRequestScheduler();
  await assert.rejects(
    () => transientScheduler.runWrite("write-503", async () => {
      throw responseError(503);
    }),
    /HTTP 503/
  );
  assert.equal(transientScheduler.getStats().writeTotalFailures, 1);
});

test("half-open 收到 non-counted error 後會釋放 probe", async () => {
  const circuitEnv = env as unknown as {
    RAGIC_CIRCUIT_FAILURE_THRESHOLD: number;
    RAGIC_CIRCUIT_COOLDOWN_MS: number;
  };
  const originalFailureThreshold = circuitEnv.RAGIC_CIRCUIT_FAILURE_THRESHOLD;
  const originalCooldownMs = circuitEnv.RAGIC_CIRCUIT_COOLDOWN_MS;
  circuitEnv.RAGIC_CIRCUIT_FAILURE_THRESHOLD = 1;
  circuitEnv.RAGIC_CIRCUIT_COOLDOWN_MS = 1;

  try {
    const scheduler = new RagicRequestScheduler();
    await assert.rejects(
      () => scheduler.runRead("open-breaker", async () => {
        throw networkError("ECONNRESET");
      }),
      /ECONNRESET/
    );
    assert.equal(scheduler.getStats().readCircuitState, "open");

    await new Promise((resolve) => setTimeout(resolve, 5));
    await assert.rejects(
      () => scheduler.runRead("non-counted-probe", async () => {
        throw responseError(400);
      }),
      /HTTP 400/
    );
    assert.equal(scheduler.getStats().readCircuitState, "half-open");
    assert.equal(scheduler.getStats().readTotalFailures, 1);

    let nextProbeRan = false;
    const result = await scheduler.runRead("next-probe", async () => {
      nextProbeRan = true;
      return "ok";
    });
    assert.equal(nextProbeRan, true);
    assert.equal(result, "ok");
    assert.equal(scheduler.getStats().readCircuitState, "closed");
  } finally {
    circuitEnv.RAGIC_CIRCUIT_FAILURE_THRESHOLD = originalFailureThreshold;
    circuitEnv.RAGIC_CIRCUIT_COOLDOWN_MS = originalCooldownMs;
  }
});

test("不同 lane 同時送出時合計受 global burst cap 限制", async () => {
  const scheduler = new RagicRequestScheduler({
    globalRatePerSecond: 100,
    globalBurstCapacity: 2,
  });
  let started = 0;
  let releaseInitialTasks!: () => void;
  const initialTaskGate = new Promise<void>((resolve) => {
    releaseInitialTasks = resolve;
  });
  let markInitialBurstReached!: () => void;
  const initialBurstReached = new Promise<void>((resolve) => {
    markInitialBurstReached = resolve;
  });
  const task = async () => {
    started += 1;
    if (started === 2) {
      markInitialBurstReached();
    }
    await initialTaskGate;
  };
  const tasks = [
    scheduler.runRead("user", task),
    scheduler.runRead("mutation", task, "mutation"),
    scheduler.runRead("sync", task, "sync"),
    scheduler.runRead("background", task, "background"),
  ];

  await initialBurstReached;
  assert.equal(started, 2);

  releaseInitialTasks();
  await Promise.all(tasks);
  assert.equal(started, 4);
});

import test from "node:test";
import assert from "node:assert/strict";
import { AxiosError } from "axios";
import {
  runWithReadRetry,
  type ReadRetryLogPayload,
} from "../../src/infra/ragicReadRetry";

test("ragic read retry log payload 會帶 priority、timeout 與 scheduler snapshot", async () => {
  const retryLogs: ReadRetryLogPayload[] = [];
  let callCount = 0;

  const result = await runWithReadRetry(
    async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new AxiosError("timeout of 1500ms exceeded", "ECONNABORTED");
      }
      return "ok";
    },
    {
      label: "getEntry:/demo/work-orders/line-a/90002",
      priority: "mutation",
      timeoutMs: 1500,
      maxRetries: 1,
      baseDelayMs: 0,
      getSchedulerStats: () => ({
        mutationActive: 1,
        mutationPending: 0,
        backgroundActive: 4,
        backgroundPending: 2,
      }),
      retryLogSink: (payload) => {
        retryLogs.push(payload);
      },
    }
  );

  assert.equal(result, "ok");
  assert.equal(callCount, 2);
  assert.equal(retryLogs.length, 1);
  assert.deepEqual(retryLogs[0], {
    event: "retry",
    label: "getEntry:/demo/work-orders/line-a/90002",
    priority: "mutation",
    timeoutMs: 1500,
    attempt: 1,
    maxRetries: 1,
    waitMs: 0,
    reason: "ECONNABORTED",
    scheduler: {
      mutationActive: 1,
      mutationPending: 0,
      backgroundActive: 4,
      backgroundPending: 2,
    },
  });
});

test("overall budget 不足以容納 backoff 時不啟動下一個 read attempt", async () => {
  let callCount = 0;
  const error = new AxiosError("timeout", "ECONNABORTED");

  await assert.rejects(
    () =>
      runWithReadRetry(
        async () => {
          callCount += 1;
          throw error;
        },
        {
          maxRetries: 2,
          baseDelayMs: 100,
          overallTimeoutMs: 50,
        }
      ),
    (actual: unknown) => actual === error
  );
  assert.equal(callCount, 1);
});

test("overall budget 大於單次 timeout 時，第一個完整 timeout 後仍可重試", async (t) => {
  let now = 0;
  let callCount = 0;
  t.mock.method(Date, "now", () => now);

  const result = await runWithReadRetry(
    async () => {
      callCount += 1;
      if (callCount === 1) {
        now += 10_000;
        throw new AxiosError("timeout of 10000ms exceeded", "ECONNABORTED");
      }
      return "ok";
    },
    {
      maxRetries: 1,
      baseDelayMs: 0,
      timeoutMs: 10_000,
      overallTimeoutMs: 21_000,
    }
  );

  assert.equal(result, "ok");
  assert.equal(callCount, 2);
});

test("pre-write read 連續兩次 timeout 後仍可在同一個 bounded task 進行第三次讀取", async (t) => {
  let now = 0;
  let callCount = 0;
  t.mock.method(Date, "now", () => now);

  const result = await runWithReadRetry(
    async () => {
      callCount += 1;
      if (callCount <= 2) {
        now += 10_000;
        throw new AxiosError("timeout of 10000ms exceeded", "ECONNABORTED");
      }
      return "ok";
    },
    {
      maxRetries: 2,
      baseDelayMs: 0,
      timeoutMs: 10_000,
      overallTimeoutMs: 32_000,
    }
  );

  assert.equal(result, "ok");
  assert.equal(callCount, 3);
});

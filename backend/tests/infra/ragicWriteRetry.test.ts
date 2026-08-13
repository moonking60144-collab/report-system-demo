import assert from "node:assert/strict";
import test from "node:test";
import { AxiosError } from "axios";
import { runWithWriteRetry } from "../../src/infra/ragicWriteRetry";

function networkError(code: string): AxiosError {
  const error = new AxiosError(`network ${code}`);
  error.code = code;
  return error;
}

function responseError(status: number): AxiosError {
  const error = new AxiosError(`HTTP ${status}`);
  Object.defineProperty(error, "response", {
    value: { status },
    configurable: true,
  });
  return error;
}

test("ambiguous write timeout 不會自動重送", async () => {
  let attempts = 0;

  await assert.rejects(
    () =>
      runWithWriteRetry(
        async () => {
          attempts += 1;
          throw networkError("ECONNABORTED");
        },
        { maxRetries: 1, baseDelayMs: 0 }
      ),
    /ECONNABORTED/
  );

  assert.equal(attempts, 1);
});

test("ambiguous HTTP 5xx write 不會自動重送", async () => {
  let attempts = 0;

  await assert.rejects(
    () =>
      runWithWriteRetry(
        async () => {
          attempts += 1;
          throw responseError(503);
        },
        { maxRetries: 1, baseDelayMs: 0 }
      ),
    /HTTP 503/
  );

  assert.equal(attempts, 1);
});

test("pre-connect DNS failure 可安全重送", async () => {
  let attempts = 0;

  const result = await runWithWriteRetry(
    async () => {
      attempts += 1;
      if (attempts === 1) {
        throw networkError("EAI_AGAIN");
      }
      return "ok";
    },
    { maxRetries: 1, baseDelayMs: 0 }
  );

  assert.equal(result, "ok");
  assert.equal(attempts, 2);
});

test("HTTP 429 明確拒絕時可重送", async () => {
  let attempts = 0;

  const result = await runWithWriteRetry(
    async () => {
      attempts += 1;
      if (attempts === 1) {
        throw responseError(429);
      }
      return "ok";
    },
    { maxRetries: 1, baseDelayMs: 0 }
  );

  assert.equal(result, "ok");
  assert.equal(attempts, 2);
});

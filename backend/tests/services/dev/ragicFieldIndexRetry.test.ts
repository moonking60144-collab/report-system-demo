import assert from "node:assert/strict";
import test from "node:test";
import { AxiosError } from "axios";
import { runRagicDocFetchWithRetry } from "../../../src/services/dev/ragicFieldIndexService";

function responseError(status: number): AxiosError {
  const error = new AxiosError(`HTTP ${status}`);
  Object.defineProperty(error, "response", {
    value: { status },
    configurable: true,
  });
  return error;
}

test("doc fetch 每次 retry attempt 都會重新進入 scheduler", async () => {
  let attempts = 0;
  let scheduledAttempts = 0;

  const result = await runRagicDocFetchWithRetry(
    async () => {
      attempts += 1;
      if (attempts <= 2) {
        throw responseError(503);
      }
      return "ok";
    },
    {
      maxRetries: 2,
      baseDelayMs: 0,
      runScheduledAttempt: async (attempt) => {
        scheduledAttempts += 1;
        return attempt();
      },
    }
  );

  assert.equal(result, "ok");
  assert.equal(attempts, 3);
  assert.equal(scheduledAttempts, 3);
});

test("doc fetch abort 不會 retry", async () => {
  let attempts = 0;
  let scheduledAttempts = 0;

  await assert.rejects(
    () =>
      runRagicDocFetchWithRetry(
        async () => {
          attempts += 1;
          throw new DOMException("refresh aborted", "AbortError");
        },
        {
          maxRetries: 2,
          baseDelayMs: 0,
          runScheduledAttempt: async (attempt) => {
            scheduledAttempts += 1;
            return attempt();
          },
        }
      ),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError"
  );

  assert.equal(attempts, 1);
  assert.equal(scheduledAttempts, 1);
});

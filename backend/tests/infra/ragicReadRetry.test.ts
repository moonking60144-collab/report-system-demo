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
      label: "getEntry:/default/forms8/104/17382",
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
    label: "getEntry:/default/forms8/104/17382",
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

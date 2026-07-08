import test from "node:test";
import assert from "node:assert/strict";
import { scheduleRagicStartupJob } from "../../src/bootstrap/ragicStartupJobScheduler";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("startup job scheduler 只排程，不會立刻執行 delayed job", async (t) => {
  const infoPayloads: unknown[] = [];
  t.mock.method(console, "info", (_label: unknown, payload: unknown) => {
    infoPayloads.push(payload);
  });

  let runCount = 0;
  const handle = scheduleRagicStartupJob({
    jobLabel: "test-job",
    scheduledLogLabel: "[test-job-scheduled]",
    scheduledLogPayload: { startupDelayMs: 35 },
    startupDelayMs: 35,
    run: () => {
      runCount += 1;
    },
  });
  t.after(() => handle.stop());

  assert.equal(runCount, 0);
  assert.deepEqual(infoPayloads, [{ startupDelayMs: 35 }]);
  await wait(10);
  assert.equal(runCount, 0);
  await wait(45);
  assert.equal(runCount, 1);
});

test("startup job scheduler stop 會取消 startup 與 interval timer", async (t) => {
  t.mock.method(console, "info", () => {});

  let runCount = 0;
  const handle = scheduleRagicStartupJob({
    jobLabel: "test-interval-job",
    scheduledLogLabel: "[test-interval-job-scheduled]",
    scheduledLogPayload: { startupDelayMs: 0, intervalMs: 20 },
    startupDelayMs: 0,
    intervalMs: 20,
    run: () => {
      runCount += 1;
    },
  });

  await wait(5);
  assert.equal(runCount, 1);
  handle.stop();
  await wait(45);
  assert.equal(runCount, 1);
});

test("startup job scheduler run 失敗時不走 console.warn fallback", async (t) => {
  t.mock.method(console, "info", () => {});
  const consoleWarn = t.mock.method(console, "warn", () => {});

  const handle = scheduleRagicStartupJob({
    jobLabel: "test-failed-job",
    scheduledLogLabel: "[test-failed-job-scheduled]",
    scheduledLogPayload: { startupDelayMs: 0 },
    startupDelayMs: 0,
    run: () => {
      throw new Error("boom");
    },
  });
  t.after(() => handle.stop());

  await wait(10);
  assert.equal(consoleWarn.mock.callCount(), 0);
});

test("startup job scheduler 會攔住 onError 自己丟出的錯誤", async (t) => {
  t.mock.method(console, "info", () => {});
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  t.after(() => process.off("unhandledRejection", onUnhandledRejection));

  let onErrorCount = 0;
  const handle = scheduleRagicStartupJob({
    jobLabel: "test-on-error-failed-job",
    scheduledLogLabel: "[test-on-error-failed-job-scheduled]",
    scheduledLogPayload: { startupDelayMs: 0 },
    startupDelayMs: 0,
    run: () => {
      throw new Error("original failure");
    },
    onError: () => {
      onErrorCount += 1;
      throw new Error("handler failure");
    },
  });
  t.after(() => handle.stop());

  await wait(10);
  assert.equal(onErrorCount, 1);
  assert.deepEqual(unhandledRejections, []);
});

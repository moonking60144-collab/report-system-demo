import assert from "node:assert/strict";
import test from "node:test";
import { createGracefulShutdownHandler } from "../../src/server";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function fakeTimer(): ReturnType<typeof setTimeout> {
  return { unref() {} } as ReturnType<typeof setTimeout>;
}

test("shutdown 等 server close、mutation 與 callback drain 後才 flush registry 並關 SQLite", async () => {
  const calls: string[] = [];
  const serverCloseGate = deferred();
  const mutationDrainGate = deferred();
  const callbackDrainGate = deferred();
  const shutdown = createGracefulShutdownHandler({
    closeMutationAdmission: () => calls.push("close-mutation-admission"),
    closeCallbackAdmission: () => calls.push("close-callback-admission"),
    closeSseConnections: () => {
      calls.push("close-sse");
      return 2;
    },
    closeServer: () => {
      calls.push("close-server-start");
      return serverCloseGate.promise;
    },
    stopBackgroundWork: () => calls.push("stop-background"),
    drainMutationQueue: () => {
      calls.push("drain-mutation-start");
      return mutationDrainGate.promise;
    },
    drainCallbackQueue: () => {
      calls.push("drain-callback-start");
      return callbackDrainGate.promise;
    },
    flushRegistries: async () => {
      calls.push("flush-registries");
    },
    closeServiceStores: async () => {
      calls.push("close-service-stores");
    },
    closeSqlite: async () => {
      calls.push("close-sqlite");
    },
    getMutationQueueStats: () => ({
      accepting: false,
      activeKeyCount: 1,
      pendingTaskCount: 1,
    }),
    getCallbackQueueStats: () => ({
      accepting: false,
      activeKeyCount: 1,
      pendingTaskCount: 1,
    }),
    getSseStats: () => ({
      acceptingConnections: false,
      activeConnectionCount: 0,
      activeHeartbeatCount: 0,
      activeEventListenerCount: 0,
    }),
    logger: { info() {}, warn() {} },
    exit: (code) => calls.push(`exit-${code}`),
    forceExitTimeoutMs: 10_000,
    drainCheckpointTimeoutMs: 6_000,
    setForceExitTimer: () => fakeTimer(),
    clearForceExitTimer: () => calls.push("clear-force-timer"),
  });

  const shutdownPromise = shutdown("SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [
    "close-mutation-admission",
    "close-callback-admission",
    "close-sse",
    "close-server-start",
    "stop-background",
    "drain-mutation-start",
    "drain-callback-start",
  ]);

  mutationDrainGate.resolve();
  serverCloseGate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.includes("flush-registries"), false);

  callbackDrainGate.resolve();
  await shutdownPromise;
  assert.deepEqual(calls, [
    "close-mutation-admission",
    "close-callback-admission",
    "close-sse",
    "close-server-start",
    "stop-background",
    "drain-mutation-start",
    "drain-callback-start",
    "clear-force-timer",
    "flush-registries",
    "close-service-stores",
    "close-sqlite",
    "clear-force-timer",
    "exit-0",
  ]);
});

test("force timeout log 包含目前 stage、mutation/callback queue 與 SSE stats", async () => {
  const timers: Array<() => void> = [];
  const warnings: Record<string, unknown>[] = [];
  const exits: number[] = [];
  const queueStats = {
    accepting: false,
    activeKeyCount: 2,
    pendingTaskCount: 5,
  };
  const callbackQueueStats = {
    accepting: false,
    activeKeyCount: 1,
    pendingTaskCount: 3,
  };
  const sseStats = {
    acceptingConnections: false,
    activeConnectionCount: 1,
    activeHeartbeatCount: 1,
    activeEventListenerCount: 1,
  };
  const shutdown = createGracefulShutdownHandler({
    closeMutationAdmission() {},
    closeCallbackAdmission() {},
    closeSseConnections: () => 1,
    closeServer: () => new Promise<void>(() => {}),
    stopBackgroundWork() {},
    drainMutationQueue: () => new Promise<void>(() => {}),
    drainCallbackQueue: () => new Promise<void>(() => {}),
    async flushRegistries() {},
    async closeServiceStores() {},
    async closeSqlite() {},
    getMutationQueueStats: () => queueStats,
    getCallbackQueueStats: () => callbackQueueStats,
    getSseStats: () => sseStats,
    logger: {
      info() {},
      warn(fields) {
        warnings.push(fields);
      },
    },
    exit: (code) => exits.push(code),
    forceExitTimeoutMs: 10_000,
    drainCheckpointTimeoutMs: 6_000,
    setForceExitTimer: (callback) => {
      timers.push(callback);
      return fakeTimer();
    },
    clearForceExitTimer() {},
  });

  void shutdown("SIGINT");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.length, 2);
  timers[0]();

  assert.deepEqual(warnings, [
    {
      event: "shutdown.force-exit",
      reason: "timeout 10000ms",
      stage: "wait-server-close-and-queue-drain",
      mutationQueue: queueStats,
      callbackQueue: callbackQueueStats,
      sse: sseStats,
    },
  ]);
  assert.deepEqual(exits, [1]);
});

test("shutdown drain 過慢時先 checkpoint flush，但不會在 worker 尚未結束時關 SQLite", async () => {
  const calls: string[] = [];
  const settlementGate = deferred();
  const timers: Array<() => void> = [];
  const shutdown = createGracefulShutdownHandler({
    closeMutationAdmission: () => calls.push("close-mutation-admission"),
    closeCallbackAdmission: () => calls.push("close-callback-admission"),
    closeSseConnections: () => 0,
    closeServer: () => settlementGate.promise,
    stopBackgroundWork: () => undefined,
    drainMutationQueue: () => settlementGate.promise,
    drainCallbackQueue: () => settlementGate.promise,
    flushRegistries: async () => {
      calls.push("flush-registries");
    },
    closeServiceStores: async () => {
      calls.push("close-service-stores");
    },
    closeSqlite: async () => {
      calls.push("close-sqlite");
    },
    getMutationQueueStats: () => ({
      accepting: false,
      activeKeyCount: 1,
      pendingTaskCount: 1,
    }),
    getCallbackQueueStats: () => ({
      accepting: false,
      activeKeyCount: 1,
      pendingTaskCount: 1,
    }),
    getSseStats: () => ({
      acceptingConnections: false,
      activeConnectionCount: 0,
      activeHeartbeatCount: 0,
      activeEventListenerCount: 0,
    }),
    logger: {
      info() {},
      warn(fields) {
        if (fields.event === "shutdown.drain-slow") calls.push("drain-slow");
      },
    },
    exit: (code) => calls.push(`exit-${code}`),
    forceExitTimeoutMs: 10_000,
    drainCheckpointTimeoutMs: 6_000,
    setForceExitTimer: (callback) => {
      timers.push(callback);
      return fakeTimer();
    },
    clearForceExitTimer() {},
  });

  const shutdownPromise = shutdown("SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.length, 2);
  timers[1]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((call) => call === "flush-registries").length, 1);
  assert.equal(calls.includes("close-sqlite"), false);

  settlementGate.resolve();
  await shutdownPromise;
  assert.equal(calls.filter((call) => call === "flush-registries").length, 2);
  assert.ok(calls.indexOf("close-sqlite") > calls.lastIndexOf("flush-registries"));
  assert.equal(calls.at(-1), "exit-0");
});

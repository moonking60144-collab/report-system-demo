import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHealthRouter } from "../../src/routes/health";

async function withTestServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(
    "/api",
    createHealthRouter({
      getForm16WriteReverifyStats: () => ({ pending: 2, failed: 1, total: 3 }),
      getRagicSchedulerStats: () => ({
        backgroundActive: 1,
        backgroundPending: 2,
        backgroundRateLimiterPendingWaiters: 3,
      }),
      getRagicCallbackRefreshStats: () => ({
        total: 4,
        running: 1,
        activeCoalescingKeys: 1,
        coalescedCallbacks: 2,
      }),
    })
  );

  const server = await new Promise<Server>((resolve) => {
    const nextServer = app.listen(0, () => resolve(nextServer));
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

test("GET /api/health 回傳 Form16 write reverify backlog 統計", async () => {
  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`);

    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      status: string;
      form16WriteReverify: { pending: number; failed: number; total: number };
    };

    assert.equal(payload.status, "ok");
    assert.deepEqual(payload.form16WriteReverify, { pending: 2, failed: 1, total: 3 });
  });
});

test("GET /api/health?detail=1 回傳 Ragic scheduler 與 callback queue 指標", async () => {
  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health?detail=1`);

    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      ragicScheduler: {
        backgroundActive: number;
        backgroundPending: number;
        backgroundRateLimiterPendingWaiters: number;
      };
      ragicCallbackRefresh: {
        total: number;
        running: number;
        activeCoalescingKeys: number;
        coalescedCallbacks: number;
      };
    };

    assert.deepEqual(payload.ragicScheduler, {
      backgroundActive: 1,
      backgroundPending: 2,
      backgroundRateLimiterPendingWaiters: 3,
    });
    assert.deepEqual(payload.ragicCallbackRefresh, {
      total: 4,
      running: 1,
      activeCoalescingKeys: 1,
      coalescedCallbacks: 2,
    });
  });
});

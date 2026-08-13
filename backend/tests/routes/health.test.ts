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
      getMeetingProviderReadiness: () => ({
        ready: false,
        issues: ["MEETING_MINUTES_PROVIDER_UNSUPPORTED"],
        transcription: {
          configuredProvider: "google-gemini",
          runtimeProvider: "disabled",
          enabled: false,
        },
        minutes: {
          configuredProvider: "anthropic-claude",
          runtimeProvider: "disabled",
          enabled: false,
        },
        devAi: {
          configuredProvider: "minimax",
          enabled: true,
          ready: true,
        },
      }),
      getRuntimeHealthSnapshot: () => ({
        at: "2026-08-13T00:00:00.000Z",
        ragic: {} as never,
        createTasks: {} as never,
        form16WriteReverify: {} as never,
        workReportMutationQueue: {
          accepting: true,
          activeKeyCount: 1,
          pendingTaskCount: 2,
          oldestPendingTaskAgeMs: 800,
          highestPendingTaskCountPerKey: 2,
          maxPendingTaskCount: 500,
          maxPendingTaskCountPerKey: 25,
          maxOldestPendingTaskAgeMs: 600000,
        },
        meetingJobs: {
          processing: { pending: 1, running: 0, ready: 2, failed: 0, total: 3, oldestPendingAgeMs: 500 },
          transcription: { pending: 0, running: 1, ready: 1, failed: 0, total: 2, oldestPendingAgeMs: 0 },
          minutes: { pending: 0, running: 0, ready: 1, failed: 0, total: 1, oldestPendingAgeMs: 0 },
        },
        memory: {
          rssBytes: 100,
          heapTotalBytes: 80,
          heapUsedBytes: 40,
          heapUsedRatio: 0.5,
          externalBytes: 10,
          arrayBuffersBytes: 5,
        },
        eventLoopLagMs: { mean: 1, p95: 2, max: 3 },
        warnings: [],
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
      meetingProviders: {
        ready: boolean;
        issues: string[];
      };
      runtime: {
        workReportMutationQueue: { pendingTaskCount: number };
        meetingJobs: { processing: { pending: number } };
        eventLoopLagMs: { p95: number };
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
    assert.equal(payload.meetingProviders.ready, false);
    assert.deepEqual(payload.meetingProviders.issues, [
      "MEETING_MINUTES_PROVIDER_UNSUPPORTED",
    ]);
    assert.equal(payload.runtime.workReportMutationQueue.pendingTaskCount, 2);
    assert.equal(payload.runtime.meetingJobs.processing.pending, 1);
    assert.equal(payload.runtime.eventLoopLagMs.p95, 2);
  });
});

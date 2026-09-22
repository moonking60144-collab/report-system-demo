import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHealthRouter } from "../../src/routes/health";
import type { WorkReportReadinessSnapshot } from "../../src/services/work-report/workReportReadinessService";

function readinessSnapshot(
  overrides: Partial<WorkReportReadinessSnapshot> = {}
): WorkReportReadinessSnapshot {
  return {
    ready: true,
    mode: "ready",
    checkedAt: "2026-08-19T01:00:00.000Z",
    bootId: "boot-test",
    deployVersion: "deploy-test",
    capabilities: {
      frontend: true,
      workReportRead: true,
      workReportWrite: true,
      realtime: true,
    },
    dependencies: {
      maintenanceMode: false,
      sqlite: {
        "901": {
          available: true,
          readable: true,
          status: "success",
          snapshotAt: "2026-08-19T00:00:00.000Z",
          readModelVersion: 3,
          error: null,
        },
        "902": {
          available: true,
          readable: true,
          status: "success",
          snapshotAt: "2026-08-19T00:00:00.000Z",
          readModelVersion: 3,
          error: null,
        },
      },
      mutationQueue: { accepting: true, activeKeyCount: 0, pendingTaskCount: 0 },
      ragic: {
        readCircuitState: "closed",
        mutationCircuitState: "closed",
        writeCircuitState: "closed",
      },
    },
    issues: [],
    ...overrides,
  };
}

test("GET /api/health snapshot 無法讀寫時不得顯示健康的空佇列", async () => {
  await withTestServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/api/health`);
    const body = await response.json() as { healthState: string; issues: string[] };
    assert.equal(response.status, 200);
    assert.equal(body.healthState, "degraded");
    assert.ok(body.issues.includes("ACTIVITY_LOG_WRITE_REVERIFY_STORE_UNAVAILABLE"));
  }, { pending: 0, conflict: 0, failed: 0, total: 0, storeUnavailable: true });
});

async function withTestServer(
  run: (baseUrl: string) => Promise<void>,
  activityLogWriteReverify: { pending: number; conflict: number; failed: number; total: number; storeUnavailable?: boolean } = { pending: 2, conflict: 0, failed: 1, total: 3 },
  readiness = readinessSnapshot()
): Promise<void> {
  const app = express();
  app.use(
    "/api",
    createHealthRouter({
      getActivityLogWriteReverifyStats: () => activityLogWriteReverify,
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
        activityLogWriteReverify: {} as never,
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
      getWorkReportReadiness: async () => readiness,
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

test("GET /api/health 回傳 ActivityLog write reverify backlog 統計", async () => {
  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`);

    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      status: string;
      healthState: string;
      issues: string[];
      activityLogWriteReverify: { pending: number; conflict: number; failed: number; total: number };
    };

    assert.equal(payload.status, "ok");
    assert.equal(payload.healthState, "degraded");
    assert.deepEqual(payload.issues, ["ACTIVITY_LOG_WRITE_REVERIFY_FAILED"]);
    assert.deepEqual(payload.activityLogWriteReverify, {
      pending: 2,
      conflict: 0,
      failed: 1,
      total: 3,
    });
  });
});

test("GET /api/ready 依 Work Report readiness 回 200 且禁止 cache", async () => {
  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/ready`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const payload = (await response.json()) as WorkReportReadinessSnapshot;
    assert.equal(payload.ready, true);
    assert.equal(payload.capabilities.workReportWrite, true);
  });
});

test("GET /api/ready mutation queue 未開放時回 503，但 /api/health liveness 維持 200", async () => {
  await withTestServer(
    async (baseUrl) => {
      const readyResponse = await fetch(`${baseUrl}/api/ready`);
      assert.equal(readyResponse.status, 503);
      const readyPayload = (await readyResponse.json()) as WorkReportReadinessSnapshot;
      assert.equal(readyPayload.ready, false);
      assert.deepEqual(readyPayload.issues, ["MUTATION_QUEUE_CLOSED"]);

      const healthResponse = await fetch(`${baseUrl}/api/health`);
      assert.equal(healthResponse.status, 200);
    },
    { pending: 0, conflict: 0, failed: 0, total: 0 },
    readinessSnapshot({
      ready: false,
      mode: "unavailable",
      issues: ["MUTATION_QUEUE_CLOSED"],
    })
  );
});

test("GET /api/health 沒有 failed 補驗時維持健康且不改變 liveness status", async () => {
  await withTestServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/health`);
      assert.equal(response.status, 200);
      const payload = (await response.json()) as {
        status: string;
        healthState: string;
        issues: string[];
      };
      assert.equal(payload.status, "ok");
      assert.equal(payload.healthState, "ok");
      assert.deepEqual(payload.issues, []);
    },
    { pending: 1, conflict: 0, failed: 0, total: 1 }
  );
});

test("GET /api/health 有 ActivityLog conflict 時維持 liveness 並標示 degraded", async () => {
  await withTestServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/health`);
      assert.equal(response.status, 200);
      const payload = (await response.json()) as {
        status: string;
        healthState: string;
        issues: string[];
      };
      assert.equal(payload.status, "ok");
      assert.equal(payload.healthState, "degraded");
      assert.deepEqual(payload.issues, ["ACTIVITY_LOG_WRITE_REVERIFY_CONFLICT"]);
    },
    { pending: 0, conflict: 1, failed: 0, total: 1 }
  );
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

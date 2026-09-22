import assert from "node:assert/strict";
import test from "node:test";
import type { RagicRequestSchedulerStats } from "../../../src/infra/ragicRequestScheduler";
import { createWorkReportReadinessService } from "../../../src/services/work-report/workReportReadinessService";
import { READ_MODEL_SCHEMA_VERSION } from "../../../src/storage/sqlite/readModelSchema";
import type { StoredSyncState } from "../../../src/storage/sqlite/workReportSqliteRepository";

function syncState(formId: string): StoredSyncState {
  return {
    formId,
    status: "success",
    taskId: null,
    startedAt: null,
    finishedAt: "2026-08-19T00:00:00.000Z",
    snapshotAt: "2026-08-19T00:00:00.000Z",
    activeGenerationId: "generation-1",
    readModelVersion: READ_MODEL_SCHEMA_VERSION,
    totalEntries: 10,
    totalRows: 20,
    message: null,
    updatedAt: "2026-08-19T00:00:00.000Z",
  };
}

function ragicStats(
  overrides: Partial<RagicRequestSchedulerStats> = {}
): RagicRequestSchedulerStats {
  return {
    readActive: 0,
    readPending: 0,
    mutationActive: 0,
    mutationPending: 0,
    syncActive: 0,
    syncPending: 0,
    backgroundActive: 0,
    backgroundPending: 0,
    writeActive: 0,
    writePending: 0,
    readLatencyMsP50: 0,
    readLatencyMsP95: 0,
    mutationLatencyMsP50: 0,
    mutationLatencyMsP95: 0,
    syncLatencyMsP50: 0,
    syncLatencyMsP95: 0,
    backgroundLatencyMsP50: 0,
    backgroundLatencyMsP95: 0,
    writeLatencyMsP50: 0,
    writeLatencyMsP95: 0,
    readTotalRequests: 0,
    readTotalFailures: 0,
    mutationTotalRequests: 0,
    mutationTotalFailures: 0,
    syncTotalRequests: 0,
    syncTotalFailures: 0,
    backgroundTotalRequests: 0,
    backgroundTotalFailures: 0,
    writeTotalRequests: 0,
    writeTotalFailures: 0,
    readCircuitState: "closed",
    mutationCircuitState: "closed",
    syncCircuitState: "closed",
    backgroundCircuitState: "closed",
    writeCircuitState: "closed",
    globalRateLimiterAvailableTokens: 1,
    globalRateLimiterPendingWaiters: 0,
    globalRateLimiterCapacity: 1,
    globalRateLimiterRefillPerSecond: 1,
    foregroundRateLimiterAvailableTokens: 1,
    foregroundRateLimiterPendingWaiters: 0,
    foregroundRateLimiterCapacity: 1,
    foregroundRateLimiterRefillPerSecond: 1,
    mutationRateLimiterAvailableTokens: 1,
    mutationRateLimiterPendingWaiters: 0,
    mutationRateLimiterCapacity: 1,
    mutationRateLimiterRefillPerSecond: 1,
    backgroundRateLimiterAvailableTokens: 1,
    backgroundRateLimiterPendingWaiters: 0,
    backgroundRateLimiterCapacity: 1,
    backgroundRateLimiterRefillPerSecond: 1,
    ...overrides,
  };
}

function buildService(
  options: {
    syncStates?: Record<string, StoredSyncState | null>;
    queueAccepting?: boolean;
    ragic?: Partial<RagicRequestSchedulerStats>;
    maintenanceMode?: boolean;
  } = {}
) {
  return createWorkReportReadinessService({
    getSyncState: async (formId) =>
      options.syncStates && Object.prototype.hasOwnProperty.call(options.syncStates, formId)
        ? options.syncStates[formId] ?? null
        : syncState(formId),
    getMutationQueueStats: () => ({
      accepting: options.queueAccepting ?? true,
      activeKeyCount: 0,
      pendingTaskCount: 0,
    }),
    getRagicCircuitStates: () => ragicStats(options.ragic),
    getMaintenanceMode: async () => options.maintenanceMode ?? false,
    getBootId: () => "boot-test",
    getDeployVersion: () => "deploy-test",
    now: () => new Date("2026-08-19T01:00:00.000Z"),
  });
}

test("readiness 在 SQLite、queue 與 Ragic circuit 正常時回 ready", async () => {
  const snapshot = await buildService().getSnapshot();
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.mode, "ready");
  assert.equal(snapshot.bootId, "boot-test");
  assert.equal(snapshot.deployVersion, "deploy-test");
  assert.deepEqual(snapshot.capabilities, {
    frontend: true,
    workReportRead: true,
    workReportWrite: true,
    realtime: true,
  });
  assert.deepEqual(snapshot.issues, []);
});

test("Ragic 寫入 circuit open 時阻擋重新進入完整報工介面", async () => {
  const snapshot = await buildService({
    ragic: { mutationCircuitState: "open", writeCircuitState: "open" },
  }).getSnapshot();
  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.mode, "unavailable");
  assert.equal(snapshot.capabilities.workReportRead, true);
  assert.equal(snapshot.capabilities.workReportWrite, false);
  assert.deepEqual(snapshot.issues, [
    "RAGIC_MUTATION_CIRCUIT_OPEN",
    "RAGIC_WRITE_CIRCUIT_OPEN",
  ]);
});

test("Ragic 寫入 circuit half-open 時允許重新進入並保留降級狀態", async () => {
  const snapshot = await buildService({
    ragic: { mutationCircuitState: "half-open", writeCircuitState: "half-open" },
  }).getSnapshot();
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.mode, "degraded");
  assert.equal(snapshot.capabilities.workReportRead, true);
  assert.equal(snapshot.capabilities.workReportWrite, true);
  assert.deepEqual(snapshot.issues, [
    "RAGIC_MUTATION_CIRCUIT_HALF-OPEN",
    "RAGIC_WRITE_CIRCUIT_HALF-OPEN",
  ]);
});

test("SQLite snapshot 不可讀且 Ragic read circuit open 時回 unavailable", async () => {
  const snapshot = await buildService({
    syncStates: { "901": null, "902": null },
    ragic: { readCircuitState: "open" },
  }).getSnapshot();
  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.mode, "unavailable");
  assert.equal(snapshot.capabilities.workReportRead, false);
  assert.deepEqual(snapshot.issues, [
    "SQLITE_SNAPSHOT_901_UNAVAILABLE",
    "SQLITE_SNAPSHOT_902_UNAVAILABLE",
    "RAGIC_READ_CIRCUIT_OPEN",
  ]);
});

test("維護公告只分類斷線畫面，不阻擋已恢復的報工 readiness", async () => {
  const maintenance = await buildService({ maintenanceMode: true }).getSnapshot();
  assert.equal(maintenance.ready, true);
  assert.equal(maintenance.mode, "ready");
  assert.equal(maintenance.dependencies.maintenanceMode, true);
  assert.deepEqual(maintenance.issues, []);
});

test("shutdown admission 關閉時回 unavailable", async () => {
  const shutdown = await buildService({ queueAccepting: false }).getSnapshot();
  assert.equal(shutdown.ready, false);
  assert.deepEqual(shutdown.issues, ["MUTATION_QUEUE_CLOSED"]);
});

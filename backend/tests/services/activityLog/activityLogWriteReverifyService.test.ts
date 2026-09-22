import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import fs from "fs/promises";
import { spawnSync } from "node:child_process";
import {
  ragicClient,
  type RagicEntryObservationRead,
  type RagicReadRequestOptions,
} from "../../../src/ragic/client";
import { env } from "../../../src/config/env";
import { activityLogClientRowKeyRepository } from "../../../src/storage/sqlite/activityLogClientRowKeyRepository";
import { CircuitBreakerOpenError } from "../../../src/infra/circuitBreaker";
import {
  ActivityLogWriteReverifyService,
  type ActivityLogWriteReverifyTask,
} from "../../../src/services/activityLog/activityLogWriteReverifyService";

const FORM_PATH = "/demo/activity-log-tests";
const ENTRY_ID = "E-REVERIFY-1";

test("snapshot 寫入失敗不可接受新任務或破壞已持久化任務", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "activityLog-reverify-atomic-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storeFile = join(dir, "tasks.json");
  const service = new ActivityLogWriteReverifyService({ enabled: true, storeFile });
  const input = { activityLogPath: FORM_PATH, entryId: "1", expected: {},
    source: "test", readPriority: "background" as const, occurredAt: new Date().toISOString(), errorMessage: "deferred" };
  await service.enqueue(input);
  await service.flush();
  const originalWrite = fs.writeFile;
  const fault = t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
    await originalWrite(args[0], "");
    throw new Error("injected snapshot EIO");
  });
  await assert.rejects(service.enqueue({ ...input, entryId: "2" }), /snapshot EIO/);
  await assert.rejects(service.flush(), /snapshot EIO/);
  fault.mock.restore();
  const restarted = spawnSync(process.execPath, ["-e", `
    const { ActivityLogWriteReverifyService } = require(process.argv[1]);
    new ActivityLogWriteReverifyService({ enabled: true, storeFile: process.argv[2] })
      .listTasks().then(tasks => console.log('RECOVERED:' + JSON.stringify(tasks.map(task => task.entryId))))
      .catch(error => { console.error(error); process.exitCode = 1; });
  `, require.resolve("../../../src/services/activityLog/activityLogWriteReverifyService"), storeFile], { encoding: "utf8" });
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.ok(restarted.stdout.includes('RECOVERED:["1"]'), restarted.stdout);
});

test("損壞 snapshot 不得被空佇列覆寫", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "activityLog-reverify-corrupt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storeFile = join(dir, "tasks.json");
  await writeFile(storeFile, "{broken");
  const service = new ActivityLogWriteReverifyService({ enabled: true, storeFile });
  await assert.rejects(service.initialize());
  await assert.rejects(service.enqueue({ activityLogPath: FORM_PATH, entryId: "2", expected: {},
    source: "test", readPriority: "background", occurredAt: new Date().toISOString(), errorMessage: "deferred" }));
  assert.equal(await readFile(storeFile, "utf8"), "{broken");
});

function buildEntryWith(workOrderNo: string, type: string): RagicEntryObservationRead {
  return {
    kind: "found",
    record: {
      [env.UPSTREAM_ACTIVITY_LOG_WORK_ORDER_FIELD_ID]: workOrderNo,
      [env.UPSTREAM_ACTIVITY_LOG_TYPE_FIELD_ID]: type,
    },
  };
}

test("ActivityLog write reverify 會持久化 pending，補驗成功後清掉佇列", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "activityLog-reverify-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const storeFile = join(dir, "tasks.json");
  const service = new ActivityLogWriteReverifyService({
    enabled: true,
    storeFile,
    maxAttempts: 2,
    maxPerRun: 5,
    timeoutMs: 1000,
    maxRetries: 0,
  });

  await service.enqueue({
    activityLogPath: FORM_PATH,
    entryId: ENTRY_ID,
    expected: { workOrderNo: "WO-100", type: "PROC-A" },
    readPriority: "user",
    errorMessage: "ECONNABORTED",
    occurredAt: "2026-06-17T00:00:00.000Z",
    source: "test",
  });
  await service.flush();

  const before = JSON.parse(await readFile(storeFile, "utf-8")) as {
    tasks: Array<{ entryId: string; status: string }>;
  };
  assert.deepEqual(before.tasks.map((task) => [task.entryId, task.status]), [
    [ENTRY_ID, "pending"],
  ]);

  const getEntryMock = t.mock.method(ragicClient, "observeEntry", async () =>
    buildEntryWith("WO-100", "PROC-A")
  );
  const deleteEntryMock = t.mock.method(ragicClient, "deleteEntry", async () => undefined);

  const stats = await service.runOnce();

  assert.deepEqual(stats, {
    scanned: 1,
    verified: 1,
    conflicted: 0,
    failed: 0,
    retryPending: 0,
  });
  assert.equal(getEntryMock.mock.callCount(), 1);
  assert.equal(deleteEntryMock.mock.callCount(), 0);
  assert.deepEqual(service.getStats(), { pending: 0, conflict: 0, failed: 0, total: 0 });

  const after = JSON.parse(await readFile(storeFile, "utf-8")) as {
    tasks: unknown[];
  };
  assert.deepEqual(after.tasks, []);
});

test("ActivityLog write reverify 讀取仍失敗時保留 pending，超過次數後標 failed", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "activityLog-reverify-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  let nowMs = Date.parse("2026-06-17T00:00:00.000Z");
  const service = new ActivityLogWriteReverifyService({
    enabled: true,
    storeFile: join(dir, "tasks.json"),
    maxAttempts: 2,
    maxPerRun: 5,
    timeoutMs: 1000,
    maxRetries: 0,
    deferDelayMs: 1000,
    now: () => nowMs,
  });

  await service.enqueue({
    activityLogPath: FORM_PATH,
    entryId: ENTRY_ID,
    expected: { workOrderNo: "WO-100" },
    readPriority: "user",
    errorMessage: "ECONNABORTED",
    occurredAt: "2026-06-17T00:00:00.000Z",
    source: "test",
  });

  t.mock.method(ragicClient, "observeEntry", async () => {
    throw new Error("ECONNABORTED");
  });
  t.mock.method(ragicClient, "deleteEntry", async () => undefined);

  assert.deepEqual(await service.runOnce(), {
    scanned: 1,
    verified: 0,
    conflicted: 0,
    failed: 0,
    retryPending: 1,
  });
  assert.deepEqual(service.getStats(), { pending: 1, conflict: 0, failed: 0, total: 1 });

  nowMs += 1000;
  assert.deepEqual(await service.runOnce(), {
    scanned: 1,
    verified: 0,
    conflicted: 0,
    failed: 1,
    retryPending: 0,
  });
  assert.deepEqual(service.getStats(), { pending: 0, conflict: 0, failed: 1, total: 1 });
});

test("ActivityLog write reverify 可列出 failed 任務並以更新時間由新到舊排序", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "activityLog-reverify-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const service = new ActivityLogWriteReverifyService({
    enabled: true,
    storeFile: join(dir, "tasks.json"),
    maxAttempts: 1,
    maxPerRun: 1,
    timeoutMs: 1000,
    maxRetries: 0,
  });
  for (const entryId of ["E-OLD", "E-NEW"]) {
    await service.enqueue({
      activityLogPath: FORM_PATH,
      entryId,
      expected: { workOrderNo: `WO-${entryId}` },
      readPriority: "background",
      errorMessage: "ECONNABORTED",
      occurredAt: "2026-06-17T00:00:00.000Z",
      source: "test",
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  t.mock.method(ragicClient, "observeEntry", async () => {
    throw new Error("ECONNABORTED");
  });
  await service.runOnce();
  await new Promise((resolve) => setTimeout(resolve, 2));
  await service.runOnce();

  const tasks = await service.listTasks("failed", 1);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.entryId, "E-NEW");
  assert.equal(tasks[0]?.status, "failed");
});

test("ActivityLog write reverify 人工重試只重設補驗狀態且會持久化", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "activityLog-reverify-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const storeFile = join(dir, "tasks.json");
  const service = new ActivityLogWriteReverifyService({
    enabled: true,
    storeFile,
    maxAttempts: 1,
    maxPerRun: 5,
    timeoutMs: 1000,
    maxRetries: 0,
  });
  const queued = await service.enqueue({
    activityLogPath: FORM_PATH,
    entryId: ENTRY_ID,
    expected: { workOrderNo: "WO-100" },
    readPriority: "background",
    errorMessage: "ECONNABORTED",
    occurredAt: "2026-06-17T00:00:00.000Z",
    source: "work-report-create",
    idempotencyReservationToken: "must-stay-private",
  });
  assert.ok(queued);

  t.mock.method(ragicClient, "observeEntry", async () => {
    throw new Error("ECONNABORTED");
  });
  await service.runOnce();

  const retried = await service.retryTask(queued.key);
  assert.equal(retried.status, "pending");
  assert.equal(retried.attempts, 0);
  assert.equal(retried.finishedAt, undefined);
  assert.equal(retried.lastAttemptAt, undefined);
  assert.equal(retried.lastError, "ECONNABORTED");
  assert.deepEqual(service.getStats(), { pending: 1, conflict: 0, failed: 0, total: 1 });

  const persisted = JSON.parse(await readFile(storeFile, "utf-8")) as {
    tasks: Array<{ status: string; attempts: number; finishedAt?: string }>;
  };
  assert.deepEqual(persisted.tasks.map((task) => [task.status, task.attempts]), [
    ["pending", 0],
  ]);
  assert.equal(persisted.tasks[0]?.finishedAt, undefined);
});

test("ActivityLog write reverify 不接受重試 pending 或不存在的任務", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "activityLog-reverify-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const service = new ActivityLogWriteReverifyService({
    enabled: true,
    storeFile: join(dir, "tasks.json"),
  });
  const queued = await service.enqueue({
    activityLogPath: FORM_PATH,
    entryId: ENTRY_ID,
    expected: { workOrderNo: "WO-100" },
    readPriority: "background",
    errorMessage: "ECONNABORTED",
    occurredAt: "2026-06-17T00:00:00.000Z",
    source: "test",
  });
  assert.ok(queued);

  await assert.rejects(
    service.retryTask(queued.key),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "ACTIVITY_LOG_WRITE_REVERIFY_NOT_RETRYABLE"
  );
  await assert.rejects(
    service.retryTask("missing"),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "ACTIVITY_LOG_WRITE_REVERIFY_NOT_FOUND"
  );
  await service.flush();
});

test("ActivityLog write reverify 確認 entry 已不存在後會清掉 idempotency 映射", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "activityLog-reverify-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const invalidated: ActivityLogWriteReverifyTask[] = [];
  const refreshed: ActivityLogWriteReverifyTask[] = [];
  const service = new ActivityLogWriteReverifyService({
    enabled: true,
    storeFile: join(dir, "tasks.json"),
    maxAttempts: 2,
    maxPerRun: 5,
    timeoutMs: 1000,
    maxRetries: 0,
    invalidateIdempotencyOnEntryGone: async (task) => {
      invalidated.push(task);
    },
    refreshWorkReportAfterEntryGone: async (task) => {
      refreshed.push(task);
    },
  });

  await service.enqueue({
    activityLogPath: FORM_PATH,
    entryId: ENTRY_ID,
    expected: { workOrderNo: "WO-100", type: "PROC-A" },
    readPriority: "background",
    errorMessage: "ECONNABORTED",
    occurredAt: "2026-06-17T00:00:00.000Z",
    source: "work-report-batch-create",
    workReportFormId: "901",
    workReportEntryId: "E-WORK-1",
    workOrderNo: "WO-100",
  });

  t.mock.method(ragicClient, "observeEntry", async () => ({ kind: "gone" as const }));
  const deleteEntryMock = t.mock.method(ragicClient, "deleteEntry", async () => undefined);

  const stats = await service.runOnce();

  assert.deepEqual(stats, {
    scanned: 1,
    verified: 0,
    conflicted: 0,
    failed: 1,
    retryPending: 0,
  });
  assert.equal(deleteEntryMock.mock.callCount(), 0);
  assert.equal(invalidated.length, 1);
  assert.equal(invalidated[0].entryId, ENTRY_ID);
  assert.equal(invalidated[0].source, "work-report-batch-create");
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].workReportFormId, "901");
  assert.equal(refreshed[0].workReportEntryId, "E-WORK-1");
});

test("ActivityLog write reverify 確認 entry 已不存在但工令 refresh 未排入時保留 pending", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "activityLog-reverify-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const storeFile = join(dir, "tasks.json");
  const invalidated: ActivityLogWriteReverifyTask[] = [];
  let refreshAttempts = 0;
  const service = new ActivityLogWriteReverifyService({
    enabled: true,
    storeFile,
    maxAttempts: 1,
    maxPerRun: 5,
    timeoutMs: 1000,
    maxRetries: 0,
    invalidateIdempotencyOnEntryGone: async (task) => {
      invalidated.push(task);
    },
    refreshWorkReportAfterEntryGone: async () => {
      refreshAttempts += 1;
      throw new Error("projection-enqueue-failed");
    },
  });

  await service.enqueue({
    activityLogPath: FORM_PATH,
    entryId: ENTRY_ID,
    expected: { workOrderNo: "WO-100", type: "PROC-A" },
    readPriority: "background",
    errorMessage: "ECONNABORTED",
    occurredAt: "2026-06-17T00:00:00.000Z",
    source: "work-report-batch-create",
    workReportFormId: "901",
    workReportEntryId: "E-WORK-1",
  });

  t.mock.method(ragicClient, "observeEntry", async () => ({ kind: "gone" as const }));
  t.mock.method(ragicClient, "deleteEntry", async () => undefined);

  const stats = await service.runOnce();

  assert.deepEqual(stats, {
    scanned: 1,
    verified: 0,
    conflicted: 0,
    failed: 0,
    retryPending: 1,
  });
  assert.deepEqual(service.getStats(), { pending: 1, conflict: 0, failed: 0, total: 1 });
  assert.equal(invalidated.length, 1);
  assert.equal(refreshAttempts, 1);

  const after = JSON.parse(await readFile(storeFile, "utf-8")) as {
    tasks: Array<{ entryId: string; status: string; lastError?: string; finishedAt?: string }>;
  };
  assert.deepEqual(after.tasks.map((task) => [task.entryId, task.status]), [
    [ENTRY_ID, "pending"],
  ]);
  assert.match(after.tasks[0]?.lastError ?? "", /work-report-refresh-failed/);
  assert.equal(after.tasks[0]?.finishedAt, undefined);
});

test("ActivityLog write reverify 確認 downtime entry 已不存在後會清掉 idempotency 映射", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "activityLog-reverify-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const service = new ActivityLogWriteReverifyService({
    enabled: true,
    storeFile: join(dir, "tasks.json"),
    maxAttempts: 2,
    maxPerRun: 5,
    timeoutMs: 1000,
    maxRetries: 0,
  });

  await service.enqueue({
    activityLogPath: FORM_PATH,
    entryId: ENTRY_ID,
    expected: { workOrderNo: "", type: "downtime" },
    readPriority: "background",
    errorMessage: "ECONNABORTED",
    occurredAt: "2026-06-17T00:00:00.000Z",
    source: "downtime",
  });

  t.mock.method(ragicClient, "observeEntry", async () => ({ kind: "gone" as const }));
  t.mock.method(ragicClient, "deleteEntry", async () => undefined);
  const deleteMappingMock = t.mock.method(
    activityLogClientRowKeyRepository,
    "deleteByEntryId",
    async () => 1
  );

  const stats = await service.runOnce();

  assert.deepEqual(stats, {
    scanned: 1,
    verified: 0,
    conflicted: 0,
    failed: 1,
    retryPending: 0,
  });
  assert.equal(deleteMappingMock.mock.callCount(), 1);
  assert.equal(deleteMappingMock.mock.calls[0]?.arguments[0], ENTRY_ID);
});

test("ActivityLog write reverify 以 clientRowKey 清掉 entryId 尚空白的 reservation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "activityLog-reverify-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const service = new ActivityLogWriteReverifyService({
    enabled: true,
    storeFile: join(dir, "tasks.json"),
    maxAttempts: 1,
    maxPerRun: 5,
    timeoutMs: 1000,
    maxRetries: 0,
  });
  await service.enqueue({
    activityLogPath: FORM_PATH,
    entryId: ENTRY_ID,
    expected: { workOrderNo: "", type: "downtime" },
    readPriority: "background",
    errorMessage: "ECONNABORTED",
    occurredAt: "2026-06-17T00:00:00.000Z",
    source: "downtime",
    clientRowKey: "downtime-reverify-key",
    idempotencySource: "downtime",
    idempotencyReservationToken: "reservation-old",
  });

  t.mock.method(ragicClient, "observeEntry", async () => ({ kind: "gone" as const }));
  t.mock.method(ragicClient, "deleteEntry", async () => undefined);
  const deleteByReservationMock = t.mock.method(
    activityLogClientRowKeyRepository,
    "deleteByReservationIdentity",
    async () => 1
  );
  const deleteByEntryIdMock = t.mock.method(
    activityLogClientRowKeyRepository,
    "deleteByEntryId",
    async () => 0
  );

  assert.deepEqual(await service.runOnce(), {
    scanned: 1,
    verified: 0,
    conflicted: 0,
    failed: 1,
    retryPending: 0,
  });
  assert.equal(deleteByReservationMock.mock.callCount(), 1);
  assert.deepEqual(deleteByReservationMock.mock.calls[0]?.arguments[0], {
    clientRowKey: "downtime-reverify-key",
    source: "downtime",
    reservationToken: "reservation-old",
    entryId: ENTRY_ID,
  });
  assert.equal(deleteByEntryIdMock.mock.callCount(), 0);
});

test("ActivityLog write reverify reservation identity 不符時不回退刪除較新的 entry 映射", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "activityLog-reverify-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const service = new ActivityLogWriteReverifyService({
    enabled: true,
    storeFile: join(dir, "tasks.json"),
    maxAttempts: 1,
    maxPerRun: 5,
    timeoutMs: 1000,
    maxRetries: 0,
  });
  await service.enqueue({
    activityLogPath: FORM_PATH,
    entryId: ENTRY_ID,
    expected: { workOrderNo: "", type: "downtime" },
    readPriority: "background",
    errorMessage: "ECONNABORTED",
    occurredAt: "2026-06-17T00:00:00.000Z",
    source: "downtime",
    clientRowKey: "downtime-reverify-key",
    idempotencySource: "downtime",
    idempotencyReservationToken: "reservation-old",
  });

  t.mock.method(ragicClient, "observeEntry", async () => ({ kind: "gone" as const }));
  t.mock.method(ragicClient, "deleteEntry", async () => undefined);
  const deleteByReservationMock = t.mock.method(
    activityLogClientRowKeyRepository,
    "deleteByReservationIdentity",
    async () => 0
  );
  const deleteByEntryIdMock = t.mock.method(
    activityLogClientRowKeyRepository,
    "deleteByEntryId",
    async () => 1
  );

  assert.deepEqual(await service.runOnce(), {
    scanned: 1,
    verified: 0,
    conflicted: 0,
    failed: 1,
    retryPending: 0,
  });
  assert.equal(deleteByReservationMock.mock.callCount(), 1);
  assert.equal(deleteByEntryIdMock.mock.callCount(), 0);
});

test("ActivityLog write reverify mismatch 保存 conflict 且不清 idempotency 映射", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "activityLog-reverify-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const invalidated: ActivityLogWriteReverifyTask[] = [];
  const refreshed: ActivityLogWriteReverifyTask[] = [];
  const service = new ActivityLogWriteReverifyService({
    enabled: true,
    storeFile: join(dir, "tasks.json"),
    maxAttempts: 2,
    maxPerRun: 5,
    timeoutMs: 1000,
    maxRetries: 0,
    invalidateIdempotencyOnEntryGone: async (task) => {
      invalidated.push(task);
    },
    refreshWorkReportAfterEntryGone: async (task) => {
      refreshed.push(task);
    },
  });

  await service.enqueue({
    activityLogPath: FORM_PATH,
    entryId: ENTRY_ID,
    expected: { workOrderNo: "WO-100", type: "PROC-A" },
    readPriority: "background",
    errorMessage: "ECONNABORTED",
    occurredAt: "2026-06-17T00:00:00.000Z",
    source: "work-report-batch-create",
    workReportFormId: "901",
    workReportEntryId: "E-WORK-1",
  });

  t.mock.method(ragicClient, "observeEntry", async () => buildEntryWith("WO-WRONG", "PROC-A"));
  const deleteEntryMock = t.mock.method(ragicClient, "deleteEntry", async () => undefined);

  const firstStats = await service.runOnce();

  assert.deepEqual(firstStats, {
    scanned: 1,
    verified: 0,
    conflicted: 1,
    failed: 0,
    retryPending: 0,
  });
  assert.equal(deleteEntryMock.mock.callCount(), 0);
  assert.equal(invalidated.length, 0);
  assert.equal(refreshed.length, 0);
  const [conflict] = await service.listTasks("conflict", 10);
  assert.equal(conflict?.lastErrorCode, "ACTIVITY_LOG_WRITE_REVERIFY_CONFLICT");
  assert.equal(conflict?.observed?.workOrderNo, "WO-WRONG");
  assert.deepEqual(conflict?.mismatches?.map((mismatch) => mismatch.field), ["workOrderNo"]);
});

test("ActivityLog write reverify 讀取持續失敗（狀態未知）不清 idempotency 映射", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "activityLog-reverify-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const invalidated: ActivityLogWriteReverifyTask[] = [];
  const service = new ActivityLogWriteReverifyService({
    enabled: true,
    storeFile: join(dir, "tasks.json"),
    maxAttempts: 1,
    maxPerRun: 5,
    timeoutMs: 1000,
    maxRetries: 0,
    invalidateIdempotencyOnEntryGone: async (task) => {
      invalidated.push(task);
    },
  });

  await service.enqueue({
    activityLogPath: FORM_PATH,
    entryId: ENTRY_ID,
    expected: { workOrderNo: "WO-100" },
    readPriority: "background",
    errorMessage: "ECONNABORTED",
    occurredAt: "2026-06-17T00:00:00.000Z",
    source: "work-report-batch-create",
  });

  // 讀取本身一直 timeout（非 entry-gone code）→ maxAttempts 耗盡標 failed，
  // 但 entry 可能還在，不該清映射（清了會讓重試重複開單）。
  t.mock.method(ragicClient, "observeEntry", async () => {
    throw new Error("ECONNABORTED");
  });
  t.mock.method(ragicClient, "deleteEntry", async () => undefined);

  const stats = await service.runOnce();

  assert.deepEqual(stats, {
    scanned: 1,
    verified: 0,
    conflicted: 0,
    failed: 1,
    retryPending: 0,
  });
  assert.equal(invalidated.length, 0);
});

test("ActivityLog write reverify 同一輪未結束時不重疊補驗", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "activityLog-reverify-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const service = new ActivityLogWriteReverifyService({
    enabled: true,
    storeFile: join(dir, "tasks.json"),
    maxAttempts: 2,
    maxPerRun: 5,
    timeoutMs: 1000,
    maxRetries: 0,
  });

  await service.enqueue({
    activityLogPath: FORM_PATH,
    entryId: ENTRY_ID,
    expected: { workOrderNo: "WO-100", type: "PROC-A" },
    readPriority: "user",
    errorMessage: "ECONNABORTED",
    occurredAt: "2026-06-17T00:00:00.000Z",
    source: "test",
  });

  let releaseGetEntry!: () => void;
  const getEntryGate = new Promise<void>((resolve) => {
    releaseGetEntry = resolve;
  });
  const getEntryMock = t.mock.method(ragicClient, "observeEntry", async () => {
    await getEntryGate;
    return buildEntryWith("WO-100", "PROC-A");
  });
  t.mock.method(ragicClient, "deleteEntry", async () => undefined);

  const first = service.runOnce();
  const second = service.runOnce();

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getEntryMock.mock.callCount(), 1);

  releaseGetEntry();
  const [firstStats, secondStats] = await Promise.all([first, second]);
  assert.deepEqual(firstStats, {
    scanned: 1,
    verified: 1,
    conflicted: 0,
    failed: 0,
    retryPending: 0,
  });
  assert.deepEqual(secondStats, firstStats);
  assert.deepEqual(service.getStats(), { pending: 0, conflict: 0, failed: 0, total: 0 });
});

test("ActivityLog delayed reverify mismatch 只保存 conflict，不刪除 Ragic entry", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "activityLog-reverify-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const service = new ActivityLogWriteReverifyService({
    enabled: true,
    storeFile: join(dir, "tasks.json"),
    maxAttempts: 1,
    maxPerRun: 5,
    timeoutMs: 1000,
    maxRetries: 0,
  });
  await service.enqueue({
    activityLogPath: FORM_PATH,
    entryId: ENTRY_ID,
    expected: { workOrderNo: "WO-100", type: "PROC-A" },
    readPriority: "background",
    errorMessage: "ECONNABORTED",
    occurredAt: "2026-06-17T00:00:00.000Z",
    source: "work-report-batch-create",
  });

  t.mock.method(ragicClient, "observeEntry", async () =>
    buildEntryWith("WO-THIRD-VALUE", "PROC-A")
  );
  const deleteEntryMock = t.mock.method(ragicClient, "deleteEntry", async () => undefined);

  await service.runOnce();

  const tasks = await service.listTasks(undefined, 10);
  assert.equal(deleteEntryMock.mock.callCount(), 0);
  assert.equal(tasks[0]?.status, "conflict");
  assert.deepEqual(tasks[0]?.expected, { workOrderNo: "WO-100", type: "PROC-A" });
  assert.deepEqual(tasks[0]?.observed, {
    workOrderNo: "WO-THIRD-VALUE",
    type: "PROC-A",
  });
  assert.deepEqual(tasks[0]?.mismatches, [
    { field: "workOrderNo", expected: "WO-100", actual: "WO-THIRD-VALUE" },
  ]);
});

test("ActivityLog reverify circuit admission rejection 不消耗 observation attempt", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "activityLog-reverify-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const service = new ActivityLogWriteReverifyService({
    enabled: true,
    storeFile: join(dir, "tasks.json"),
    maxAttempts: 1,
    maxPerRun: 5,
    timeoutMs: 1000,
    maxRetries: 0,
  });
  await service.enqueue({
    activityLogPath: FORM_PATH,
    entryId: ENTRY_ID,
    expected: { workOrderNo: "WO-100" },
    readPriority: "background",
    errorMessage: "ECONNABORTED",
    occurredAt: new Date().toISOString(),
    source: "work-report-batch-create",
  });

  t.mock.method(ragicClient, "observeEntry", async () => {
    throw new CircuitBreakerOpenError("background", 30_000);
  });

  assert.deepEqual(await service.runOnce(), {
    scanned: 1,
    verified: 0,
    conflicted: 0,
    failed: 0,
    retryPending: 1,
  });
  const tasks = await service.listTasks(undefined, 10);
  assert.equal(tasks[0]?.status, "pending");
  assert.equal(tasks[0]?.attempts, 0);
});

test("ActivityLog reverify 依實際開始的 outbound observations 累加 attempts", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "activityLog-reverify-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const service = new ActivityLogWriteReverifyService({
    enabled: true,
    storeFile: join(dir, "tasks.json"),
    maxAttempts: 2,
    maxPerRun: 5,
    timeoutMs: 1000,
    maxRetries: 1,
  });
  await service.enqueue({
    activityLogPath: FORM_PATH,
    entryId: ENTRY_ID,
    expected: { workOrderNo: "WO-100" },
    readPriority: "background",
    errorMessage: "ECONNABORTED",
    occurredAt: new Date().toISOString(),
    source: "work-report-batch-create",
  });

  t.mock.method(
    ragicClient,
    "observeEntry",
    async (_formPath: string, _entryId: string, options: RagicReadRequestOptions) => {
      for (let index = 0; index < 2; index += 1) {
        options.onAttemptTiming?.({
          requestStarted: true,
          laneWaitMs: 0,
          upstreamMs: 10,
          totalMs: 10,
          outcome: "failure",
        });
      }
      throw new Error("ECONNABORTED");
    }
  );

  assert.deepEqual(await service.runOnce(), {
    scanned: 1,
    verified: 0,
    conflicted: 0,
    failed: 1,
    retryPending: 0,
  });
  const [failed] = await service.listTasks("failed", 10);
  assert.equal(failed?.attempts, 2);
});

test("ActivityLog reverify 遵守 nextAttemptAt，deferred 到期後才再次 observation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "activityLog-reverify-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  let nowMs = Date.parse("2026-09-04T00:00:00.000Z");
  const service = new ActivityLogWriteReverifyService({
    enabled: true,
    storeFile: join(dir, "tasks.json"),
    maxAttempts: 1,
    maxPerRun: 5,
    timeoutMs: 1000,
    maxRetries: 0,
    maxAgeMs: 60_000,
    now: () => nowMs,
  });
  await service.enqueue({
    activityLogPath: FORM_PATH,
    entryId: ENTRY_ID,
    expected: { workOrderNo: "WO-100", type: "PROC-A" },
    readPriority: "background",
    errorMessage: "ECONNABORTED",
    occurredAt: new Date(nowMs).toISOString(),
    source: "work-report-batch-create",
  });

  let calls = 0;
  t.mock.method(ragicClient, "observeEntry", async () => {
    calls += 1;
    if (calls === 1) throw new CircuitBreakerOpenError("background", 30_000);
    return buildEntryWith("WO-100", "PROC-A");
  });

  await service.runOnce();
  const [deferred] = await service.listTasks("pending", 10);
  assert.equal(deferred?.attempts, 0);
  assert.equal(deferred?.nextAttemptAt, "2026-09-04T00:00:30.000Z");

  nowMs += 29_999;
  assert.deepEqual(await service.runOnce(), {
    scanned: 0,
    verified: 0,
    conflicted: 0,
    failed: 0,
    retryPending: 0,
  });
  assert.equal(calls, 1);

  nowMs += 1;
  assert.deepEqual(await service.runOnce(), {
    scanned: 1,
    verified: 1,
    conflicted: 0,
    failed: 0,
    retryPending: 0,
  });
  assert.equal(calls, 2);
});

test("ActivityLog reverify durable deadline 到期時不再送 observation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "activityLog-reverify-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  let nowMs = Date.parse("2026-09-04T00:00:00.000Z");
  const service = new ActivityLogWriteReverifyService({
    enabled: true,
    storeFile: join(dir, "tasks.json"),
    maxAttempts: 6,
    maxPerRun: 5,
    maxAgeMs: 60_000,
    now: () => nowMs,
  });
  await service.enqueue({
    activityLogPath: FORM_PATH,
    entryId: ENTRY_ID,
    expected: { workOrderNo: "WO-100" },
    readPriority: "background",
    errorMessage: "ECONNABORTED",
    occurredAt: new Date(nowMs).toISOString(),
    source: "work-report-batch-create",
  });
  const observeMock = t.mock.method(ragicClient, "observeEntry", async () =>
    buildEntryWith("WO-100", "PROC-A")
  );

  nowMs += 60_000;
  assert.deepEqual(await service.runOnce(), {
    scanned: 1,
    verified: 0,
    conflicted: 0,
    failed: 1,
    retryPending: 0,
  });
  assert.equal(observeMock.mock.callCount(), 0);
  const [failed] = await service.listTasks("failed", 10);
  assert.equal(failed?.attempts, 0);
  assert.equal(failed?.lastErrorCode, "ACTIVITY_LOG_WRITE_REVERIFY_DEADLINE_EXCEEDED");
});

test("ActivityLog reverify 載入舊 pending/failed 並持久化新版 conflict evidence", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "activityLog-reverify-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const storeFile = join(dir, "tasks.json");
  const nowMs = Date.parse("2026-09-04T00:00:00.000Z");
  await writeFile(
    storeFile,
    JSON.stringify({
      version: "v1",
      savedAt: "2026-08-10T00:00:00.000Z",
      tasks: [
        {
          key: `${FORM_PATH}::E-LEGACY-PENDING`,
          source: "work-report-batch-create",
          activityLogPath: FORM_PATH,
          entryId: "E-LEGACY-PENDING",
          expected: { workOrderNo: "WO-PENDING" },
          status: "pending",
          attempts: 0,
          createdAt: "2026-08-10T00:00:00.000Z",
          updatedAt: "2026-08-10T00:00:00.000Z",
          lastError: "legacy pending",
        },
        {
          key: `${FORM_PATH}::E-LEGACY-FAILED`,
          source: "work-report-batch-create",
          activityLogPath: FORM_PATH,
          entryId: "E-LEGACY-FAILED",
          expected: { workOrderNo: "WO-FAILED" },
          status: "failed",
          attempts: 6,
          createdAt: "2026-08-10T00:00:00.000Z",
          updatedAt: "2026-08-10T00:06:00.000Z",
          finishedAt: "2026-08-10T00:06:00.000Z",
          lastError: "legacy failed",
        },
      ],
    }),
    "utf-8"
  );

  const service = new ActivityLogWriteReverifyService({
    enabled: true,
    storeFile,
    maxAgeMs: 60_000,
    now: () => nowMs,
  });
  await service.initialize();
  await service.flush();
  const tasks = await service.listTasks(undefined, 10);
  const pending = tasks.find((task) => task.entryId === "E-LEGACY-PENDING");
  const failed = tasks.find((task) => task.entryId === "E-LEGACY-FAILED");
  assert.equal(pending?.deadlineAt, "2026-09-04T00:01:00.000Z");
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.attempts, 6);
  assert.equal(failed?.deadlineAt, undefined);

  const retried = await service.retryTask(`${FORM_PATH}::E-LEGACY-FAILED`);
  assert.equal(retried.status, "pending");
  assert.equal(retried.attempts, 0);
  assert.equal(retried.deadlineAt, "2026-09-04T00:01:00.000Z");

  const conflictStore = join(dir, "conflict.json");
  const conflictService = new ActivityLogWriteReverifyService({
    enabled: true,
    storeFile: conflictStore,
    maxAttempts: 1,
    now: () => nowMs,
  });
  await conflictService.enqueue({
    activityLogPath: FORM_PATH,
    entryId: "E-CONFLICT",
    expected: { workOrderNo: "WO-EXPECTED", type: "PROC-A" },
    readPriority: "background",
    errorMessage: "legacy timeout",
    occurredAt: new Date(nowMs).toISOString(),
    source: "work-report-batch-create",
  });
  t.mock.method(ragicClient, "observeEntry", async () =>
    buildEntryWith("WO-OBSERVED", "PROC-A")
  );
  await conflictService.runOnce();

  const reloaded = new ActivityLogWriteReverifyService({
    enabled: true,
    storeFile: conflictStore,
    now: () => nowMs,
  });
  await reloaded.initialize();
  const [conflict] = await reloaded.listTasks("conflict", 10);
  assert.equal(conflict?.entryId, "E-CONFLICT");
  assert.equal(conflict?.observed?.workOrderNo, "WO-OBSERVED");
  assert.deepEqual(conflict?.mismatches, [
    { field: "workOrderNo", expected: "WO-EXPECTED", actual: "WO-OBSERVED" },
  ]);
  assert.equal(conflict?.observedAt, "2026-09-04T00:00:00.000Z");
});

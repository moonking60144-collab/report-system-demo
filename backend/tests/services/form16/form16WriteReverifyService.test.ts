import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { ragicClient, type RagicRecord } from "../../../src/ragic/client";
import { env } from "../../../src/config/env";
import { form16ClientRowKeyRepository } from "../../../src/storage/sqlite/form16ClientRowKeyRepository";
import {
  Form16WriteReverifyService,
  type Form16WriteReverifyTask,
} from "../../../src/services/form16/form16WriteReverifyService";

const FORM_PATH = "/default/forms11/16";
const ENTRY_ID = "E-REVERIFY-1";

function buildEntryWith(workOrderNo: string, type: string): RagicRecord {
  return {
    [env.RAGIC_FORM_16_WORK_ORDER_FIELD_ID]: workOrderNo,
    [env.RAGIC_FORM_16_TYPE_FIELD_ID]: type,
  } as RagicRecord;
}

test("Form16 write reverify 會持久化 pending，補驗成功後清掉佇列", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "form16-reverify-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const storeFile = join(dir, "tasks.json");
  const service = new Form16WriteReverifyService({
    enabled: true,
    storeFile,
    maxAttempts: 2,
    maxPerRun: 5,
    timeoutMs: 1000,
    maxRetries: 0,
  });

  await service.enqueue({
    form16Path: FORM_PATH,
    entryId: ENTRY_ID,
    expected: { workOrderNo: "WO-100", type: "TI搓牙" },
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

  const getEntryMock = t.mock.method(ragicClient, "getEntry", async () =>
    buildEntryWith("WO-100", "TI搓牙")
  );
  const deleteEntryMock = t.mock.method(ragicClient, "deleteEntry", async () => undefined);

  const stats = await service.runOnce();

  assert.deepEqual(stats, { scanned: 1, verified: 1, failed: 0, retryPending: 0 });
  assert.equal(getEntryMock.mock.callCount(), 1);
  assert.equal(deleteEntryMock.mock.callCount(), 0);
  assert.deepEqual(service.getStats(), { pending: 0, failed: 0, total: 0 });

  const after = JSON.parse(await readFile(storeFile, "utf-8")) as {
    tasks: unknown[];
  };
  assert.deepEqual(after.tasks, []);
});

test("Form16 write reverify 讀取仍失敗時保留 pending，超過次數後標 failed", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "form16-reverify-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const service = new Form16WriteReverifyService({
    enabled: true,
    storeFile: join(dir, "tasks.json"),
    maxAttempts: 2,
    maxPerRun: 5,
    timeoutMs: 1000,
    maxRetries: 0,
  });

  await service.enqueue({
    form16Path: FORM_PATH,
    entryId: ENTRY_ID,
    expected: { workOrderNo: "WO-100" },
    readPriority: "user",
    errorMessage: "ECONNABORTED",
    occurredAt: "2026-06-17T00:00:00.000Z",
    source: "test",
  });

  t.mock.method(ragicClient, "getEntry", async () => {
    throw new Error("ECONNABORTED");
  });
  t.mock.method(ragicClient, "deleteEntry", async () => undefined);

  assert.deepEqual(await service.runOnce(), {
    scanned: 1,
    verified: 0,
    failed: 0,
    retryPending: 1,
  });
  assert.deepEqual(service.getStats(), { pending: 1, failed: 0, total: 1 });

  assert.deepEqual(await service.runOnce(), {
    scanned: 1,
    verified: 0,
    failed: 1,
    retryPending: 0,
  });
  assert.deepEqual(service.getStats(), { pending: 0, failed: 1, total: 1 });
});

test("Form16 write reverify 確認 orphan 刪除後會清掉 idempotency 映射", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "form16-reverify-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const invalidated: Form16WriteReverifyTask[] = [];
  const refreshed: Form16WriteReverifyTask[] = [];
  const service = new Form16WriteReverifyService({
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
    form16Path: FORM_PATH,
    entryId: ENTRY_ID,
    expected: { workOrderNo: "WO-100", type: "TI搓牙" },
    readPriority: "background",
    errorMessage: "ECONNABORTED",
    occurredAt: "2026-06-17T00:00:00.000Z",
    source: "work-report-batch-create",
    workReportFormId: "104",
    workReportEntryId: "E-WORK-1",
    workOrderNo: "WO-100",
  });

  // 讀回 workOrderNo 不符且 rollback delete 成功 → 可確認 entry 已不存在。
  t.mock.method(ragicClient, "getEntry", async () => buildEntryWith("WO-WRONG", "TI搓牙"));
  const deleteEntryMock = t.mock.method(ragicClient, "deleteEntry", async () => undefined);

  const stats = await service.runOnce();

  assert.deepEqual(stats, { scanned: 1, verified: 0, failed: 1, retryPending: 0 });
  assert.equal(deleteEntryMock.mock.callCount(), 1);
  assert.equal(invalidated.length, 1);
  assert.equal(invalidated[0].entryId, ENTRY_ID);
  assert.equal(invalidated[0].source, "work-report-batch-create");
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].workReportFormId, "104");
  assert.equal(refreshed[0].workReportEntryId, "E-WORK-1");
});

test("Form16 write reverify 確認 orphan 但工令 refresh 未排入時保留 pending", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "form16-reverify-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const storeFile = join(dir, "tasks.json");
  const invalidated: Form16WriteReverifyTask[] = [];
  let refreshAttempts = 0;
  const service = new Form16WriteReverifyService({
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
    form16Path: FORM_PATH,
    entryId: ENTRY_ID,
    expected: { workOrderNo: "WO-100", type: "TI搓牙" },
    readPriority: "background",
    errorMessage: "ECONNABORTED",
    occurredAt: "2026-06-17T00:00:00.000Z",
    source: "work-report-batch-create",
    workReportFormId: "104",
    workReportEntryId: "E-WORK-1",
  });

  t.mock.method(ragicClient, "getEntry", async () => buildEntryWith("WO-WRONG", "TI搓牙"));
  t.mock.method(ragicClient, "deleteEntry", async () => undefined);

  const stats = await service.runOnce();

  assert.deepEqual(stats, { scanned: 1, verified: 0, failed: 0, retryPending: 1 });
  assert.deepEqual(service.getStats(), { pending: 1, failed: 0, total: 1 });
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

test("Form16 write reverify 確認 downtime orphan 刪除後會清掉 idempotency 映射", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "form16-reverify-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const service = new Form16WriteReverifyService({
    enabled: true,
    storeFile: join(dir, "tasks.json"),
    maxAttempts: 2,
    maxPerRun: 5,
    timeoutMs: 1000,
    maxRetries: 0,
  });

  await service.enqueue({
    form16Path: FORM_PATH,
    entryId: ENTRY_ID,
    expected: { workOrderNo: "", type: "downtime" },
    readPriority: "background",
    errorMessage: "ECONNABORTED",
    occurredAt: "2026-06-17T00:00:00.000Z",
    source: "downtime",
  });

  t.mock.method(ragicClient, "getEntry", async () => buildEntryWith("WO-WRONG", "downtime"));
  t.mock.method(ragicClient, "deleteEntry", async () => undefined);
  const deleteMappingMock = t.mock.method(
    form16ClientRowKeyRepository,
    "deleteByEntryId",
    async () => 1
  );

  const stats = await service.runOnce();

  assert.deepEqual(stats, { scanned: 1, verified: 0, failed: 1, retryPending: 0 });
  assert.equal(deleteMappingMock.mock.callCount(), 1);
  assert.equal(deleteMappingMock.mock.calls[0]?.arguments[0], ENTRY_ID);
});

test("Form16 write reverify rollback 刪除未確認時保留 retry 且不清 idempotency 映射", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "form16-reverify-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const invalidated: Form16WriteReverifyTask[] = [];
  const refreshed: Form16WriteReverifyTask[] = [];
  const service = new Form16WriteReverifyService({
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
    form16Path: FORM_PATH,
    entryId: ENTRY_ID,
    expected: { workOrderNo: "WO-100", type: "TI搓牙" },
    readPriority: "background",
    errorMessage: "ECONNABORTED",
    occurredAt: "2026-06-17T00:00:00.000Z",
    source: "work-report-batch-create",
    workReportFormId: "104",
    workReportEntryId: "E-WORK-1",
  });

  t.mock.method(ragicClient, "getEntry", async () => buildEntryWith("WO-WRONG", "TI搓牙"));
  const deleteEntryMock = t.mock.method(ragicClient, "deleteEntry", async () => {
    throw new Error("ragic-delete-failed");
  });

  const firstStats = await service.runOnce();

  assert.deepEqual(firstStats, { scanned: 1, verified: 0, failed: 0, retryPending: 1 });
  assert.equal(deleteEntryMock.mock.callCount(), 1);
  assert.equal(invalidated.length, 0);

  const secondStats = await service.runOnce();

  assert.deepEqual(secondStats, { scanned: 1, verified: 0, failed: 1, retryPending: 0 });
  assert.equal(deleteEntryMock.mock.callCount(), 2);
  assert.equal(invalidated.length, 0);
  assert.equal(refreshed.length, 0);
});

test("Form16 write reverify 讀取持續失敗（狀態未知）不清 idempotency 映射", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "form16-reverify-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const invalidated: Form16WriteReverifyTask[] = [];
  const service = new Form16WriteReverifyService({
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
    form16Path: FORM_PATH,
    entryId: ENTRY_ID,
    expected: { workOrderNo: "WO-100" },
    readPriority: "background",
    errorMessage: "ECONNABORTED",
    occurredAt: "2026-06-17T00:00:00.000Z",
    source: "work-report-batch-create",
  });

  // 讀取本身一直 timeout（非 entry-gone code）→ maxAttempts 耗盡標 failed，
  // 但 entry 可能還在，不該清映射（清了會讓重試重複開單）。
  t.mock.method(ragicClient, "getEntry", async () => {
    throw new Error("ECONNABORTED");
  });
  t.mock.method(ragicClient, "deleteEntry", async () => undefined);

  const stats = await service.runOnce();

  assert.deepEqual(stats, { scanned: 1, verified: 0, failed: 1, retryPending: 0 });
  assert.equal(invalidated.length, 0);
});

test("Form16 write reverify 同一輪未結束時不重疊補驗", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "form16-reverify-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const service = new Form16WriteReverifyService({
    enabled: true,
    storeFile: join(dir, "tasks.json"),
    maxAttempts: 2,
    maxPerRun: 5,
    timeoutMs: 1000,
    maxRetries: 0,
  });

  await service.enqueue({
    form16Path: FORM_PATH,
    entryId: ENTRY_ID,
    expected: { workOrderNo: "WO-100", type: "TI搓牙" },
    readPriority: "user",
    errorMessage: "ECONNABORTED",
    occurredAt: "2026-06-17T00:00:00.000Z",
    source: "test",
  });

  let releaseGetEntry!: () => void;
  const getEntryGate = new Promise<void>((resolve) => {
    releaseGetEntry = resolve;
  });
  const getEntryMock = t.mock.method(ragicClient, "getEntry", async () => {
    await getEntryGate;
    return buildEntryWith("WO-100", "TI搓牙");
  });
  t.mock.method(ragicClient, "deleteEntry", async () => undefined);

  const first = service.runOnce();
  const second = service.runOnce();

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getEntryMock.mock.callCount(), 1);

  releaseGetEntry();
  const [firstStats, secondStats] = await Promise.all([first, second]);
  assert.deepEqual(firstStats, { scanned: 1, verified: 1, failed: 0, retryPending: 0 });
  assert.deepEqual(secondStats, firstStats);
  assert.deepEqual(service.getStats(), { pending: 0, failed: 0, total: 0 });
});

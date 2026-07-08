import test from "node:test";
import assert from "node:assert/strict";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import { createBatchCreateRowKeyRepository } from "../../src/storage/sqlite/batchCreateRowKeyRepository";
import { initializeReadModelSchema } from "../../src/storage/sqlite/readModelSchema";

async function buildRepo() {
  const db: Database = await open({ filename: ":memory:", driver: sqlite3.Database });
  await initializeReadModelSchema(db);
  const repo = createBatchCreateRowKeyRepository(async () => db);
  return { db, repo };
}

test("lookup 未命中回 null", async () => {
  const { repo } = await buildRepo();
  const result = await repo.lookup("non-existent");
  assert.equal(result, null);
});

test("record 後 lookup 可查到", async () => {
  const { repo } = await buildRepo();
  await repo.record({
    clientRowKey: "key-1",
    formId: "104",
    entryId: "E-100",
    ragicRowId: "R-200",
  });
  const hit = await repo.lookup("key-1");
  assert.equal(hit?.formId, "104");
  assert.equal(hit?.entryId, "E-100");
  assert.equal(hit?.ragicRowId, "R-200");
  assert.equal(hit?.status, "confirmed");
  assert.ok(hit?.createdAt);
  assert.ok(hit?.updatedAt);
});

test("相同 key 重複 record 不會覆蓋已 confirmed 原映射", async () => {
  const { repo } = await buildRepo();
  await repo.record({
    clientRowKey: "dup-key",
    formId: "104",
    entryId: "E-1",
    ragicRowId: "R-FIRST",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await repo.record({
    clientRowKey: "dup-key",
    formId: "999",
    entryId: "E-WRONG",
    ragicRowId: "R-SECOND",
    createdAt: "2026-01-02T00:00:00.000Z",
  });
  const hit = await repo.lookup("dup-key");
  assert.equal(hit?.ragicRowId, "R-FIRST");
  assert.equal(hit?.formId, "104");
  assert.equal(hit?.createdAt, "2026-01-01T00:00:00.000Z");
});

test("空字串或 undefined key 不 insert 也不查", async () => {
  const { repo } = await buildRepo();
  await repo.record({
    clientRowKey: "",
    formId: "104",
    entryId: "E-1",
    ragicRowId: "R-1",
  });
  assert.equal(await repo.lookup(""), null);
  assert.equal(await repo.lookup("   "), null);
});

test("cleanupOlderThan 刪除早於閾值的紀錄", async () => {
  const { repo } = await buildRepo();
  await repo.record({
    clientRowKey: "old",
    formId: "104",
    entryId: "E-1",
    ragicRowId: "R-1",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await repo.record({
    clientRowKey: "new",
    formId: "104",
    entryId: "E-2",
    ragicRowId: "R-2",
    createdAt: "2026-04-01T00:00:00.000Z",
  });
  const deleted = await repo.cleanupOlderThan("2026-03-01T00:00:00.000Z");
  assert.equal(deleted, 1);
  assert.equal(await repo.lookup("old"), null);
  assert.ok(await repo.lookup("new"));
});

test("cleanupOlderThan 沒有符合條件時回 0", async () => {
  const { repo } = await buildRepo();
  await repo.record({
    clientRowKey: "fresh",
    formId: "104",
    entryId: "E-1",
    ragicRowId: "R-1",
    createdAt: "2026-04-20T00:00:00.000Z",
  });
  const deleted = await repo.cleanupOlderThan("2026-01-01T00:00:00.000Z");
  assert.equal(deleted, 0);
});

test("reservePending 會建立 pending row，confirm 後轉為 confirmed", async () => {
  const { repo } = await buildRepo();
  const reserved = await repo.reservePending({
    clientRowKey: "pending-key",
    formId: "104",
    entryId: "E-1",
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(reserved.reserved, true);
  assert.equal(reserved.record?.status, "pending");
  assert.equal(reserved.record?.ragicRowId, "");

  await repo.confirm({
    clientRowKey: "pending-key",
    formId: "104",
    entryId: "E-1",
    ragicRowId: "R-1",
    updatedAt: "2026-01-01T00:01:00.000Z",
  });

  const hit = await repo.lookup("pending-key");
  assert.equal(hit?.status, "confirmed");
  assert.equal(hit?.ragicRowId, "R-1");
  assert.equal(hit?.updatedAt, "2026-01-01T00:01:00.000Z");
});

test("markIndeterminate 會保留 key，releasePending 只刪 pending", async () => {
  const { repo } = await buildRepo();
  await repo.reservePending({
    clientRowKey: "unknown-key",
    formId: "104",
    entryId: "E-1",
  });

  await repo.markIndeterminate({
    clientRowKey: "unknown-key",
    formId: "104",
    entryId: "E-1",
    errorMessage: "ECONNABORTED",
    updatedAt: "2026-01-01T00:01:00.000Z",
  });

  const released = await repo.releasePending({
    clientRowKey: "unknown-key",
    formId: "104",
    entryId: "E-1",
  });
  assert.equal(released, 0);

  const hit = await repo.lookup("unknown-key");
  assert.equal(hit?.status, "indeterminate");
  assert.equal(hit?.errorMessage, "ECONNABORTED");
});

test("markStalePendingIndeterminate 只會把過久 pending 轉成 indeterminate", async () => {
  const { repo } = await buildRepo();
  await repo.reservePending({
    clientRowKey: "old-pending",
    formId: "104",
    entryId: "E-1",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await repo.reservePending({
    clientRowKey: "fresh-pending",
    formId: "104",
    entryId: "E-1",
    createdAt: "2026-01-01T00:10:00.000Z",
  });
  await repo.record({
    clientRowKey: "confirmed",
    formId: "104",
    entryId: "E-1",
    ragicRowId: "R-1",
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  const marked = await repo.markStalePendingIndeterminate({
    thresholdIso: "2026-01-01T00:05:00.000Z",
    errorMessage: "stale pending",
    updatedAt: "2026-01-01T00:20:00.000Z",
  });

  assert.equal(marked, 1);
  const oldPending = await repo.lookup("old-pending");
  const freshPending = await repo.lookup("fresh-pending");
  const confirmed = await repo.lookup("confirmed");
  assert.equal(oldPending?.status, "indeterminate");
  assert.equal(oldPending?.errorMessage, "stale pending");
  assert.equal(oldPending?.updatedAt, "2026-01-01T00:20:00.000Z");
  assert.equal(freshPending?.status, "pending");
  assert.equal(confirmed?.status, "confirmed");
});

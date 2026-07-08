import test from "node:test";
import assert from "node:assert/strict";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import { createForm16ClientRowKeyRepository } from "../../src/storage/sqlite/form16ClientRowKeyRepository";
import { initializeReadModelSchema } from "../../src/storage/sqlite/readModelSchema";

async function buildRepo() {
  const db: Database = await open({ filename: ":memory:", driver: sqlite3.Database });
  await initializeReadModelSchema(db);
  const repo = createForm16ClientRowKeyRepository(async () => db);
  return { db, repo };
}

test("lookup 未命中回 null", async () => {
  const { repo } = await buildRepo();
  const result = await repo.lookup("non-existent");
  assert.equal(result, null);
});

test("lookup 空 key 直接回 null 不打 DB", async () => {
  const { repo } = await buildRepo();
  assert.equal(await repo.lookup(""), null);
  assert.equal(await repo.lookup("   "), null);
});

test("record 後 lookup 可查到", async () => {
  const { repo } = await buildRepo();
  await repo.record({
    clientRowKey: "uuid-1",
    entryId: "E-100",
    source: "downtime",
  });
  const hit = await repo.lookup("uuid-1");
  assert.equal(hit?.entryId, "E-100");
  assert.equal(hit?.source, "downtime");
  assert.equal(hit?.status, "confirmed");
  assert.ok(hit?.createdAt);
  assert.ok(hit?.updatedAt);
});

test("同 key 重複 confirmed record 不會 overwrite 原映射", async () => {
  const { repo } = await buildRepo();
  await repo.record({
    clientRowKey: "dup-key",
    entryId: "E-FIRST",
    source: "downtime",
  });
  await repo.record({
    clientRowKey: "dup-key",
    entryId: "E-SECOND",
    source: "work-report-104",
  });
  const hit = await repo.lookup("dup-key");
  // 保留第一筆：這樣 retry 場景下 UUID 對應的還是第一次寫成功的 entryId
  assert.equal(hit?.entryId, "E-FIRST");
  assert.equal(hit?.source, "downtime");
});

test("reservePending 新 key 會建立 pending 紀錄", async () => {
  const { repo } = await buildRepo();
  const result = await repo.reservePending({
    clientRowKey: "pending-key",
    source: "work-report-104",
    createdAt: "2026-06-01T00:00:00.000Z",
  });

  assert.equal(result.reserved, true);
  assert.equal(result.record?.clientRowKey, "pending-key");
  assert.equal(result.record?.entryId, "");
  assert.equal(result.record?.source, "work-report-104");
  assert.equal(result.record?.status, "pending");
  assert.equal(result.record?.createdAt, "2026-06-01T00:00:00.000Z");
  assert.equal(result.record?.updatedAt, "2026-06-01T00:00:00.000Z");
});

test("confirm 會把 pending 轉成 confirmed 並寫入 entryId", async () => {
  const { repo } = await buildRepo();
  await repo.reservePending({ clientRowKey: "confirm-key", source: "downtime" });
  await repo.confirm({
    clientRowKey: "confirm-key",
    entryId: "E-CONFIRMED",
    source: "downtime",
    updatedAt: "2026-06-02T00:00:00.000Z",
  });

  const hit = await repo.lookup("confirm-key");
  assert.equal(hit?.entryId, "E-CONFIRMED");
  assert.equal(hit?.status, "confirmed");
  assert.equal(hit?.errorMessage, undefined);
  assert.equal(hit?.updatedAt, "2026-06-02T00:00:00.000Z");
});

test("markIndeterminate 只更新 pending 紀錄", async () => {
  const { repo } = await buildRepo();
  await repo.reservePending({ clientRowKey: "unknown-key", source: "downtime" });
  await repo.markIndeterminate({
    clientRowKey: "unknown-key",
    source: "downtime",
    errorMessage: "ECONNABORTED",
    updatedAt: "2026-06-03T00:00:00.000Z",
  });

  const hit = await repo.lookup("unknown-key");
  assert.equal(hit?.status, "indeterminate");
  assert.equal(hit?.errorMessage, "ECONNABORTED");
  assert.equal(hit?.updatedAt, "2026-06-03T00:00:00.000Z");

  await repo.record({
    clientRowKey: "confirmed-key",
    entryId: "E-OK",
    source: "downtime",
  });
  await repo.markIndeterminate({
    clientRowKey: "confirmed-key",
    source: "downtime",
    errorMessage: "should-not-write",
  });
  assert.equal((await repo.lookup("confirmed-key"))?.status, "confirmed");
  assert.equal((await repo.lookup("confirmed-key"))?.errorMessage, undefined);
});

test("releasePending 只刪 pending 紀錄", async () => {
  const { repo } = await buildRepo();
  await repo.reservePending({ clientRowKey: "release-key", source: "downtime" });
  await repo.record({ clientRowKey: "keep-key", entryId: "E-KEEP", source: "downtime" });

  assert.equal(await repo.releasePending({ clientRowKey: "release-key", source: "downtime" }), 1);
  assert.equal(await repo.lookup("release-key"), null);
  assert.equal(await repo.releasePending({ clientRowKey: "keep-key", source: "downtime" }), 0);
  assert.equal((await repo.lookup("keep-key"))?.entryId, "E-KEEP");
});

test("record 空 key 靜默 noop（不拋錯）", async () => {
  const { repo } = await buildRepo();
  await repo.record({ clientRowKey: "", entryId: "E-X", source: "downtime" });
  assert.equal(await repo.lookup(""), null);
});

test("cleanupOlderThan 依 createdAt 閾值刪舊資料", async () => {
  const { db, repo } = await buildRepo();
  // 手動塞不同 createdAt 的紀錄（繞過 repo.record 才能控 timestamp）
  await db.run(
    `INSERT INTO form16_client_row_keys (client_row_key, entry_id, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    "old-key",
    "E-OLD",
    "downtime",
    "2020-01-01T00:00:00.000Z",
    "2020-01-01T00:00:00.000Z"
  );
  await db.run(
    `INSERT INTO form16_client_row_keys (client_row_key, entry_id, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    "new-key",
    "E-NEW",
    "downtime",
    "2099-12-31T00:00:00.000Z",
    "2099-12-31T00:00:00.000Z"
  );

  const deleted = await repo.cleanupOlderThan("2021-01-01T00:00:00.000Z");
  assert.equal(deleted, 1);
  assert.equal(await repo.lookup("old-key"), null);
  assert.ok(await repo.lookup("new-key"));
});

test("cleanupOlderThan 沒符合條件時回 0", async () => {
  const { repo } = await buildRepo();
  await repo.record({
    clientRowKey: "fresh-key",
    entryId: "E-FRESH",
    source: "downtime",
  });
  const deleted = await repo.cleanupOlderThan("1999-01-01T00:00:00.000Z");
  assert.equal(deleted, 0);
});

test("trim key：lookup 跟 record 都會 trim 前後空白", async () => {
  const { repo } = await buildRepo();
  await repo.record({
    clientRowKey: "  trimmed  ",
    entryId: "E-T",
    source: "downtime",
  });
  // 用帶空白跟不帶空白的 key 都能命中
  assert.equal((await repo.lookup("trimmed"))?.entryId, "E-T");
  assert.equal((await repo.lookup("  trimmed  "))?.entryId, "E-T");
});

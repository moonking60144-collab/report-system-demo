import test from "node:test";
import assert from "node:assert/strict";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import { ensureRagicFieldIndexSchema } from "../../src/storage/sqlite/ragicFieldIndexSchema";

async function buildDb(): Promise<Database> {
  const db = await open({ filename: ":memory:", driver: sqlite3.Database });
  await db.exec("PRAGMA foreign_keys=ON;");
  await ensureRagicFieldIndexSchema(db);
  return db;
}

async function seedMain(db: Database, count: number): Promise<void> {
  const now = "2026-05-25T00:00:00.000Z";
  for (let i = 0; i < count; i += 1) {
    await db.run(
      `INSERT INTO ragic_field_index (
        form_path, form_name, scope, subtable_key, field_name, field_id,
        search_text, refreshed_at
      ) VALUES (?, ?, 'main', ?, ?, ?, ?, ?)`,
      `default/forms8/${1000 + i}`,
      `[${1000 + i}] Form`,
      `${i}`,
      `field-${i}`,
      `${5000000 + i}`,
      `form ${i} field ${i}`,
      now
    );
  }
}

test("integrity check：FTS 完全空但 main 有資料 → 自動 rebuild FTS", async () => {
  const db = await buildDb();
  await seedMain(db, 10);
  // 模擬 FTS 沒同步（例如 schema migration 前的舊資料）
  await db.exec("DELETE FROM ragic_field_index_fts");
  const before = await db.get<{ cnt: number }>(
    "SELECT COUNT(*) AS cnt FROM ragic_field_index_fts"
  );
  assert.equal(before?.cnt, 0);

  await ensureRagicFieldIndexSchema(db);

  const after = await db.get<{ cnt: number }>(
    "SELECT COUNT(*) AS cnt FROM ragic_field_index_fts"
  );
  assert.equal(after?.cnt, 10);
});

test("integrity check：count 對齊但內容 drift → 仍會偵測並 rebuild", async () => {
  const db = await buildDb();
  await seedMain(db, 30);
  // 手動 populate 一次（模擬正常情況）
  await db.exec(
    "INSERT INTO ragic_field_index_fts (rowid, search_text) SELECT id, search_text FROM ragic_field_index"
  );

  // 故意污染 FTS 內容：所有 row 的 search_text 改成廢字串
  // count 仍對齊，但 byte equal 一定失敗
  await db.exec("UPDATE ragic_field_index_fts SET search_text = 'corrupted'");

  // 確認受污染
  const corrupted = await db.get<{ search_text: string }>(
    "SELECT search_text FROM ragic_field_index_fts WHERE rowid = 1"
  );
  assert.equal(corrupted?.search_text, "corrupted");

  await ensureRagicFieldIndexSchema(db);

  const repaired = await db.get<{ search_text: string }>(
    "SELECT search_text FROM ragic_field_index_fts WHERE rowid = 1"
  );
  // 應該被重 populate 成 main 的 search_text
  assert.equal(repaired?.search_text, "form 0 field 0");
});

test("integrity check：main 跟 FTS count 不同（FTS 少了幾筆）→ rebuild", async () => {
  const db = await buildDb();
  await seedMain(db, 20);
  await db.exec(
    "INSERT INTO ragic_field_index_fts (rowid, search_text) SELECT id, search_text FROM ragic_field_index"
  );
  // 砍掉 FTS 一半
  await db.exec("DELETE FROM ragic_field_index_fts WHERE rowid > 10");

  await ensureRagicFieldIndexSchema(db);

  const after = await db.get<{ cnt: number }>(
    "SELECT COUNT(*) AS cnt FROM ragic_field_index_fts"
  );
  assert.equal(after?.cnt, 20);
});

test("integrity check：main 空但 FTS 有殘留 → 清空 FTS（避免孤兒 row）", async () => {
  const db = await buildDb();
  // main 沒資料、人為塞 FTS 孤兒
  await db.exec(
    "INSERT INTO ragic_field_index_fts (rowid, search_text) VALUES (1, 'orphan')"
  );

  await ensureRagicFieldIndexSchema(db);

  const after = await db.get<{ cnt: number }>(
    "SELECT COUNT(*) AS cnt FROM ragic_field_index_fts"
  );
  assert.equal(after?.cnt, 0);
});

test("integrity check：main + FTS 一致 → no-op，不會改動既有 FTS rowid", async () => {
  const db = await buildDb();
  await seedMain(db, 5);
  await db.exec(
    "INSERT INTO ragic_field_index_fts (rowid, search_text) SELECT id, search_text FROM ragic_field_index"
  );
  // 抓 sqlite_sequence 不可靠，改驗 rowid set 保持不變
  const beforeRows = await db.all<{ rowid: number; search_text: string }[]>(
    "SELECT rowid, search_text FROM ragic_field_index_fts ORDER BY rowid"
  );

  await ensureRagicFieldIndexSchema(db);

  const afterRows = await db.all<{ rowid: number; search_text: string }[]>(
    "SELECT rowid, search_text FROM ragic_field_index_fts ORDER BY rowid"
  );
  assert.deepEqual(afterRows, beforeRows, "consistent 狀態下不應觸發 rebuild");
});

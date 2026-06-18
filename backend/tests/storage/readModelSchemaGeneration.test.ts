import assert from "node:assert/strict";
import test from "node:test";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import { initializeReadModelSchema } from "../../src/storage/sqlite/readModelSchema";
import { cleanupOldFormGenerationsBatchWithDb } from "../../src/storage/sqlite/workReportSqliteRepository";

async function openMemoryDb(): Promise<Database> {
  const db = await open({ filename: ":memory:", driver: sqlite3.Database });
  await db.exec("PRAGMA foreign_keys=ON;");
  return db;
}

test("initializeReadModelSchema 會把舊 work_report snapshot 遷移成 active generation", async () => {
  const db = await openMemoryDb();
  await db.exec(`
    CREATE TABLE work_report_entries (
      form_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      work_order_no TEXT,
      customer_part_no TEXT,
      machine_code TEXT,
      filter_machine_code TEXT,
      status TEXT,
      ragic_unfinished_status TEXT,
      site_running INTEGER,
      start_schedule INTEGER,
      sort_order REAL,
      planned_start_date TEXT,
      last_updated_at TEXT,
      search_text TEXT,
      summary_json TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      synced_at TEXT NOT NULL,
      PRIMARY KEY (form_id, entry_id)
    );

    CREATE TABLE work_report_rows (
      form_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      row_id TEXT NOT NULL,
      date_value TEXT,
      operator_id TEXT,
      process_code TEXT,
      machine_id TEXT,
      payload_json TEXT NOT NULL,
      synced_at TEXT NOT NULL,
      PRIMARY KEY (form_id, entry_id, row_id)
    );

    CREATE TABLE sync_state (
      form_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      task_id TEXT,
      started_at TEXT,
      finished_at TEXT,
      snapshot_at TEXT,
      read_model_version INTEGER,
      total_entries INTEGER NOT NULL DEFAULT 0,
      total_rows INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  await db.run(
    `
    INSERT INTO sync_state (
      form_id,
      status,
      snapshot_at,
      read_model_version,
      total_entries,
      total_rows,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    "105",
    "success",
    "2026-06-16T01:02:03.000Z",
    5,
    1,
    1,
    "2026-06-16T01:02:04.000Z"
  );
  await db.run(
    `
    INSERT INTO work_report_entries (
      form_id,
      entry_id,
      summary_json,
      detail_json,
      synced_at
    ) VALUES (?, ?, ?, ?, ?)
    `,
    "105",
    "E-1",
    JSON.stringify({ id: "E-1", reports: [] }),
    JSON.stringify({ id: "E-1", reports: [{ rowId: "R-1" }] }),
    "2026-06-16T01:02:03.000Z"
  );
  await db.run(
    `
    INSERT INTO work_report_rows (
      form_id,
      entry_id,
      row_id,
      payload_json,
      synced_at
    ) VALUES (?, ?, ?, ?, ?)
    `,
    "105",
    "E-1",
    "R-1",
    JSON.stringify({ rowId: "R-1" }),
    "2026-06-16T01:02:03.000Z"
  );

  await initializeReadModelSchema(db);

  const entryColumns = await db.all<Array<{ name: string }>>(
    "PRAGMA table_info(work_report_entries)"
  );
  assert.equal(entryColumns.some((column) => column.name === "generation_id"), true);

  const row = await db.get<{ generation_id: string; detail_json: string }>(
    `
    SELECT generation_id, detail_json
    FROM work_report_entries
    WHERE form_id = ? AND entry_id = ?
    `,
    "105",
    "E-1"
  );
  assert.equal(row?.generation_id, "2026-06-16T01:02:03.000Z");
  assert.match(row?.detail_json ?? "", /R-1/);

  const rowSnapshot = await db.get<{ generation_id: string; payload_json: string }>(
    `
    SELECT generation_id, payload_json
    FROM work_report_rows
    WHERE form_id = ? AND entry_id = ? AND row_id = ?
    `,
    "105",
    "E-1",
    "R-1"
  );
  assert.equal(rowSnapshot?.generation_id, "2026-06-16T01:02:03.000Z");

  const state = await db.get<{ active_generation_id: string | null }>(
    "SELECT active_generation_id FROM sync_state WHERE form_id = ?",
    "105"
  );
  assert.equal(state?.active_generation_id, "2026-06-16T01:02:03.000Z");

  await db.close();
});

test("cleanupOldFormGenerations 會保留目前與上一代 generation", async () => {
  const db = await openMemoryDb();
  await initializeReadModelSchema(db);

  const generations = [
    "2026-06-16T01:00:00.000Z",
    "2026-06-16T02:00:00.000Z",
    "2026-06-16T03:00:00.000Z",
  ];
  for (const [index, generationId] of generations.entries()) {
    const entryId = `E-${index + 1}`;
    await db.run(
      `
      INSERT INTO work_report_entries (
        form_id,
        generation_id,
        entry_id,
        summary_json,
        detail_json,
        synced_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      "105",
      generationId,
      entryId,
      JSON.stringify({ id: entryId, reports: [] }),
      JSON.stringify({ id: entryId, reports: [{ rowId: `R-${index + 1}` }] }),
      generationId
    );
    await db.run(
      `
      INSERT INTO work_report_rows (
        form_id,
        generation_id,
        entry_id,
        row_id,
        payload_json,
        synced_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      "105",
      generationId,
      entryId,
      `R-${index + 1}`,
      JSON.stringify({ rowId: `R-${index + 1}` }),
      generationId
    );
  }

  const deletedEntries = await cleanupOldFormGenerationsBatchWithDb(
    db,
    "105",
    generations[2],
    { batchSize: 10 }
  );

  assert.equal(deletedEntries, 1);
  const remainingEntries = await db.all<Array<{ generation_id: string }>>(
    `
    SELECT generation_id
    FROM work_report_entries
    WHERE form_id = ?
    ORDER BY generation_id ASC
    `,
    "105"
  );
  assert.deepEqual(
    remainingEntries.map((row) => row.generation_id),
    [generations[1], generations[2]]
  );
  const deletedRowCount = await db.get<{ count: number }>(
    `
    SELECT COUNT(*) AS count
    FROM work_report_rows
    WHERE form_id = ? AND generation_id = ?
    `,
    "105",
    generations[0]
  );
  assert.equal(Number(deletedRowCount?.count ?? 0), 0);

  await db.close();
});

test("generation migration 失敗時會 rollback，不留下 renamed legacy table", async () => {
  const db = await openMemoryDb();
  await db.exec(`
    CREATE TABLE work_report_entries (
      form_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      synced_at TEXT NOT NULL,
      PRIMARY KEY (form_id, entry_id)
    );

    CREATE TABLE work_report_rows (
      form_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      row_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      synced_at TEXT NOT NULL,
      PRIMARY KEY (form_id, entry_id, row_id)
    );

    CREATE TABLE sync_state (
      form_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      snapshot_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE work_report_rows_legacy_generation_migration (
      id TEXT PRIMARY KEY
    );
  `);
  await db.run(
    `
    INSERT INTO work_report_entries (
      form_id,
      entry_id,
      summary_json,
      detail_json,
      synced_at
    ) VALUES (?, ?, ?, ?, ?)
    `,
    "105",
    "E-rollback",
    JSON.stringify({ id: "E-rollback", reports: [] }),
    JSON.stringify({ id: "E-rollback", reports: [] }),
    "2026-06-16T01:02:03.000Z"
  );

  await assert.rejects(() => initializeReadModelSchema(db));

  const entryColumns = await db.all<Array<{ name: string }>>(
    "PRAGMA table_info(work_report_entries)"
  );
  assert.equal(entryColumns.some((column) => column.name === "generation_id"), false);
  const rowColumns = await db.all<Array<{ name: string }>>(
    "PRAGMA table_info(work_report_rows)"
  );
  assert.equal(rowColumns.some((column) => column.name === "generation_id"), false);

  const entry = await db.get<{ entry_id: string }>(
    "SELECT entry_id FROM work_report_entries WHERE form_id = ?",
    "105"
  );
  assert.equal(entry?.entry_id, "E-rollback");

  await db.close();
});

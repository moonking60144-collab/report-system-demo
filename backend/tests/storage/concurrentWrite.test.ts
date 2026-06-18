import test from "node:test";
import assert from "node:assert/strict";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import { createConnectionSerializer } from "../../src/storage/sqlite/sqliteClient";
import { createRagicFieldIndexRepository } from "../../src/storage/sqlite/ragicFieldIndexRepository";
import { ensureRagicFieldIndexSchema } from "../../src/storage/sqlite/ragicFieldIndexSchema";
import { initializeReadModelSchema } from "../../src/storage/sqlite/readModelSchema";

// 回歸：concurrent-transaction bug。
// 業務規則：6+ 個 repository 共用同一條 sqlite 連線（production 是 sqliteClient.getDb
// singleton）。當 field-index 的 replaceAll 還握著一段長 BEGIN...COMMIT 時，另一個
// repo（form16 / workReport snapshot，由 auto-sync 觸發）在同一連線發 BEGIN，舊架構
// 每個 repo 各自 serialize → 兩個 BEGIN 交錯 → SQLITE_ERROR
// "cannot start a transaction within a transaction"。
// 修法：以「連線實例」為 key 的單一 writeChain（WeakMap keyed by Database），所有寫入
// 不論來自哪個 serializer 都排到同一條 chain。本測試共用一條 :memory: 連線、用兩個
// 獨立 serializer 模擬兩個 repo，concurrently fire 兩筆交易寫入，斷言都不炸且都完成。

// timeout guard：若 chain 真的卡死會「永不 resolve」，靠 race 變成可失敗的測試。
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`TIMEOUT(${label})`)), ms)
    ),
  ]);
}

async function buildSharedConnection(): Promise<Database> {
  // 一條連線同時帶 read-model schema（form16_downtime_*）與 field-index schema，
  // 模擬 production 上同一條連線承載多個 repo 的表。
  const db: Database = await open({ filename: ":memory:", driver: sqlite3.Database });
  await db.exec("PRAGMA foreign_keys=ON;");
  await initializeReadModelSchema(db);
  await ensureRagicFieldIndexSchema(db);
  return db;
}

const FIELD_INDEX_ENTRIES = [
  {
    formPath: "default/forms8/104",
    formName: "[104] 工令單搓牙報工+排程",
    scope: "main" as const,
    subtableKey: "1005987",
    fieldPos: "B1",
    fieldName: "工令單單號",
    fieldId: "1005984",
    fieldType: "文字",
  },
  {
    formPath: "default/forms8/105",
    formName: "[105] 報工表",
    scope: "main" as const,
    subtableKey: "999",
    fieldPos: "A1",
    fieldName: "單號",
    fieldId: "1234567",
    fieldType: "文字",
  },
];

// 模擬 form16DowntimeSqliteRepository.replaceSnapshot 的交易（DELETE 全表 → INSERT →
// state upsert），但走呼叫端注入的 serializer，這樣它與 field-index repo 共用同連線的
// writeChain。structurally 等同 production replaceSnapshot。
async function replaceForm16Snapshot(
  withWriteTransaction: <T>(fn: (db: Database) => Promise<T>) => Promise<T>,
  records: Array<{ entryId: string; machineId: string }>,
  syncedAt: string
): Promise<void> {
  await withWriteTransaction(async (db) => {
    await db.exec("DELETE FROM form16_downtime_records");
    for (const record of records) {
      await db.run(
        `INSERT INTO form16_downtime_records (entry_id, machine_id, raw_json, synced_at)
         VALUES (?, ?, ?, ?)`,
        record.entryId,
        record.machineId,
        JSON.stringify(record),
        syncedAt
      );
    }
    await db.run(
      `INSERT INTO form16_downtime_state (id, snapshot_at, total_records, updated_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         snapshot_at = excluded.snapshot_at,
         total_records = excluded.total_records,
         updated_at = excluded.updated_at`,
      syncedAt,
      records.length,
      new Date().toISOString()
    );
  });
}

test("兩個 repo 同連線 concurrent 交易寫入：都不丟 'cannot start a transaction within a transaction' 且都完成", async () => {
  const db = await buildSharedConnection();
  // 兩個獨立 repo / serializer，但底層同一條連線（getDb 都回同一個 db 實例）
  const fieldIndexRepo = createRagicFieldIndexRepository(async () => db);
  const form16Serializer = createConnectionSerializer(async () => db);

  const downtimeRecords = [
    { entryId: "E-1", machineId: "M-01" },
    { entryId: "E-2", machineId: "M-02" },
  ];

  // 關鍵：兩筆「整段交易」同時 fire。舊架構（per-repo chain）下兩個 BEGIN 會交錯。
  const results = await withTimeout(
    Promise.allSettled([
      fieldIndexRepo.replaceAll(FIELD_INDEX_ENTRIES, "2026-06-02T00:00:00.000Z"),
      replaceForm16Snapshot(
        form16Serializer.withWriteTransaction,
        downtimeRecords,
        "2026-06-02T00:00:00.000Z"
      ),
    ]),
    2000,
    "concurrent-two-repo-tx"
  );

  for (const r of results) {
    if (r.status === "rejected") {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      assert.fail(`concurrent 交易不應 reject，但收到：${msg}`);
    }
  }

  // 兩筆都真的 commit 完成、互不洗掉對方
  const fieldCounts = await fieldIndexRepo.countAll();
  assert.equal(fieldCounts.totalFields, 2, "field-index replaceAll 應完成且寫入 2 筆");
  assert.equal(fieldCounts.totalForms, 2);

  const downtimeCount = await db.get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM form16_downtime_records"
  );
  assert.equal(downtimeCount?.c, 2, "form16 snapshot replace 應完成且寫入 2 筆");
  const stateRow = await db.get<{ total_records: number }>(
    "SELECT total_records FROM form16_downtime_state WHERE id = 1"
  );
  assert.equal(stateRow?.total_records, 2);
});

test("兩筆 replaceAll-like 交易透過兩個獨立 serializer 同連線 concurrent fire：不 nested BEGIN、都完成", async () => {
  const db = await buildSharedConnection();
  // 兩個分別建立的 serializer（模擬不同 module 各自 createConnectionSerializer），
  // 但同一條連線 → 必須共用同一條 connection-keyed chain。
  const serializerA = createConnectionSerializer(async () => db);
  const serializerB = createConnectionSerializer(async () => db);

  const recordsA = [{ entryId: "A-1", machineId: "MA" }];
  const recordsB = [
    { entryId: "B-1", machineId: "MB" },
    { entryId: "B-2", machineId: "MB" },
    { entryId: "B-3", machineId: "MB" },
  ];

  const results = await withTimeout(
    Promise.allSettled([
      replaceForm16Snapshot(serializerA.withWriteTransaction, recordsA, "2026-06-02T01:00:00.000Z"),
      replaceForm16Snapshot(serializerB.withWriteTransaction, recordsB, "2026-06-02T02:00:00.000Z"),
    ]),
    2000,
    "concurrent-two-serializer-replaceAll"
  );

  for (const r of results) {
    if (r.status === "rejected") {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      assert.match(
        msg,
        /^(?!.*cannot start a transaction within a transaction).*/,
        "不應出現 nested-BEGIN 的 concurrent-transaction 錯誤"
      );
      assert.fail(`concurrent 交易不應 reject，但收到：${msg}`);
    }
  }

  // 序列化保證後到的整批 DELETE→INSERT 是最後狀態（其中一筆 replaceSnapshot 整批勝出，
  // 不會留下兩批交錯的半截 row）。總數必為其中一批的 length（1 或 3），絕不是 4。
  const count = await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM form16_downtime_records");
  assert.ok(
    count?.c === recordsA.length || count?.c === recordsB.length,
    `最終列數應等於其中一批（${recordsA.length} 或 ${recordsB.length}），不是交錯的半截狀態，實得 ${count?.c}`
  );
});

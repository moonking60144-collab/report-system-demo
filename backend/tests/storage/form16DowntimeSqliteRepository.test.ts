import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../../src/config/env";
import {
  buildForm16DowntimeSnapshotHash,
  form16DowntimeSqliteRepository,
} from "../../src/storage/sqlite/form16DowntimeSqliteRepository";
import { sqliteClient } from "../../src/storage/sqlite/sqliteClient";
import type { Form16DowntimeRecord } from "../../src/types/form16Downtime";

function downtimeRecord(id: string, plannedIdleMinutes: number): Form16DowntimeRecord {
  return {
    id,
    snapshotHash: null,
    date: "2026/06/25",
    machineId: "P10",
    processCode: "TI01",
    operatorId: "RA004",
    operatorName: "羅智加",
    reportType: "planned",
    startTime: "08:00",
    endTime: "17:00",
    breakTime: "1",
    plannedIdleMinutes,
    remark: `年度保養 ${id}`,
    workOrderNo: `WO-${id}`,
  };
}

test("停機紀錄 snapshot hash 對相同 raw_json 穩定", () => {
  const rawJson = JSON.stringify({
    id: "123",
    date: "2026/06/23",
    machineId: "P10",
    processCode: "TI01",
    plannedIdleMinutes: 480,
  });

  assert.equal(
    buildForm16DowntimeSnapshotHash(rawJson),
    buildForm16DowntimeSnapshotHash(rawJson)
  );
});

test("停機紀錄 snapshot hash 對不同 raw_json 會變動", () => {
  const before = JSON.stringify({ id: "123", plannedIdleMinutes: 480 });
  const after = JSON.stringify({ id: "123", plannedIdleMinutes: 60 });

  assert.notEqual(
    buildForm16DowntimeSnapshotHash(before),
    buildForm16DowntimeSnapshotHash(after)
  );
});

test("停機紀錄 snapshot hash 對空 raw_json 回 null", () => {
  assert.equal(buildForm16DowntimeSnapshotHash(null), null);
  assert.equal(buildForm16DowntimeSnapshotHash(""), null);
});

test("停機紀錄 repository 寫入後可從 read connection 讀取 snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "form16-downtime-"));
  const dbPath = join(root, "read-model.sqlite3");
  const mutableEnv = env as {
    SQLITE_ENABLED: boolean;
    SQLITE_DB_FILE: string;
    SQLITE_SYNC_BATCH_SIZE: number;
  };
  const originalSqliteEnabled = mutableEnv.SQLITE_ENABLED;
  const originalSqliteDbFile = mutableEnv.SQLITE_DB_FILE;
  const originalSyncBatchSize = mutableEnv.SQLITE_SYNC_BATCH_SIZE;
  mutableEnv.SQLITE_ENABLED = true;
  mutableEnv.SQLITE_DB_FILE = dbPath;
  mutableEnv.SQLITE_SYNC_BATCH_SIZE = 2;

  try {
    const records = Array.from({ length: 5 }, (_unused, index) =>
      downtimeRecord(String(101 + index), (index + 1) * 10)
    );
    await form16DowntimeSqliteRepository.replaceSnapshot(
      records,
      "2026-06-25T00:00:00.000Z"
    );

    const rows = await form16DowntimeSqliteRepository.listRecords();
    assert.equal(rows.length, 5);
    assert.equal(rows[0]?.id, "105");
    assert.equal(rows[0]?.plannedIdleMinutes, 50);
    assert.equal(typeof rows[0]?.snapshotHash, "string");
    assert.equal(rows[0]?.snapshotHash?.length, 64);

    const state = await form16DowntimeSqliteRepository.getSnapshotState();
    assert.equal(state?.snapshotAt, "2026-06-25T00:00:00.000Z");
    assert.equal(state?.totalRecords, 5);

    const hash = await form16DowntimeSqliteRepository.getRecordSnapshotHash("105");
    assert.equal(hash, rows[0]?.snapshotHash);

    await form16DowntimeSqliteRepository.syncSnapshot(
      [downtimeRecord("102", 777), downtimeRecord("104", 40), downtimeRecord("106", 60)],
      "2026-06-25T00:05:00.000Z"
    );
    const syncedRows = await form16DowntimeSqliteRepository.listRecords();
    assert.deepEqual(
      syncedRows.map((row) => `${row.id}:${row.plannedIdleMinutes}`),
      ["106:60", "104:40", "102:777"]
    );
    const syncedState = await form16DowntimeSqliteRepository.getSnapshotState();
    assert.equal(syncedState?.snapshotAt, "2026-06-25T00:05:00.000Z");
    assert.equal(syncedState?.totalRecords, 3);
  } finally {
    await sqliteClient.close();
    mutableEnv.SQLITE_ENABLED = originalSqliteEnabled;
    mutableEnv.SQLITE_DB_FILE = originalSqliteDbFile;
    mutableEnv.SQLITE_SYNC_BATCH_SIZE = originalSyncBatchSize;
    await rm(root, { recursive: true, force: true });
  }
});

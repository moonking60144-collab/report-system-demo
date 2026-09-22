import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../../src/config/env";
import {
  buildActivityLogDowntimeSnapshotHash,
  activityLogDowntimeSqliteRepository,
} from "../../src/storage/sqlite/activityLogDowntimeSqliteRepository";
import { sqliteClient } from "../../src/storage/sqlite/sqliteClient";
import type { ActivityLogDowntimeRecord } from "../../src/types/activityLogDowntime";

function downtimeRecord(id: string, plannedIdleMinutes: number): ActivityLogDowntimeRecord {
  return {
    id,
    snapshotHash: null,
    date: "2026/06/25",
    machineId: "MB50",
    processCode: "A01",
    operatorId: "RA004",
    operatorName: "示範帳號",
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
    machineId: "MB50",
    processCode: "A01",
    plannedIdleMinutes: 480,
  });

  assert.equal(
    buildActivityLogDowntimeSnapshotHash(rawJson),
    buildActivityLogDowntimeSnapshotHash(rawJson)
  );
});

test("停機紀錄 snapshot hash 對不同 raw_json 會變動", () => {
  const before = JSON.stringify({ id: "123", plannedIdleMinutes: 480 });
  const after = JSON.stringify({ id: "123", plannedIdleMinutes: 60 });

  assert.notEqual(
    buildActivityLogDowntimeSnapshotHash(before),
    buildActivityLogDowntimeSnapshotHash(after)
  );
});

test("停機紀錄 snapshot hash 對空 raw_json 回 null", () => {
  assert.equal(buildActivityLogDowntimeSnapshotHash(null), null);
  assert.equal(buildActivityLogDowntimeSnapshotHash(""), null);
});

test("停機紀錄 repository 寫入後可從 read connection 讀取 snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "activityLog-downtime-"));
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
    await activityLogDowntimeSqliteRepository.replaceSnapshot(
      records,
      "2026-06-25T00:00:00.000Z"
    );

    const rows = await activityLogDowntimeSqliteRepository.listRecords();
    assert.equal(rows.length, 5);
    assert.equal(rows[0]?.id, "105");
    assert.equal(rows[0]?.plannedIdleMinutes, 50);
    assert.equal(typeof rows[0]?.snapshotHash, "string");
    assert.equal(rows[0]?.snapshotHash?.length, 64);

    const state = await activityLogDowntimeSqliteRepository.getSnapshotState();
    assert.equal(state?.snapshotAt, "2026-06-25T00:00:00.000Z");
    assert.equal(state?.totalRecords, 5);
    assert.equal(state?.revision, 1);

    const hash = await activityLogDowntimeSqliteRepository.getRecordSnapshotHash("105");
    assert.equal(hash, rows[0]?.snapshotHash);

    await activityLogDowntimeSqliteRepository.syncSnapshot(
      [downtimeRecord("102", 777), downtimeRecord("104", 40), downtimeRecord("106", 60)],
      "2026-06-25T00:05:00.000Z",
      state?.revision ?? -1
    );
    const syncedRows = await activityLogDowntimeSqliteRepository.listRecords();
    assert.deepEqual(
      syncedRows.map((row) => `${row.id}:${row.plannedIdleMinutes}`),
      ["106:60", "104:40", "102:777"]
    );
    const syncedState = await activityLogDowntimeSqliteRepository.getSnapshotState();
    assert.equal(syncedState?.snapshotAt, "2026-06-25T00:05:00.000Z");
    assert.equal(syncedState?.totalRecords, 3);
    assert.equal(syncedState?.revision, 2);

    const revisionBeforeUpsert = syncedState?.revision ?? -1;
    await activityLogDowntimeSqliteRepository.upsertRecord(
      downtimeRecord("107", 700),
      "2026-06-25T00:05:00.000Z"
    );
    const staleSyncResult = await activityLogDowntimeSqliteRepository.syncSnapshot(
      [downtimeRecord("102", 1), downtimeRecord("104", 2)],
      "2026-06-25T00:05:00.000Z",
      revisionBeforeUpsert
    );
    assert.equal(staleSyncResult, "stale");
    assert.deepEqual(
      (await activityLogDowntimeSqliteRepository.listRecords()).map(
        (row) => `${row.id}:${row.plannedIdleMinutes}`
      ),
      ["107:700", "106:60", "104:40", "102:777"]
    );

    const revisionBeforeDelete =
      (await activityLogDowntimeSqliteRepository.getSnapshotState())?.revision ?? -1;
    await activityLogDowntimeSqliteRepository.deleteRecord("901", "2026-06-25T00:05:00.000Z");
    const staleResurrectionResult = await activityLogDowntimeSqliteRepository.syncSnapshot(
      [downtimeRecord("901", 999)],
      "2026-06-25T00:05:00.000Z",
      revisionBeforeDelete
    );
    assert.equal(staleResurrectionResult, "stale");
    assert.equal(
      (await activityLogDowntimeSqliteRepository.listRecords()).some((row) => row.id === "901"),
      false
    );
  } finally {
    await sqliteClient.close();
    mutableEnv.SQLITE_ENABLED = originalSqliteEnabled;
    mutableEnv.SQLITE_DB_FILE = originalSqliteDbFile;
    mutableEnv.SQLITE_SYNC_BATCH_SIZE = originalSyncBatchSize;
    await rm(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { env } from "../../src/config/env";
import {
  form16PlannedIdleSqliteRepository,
  type PlannedIdleSqliteRecord,
} from "../../src/storage/sqlite/form16PlannedIdleSqliteRepository";
import { sqliteClient } from "../../src/storage/sqlite/sqliteClient";

test("計畫停機 repository 寫入後可從 read connection 聚合與讀取狀態", async () => {
  const root = await mkdtemp(join(tmpdir(), "form16-planned-idle-"));
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

  const records: PlannedIdleSqliteRecord[] = [
    {
      entryId: "101",
      date: "2026/06/01",
      monthKey: "2026/06",
      machineId: "P10",
      prodType: "TI",
      plannedMinutes: 10,
    },
    {
      entryId: "102",
      date: "2026/06/02",
      monthKey: "2026/06",
      machineId: "P10",
      prodType: "HF",
      plannedMinutes: 20,
    },
    {
      entryId: "103",
      date: "2026/06/03",
      monthKey: "2026/06",
      machineId: "P20",
      prodType: "HF",
      plannedMinutes: 5,
    },
    {
      entryId: "104",
      date: "2026/07/01",
      monthKey: "2026/07",
      machineId: "P10",
      prodType: "TI",
      plannedMinutes: 99,
    },
    {
      entryId: "105",
      date: "2026/08/01",
      monthKey: "2026/08",
      machineId: "P30",
      prodType: "TI",
      plannedMinutes: 1,
    },
  ];

  try {
    await form16PlannedIdleSqliteRepository.replaceAll(
      records,
      "2026/01",
      "2026-06-25T00:00:00.000Z"
    );

    const aggregate = await form16PlannedIdleSqliteRepository.aggregateByMonth("2026/06");
    assert.deepEqual(aggregate, [
      { machineId: "P10", prodType: "TI", totalMinutes: 30, count: 2 },
      { machineId: "P20", prodType: "HF", totalMinutes: 5, count: 1 },
    ]);

    const state = await form16PlannedIdleSqliteRepository.getState();
    assert.deepEqual(state, {
      syncedAt: "2026-06-25T00:00:00.000Z",
      oldestMonth: "2026/01",
      totalRecords: 5,
    });

    await form16PlannedIdleSqliteRepository.replaceMonth(
      "2026/06",
      [
        {
          entryId: "201",
          date: "2026/06/10",
          monthKey: "2026/06",
          machineId: "P10",
          prodType: "HF",
          plannedMinutes: 7,
        },
        {
          entryId: "202",
          date: "2026/06/11",
          monthKey: "2026/06",
          machineId: "P10",
          prodType: "TI",
          plannedMinutes: 8,
        },
        {
          entryId: "203",
          date: "2026/06/12",
          monthKey: "2026/06",
          machineId: "P20",
          prodType: "HF",
          plannedMinutes: 9,
        },
      ],
      "2026-06-25T00:10:00.000Z"
    );

    const refreshedAggregate = await form16PlannedIdleSqliteRepository.aggregateByMonth("2026/06");
    assert.deepEqual(refreshedAggregate, [
      { machineId: "P10", prodType: "HF", totalMinutes: 15, count: 2 },
      { machineId: "P20", prodType: "HF", totalMinutes: 9, count: 1 },
    ]);

    const unchangedState = await form16PlannedIdleSqliteRepository.getState();
    assert.deepEqual(unchangedState, {
      syncedAt: "2026-06-25T00:00:00.000Z",
      oldestMonth: "2026/01",
      totalRecords: 5,
    });
  } finally {
    await sqliteClient.close();
    mutableEnv.SQLITE_ENABLED = originalSqliteEnabled;
    mutableEnv.SQLITE_DB_FILE = originalSqliteDbFile;
    mutableEnv.SQLITE_SYNC_BATCH_SIZE = originalSyncBatchSize;
    await rm(root, { recursive: true, force: true });
  }
});

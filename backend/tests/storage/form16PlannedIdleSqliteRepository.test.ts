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
      "2026-06-25T00:00:00.000Z",
      0
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
      fullRevision: 1,
      projectionRevision: 1,
    });

    const staleFullRevision = await form16PlannedIdleSqliteRepository.getProjectionRevision();
    const monthBarrier = await form16PlannedIdleSqliteRepository.getRefreshBarrier("2026/06");

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
      "2026-06-25T00:00:00.000Z",
      monthBarrier
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
      fullRevision: 1,
      projectionRevision: 2,
    });
    assert.equal(
      await form16PlannedIdleSqliteRepository.getMonthSyncedAt("2026/06"),
      "2026-06-25T00:00:00.000Z"
    );

    const staleHalfYearResult = await form16PlannedIdleSqliteRepository.replaceAll(
      [
        {
          entryId: "old-june",
          date: "2026/06/01",
          monthKey: "2026/06",
          machineId: "P99",
          prodType: "OLD",
          plannedMinutes: 999,
        },
        {
          entryId: "new-july",
          date: "2026/07/15",
          monthKey: "2026/07",
          machineId: "P40",
          prodType: "TI",
          plannedMinutes: 30,
        },
      ],
      "2026/01",
      "2026-06-25T00:00:00.000Z",
      staleFullRevision
    );
    assert.equal(staleHalfYearResult, "stale");
    assert.deepEqual(
      await form16PlannedIdleSqliteRepository.aggregateByMonth("2026/06"),
      [
        { machineId: "P10", prodType: "HF", totalMinutes: 15, count: 2 },
        { machineId: "P20", prodType: "HF", totalMinutes: 9, count: 1 },
      ]
    );
    assert.deepEqual(
      await form16PlannedIdleSqliteRepository.aggregateByMonth("2026/07"),
      [{ machineId: "P10", prodType: "TI", totalMinutes: 99, count: 1 }]
    );

    const staleMonthBarrier =
      await form16PlannedIdleSqliteRepository.getRefreshBarrier("2026/07");
    const currentProjectionRevision =
      await form16PlannedIdleSqliteRepository.getProjectionRevision();
    assert.equal(
      await form16PlannedIdleSqliteRepository.replaceAll(
        [
          {
            entryId: "new-july",
            date: "2026/07/15",
            monthKey: "2026/07",
            machineId: "P40",
            prodType: "TI",
            plannedMinutes: 30,
          },
        ],
        "2026/01",
        "2026-06-25T00:00:00.000Z",
        currentProjectionRevision
      ),
      "applied"
    );

    const staleMonthResult = await form16PlannedIdleSqliteRepository.replaceMonth(
      "2026/07",
      [
        {
          entryId: "stale-july",
          date: "2026/07/01",
          monthKey: "2026/07",
          machineId: "P50",
          prodType: "OLD",
          plannedMinutes: 500,
        },
      ],
      "2026-06-25T00:00:00.000Z",
      staleMonthBarrier
    );
    assert.equal(staleMonthResult, "stale");
    assert.deepEqual(
      await form16PlannedIdleSqliteRepository.aggregateByMonth("2026/07"),
      [{ machineId: "P40", prodType: "TI", totalMinutes: 30, count: 1 }]
    );

    const staleJuneBarrier =
      await form16PlannedIdleSqliteRepository.getRefreshBarrier("2026/06");
    const julyMoveBarrier =
      await form16PlannedIdleSqliteRepository.getRefreshBarrier("2026/07");
    assert.equal(
      await form16PlannedIdleSqliteRepository.replaceMonth(
        "2026/07",
        [
          {
            entryId: "moving-entry",
            date: "2026/07/20",
            monthKey: "2026/07",
            machineId: "P60",
            prodType: "TI",
            plannedMinutes: 60,
          },
        ],
        "2026-07-20T00:00:00.000Z",
        julyMoveBarrier
      ),
      "applied"
    );
    assert.equal(
      await form16PlannedIdleSqliteRepository.replaceMonth(
        "2026/06",
        [
          {
            entryId: "moving-entry",
            date: "2026/06/20",
            monthKey: "2026/06",
            machineId: "P60",
            prodType: "OLD",
            plannedMinutes: 600,
          },
        ],
        "2026-07-20T00:00:01.000Z",
        staleJuneBarrier
      ),
      "stale"
    );
    assert.deepEqual(
      await form16PlannedIdleSqliteRepository.aggregateByMonth("2026/06"),
      []
    );
    assert.deepEqual(
      await form16PlannedIdleSqliteRepository.aggregateByMonth("2026/07"),
      [{ machineId: "P60", prodType: "TI", totalMinutes: 60, count: 1 }]
    );
  } finally {
    await sqliteClient.close();
    mutableEnv.SQLITE_ENABLED = originalSqliteEnabled;
    mutableEnv.SQLITE_DB_FILE = originalSqliteDbFile;
    mutableEnv.SQLITE_SYNC_BATCH_SIZE = originalSyncBatchSize;
    await rm(root, { recursive: true, force: true });
  }
});

test("Form 16 CRUD bump 會讓較早取得的單月 refresh barrier 失效", async () => {
  const root = await mkdtemp(join(tmpdir(), "form16-planned-idle-bump-"));
  const dbPath = join(root, "read-model.sqlite3");
  const mutableEnv = env as {
    SQLITE_ENABLED: boolean;
    SQLITE_DB_FILE: string;
  };
  const originalSqliteEnabled = mutableEnv.SQLITE_ENABLED;
  const originalSqliteDbFile = mutableEnv.SQLITE_DB_FILE;
  mutableEnv.SQLITE_ENABLED = true;
  mutableEnv.SQLITE_DB_FILE = dbPath;

  try {
    const staleBarrier = await form16PlannedIdleSqliteRepository.getRefreshBarrier("2026/07");

    await form16PlannedIdleSqliteRepository.bumpProjectionRevision(
      "2026-07-20T01:00:00.000Z"
    );

    assert.equal(await form16PlannedIdleSqliteRepository.getProjectionRevision(), 1);
    assert.equal(
      await form16PlannedIdleSqliteRepository.replaceMonth(
        "2026/07",
        [
          {
            entryId: "stale-entry",
            date: "2026/07/20",
            monthKey: "2026/07",
            machineId: "P10",
            prodType: "TI",
            plannedMinutes: 480,
          },
        ],
        "2026-07-20T01:01:00.000Z",
        staleBarrier
      ),
      "stale"
    );
    assert.deepEqual(
      await form16PlannedIdleSqliteRepository.aggregateByMonth("2026/07"),
      []
    );
  } finally {
    await sqliteClient.close();
    mutableEnv.SQLITE_ENABLED = originalSqliteEnabled;
    mutableEnv.SQLITE_DB_FILE = originalSqliteDbFile;
    await rm(root, { recursive: true, force: true });
  }
});

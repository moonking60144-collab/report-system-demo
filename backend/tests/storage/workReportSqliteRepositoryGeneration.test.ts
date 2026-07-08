import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { env } from "../../src/config/env";
import { sqliteClient } from "../../src/storage/sqlite/sqliteClient";
import { READ_MODEL_SCHEMA_VERSION } from "../../src/storage/sqlite/readModelSchema";
import { workReportSqliteRepository } from "../../src/storage/sqlite/workReportSqliteRepository";
import type { WorkReportRecord } from "../../src/types/workReport";

function record(id: string, workOrderNo: string, rowCount = 1): WorkReportRecord {
  return {
    id,
    workOrderNo,
    reports: Array.from({ length: rowCount }, (_unused, index) => ({
      rowId: `${id}-R${index + 1}`,
      operatorId: `OP-${index + 1}`,
    })),
  };
}

test("workReportSqliteRepository 只讀 active generation，promote 後才切到新 snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-report-generation-"));
  const dbPath = join(root, "read-model.sqlite3");
  const mutableEnv = env as { SQLITE_ENABLED: boolean; SQLITE_DB_FILE: string };
  const originalSqliteEnabled = mutableEnv.SQLITE_ENABLED;
  const originalSqliteDbFile = mutableEnv.SQLITE_DB_FILE;
  mutableEnv.SQLITE_ENABLED = true;
  mutableEnv.SQLITE_DB_FILE = dbPath;

  try {
    await workReportSqliteRepository.replaceFormSnapshot("105", [record("E-old", "WO-old")], "gen-a");
    await workReportSqliteRepository.upsertSyncState({
      formId: "105",
      status: "success",
      snapshotAt: "public-a",
      activeGenerationId: "gen-a",
      readModelVersion: READ_MODEL_SCHEMA_VERSION,
      totalEntries: 1,
      totalRows: 1,
      message: "active-a",
    });

    const beforePending = await workReportSqliteRepository.getReports("105", {
      limit: 10,
      offset: 0,
    });
    assert.deepEqual(beforePending.data.map((item: WorkReportRecord) => item.id), ["E-old"]);
    assert.equal(beforePending.data[0]?.workOrderNo, "WO-old");

    await workReportSqliteRepository.replaceFormSnapshot("105", [record("E-new", "WO-new")], "gen-b");

    const duringPending = await workReportSqliteRepository.getReports("105", {
      limit: 10,
      offset: 0,
    });
    assert.deepEqual(duringPending.data.map((item: WorkReportRecord) => item.id), ["E-old"]);
    assert.equal(await workReportSqliteRepository.getReportByEntryId("105", "E-new"), null);

    await workReportSqliteRepository.upsertSyncState({
      formId: "105",
      status: "success",
      snapshotAt: "public-b",
      activeGenerationId: "gen-b",
      readModelVersion: READ_MODEL_SCHEMA_VERSION,
      totalEntries: 1,
      totalRows: 1,
      message: "active-b",
    });

    const afterPromote = await workReportSqliteRepository.getReports("105", {
      limit: 10,
      offset: 0,
    });
    assert.deepEqual(afterPromote.data.map((item: WorkReportRecord) => item.id), ["E-new"]);
    assert.equal(afterPromote.data[0]?.workOrderNo, "WO-new");
    assert.equal(await workReportSqliteRepository.getReportByEntryId("105", "E-old"), null);
  } finally {
    await sqliteClient.close();
    mutableEnv.SQLITE_ENABLED = originalSqliteEnabled;
    mutableEnv.SQLITE_DB_FILE = originalSqliteDbFile;
    await rm(root, { recursive: true, force: true });
  }
});

test("workReportSqliteRepository 小批次 snapshot 寫入會跨 chunk 保留所有 entries 與 rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-report-generation-"));
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
    const records = Array.from({ length: 7 }, (_unused, index) =>
      record(`E-${index + 1}`, `WO-${index + 1}`, 3)
    );
    const result = await workReportSqliteRepository.replaceFormSnapshot(
      "105",
      records,
      "gen-chunked"
    );
    assert.deepEqual(result, { entryCount: 7, rowCount: 21 });

    await workReportSqliteRepository.upsertSyncState({
      formId: "105",
      status: "success",
      snapshotAt: "public-chunked",
      activeGenerationId: "gen-chunked",
      readModelVersion: READ_MODEL_SCHEMA_VERSION,
      totalEntries: result.entryCount,
      totalRows: result.rowCount,
      message: "active-chunked",
    });

    const page = await workReportSqliteRepository.getReports("105", {
      limit: 10,
      offset: 0,
    });
    assert.equal(page.totalCount, 7);
    assert.deepEqual(
      page.data.map((item) => item.id),
      ["E-1", "E-2", "E-3", "E-4", "E-5", "E-6", "E-7"]
    );

    const fullRecord = await workReportSqliteRepository.getReportByEntryId(
      "105",
      "E-7"
    );
    assert.equal(fullRecord?.reports.length, 3);
    assert.deepEqual(
      fullRecord?.reports.map((item) => item.rowId),
      ["E-7-R1", "E-7-R2", "E-7-R3"]
    );
  } finally {
    await sqliteClient.close();
    mutableEnv.SQLITE_ENABLED = originalSqliteEnabled;
    mutableEnv.SQLITE_DB_FILE = originalSqliteDbFile;
    mutableEnv.SQLITE_SYNC_BATCH_SIZE = originalSyncBatchSize;
    await rm(root, { recursive: true, force: true });
  }
});

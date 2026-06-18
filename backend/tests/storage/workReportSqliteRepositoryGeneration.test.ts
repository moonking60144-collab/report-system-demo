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

function record(id: string, workOrderNo: string): WorkReportRecord {
  return {
    id,
    workOrderNo,
    reports: [
      {
        rowId: `${id}-R1`,
        operatorId: "OP-1",
      },
    ],
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

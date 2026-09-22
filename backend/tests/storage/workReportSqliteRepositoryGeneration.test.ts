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

test("更新中間工令保留預設順序及分頁，明確排序仍依新值排列", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-report-order-"));
  const mutableEnv = env as { SQLITE_ENABLED: boolean; SQLITE_DB_FILE: string };
  const original = { SQLITE_ENABLED: env.SQLITE_ENABLED, SQLITE_DB_FILE: env.SQLITE_DB_FILE };
  Object.assign(mutableEnv, { SQLITE_ENABLED: true, SQLITE_DB_FILE: join(root, "test.sqlite3") });
  try {
    const records = Array.from({ length: 23 }, (_, i) => ({
      ...record(String(i), `WO-test-${i}`, 2), sortOrder: i + 1,
    }));
    await workReportSqliteRepository.replaceFormSnapshot("901", records, "order-a");
    await workReportSqliteRepository.upsertSyncState({
      formId: "901", status: "success", snapshotAt: "order-a", activeGenerationId: "order-a",
      readModelVersion: READ_MODEL_SCHEMA_VERSION, totalEntries: 23, totalRows: 46,
    });
    const before = await workReportSqliteRepository.getReports("901", { limit: 25, offset: 0 });
    for (const sortOrder of [6, 0, 30]) {
      await workReportSqliteRepository.upsertEntrySnapshot("901", {
        ...records[10]!, sortOrder, reports: [{ rowId: "replacement", operatorId: "NEW" }],
      }, "updated");
      const after = await workReportSqliteRepository.getReports("901", { limit: 25, offset: 0 });
      assert.deepEqual(after.data.map(r => r.id), before.data.map(r => r.id), "default order must remain stable after projection");
      assert.equal(after.data[10]?.sortOrder, sortOrder);
      const secondPage = await workReportSqliteRepository.getReports("901", { limit: 10, offset: 10 });
      assert.equal(secondPage.data[0]?.id, "10");
    }
    const sorted = await workReportSqliteRepository.getReports("901", {
      limit: 25, offset: 0, sortRules: [{ key: "sortOrder", direction: "desc" }],
    });
    assert.equal(sorted.data[0]?.id, "10");
    const detail = await workReportSqliteRepository.getReportByEntryId("901", "10");
    assert.deepEqual(detail?.reports?.map(r => r.rowId), ["replacement"]);
    await workReportSqliteRepository.upsertEntrySnapshot("901", record("new", "WO-test-new"), "updated");
    const inserted = await workReportSqliteRepository.getReports("901", { limit: 25, offset: 0 });
    assert.equal(inserted.data.at(-1)?.id, "new");
  } finally {
    await sqliteClient.close();
    Object.assign(mutableEnv, original);
    await rm(root, { recursive: true, force: true });
  }
});

test("workReportSqliteRepository 只讀 active generation，promote 後才切到新 snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-report-generation-"));
  const dbPath = join(root, "read-model.sqlite3");
  const mutableEnv = env as { SQLITE_ENABLED: boolean; SQLITE_DB_FILE: string };
  const originalSqliteEnabled = mutableEnv.SQLITE_ENABLED;
  const originalSqliteDbFile = mutableEnv.SQLITE_DB_FILE;
  mutableEnv.SQLITE_ENABLED = true;
  mutableEnv.SQLITE_DB_FILE = dbPath;

  try {
    await workReportSqliteRepository.replaceFormSnapshot("902", [record("E-old", "WO-old")], "gen-a");
    await workReportSqliteRepository.upsertSyncState({
      formId: "902",
      status: "success",
      snapshotAt: "public-a",
      activeGenerationId: "gen-a",
      readModelVersion: READ_MODEL_SCHEMA_VERSION,
      totalEntries: 1,
      totalRows: 1,
      message: "active-a",
    });

    const beforePending = await workReportSqliteRepository.getReports("902", {
      limit: 10,
      offset: 0,
    });
    assert.deepEqual(beforePending.data.map((item: WorkReportRecord) => item.id), ["E-old"]);
    assert.equal(beforePending.data[0]?.workOrderNo, "WO-old");

    await workReportSqliteRepository.replaceFormSnapshot("902", [record("E-new", "WO-new")], "gen-b");

    const duringPending = await workReportSqliteRepository.getReports("902", {
      limit: 10,
      offset: 0,
    });
    assert.deepEqual(duringPending.data.map((item: WorkReportRecord) => item.id), ["E-old"]);
    assert.equal(await workReportSqliteRepository.getReportByEntryId("902", "E-new"), null);

    await workReportSqliteRepository.upsertSyncState({
      formId: "902",
      status: "success",
      snapshotAt: "public-b",
      activeGenerationId: "gen-b",
      readModelVersion: READ_MODEL_SCHEMA_VERSION,
      totalEntries: 1,
      totalRows: 1,
      message: "active-b",
    });

    const afterPromote = await workReportSqliteRepository.getReports("902", {
      limit: 10,
      offset: 0,
    });
    assert.deepEqual(afterPromote.data.map((item: WorkReportRecord) => item.id), ["E-new"]);
    assert.equal(afterPromote.data[0]?.workOrderNo, "WO-new");
    assert.equal(await workReportSqliteRepository.getReportByEntryId("902", "E-old"), null);
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
      "902",
      records,
      "gen-chunked"
    );
    assert.deepEqual(result, { entryCount: 7, rowCount: 21 });

    await workReportSqliteRepository.upsertSyncState({
      formId: "902",
      status: "success",
      snapshotAt: "public-chunked",
      activeGenerationId: "gen-chunked",
      readModelVersion: READ_MODEL_SCHEMA_VERSION,
      totalEntries: result.entryCount,
      totalRows: result.rowCount,
      message: "active-chunked",
    });

    const page = await workReportSqliteRepository.getReports("902", {
      limit: 10,
      offset: 0,
    });
    assert.equal(page.totalCount, 7);
    assert.deepEqual(
      page.data.map((item) => item.id),
      ["E-1", "E-2", "E-3", "E-4", "E-5", "E-6", "E-7"]
    );

    const fullRecord = await workReportSqliteRepository.getReportByEntryId(
      "902",
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

test("workReportSqliteRepository 排序投影只更新 entry sortOrder 且保留既有報工明細", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-report-sort-order-"));
  const dbPath = join(root, "read-model.sqlite3");
  const mutableEnv = env as { SQLITE_ENABLED: boolean; SQLITE_DB_FILE: string };
  const originalSqliteEnabled = mutableEnv.SQLITE_ENABLED;
  const originalSqliteDbFile = mutableEnv.SQLITE_DB_FILE;
  mutableEnv.SQLITE_ENABLED = true;
  mutableEnv.SQLITE_DB_FILE = dbPath;

  try {
    await workReportSqliteRepository.replaceFormSnapshot(
      "901",
      [{ ...record("E-sort", "WO-sort", 3), sortOrder: 2 }],
      "gen-sort"
    );
    await workReportSqliteRepository.upsertSyncState({
      formId: "901",
      status: "success",
      snapshotAt: "public-sort",
      activeGenerationId: "gen-sort",
      readModelVersion: READ_MODEL_SCHEMA_VERSION,
      totalEntries: 1,
      totalRows: 3,
      message: "active-sort",
    });

    const result = await workReportSqliteRepository.patchEntrySortOrderSnapshot(
      "901",
      "E-sort",
      7,
      "2026-08-07T06:00:00.000Z"
    );

    assert.deepEqual(result, { rowCount: 1 });
    const page = await workReportSqliteRepository.getReports("901", {
      limit: 10,
      offset: 0,
    });
    assert.equal(page.data[0]?.sortOrder, 7);
    const detail = await workReportSqliteRepository.getReportByEntryId(
      "901",
      "E-sort"
    );
    assert.equal(detail?.sortOrder, 7);
    assert.deepEqual(
      detail?.reports.map((item) => item.rowId),
      ["E-sort-R1", "E-sort-R2", "E-sort-R3"]
    );
  } finally {
    await sqliteClient.close();
    mutableEnv.SQLITE_ENABLED = originalSqliteEnabled;
    mutableEnv.SQLITE_DB_FILE = originalSqliteDbFile;
    await rm(root, { recursive: true, force: true });
  }
});

test("workReportSqliteRepository 以 allowlisted summary 欄位執行 filter、sort、facet 與 analysis values", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-report-precise-query-"));
  const dbPath = join(root, "read-model.sqlite3");
  const mutableEnv = env as { SQLITE_ENABLED: boolean; SQLITE_DB_FILE: string };
  const originalSqliteEnabled = mutableEnv.SQLITE_ENABLED;
  const originalSqliteDbFile = mutableEnv.SQLITE_DB_FILE;
  mutableEnv.SQLITE_ENABLED = true;
  mutableEnv.SQLITE_DB_FILE = dbPath;

  try {
    await workReportSqliteRepository.replaceFormSnapshot(
      "902",
      [
        {
          ...record("E-1", "WO-1"),
          previousMachine: "MB17",
          urgent: "Yes",
          estimatedHours: "8.3",
          plannedEndDate: "2026/08/20",
        },
        {
          ...record("E-2", "WO-2"),
          previousMachine: "MA51",
          urgent: "No",
          estimatedHours: "2.1",
          plannedEndDate: "2026/08/19",
        },
        {
          ...record("E-3", "WO-3"),
          previousMachine: "MB17",
          urgent: "",
          estimatedHours: "",
          plannedEndDate: "",
        },
      ],
      "gen-precise"
    );
    await workReportSqliteRepository.upsertSyncState({
      formId: "902",
      status: "success",
      snapshotAt: "public-precise",
      activeGenerationId: "gen-precise",
      readModelVersion: READ_MODEL_SCHEMA_VERSION,
      totalEntries: 3,
      totalRows: 3,
      message: "active-precise",
    });

    const filtered = await workReportSqliteRepository.getReports("902", {
      limit: 10,
      offset: 0,
      columnFilters: {
        previousMachine: { type: "text", textQuery: "mb17" },
      },
      sortRules: [{ key: "estimatedHours", direction: "desc" }],
    });
    assert.equal(filtered.totalCount, 2);
    assert.deepEqual(filtered.data.map((item) => item.id), ["E-1", "E-3"]);

    const urgent = await workReportSqliteRepository.getReports("902", {
      limit: 10,
      offset: 0,
      columnFilters: {
        urgent: { type: "boolean", selectedTokens: ["__bool_true__"] },
      },
    });
    assert.deepEqual(urgent.data.map((item) => item.id), ["E-1"]);

    const facets = await workReportSqliteRepository.getFacetCounts(
      "902",
      {},
      ["previousMachine", "urgent"]
    );
    assert.deepEqual(facets.previousMachine, [
      { token: "MA51", count: 1 },
      { token: "MB17", count: 2 },
    ]);
    assert.deepEqual(facets.urgent, [
      { token: "__bool_false__", count: 1 },
      { token: "__bool_true__", count: 1 },
      { token: "__blank__", count: 1 },
    ]);

    const values = await workReportSqliteRepository.getColumnValues(
      "902",
      {
        columnFilters: {
          previousMachine: { type: "text", textQuery: "mb17" },
        },
      },
      "estimatedHours"
    );
    assert.deepEqual(values, ["8.3", ""]);
  } finally {
    await sqliteClient.close();
    mutableEnv.SQLITE_ENABLED = originalSqliteEnabled;
    mutableEnv.SQLITE_DB_FILE = originalSqliteDbFile;
    await rm(root, { recursive: true, force: true });
  }
});

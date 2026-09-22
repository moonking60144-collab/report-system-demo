import assert from "node:assert/strict";
import test from "node:test";
import { ragicClient } from "../../src/ragic/client";
import { WorkReportReportsReadService } from "../../src/services/work-report/workReportReportsReadService";
import { WorkReportReadSupport } from "../../src/services/work-report/shared/workReportReadSupport";
import { READ_MODEL_SCHEMA_VERSION } from "../../src/storage/sqlite/readModelSchema";
import {
  workReportSqliteRepository,
  type SqliteReportQueryOptions,
} from "../../src/storage/sqlite/workReportSqliteRepository";

test("結構化列表在啟動同步期間沿用過期但相容的最後成功 SQLite snapshot", async (t) => {
  const service = new WorkReportReportsReadService(new WorkReportReadSupport());
  let ragicReadCalled = false;

  t.mock.method(workReportSqliteRepository, "getSyncState", async () => ({
    formId: "902",
    status: "running",
    taskId: "sync-902",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    snapshotAt: "2020-01-01T00:00:00.000Z",
    activeGenerationId: "2020-01-01T00:00:00.000Z",
    readModelVersion: READ_MODEL_SCHEMA_VERSION,
    totalEntries: 1,
    totalRows: 0,
    message: "正在從 Ragic 擷取資料",
    updatedAt: new Date().toISOString(),
  }));
  t.mock.method(workReportSqliteRepository, "getReports", async () => ({
    data: [{ id: "entry-902", workOrderNo: "WO-902", reports: [] }],
    count: 1,
    totalCount: 1,
    hasMore: false,
  }));
  t.mock.method(ragicClient, "getFormPage", async () => {
    ragicReadCalled = true;
    return {};
  });

  const result = await service.getReports("902", {
    limit: 25,
    offset: 0,
    updatedDateFrom: "2026-08-14T00:00:00+08:00",
    updatedDateTo: "2026-08-14T23:59:59+08:00",
    sortRules: [{ key: "lastUpdatedAt", direction: "desc" }],
  });

  assert.equal(result.totalCount, 1);
  assert.equal(result.data[0]?.id, "entry-902");
  assert.deepEqual(result.meta, {
    cacheSource: "sqlite",
    cacheState: "building",
    snapshotAt: "2020-01-01T00:00:00.000Z",
  });
  assert.equal(ragicReadCalled, false);
});

test("只有本機隱藏條件時仍走結構化 read model 並在分頁前套用", async (t) => {
  const support = new WorkReportReadSupport();
  const service = new WorkReportReportsReadService(support);
  const receivedOptions: SqliteReportQueryOptions[] = [];
  let ragicReadCalled = false;

  t.mock.method(support, "shouldUseSqliteRead", () => true);
  t.mock.method(support, "isSqliteSnapshotReady", () => true);
  t.mock.method(workReportSqliteRepository, "getSyncState", async () => ({
    formId: "902",
    status: "success",
    taskId: null,
    startedAt: null,
    finishedAt: "2026-09-03T00:00:00.000Z",
    snapshotAt: "2026-09-03T00:00:00.000Z",
    activeGenerationId: "gen-local-filter",
    readModelVersion: READ_MODEL_SCHEMA_VERSION,
    totalEntries: 1,
    totalRows: 0,
    message: "ready",
    updatedAt: "2026-09-03T00:00:00.000Z",
  }));
  t.mock.method(workReportSqliteRepository, "getReports", async (
    _formId: string,
    options: SqliteReportQueryOptions
  ) => {
    receivedOptions.push(options);
    return {
      data: [{ id: "visible", reports: [] }],
      count: 1,
      totalCount: 1,
      hasMore: false,
    };
  });
  t.mock.method(ragicClient, "getFormPage", async () => {
    ragicReadCalled = true;
    return {};
  });

  await service.getReports("902", {
    limit: 25,
    offset: 0,
    prodType: "PB",
    excludeTestCustomerPart: true,
    excludeSortOrder99: true,
  });

  assert.equal(receivedOptions[0]?.excludeTestCustomerPart, true);
  assert.equal(receivedOptions[0]?.excludeSortOrder99, true);
  assert.equal(receivedOptions[0]?.prodType, "PB");
  assert.equal(ragicReadCalled, false);
});

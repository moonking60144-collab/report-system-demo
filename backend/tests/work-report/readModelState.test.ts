import assert from "node:assert/strict";
import test from "node:test";
import {
  hasReadableSqliteSnapshot,
  isSqliteSnapshotStale,
  resolveSqliteFullReportsCacheState,
} from "../../src/services/work-report/readModelState";
import { WorkReportReadSupport } from "../../src/services/work-report/shared/workReportReadSupport";
import { READ_MODEL_SCHEMA_VERSION } from "../../src/storage/sqlite/readModelSchema";

test("hasReadableSqliteSnapshot 需要 snapshotAt 與相容的 read model version", () => {
  assert.equal(hasReadableSqliteSnapshot(null), false);
  assert.equal(
    hasReadableSqliteSnapshot({
      status: "success",
      snapshotAt: null,
      readModelVersion: READ_MODEL_SCHEMA_VERSION,
    }),
    false
  );
  assert.equal(
    hasReadableSqliteSnapshot({
      status: "running",
      snapshotAt: "2026-03-10T00:00:00.000Z",
      readModelVersion: READ_MODEL_SCHEMA_VERSION - 1,
    }),
    false
  );
  assert.equal(
    hasReadableSqliteSnapshot({
      status: "running",
      snapshotAt: "2026-03-10T00:00:00.000Z",
      readModelVersion: READ_MODEL_SCHEMA_VERSION,
    }),
    true
  );
  assert.equal(
    hasReadableSqliteSnapshot({
      status: "failed",
      snapshotAt: "2026-03-10T00:00:00.000Z",
      readModelVersion: READ_MODEL_SCHEMA_VERSION,
    }),
    true
  );
});

test("isSqliteSnapshotStale 超過上限的 snapshot 視為過舊，上限內不算", () => {
  const recentSnapshot = {
    status: "success",
    snapshotAt: new Date(Date.now() - 60_000).toISOString(),
    readModelVersion: READ_MODEL_SCHEMA_VERSION,
  };
  const oldSnapshot = {
    status: "success",
    snapshotAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    readModelVersion: READ_MODEL_SCHEMA_VERSION,
  };
  assert.equal(isSqliteSnapshotStale(recentSnapshot, 2 * 60 * 60 * 1000), false);
  assert.equal(isSqliteSnapshotStale(oldSnapshot, 2 * 60 * 60 * 1000), true);
});

test("isSqliteSnapshotStale maxStalenessMs<=0 表示停用檢查，恆為不過舊", () => {
  const oldSnapshot = {
    status: "success",
    snapshotAt: "2020-01-01T00:00:00.000Z",
    readModelVersion: READ_MODEL_SCHEMA_VERSION,
  };
  assert.equal(isSqliteSnapshotStale(oldSnapshot, 0), false);
  assert.equal(isSqliteSnapshotStale(oldSnapshot, -1), false);
});

test("isSqliteSnapshotStale snapshotAt 缺失或解析失敗的處理", () => {
  // 沒有 snapshot 不算 stale（冷啟動由 hasReadableSqliteSnapshot 擋）
  assert.equal(isSqliteSnapshotStale(null, 1000), false);
  assert.equal(
    isSqliteSnapshotStale(
      { status: "success", snapshotAt: null, readModelVersion: READ_MODEL_SCHEMA_VERSION },
      1000
    ),
    false
  );
  // 壞時間戳視為 stale，回退 Ragic 直讀的安全方向
  assert.equal(
    isSqliteSnapshotStale(
      {
        status: "success",
        snapshotAt: "not-a-date",
        readModelVersion: READ_MODEL_SCHEMA_VERSION,
      },
      1000
    ),
    true
  );
});

test("resolveSqliteFullReportsCacheState 會依 sync 狀態回傳 building/stale/fresh", () => {
  assert.equal(
    resolveSqliteFullReportsCacheState({
      status: "running",
      snapshotAt: "2026-03-10T00:00:00.000Z",
      readModelVersion: READ_MODEL_SCHEMA_VERSION,
    }),
    "building"
  );
  assert.equal(
    resolveSqliteFullReportsCacheState({
      status: "failed",
      snapshotAt: "2026-03-10T00:00:00.000Z",
      readModelVersion: READ_MODEL_SCHEMA_VERSION,
    }),
    "stale"
  );
  assert.equal(
    resolveSqliteFullReportsCacheState({
      status: "success",
      snapshotAt: new Date(Date.now() - 60_000).toISOString(),
      readModelVersion: READ_MODEL_SCHEMA_VERSION,
    }),
    "fresh"
  );
  assert.equal(
    resolveSqliteFullReportsCacheState({
      status: "success",
      snapshotAt: "2020-01-01T00:00:00.000Z",
      readModelVersion: READ_MODEL_SCHEMA_VERSION,
    }),
    "stale"
  );
});

test("WorkReportReadSupport 可選擇使用 stale 但可讀的 SQLite snapshot", () => {
  const support = new WorkReportReadSupport();
  const staleReadableSnapshot = {
    formId: "104",
    status: "success",
    taskId: "task-1",
    startedAt: null,
    finishedAt: null,
    snapshotAt: "2020-01-01T00:00:00.000Z",
    readModelVersion: READ_MODEL_SCHEMA_VERSION,
    totalEntries: 1,
    totalRows: 1,
    message: null,
    updatedAt: "2020-01-01T00:00:00.000Z",
  };

  assert.equal(support.isSqliteSnapshotReady(staleReadableSnapshot), false);
  assert.equal(support.isSqliteSnapshotReady(staleReadableSnapshot, { allowStale: true }), true);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  hasReadableSqliteSnapshot,
  resolveSqliteFullReportsCacheState,
} from "../../src/services/work-report/readModelState";
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
      snapshotAt: "2026-03-10T00:00:00.000Z",
      readModelVersion: READ_MODEL_SCHEMA_VERSION,
    }),
    "fresh"
  );
});

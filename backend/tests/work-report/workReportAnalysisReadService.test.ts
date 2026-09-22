import assert from "node:assert/strict";
import test from "node:test";
import { WorkReportAnalysisReadService } from "../../src/services/work-report/workReportAnalysisReadService";
import { WorkReportReadSupport } from "../../src/services/work-report/shared/workReportReadSupport";
import { READ_MODEL_SCHEMA_VERSION } from "../../src/storage/sqlite/readModelSchema";
import { workReportSqliteRepository } from "../../src/storage/sqlite/workReportSqliteRepository";

function readableSyncState() {
  return {
    formId: "902",
    status: "success",
    taskId: null,
    startedAt: null,
    finishedAt: "2026-08-19T00:00:00.000Z",
    snapshotAt: "2026-08-19T00:00:00.000Z",
    activeGenerationId: "generation-902",
    readModelVersion: READ_MODEL_SCHEMA_VERSION,
    totalEntries: 3,
    totalRows: 0,
    message: null,
    updatedAt: "2026-08-19T00:00:00.000Z",
  };
}

test("analysis 與帶 columnFilters 的 facets 優先走 SQLite，不建立 full snapshot", async (t) => {
  let fullReadCount = 0;
  const service = new WorkReportAnalysisReadService(
    new WorkReportReadSupport(),
    async () => {
      fullReadCount += 1;
      throw new Error("full snapshot should not be used");
    }
  );
  t.mock.method(workReportSqliteRepository, "getSyncState", async () => readableSyncState());
  t.mock.method(workReportSqliteRepository, "getFacetCounts", async () => ({
    previousMachine: [
      { token: "MB17", count: 2 },
      { token: "MA51", count: 1 },
    ],
  }));
  t.mock.method(workReportSqliteRepository, "getColumnValues", async () => ["8.3", "2.1", ""]);

  const facets = await service.getReportFacets(
    "902",
    ["previousMachine"],
    {
      columnFilters: {
        urgent: { type: "boolean", selectedTokens: ["__bool_true__"] },
      },
    }
  );
  const analysis = await service.getReportAnalysis("902", {
    field: "estimatedHours",
    columnType: "number",
    columnFilters: {
      previousMachine: { type: "text", textQuery: "MB17" },
    },
  });

  assert.equal(fullReadCount, 0);
  assert.equal(facets.meta.cacheSource, "sqlite");
  assert.deepEqual(facets.data.previousMachine, [
    { token: "MB17", count: 2 },
    { token: "MA51", count: 1 },
  ]);
  assert.equal(analysis.meta.cacheSource, "sqlite");
  assert.deepEqual(analysis.data.numberStats, {
    sum: 10.4,
    avg: 5.2,
    min: 2.1,
    max: 8.3,
    count: 2,
  });
});

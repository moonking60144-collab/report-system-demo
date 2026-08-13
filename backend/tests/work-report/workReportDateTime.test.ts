import assert from "node:assert/strict";
import test from "node:test";
import { WorkReportReadSupport } from "../../src/services/work-report/shared/workReportReadSupport";
import {
  buildEntryWhereClauses,
  toNullableIsoDateTime,
} from "../../src/storage/sqlite/workReportSqliteHelpers";
import type { WorkReportRecord } from "../../src/types/workReport";
import { parseDateTimeTimestamp } from "../../src/utils/dateTime";

test("parseDateTimeTimestamp 接受 ISO 8601 時區且不破壞負號", () => {
  const value = "2099-01-01T00:00:00.000+08:00";

  assert.equal(parseDateTimeTimestamp(value), Date.parse(value));
  assert.equal(toNullableIsoDateTime(value), "2098-12-31T16:00:00.000Z");
});

test("parseDateTimeTimestamp 保留 Ragic 舊式日期與本地日期語意", () => {
  assert.equal(
    parseDateTimeTimestamp("2026/08/10 06:29:00"),
    new Date(2026, 7, 10, 6, 29, 0).getTime()
  );
  assert.equal(
    parseDateTimeTimestamp("2026-08-10"),
    new Date(2026, 7, 10).getTime()
  );
  assert.equal(parseDateTimeTimestamp("not-a-date"), null);
});

test("WorkReportReadSupport 會實際套用 ISO 更新日期篩選", () => {
  const records: WorkReportRecord[] = [
    {
      id: "before-range",
      lastUpdatedAt: "2026/08/10 06:29:00",
      reports: [],
    },
  ];

  const result = new WorkReportReadSupport().filterSortAndPaginateReports(records, {
    limit: 25,
    offset: 0,
    updatedDateFrom: "2099-01-01T00:00:00.000+08:00",
  });

  assert.equal(result.totalCount, 0);
  assert.deepEqual(result.data, []);
});

test("SQLite 查詢會把 ISO 更新日期範圍轉成可比較參數", () => {
  const query = buildEntryWhereClauses("104", {
    limit: 25,
    offset: 0,
    updatedDateFrom: "2026-08-10T00:00:00.000+08:00",
    updatedDateTo: "2026-08-10T23:59:59.999+08:00",
  });

  assert.deepEqual(query.whereClauses, [
    "form_id = ?",
    "last_updated_at >= ?",
    "last_updated_at <= ?",
  ]);
  assert.deepEqual(query.whereParams, [
    "104",
    "2026-08-09T16:00:00.000Z",
    "2026-08-10T15:59:59.999Z",
  ]);
});

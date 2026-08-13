import test from "node:test";
import assert from "node:assert/strict";
import { parseReportsQuery } from "../../src/routes/workReportRequest";
import { HttpError } from "../../src/utils/httpError";

test("parseReportsQuery 會保留 105 sidebar 專用的 ragicUnfinishedStatus", () => {
  const parsed = parseReportsQuery({
    limit: "25",
    offset: "0",
    ragicUnfinishedStatus: "未結案",
    machineCode: "F7",
  });

  assert.equal(parsed.limit, 25);
  assert.equal(parsed.offset, 0);
  assert.equal(parsed.ragicUnfinishedStatus, "未結案");
  assert.equal(parsed.machineCode, "F7");
});

test("parseReportsQuery 會接受 plannedStartDate sort", () => {
  const parsed = parseReportsQuery({
    sort: "machineCode:asc,plannedStartDate:asc",
  });

  assert.deepEqual(parsed.sortRules, [
    { key: "machineCode", direction: "asc" },
    { key: "plannedStartDate", direction: "asc" },
  ]);
});

test("parseReportsQuery 會接受有時區的更新日期範圍", () => {
  const parsed = parseReportsQuery({
    updatedDateFrom: "2026-08-10T00:00:00.000+08:00",
    updatedDateTo: "2026-08-10T23:59:59.999+08:00",
  });

  assert.equal(parsed.updatedDateFrom, "2026-08-10T00:00:00.000+08:00");
  assert.equal(parsed.updatedDateTo, "2026-08-10T23:59:59.999+08:00");
});

test("parseReportsQuery 會拒絕無效或不存在的更新日期", () => {
  for (const query of [
    { updatedDateFrom: "not-a-date" },
    { updatedDateFrom: "2026-08-10" },
    { updatedDateTo: "2026-02-30" },
    { updatedDateFrom: "2026-08-10T24:00:00.000+08:00" },
  ]) {
    assert.throws(
      () => parseReportsQuery(query),
      (error) =>
        error instanceof HttpError &&
        error.statusCode === 400 &&
        error.code === "INVALID_QUERY_PARAM"
    );
  }
});

test("parseReportsQuery 會拒絕起日晚於迄日的更新日期範圍", () => {
  assert.throws(
    () =>
      parseReportsQuery({
        updatedDateFrom: "2026-08-11T00:00:00.000+08:00",
        updatedDateTo: "2026-08-10T23:59:59.999+08:00",
      }),
    (error) =>
      error instanceof HttpError &&
      error.statusCode === 400 &&
      error.code === "INVALID_QUERY_PARAM"
  );
});

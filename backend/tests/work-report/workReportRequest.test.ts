import test from "node:test";
import assert from "node:assert/strict";
import {
  parseAnalysisQuery,
  parsePlannedEndDateUpdatePayload,
  parseReportsQuery,
  parseStartScheduleUpdatePayload,
  parseUrgentUpdatePayload,
} from "../../src/routes/workReportRequest";
import { HttpError } from "../../src/utils/httpError";

test("parseReportsQuery 會保留 902 sidebar 專用的 ragicUnfinishedStatus", () => {
  const parsed = parseReportsQuery({
    limit: "25",
    offset: "0",
    ragicUnfinishedStatus: "未結案",
    machineCode: "MB07",
  });

  assert.equal(parsed.limit, 25);
  assert.equal(parsed.offset, 0);
  assert.equal(parsed.ragicUnfinishedStatus, "未結案");
  assert.equal(parsed.machineCode, "MB07");
});

test("parseReportsQuery 會解析只影響本次讀取的本機隱藏條件", () => {
  const parsed = parseReportsQuery({
    excludeTestCustomerPart: "1",
    excludeSortOrder99: "true",
  });

  assert.equal(parsed.excludeTestCustomerPart, true);
  assert.equal(parsed.excludeSortOrder99, true);
  assert.equal(parseReportsQuery({}).excludeTestCustomerPart, false);
  assert.equal(parseReportsQuery({}).excludeSortOrder99, false);
});

test("checkbox update payload 只接受真正 boolean", () => {
  assert.deepEqual(parseUrgentUpdatePayload({ urgent: true }), { urgent: true });
  assert.deepEqual(parseStartScheduleUpdatePayload({ startSchedule: false }), {
    startSchedule: false,
  });
  for (const run of [
    () => parseUrgentUpdatePayload({ urgent: "Yes" }),
    () => parseStartScheduleUpdatePayload({ startSchedule: 1 }),
    () => parseUrgentUpdatePayload(null),
  ]) {
    assert.throws(
      run,
      (error) =>
        error instanceof HttpError &&
        error.statusCode === 400 &&
        error.code === "INVALID_PAYLOAD"
    );
  }
});

test("parsePlannedEndDateUpdatePayload 只接受有效 canonical 日期", () => {
  assert.deepEqual(parsePlannedEndDateUpdatePayload({ plannedEndDate: "2026-09-05" }), {
    plannedEndDate: "2026-09-05",
  });
  for (const payload of [
    { plannedEndDate: "2026-02-30" },
    { plannedEndDate: "2026/09/05" },
    { plannedEndDate: "2026-9-5" },
    { plannedEndDate: "" },
    null,
  ]) {
    assert.throws(
      () => parsePlannedEndDateUpdatePayload(payload),
      (error) =>
        error instanceof HttpError &&
        error.statusCode === 400 &&
        error.code === "INVALID_PAYLOAD"
    );
  }
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

test("parseReportsQuery 會接受 allowlist 內的精確欄位篩選與排序", () => {
  const parsed = parseReportsQuery({
    columnFilters: JSON.stringify({
      previousMachine: { type: "text", textQuery: "MB17" },
      urgent: { type: "boolean", selectedTokens: ["__bool_true__"] },
    }),
    sort: "estimatedHours:desc",
  });

  assert.deepEqual(parsed.columnFilters, {
    previousMachine: { type: "text", textQuery: "MB17" },
    urgent: { type: "boolean", selectedTokens: ["__bool_true__"] },
  });
  assert.deepEqual(parsed.sortRules, [
    { key: "estimatedHours", direction: "desc" },
  ]);
});

test("parseReportsQuery 驗證自訂 filterGroup 的欄位、運算子與上限", () => {
  const parsed = parseReportsQuery(
    {
      prodType: " PA ",
      filterGroup: JSON.stringify({
        joinMode: "any",
        conditions: [
          { id: "m", field: "machineCode", operator: "isAnyOf", values: ["MA23", "MA18"] },
          { id: "p", field: "customerPartNo", operator: "contains", values: ["TEST"] },
        ],
      }),
    },
    "902"
  );

  assert.equal(parsed.formId, "902");
  assert.equal(parsed.prodType, "PA");
  assert.equal(parsed.filterGroup?.joinMode, "any");
  assert.deepEqual(parsed.filterGroup?.conditions[0]?.values, ["MA23", "MA18"]);

  for (const filterGroup of [
    { joinMode: "xor", conditions: [] },
    {
      joinMode: "all",
      conditions: [{ id: "x", field: "status", operator: "contains", values: ["未結案"] }],
    },
    {
      joinMode: "all",
      conditions: [{ id: "x", field: "__proto__", operator: "isEmpty", values: [] }],
    },
    {
      joinMode: "all",
      conditions: [{ id: "x", field: "constructor", operator: "isEmpty", values: [] }],
    },
    {
      joinMode: "all",
      conditions: [{ id: "d", field: "lastUpdatedAt", operator: "between", values: ["2026-09-03", "2026-09-01"] }],
    },
    {
      joinMode: "all",
      conditions: Array.from({ length: 13 }, (_, index) => ({
        id: String(index),
        field: "status",
        operator: "isAnyOf",
        values: ["未結案"],
      })),
    },
  ]) {
    assert.throws(
      () => parseReportsQuery({ filterGroup: JSON.stringify(filterGroup) }),
      (error) =>
        error instanceof HttpError &&
        error.statusCode === 400 &&
        error.code === "INVALID_QUERY_PARAM"
    );
  }
});

test("精確查詢拒絕 unknown 欄位與 analysis 型別不符", () => {
  assert.throws(
    () =>
      parseReportsQuery({
        columnFilters: JSON.stringify({
          injected: { type: "text", textQuery: "x" },
        }),
      }),
    (error) =>
      error instanceof HttpError &&
      error.statusCode === 400 &&
      error.code === "INVALID_QUERY_PARAM"
  );
  assert.throws(
    () => parseReportsQuery({ sort: "injected:asc" }),
    (error) =>
      error instanceof HttpError &&
      error.statusCode === 400 &&
      error.code === "INVALID_QUERY_PARAM"
  );
  assert.throws(
    () =>
      parseReportsQuery({
        columnFilters: JSON.stringify({
          estimatedHours: { type: "text", textQuery: "8.3" },
        }),
      }),
    (error) =>
      error instanceof HttpError &&
      error.statusCode === 400 &&
      error.code === "INVALID_QUERY_PARAM"
  );
  assert.throws(
    () => parseAnalysisQuery({ field: "estimatedHours", columnType: "text" }),
    (error) =>
      error instanceof HttpError &&
      error.statusCode === 400 &&
      error.code === "INVALID_QUERY_PARAM"
  );
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

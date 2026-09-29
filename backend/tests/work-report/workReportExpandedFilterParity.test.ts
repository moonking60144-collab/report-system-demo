import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { env } from "../../src/config/env";
import { WorkReportReadSupport } from "../../src/services/work-report/shared/workReportReadSupport";
import { sqliteClient } from "../../src/storage/sqlite/sqliteClient";
import { READ_MODEL_SCHEMA_VERSION } from "../../src/storage/sqlite/readModelSchema";
import { workReportSqliteRepository } from "../../src/storage/sqlite/workReportSqliteRepository";
import { REPORT_COLUMN_TYPE_BY_KEY, type WorkReportRecord } from "../../src/types/workReport";
import type { WorkReportFilterCondition, WorkReportFilterField } from "@shared-types/workReportFilter";
import { parseReportsQuery } from "../../src/routes/workReportRequest";

for (const timezone of ["Asia/Taipei", "UTC", "America/Los_Angeles"]) {
test(`擴充右鍵篩選由 API 到 SQLite 與 memory，支援資料欄位並排除錯值 (${timezone})`, async () => {
  const originalTz = process.env.TZ;
  process.env.TZ = timezone;
  const root = await mkdtemp(join(tmpdir(), "work-report-expanded-filter-"));
  const original = { SQLITE_ENABLED: env.SQLITE_ENABLED, SQLITE_DB_FILE: env.SQLITE_DB_FILE };
  Object.assign(env, { SQLITE_ENABLED: true, SQLITE_DB_FILE: join(root, "test.sqlite3") });
  const support = new WorkReportReadSupport();
  const source: WorkReportRecord = { id: "source", prodType: "PA", reports: [] };
  const other: WorkReportRecord = { id: "other", prodType: "PA", reports: [] };
  for (const [field, type] of Object.entries(REPORT_COLUMN_TYPE_BY_KEY)) {
    source[field] = type === "boolean" ? "\tYes\u00a0" : type === "date" ? "\u00a02026/09/07\ufeff" : type === "number" ? "\t1,000.5\u00a0" : "\tSource-Value\u00a0";
    other[field] = type === "boolean" ? "No" : type === "date" ? "2026/09/08" : type === "number" ? "1001" : "other-value";
  }
  try {
    for (const formId of ["901", "902"] as const) {
      await workReportSqliteRepository.replaceFormSnapshot(formId, [source, other], "expanded-" + formId);
      await workReportSqliteRepository.upsertSyncState({ formId, status: "success", snapshotAt: "expanded", activeGenerationId: "expanded-" + formId,
        readModelVersion: READ_MODEL_SCHEMA_VERSION, totalEntries: 2, totalRows: 0 });
      for (const [field, type] of Object.entries(REPORT_COLUMN_TYPE_BY_KEY)) {
        if (field === "filterMachineCode") continue;
        const condition: WorkReportFilterCondition = {
          id: field, field: field as WorkReportFilterField,
          operator: type === "date" ? "between" : type === "boolean" || field === "machineCode" || field === "status" ? "isAnyOf" : "equals",
          values: type === "date" ? ["2026-09-07", "2026-09-07"] : type === "boolean" ? ["yes"] : type === "number" ? ["1000.5"] : ["source-value"],
        };
        const options = parseReportsQuery({ limit: "100", filterGroup: JSON.stringify({ joinMode: "all", conditions: [condition] }) }, formId);
        const actual = await workReportSqliteRepository.getReports(formId, options);
        const memory = support.filterSortAndPaginateReports([source, other], options);
        assert.deepEqual(actual.data.map(row => row.id), ["source"], "SQLITE_EXPANDED_FILTER_RETAINS_ONLY_SOURCE " + field);
        assert.deepEqual(memory.data.map(row => row.id), ["source"], "MEMORY_EXPANDED_FILTER_RETAINS_ONLY_SOURCE " + field);
      }
    }
    const numericRows = ["0", "2", "10", "1,000", "abc", "", null, "1e400", "01", ".5", "0abc", "\u00a00\ufeff", "\t2\n"].map((value, index) => ({ id: String(index), prodType: "PA", reports: [], estimatedHours: value, sortOrder: value }));
    await workReportSqliteRepository.replaceFormSnapshot("901", numericRows, "numeric-901");
    await workReportSqliteRepository.upsertSyncState({ formId: "901", status: "success", snapshotAt: "numeric", activeGenerationId: "numeric-901",
      readModelVersion: READ_MODEL_SCHEMA_VERSION, totalEntries: numericRows.length, totalRows: 0 });
    for (const field of ["estimatedHours", "sortOrder"]) for (const [operator, value, expected] of [
      ["equals", "0", ["0", "11"]], ["equals", "1000", ["3"]], ["greaterThan", "2", ["2", "3"]],
      ["lessThan", "2", ["0", "11"]], ["atLeast", "2", ["1", "2", "3", "12"]], ["atMost", "2", ["0", "1", "11", "12"]],
    ] as const) {
      const options = parseReportsQuery({ limit: "100", filterGroup: JSON.stringify({ joinMode: "all", conditions: [
        { id: "number", field, operator, values: [value] },
      ] }) }, "901");
      const sqlite = await workReportSqliteRepository.getReports("901", options);
      const memory = support.filterSortAndPaginateReports(numericRows, options);
      assert.deepEqual(sqlite.data.map(row => row.id), expected, "SQLITE_NUMERIC_FILTER_EXCLUDES_INVALID_AND_USES_NUMBERS " + field);
      assert.deepEqual(memory.data.map(row => row.id), expected, "MEMORY_NUMERIC_FILTER_EXCLUDES_INVALID_AND_USES_NUMBERS " + field);
    }
    for (const field of ["estimatedHours", "sortOrder"]) for (const [operator, expected] of [
      ["isEmpty", ["5", "6"]], ["isNotEmpty", ["0", "1", "2", "3", "4", "7", "8", "9", "10", "11", "12"]],
    ] as const) {
      const options = parseReportsQuery({ limit: "100", filterGroup: JSON.stringify({ joinMode: "all", conditions: [
        { id: "number-blank", field, operator, values: [] },
      ] }) }, "901");
      const sqlite = await workReportSqliteRepository.getReports("901", options);
      const memory = support.filterSortAndPaginateReports(numericRows, options);
      assert.deepEqual(sqlite.data.map(row => row.id), expected, "SQLITE_NUMERIC_BLANK_FILTER_USES_ORIGINAL_VALUE " + field);
      assert.deepEqual(memory.data.map(row => row.id), expected, "MEMORY_NUMERIC_BLANK_FILTER_USES_ORIGINAL_VALUE " + field);
    }
    const numericTypeRows = [false, true, 0, 1, "0", "1", [1], { value: 1 }, null].map((value, index) => ({
      id: String(index), prodType: "PA", reports: [], estimatedHours: value, sortOrder: value,
    }));
    await workReportSqliteRepository.replaceFormSnapshot("901", numericTypeRows, "numeric-types-901");
    await workReportSqliteRepository.upsertSyncState({ formId: "901", status: "success", snapshotAt: "numeric-types", activeGenerationId: "numeric-types-901",
      readModelVersion: READ_MODEL_SCHEMA_VERSION, totalEntries: numericTypeRows.length, totalRows: 0 });
    for (const field of ["estimatedHours", "sortOrder"]) for (const [value, expected] of [["0", ["2", "4"]], ["1", ["3", "5"]]] as const) {
      const options = parseReportsQuery({ limit: "100", filterGroup: JSON.stringify({ joinMode: "all", conditions: [
        { id: "numeric-types", field, operator: "equals", values: [value] },
      ] }) }, "901");
      assert.deepEqual((await workReportSqliteRepository.getReports("901", options)).data.map(row => row.id), expected, "SQLITE_NUMERIC_FILTER_REJECTS_NON_NUMERIC_JSON_TYPES " + field);
      assert.deepEqual(support.filterSortAndPaginateReports(numericTypeRows, options).data.map(row => row.id), expected, "MEMORY_NUMERIC_FILTER_REJECTS_NON_NUMERIC_JSON_TYPES " + field);
    }
    const datedRows = ["2026/09/07 23:30:00", "2026-09-07T23:30:00", "2026-09-07T23:30:00Z", "2026-09-07T23:30:00+08:00", "2026/09/07", "2026-09-07T23:30:00+0800", "2026-09-07T23:30:00-0500", "\ufeff2026/09/07 23:30:00+0800\u00a0", "2026-09-07t23:30:00z", false, true, 0, 1, ["2026/09/07"], " 2026-09-07T23:30:00+0800 ", "\u00a02026-09-07T23:30:00Z\ufeff"].map((value, index) => ({
      id: String(index), prodType: "PA", reports: [], plannedEndDate: value, prevPlanEndDate: value, plannedStartDate: value, lastUpdatedAt: value,
    }));
    await workReportSqliteRepository.replaceFormSnapshot("901", datedRows, "date-901");
    await workReportSqliteRepository.upsertSyncState({ formId: "901", status: "success", snapshotAt: "date", activeGenerationId: "date-901",
      readModelVersion: READ_MODEL_SCHEMA_VERSION, totalEntries: datedRows.length, totalRows: 0 });
    for (const field of ["plannedEndDate", "prevPlanEndDate", "plannedStartDate", "lastUpdatedAt"]) {
      const options = parseReportsQuery({ limit: "100", filterGroup: JSON.stringify({ joinMode: "all", conditions: [
        { id: "date", field, operator: "between", values: ["2026-09-07", "2026-09-07"] },
      ] }) }, "901");
      const sqlite = await workReportSqliteRepository.getReports("901", options);
      const memory = support.filterSortAndPaginateReports(datedRows, options);
      assert.deepEqual(sqlite.data.map(row => row.id), ["0", "1", "3", "4", "5", "7", "14"], "SQLITE_DATE_FILTER_PRESERVES_LOCAL_DAY " + field);
      assert.deepEqual(memory.data.map(row => row.id), ["0", "1", "3", "4", "5", "7", "14"], "MEMORY_DATE_FILTER_PRESERVES_LOCAL_DAY " + field);
    }
    const crossZoneRows = ["2026-09-17T20:00:00Z", "2026-09-17T16:00:00Z", "2026-09-18T15:59:59.999Z", "2026/09/18", "2026/09/18 23:30:00", "2026-09-18T23:30:00+0800", "2026-09-17T15:59:59.999Z", "2026-09-18T16:00:00Z", "2026-09-17T20:00:00-0500", "\u00a02026-09-17T20:00:00Z\ufeff", "2026-09-17T24:00:00"].map((value, index) => ({
      id: String(index), prodType: "PA", reports: [], plannedEndDate: value, prevPlanEndDate: value, plannedStartDate: value, lastUpdatedAt: value,
    }));
    await workReportSqliteRepository.replaceFormSnapshot("901", crossZoneRows, "cross-zone-901");
    await workReportSqliteRepository.upsertSyncState({ formId: "901", status: "success", snapshotAt: "cross-zone", activeGenerationId: "cross-zone-901",
      readModelVersion: READ_MODEL_SCHEMA_VERSION, totalEntries: crossZoneRows.length, totalRows: 0 });
    const legacyLocalDay = await (await sqliteClient.getDb()).get<{ day: string }>("SELECT date('2026-09-17T20:00:00Z', 'localtime') AS day");
    // Windows SQLite uses the system timezone even when Node's TZ changes.
    if (process.platform !== "win32") assert.equal(legacyLocalDay?.day, timezone === "Asia/Taipei" ? "2026-09-18" : "2026-09-17", "HOST_TIMEZONE_NEGATIVE_CONTROL");
    for (const field of ["plannedEndDate", "prevPlanEndDate", "plannedStartDate", "lastUpdatedAt"]) for (const [operator, values, expected] of [
      ["between", ["2026-09-18", "2026-09-18"], ["0", "1", "2", "3", "4", "5", "8", "9", "10"]],
      ["before", ["2026-09-18"], ["0", "1", "2", "3", "4", "5", "6", "8", "9", "10"]],
      ["after", ["2026-09-18"], ["0", "1", "2", "3", "4", "5", "7", "8", "9", "10"]],
    ] as const) {
      const options = parseReportsQuery({ limit: "100", filterGroup: JSON.stringify({ joinMode: "all", conditions: [
        { id: "cross-zone", field, operator, values },
      ] }) }, "901");
      assert.deepEqual((await workReportSqliteRepository.getReports("901", options)).data.map(row => row.id), expected, "SQLITE_DATE_FILTER_MUST_USE_TAIWAN_TIME " + field + " " + timezone);
      assert.deepEqual(support.filterSortAndPaginateReports(crossZoneRows, options).data.map(row => row.id), expected, "MEMORY_DATE_FILTER_MUST_USE_TAIWAN_TIME " + field + " " + timezone);
    }
    const blankRows = ["bad", "", null, 0, false, " \t\r\n ", "\u00a0", "\ufeff", "\u200b"].map((value, index) => ({
      id: String(index), prodType: "PA", reports: [], plannedStartDate: value, lastUpdatedAt: value, startSchedule: value, siteRunning: value,
      sortOrder: value, workOrderNo: value, size: value, urgent: value,
    }));
    await workReportSqliteRepository.replaceFormSnapshot("901", blankRows, "blank-901");
    await workReportSqliteRepository.upsertSyncState({ formId: "901", status: "success", snapshotAt: "blank", activeGenerationId: "blank-901",
      readModelVersion: READ_MODEL_SCHEMA_VERSION, totalEntries: blankRows.length, totalRows: 0 });
    for (const field of ["plannedStartDate", "lastUpdatedAt", "startSchedule", "siteRunning", "sortOrder", "workOrderNo", "size", "urgent"]) for (const [operator, expected] of [
      ["isEmpty", ["1", "2", "5", "6", "7"]], ["isNotEmpty", ["0", "3", "4", "8"]],
    ] as const) {
      const options = parseReportsQuery({ limit: "100", filterGroup: JSON.stringify({ joinMode: "all", conditions: [
        { id: "blank", field, operator, values: [] },
      ] }) }, "901");
      const sqlite = await workReportSqliteRepository.getReports("901", options);
      const memory = support.filterSortAndPaginateReports(blankRows, options);
      assert.deepEqual(sqlite.data.map(row => row.id), expected, "SQLITE_BLANK_FILTER_MUST_PRESERVE_RAW_VALUE " + field);
      assert.deepEqual(memory.data.map(row => row.id), expected, "MEMORY_BLANK_FILTER_MUST_PRESERVE_RAW_VALUE " + field);
    }
    const textRows = [
      { id: "diameter", prodType: "PA", reports: [], size: "\tΦAB06*15\u00a0" },
      { id: "lower-diameter", prodType: "PA", reports: [], size: "φab06*15" },
    ];
    await workReportSqliteRepository.replaceFormSnapshot("901", textRows, "text-901");
    await workReportSqliteRepository.upsertSyncState({ formId: "901", status: "success", snapshotAt: "text", activeGenerationId: "text-901",
      readModelVersion: READ_MODEL_SCHEMA_VERSION, totalEntries: textRows.length, totalRows: 0 });
    const textOptions = parseReportsQuery({ limit: "100", filterGroup: JSON.stringify({ joinMode: "all", conditions: [
      { id: "size", field: "size", operator: "equals", values: ["Φab06*15"] },
    ] }) }, "901");
    assert.deepEqual((await workReportSqliteRepository.getReports("901", textOptions)).data.map(row => row.id), ["diameter"], "SQLITE_TEXT_FILTER_MUST_RETAIN_ORIGINAL_SYMBOL");
    assert.deepEqual(support.filterSortAndPaginateReports(textRows, textOptions).data.map(row => row.id), ["diameter"], "MEMORY_TEXT_FILTER_MUST_RETAIN_ORIGINAL_SYMBOL");
  } finally {
    await sqliteClient.close();
    Object.assign(env, original);
    if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz;
    await rm(root, { recursive: true, force: true });
  }
});
}

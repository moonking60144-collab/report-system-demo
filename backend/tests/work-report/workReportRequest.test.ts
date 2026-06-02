import test from "node:test";
import assert from "node:assert/strict";
import { parseReportsQuery } from "../../src/routes/workReportRequest";

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


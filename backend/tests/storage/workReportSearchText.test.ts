import assert from "node:assert/strict";
import test from "node:test";
import { buildSearchText } from "../../src/storage/sqlite/workReportSqliteHelpers";

test("工令搜尋文字只收業務值，不收明細 API 的版本 hash", () => {
  const hash = `sha256:${"a".repeat(64)}`;
  const searchText = buildSearchText({
    id: "E-901",
    workOrderNo: "WO-DEMO-0004",
    entrySnapshotHash: hash,
    reports: [],
  });

  assert.match(searchText ?? "", /wo-demo-0004/);
  assert.equal(searchText?.includes(hash), false);
});

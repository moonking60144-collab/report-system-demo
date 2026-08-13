import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  efficiencyReportRetentionCutoffMonth,
  inspectForm16PublishedCsv,
  previousCompleteTaipeiMonth,
} from "../../../src/services/form16/form16PublishedCsv";

function csv(rows: Array<{ id: string; date?: string; value?: string }>): string {
  const header = Array.from({ length: 65 }, (_, index) => `H${index}`);
  const data = rows.map((input) => {
    const cells = Array.from({ length: 65 }, () => "");
    cells[0] = input.id;
    cells[5] = input.date ?? "2026/06/15";
    cells[10] = input.value ?? "10";
    return cells;
  });
  return [header, ...data].map((row) => row.join(",")).join("\n");
}

test("效率報表來源 hash 不受 CSV 資料列順序影響", () => {
  const first = inspectForm16PublishedCsv(
    csv([
      { id: "A", value: "10" },
      { id: "B", value: "20" },
    ]),
    "2026-06",
    100
  );
  const second = inspectForm16PublishedCsv(
    csv([
      { id: "B", value: "20" },
      { id: "A", value: "10" },
    ]),
    "2026-06",
    100
  );

  assert.equal(first.sourceHash, second.sourceHash);
  assert.equal(first.rowCount, 2);
});

test("效率報表來源 hash 維持既有 JSON canonicalization 相容性", () => {
  const source = csv([
    { id: "B", value: "20" },
    { id: "A", value: "10" },
  ]);
  const parsed = source.split("\n").map((line) => line.split(",").map((value) => value.trim()));
  const expected = createHash("sha256")
    .update(JSON.stringify([parsed[0], parsed.slice(1).sort((left, right) => {
      const leftKey = JSON.stringify(left);
      const rightKey = JSON.stringify(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    })]))
    .digest("hex");

  assert.equal(inspectForm16PublishedCsv(source, "2026-06", 100).sourceHash, expected);
});

test("效率報表來源內容變更會產生不同 hash", () => {
  const first = inspectForm16PublishedCsv(csv([{ id: "A", value: "10" }]), "2026-06", 100);
  const second = inspectForm16PublishedCsv(csv([{ id: "A", value: "11" }]), "2026-06", 100);

  assert.notEqual(first.sourceHash, second.sourceHash);
});

test("效率報表來源新增欄位的內容變更也會建立不同 hash", () => {
  const base = csv([{ id: "row-a", date: "2026/06/01" }]);
  const withExtraA = base
    .split("\n")
    .map((line, index) => `${line},${index === 0 ? "extra" : "A"}`)
    .join("\n");
  const withExtraB = withExtraA.replace(/,A$/, ",B");

  const first = inspectForm16PublishedCsv(withExtraA, "2026-06", 100);
  const second = inspectForm16PublishedCsv(withExtraB, "2026-06", 100);

  assert.notEqual(first.sourceHash, second.sourceHash);
});

test("效率報表拒絕歸屬到其他月份的 CSV", () => {
  assert.throws(
    () => inspectForm16PublishedCsv(csv([{ id: "A", date: "2026/05/31" }]), "2026-06", 100),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EFFICIENCY_REPORT_PERIOD_MISMATCH"
  );
});

test("效率報表拒絕不存在的日期", () => {
  const invalidCsv = csv([{ id: "row-a", date: "2026/06/31" }]);
  assert.throws(
    () => inspectForm16PublishedCsv(invalidCsv, "2026-06", 100),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EFFICIENCY_REPORT_PERIOD_MISMATCH"
  );
});

test("上個完整台北月份跨年計算正確", () => {
  assert.equal(previousCompleteTaipeiMonth(new Date("2026-01-01T00:30:00+08:00")), "2025-12");
  assert.equal(previousCompleteTaipeiMonth(new Date("2026-07-13T12:00:00+08:00")), "2026-06");
});

test("兩年保存邊界以台北完整月份計算", () => {
  assert.equal(
    efficiencyReportRetentionCutoffMonth(new Date("2026-07-13T12:00:00+08:00"), 24),
    "2024-07"
  );
});

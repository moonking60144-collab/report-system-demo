import test from "node:test";
import assert from "node:assert/strict";
import type { FormConfig } from "../../src/types/formConfig";
import {
  computeTotalWorkTimeHours,
  evaluateCreateRepairRequirement,
  evaluatePostCreateRecalculateNeed,
  shouldUseComputedTotalWorkTimeFallback,
} from "../../src/services/work-report/create/recalculateInspection";

function buildConfig(): FormConfig {
  return {
    formId: "104",
    formName: "test",
    ragicPath: "/test",
    mainFields: { workOrderNo: "wo" },
    subtableId: "_subtable_1",
    subtableFields: {
      operatorId: "opIdLabel",
      operatorName: "opNameLabel",
      date: "dateLabel",
      machineId: "machineLabel",
      startTime: "startLabel",
      endTime: "endLabel",
      productionQty: "qtyLabel",
      shiftType: "shiftLabel",
      breakTime: "breakLabel",
      totalWorkTime: "totalLabel",
    },
    writeConfig: {
      subtableId: "_subtable_1",
      requiredFields: ["operatorId", "date", "machineId", "startTime", "endTime", "productionQty"],
      subtableWriteFields: {
        operatorId: "opId",
        operatorName: "opName",
        date: "date",
        machineId: "machine",
        startTime: "start",
        endTime: "end",
        productionQty: "qty",
        breakTime: "break",
        totalWorkTime: "total",
      },
    },
    displayFields: [],
  };
}

test("evaluateCreateRepairRequirement 可判斷缺漏與不一致欄位", () => {
  const config = buildConfig();
  const expected = { opId: "A001", opName: "王小明", date: "2025/01/01" };
  const actual = { opId: "A001", opName: "", date: "2025/01/02" };

  const result = evaluateCreateRepairRequirement(actual, expected, config);
  assert.equal(result.needsRepair, true);
  assert.deepEqual(result.missingFieldKeys, ["opName"]);
  assert.deepEqual(result.mismatchedFieldKeys, ["date"]);
});

test("evaluatePostCreateRecalculateNeed 可抓到 totalWorkTime 未計算", () => {
  const config = buildConfig();
  const row = {
    opId: "A001",
    opName: "王小明",
    date: "2025/01/01",
    machine: "W1",
    start: "08:00:00",
    end: "17:00:00",
    qty: "100",
    shiftLabel: "正常班Reg",
    break: "1",
    total: "",
  };

  const result = evaluatePostCreateRecalculateNeed(row, config);
  assert.equal(result.needsRecalculate, true);
  assert.equal(result.missingFields.includes("totalWorkTime"), true);
  assert.equal(result.formulaGaps.includes("totalWorkTime-not-calculated"), true);
  assert.equal(shouldUseComputedTotalWorkTimeFallback(result), true);
});

test("computeTotalWorkTimeHours 可正確計算跨時段工時（扣休息）", () => {
  const config = buildConfig();
  const row = {
    start: "08:00:00",
    end: "17:00:00",
    break: "1",
  };

  assert.equal(computeTotalWorkTimeHours(row, config), 8);
});

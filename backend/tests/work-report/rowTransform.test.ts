import test from "node:test";
import assert from "node:assert/strict";
import type { FormConfig } from "../../src/types/formConfig";
import {
  enrichLinkedFields,
  mapFields,
  mapSubtable,
  normalizeMappedFieldValue,
  resolveCandidateFieldKeys,
  transformRow,
} from "../../src/services/work-report/queries/rowTransform";
import type { SourceDataMap } from "../../src/services/work-report/shared/ragicRowUtils";

function buildConfig(): FormConfig {
  return {
    formId: "901",
    formName: "test",
    ragicPath: "/test",
    mainFields: { machineCode: "1001", workOrderNo: "1002" },
    mainFieldFallbacks: { workOrderNo: "Work Order|工令" },
    filterFields: { machineCode: "1003" },
    subtableId: "_subtable_1",
    subtableFields: { operatorId: "2001", remark: "2002" },
    writeConfig: {
      subtableId: "_subtable_1",
      requiredFields: [],
      subtableWriteFields: {},
    },
    linkedFields: {
      operatorId: {
        sourceFormPath: "/ops",
        displayFieldId: "name",
      },
    },
    displayFields: [],
  };
}

test("resolveCandidateFieldKeys 會展開 fallback 並去空白", () => {
  assert.deepEqual(resolveCandidateFieldKeys("1001", " A | B | "), ["1001", "A", "B"]);
});

test("normalizeMappedFieldValue machineCode 會截取 @ 後機台代碼", () => {
  assert.equal(normalizeMappedFieldValue("machineCode", "料號@MA18"), "MA18");
  assert.equal(normalizeMappedFieldValue("machineCode", "UPSTREAM@MB07"), "MB07");
  assert.equal(normalizeMappedFieldValue("workOrderNo", "WO-1"), "WO-1");
});

test("normalizeMappedFieldValue modificationStatus 會把陣列轉成可顯示字串", () => {
  assert.equal(normalizeMappedFieldValue("modificationStatus", ["新增"]), "新增");
  assert.equal(
    normalizeMappedFieldValue("modificationStatus", ["新增", "量增"]),
    "新增、量增"
  );
  assert.equal(normalizeMappedFieldValue("modificationStatus", []), null);
});

test("mapFields 會使用 fallback 並保留第一個可用值", () => {
  const mapped = mapFields(
    { "1001": "料號@MA05", WorkOrder: "WO-DEMO-1" },
    { machineCode: "1001", workOrderNo: "1002" },
    { workOrderNo: "WorkOrder|工令" }
  );
  assert.equal(mapped.machineCode, "MA05");
  assert.equal(mapped.workOrderNo, "WO-DEMO-1");
});

test("mapFields 會從 prodType fallback 讀到製程大分類代碼", () => {
  const mapped = mapFields(
    { "demo_prod_type": "PA" },
    { prodType: "demo_prod_type" },
    { prodType: "demo_prod_type" }
  );
  assert.equal(mapped.prodType, "PA");
});

test("mapSubtable / enrichLinkedFields / transformRow 會維持既有 mapping 行為", () => {
  const config = buildConfig();
  const subtable = {
    "12": { "2001": "A001", "2002": "備註A" },
    x: { "2001": "skip" },
  };
  const reports = mapSubtable(subtable, config);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].rowId, "12");
  assert.equal(reports[0].remark, "備註A");

  const sourceMap: SourceDataMap = new Map([["A001", { name: "示範帳號" }]]);
  enrichLinkedFields(reports, config, new Map([["operatorId", sourceMap]]));
  assert.equal(reports[0].operatorIdDisplay, "示範帳號");

  const transformed = transformRow(
    {
      entryId: "724",
      data: {
        _ragicId: "999",
        "1001": "TEST@MA11",
        "1003": "MA11",
        "1002": "WO-DEMO-1",
        _subtable_1: { "12": { "2001": "A001", "2002": "備註A" } },
      },
    },
    config,
    new Map([["operatorId", sourceMap]])
  );
  assert.equal(transformed.id, "999");
  assert.equal(transformed.machineCode, "MA11");
  assert.equal(transformed.filterMachineCode, "MA11");
  assert.equal(transformed.reports.length, 1);
  assert.equal(transformed.reports[0].operatorIdDisplay, "示範帳號");
});

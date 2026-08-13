import test from "node:test";
import assert from "node:assert/strict";
import { FORM_104_CONFIG } from "../../src/config/forms/form-104";
import { FORM_105_CONFIG } from "../../src/config/forms/form-105";

test("Form 105 detail 主機台讀取契約對齊寫入 field 1006031", () => {
  const writeField = FORM_105_CONFIG.writeConfig.mainWriteFields?.machineCode;
  const filterFallbacks = String(
    FORM_105_CONFIG.filterFieldFallbacks?.machineCode ?? ""
  ).split("|");

  assert.equal(FORM_105_CONFIG.filterFields?.machineCode, "內製指定機台");
  assert.equal(writeField, "1006031");
  assert.ok(filterFallbacks.includes(writeField));
  assert.notEqual(FORM_105_CONFIG.mainFields.machineCode, "內製指定機台");
});

test("Form 104 detail 主機台讀取與寫入維持同一機台欄位", () => {
  const writeField = FORM_104_CONFIG.writeConfig.mainWriteFields?.machineCode;
  const mainFallbacks = String(
    FORM_104_CONFIG.mainFieldFallbacks?.machineCode ?? ""
  ).split("|");

  assert.equal(FORM_104_CONFIG.mainFields.machineCode, "內製指定機台");
  assert.equal(writeField, "1006031");
  assert.ok(mainFallbacks.includes(writeField));
});

test("Form 104/105 排序碼讀寫契約都對齊 field 1012079", () => {
  for (const config of [FORM_104_CONFIG, FORM_105_CONFIG]) {
    const writeField = config.writeConfig.mainWriteFields?.sortOrder;
    const readField = config.mainFields.sortOrder;
    const fallbacks = String(config.mainFieldFallbacks?.sortOrder ?? "").split("|");

    assert.equal(writeField, "1012079");
    assert.ok(readField === writeField || fallbacks.includes(writeField));
  }
});

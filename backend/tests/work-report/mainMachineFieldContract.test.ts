import test from "node:test";
import assert from "node:assert/strict";
import { FORM_901_CONFIG } from "../../src/config/forms/form-901";
import { FORM_902_CONFIG } from "../../src/config/forms/form-902";

test("Form 902 detail 主機台讀取契約對齊寫入 field 9001045", () => {
  const writeField = FORM_902_CONFIG.writeConfig.mainWriteFields?.machineCode;
  const filterFallbacks = String(
    FORM_902_CONFIG.filterFieldFallbacks?.machineCode ?? ""
  ).split("|");

  assert.equal(FORM_902_CONFIG.filterFields?.machineCode, "demo_machine_code");
  assert.equal(writeField, "9001045");
  assert.ok(filterFallbacks.includes(writeField));
  assert.notEqual(FORM_902_CONFIG.mainFields.machineCode, "demo_machine_code");
});

test("Form 901 detail 主機台讀取與寫入維持同一機台欄位", () => {
  const writeField = FORM_901_CONFIG.writeConfig.mainWriteFields?.machineCode;
  const mainFallbacks = String(
    FORM_901_CONFIG.mainFieldFallbacks?.machineCode ?? ""
  ).split("|");

  assert.equal(FORM_901_CONFIG.mainFields.machineCode, "demo_machine_code");
  assert.equal(writeField, "9001045");
  assert.ok(mainFallbacks.includes(writeField));
});

test("Form 901/902 排序碼讀寫契約都對齊 field 9001063", () => {
  for (const config of [FORM_901_CONFIG, FORM_902_CONFIG]) {
    const writeField = config.writeConfig.mainWriteFields?.sortOrder;
    const readField = config.mainFields.sortOrder;
    const fallbacks = String(config.mainFieldFallbacks?.sortOrder ?? "").split("|");

    assert.equal(writeField, "9001063");
    assert.ok(readField === writeField || fallbacks.includes(writeField));
  }
});

test("Form 901/902 急件共用 field 9001088，開始排程只存在 Form 901", () => {
  for (const config of [FORM_901_CONFIG, FORM_902_CONFIG]) {
    assert.equal(config.writeConfig.mainWriteFields?.urgent, "9001088");
    assert.equal(config.mainFieldFallbacks?.urgent, "9001088");
  }
  assert.equal(FORM_901_CONFIG.writeConfig.mainWriteFields?.startSchedule, "9001102");
  assert.equal(FORM_902_CONFIG.writeConfig.mainWriteFields?.startSchedule, undefined);
});

test("Form 901/902 都讀取同一個上一站機台欄位", () => {
  for (const config of [FORM_901_CONFIG, FORM_902_CONFIG]) {
    assert.equal(config.mainFields.previousMachine, "demo_previous_machine");
    assert.equal(config.mainFieldFallbacks?.previousMachine, "9001112");
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  asksForWorkflow,
  formPathsFromQuestion,
  normalizeExplicitFormPath,
} from "../../../src/services/dev/ai/devAiFormContext";

test("Dev AI form context 只辨識明確的 Ragic 表單 identity", () => {
  assert.deepEqual(
    formPathsFromQuestion("https://demo.example/default/forms999/9001/123?PAGEID=demo"),
    ["default/forms999/9001"]
  );
  assert.deepEqual(formPathsFromQuestion("forms999/9002"), ["default/forms999/9002"]);
  assert.deepEqual(formPathsFromQuestion("standard/demo/51"), ["standard/demo/51"]);
  assert.equal(normalizeExplicitFormPath("forms999/9001"), "default/forms999/9001");
  assert.equal(normalizeExplicitFormPath("default/forms999/9001.1"), "default/forms999/9001.1");
});

test("Dev AI form context 不把日期、原始碼路徑或普通 camelCase 當成表單", () => {
  for (const value of [
    "2026/09/22 的報工資料",
    "backend/src/example 的錯誤",
    "macOS 要怎麼設定",
    "formPath 是什麼",
  ]) {
    assert.deepEqual(formPathsFromQuestion(value), []);
  }
  assert.equal(normalizeExplicitFormPath("2026/09/22"), undefined, "FORM_IDENTITY_CONTRACT");
  assert.equal(normalizeExplicitFormPath("backend/src/example"), undefined);
  assert.equal(asksForWorkflow("formPath 是什麼"), false);
  assert.equal(asksForWorkflow("preparePickingDetails() 怎麼運作"), true);
});

test("Dev AI form context 拒絕 traversal 與不支援的 namespace", () => {
  assert.equal(normalizeExplicitFormPath("default/../92"), undefined);
  assert.equal(normalizeExplicitFormPath("private/forms999/9001"), undefined);
  assert.equal(normalizeExplicitFormPath("default/forms999/."), undefined);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  tokenizeFormula,
  translateFormulaPositions,
  type TranslatorFieldInfo,
} from "../../../src/services/dev/ragicFormulaPositionTranslator";

function sourceMap(entries: Record<string, TranslatorFieldInfo>) {
  return new Map(Object.entries(entries));
}

function targetMap(entries: Record<string, { position: string; fieldName: string }>) {
  return new Map(Object.entries(entries));
}

const SOURCE = sourceMap({
  A6: { fieldId: "1001", fieldName: "規格" },
  B6: { fieldId: "1002", fieldName: "數量" },
  D15: { fieldId: "1003", fieldName: "校正日" },
});

const TARGET = targetMap({
  "1001": { position: "C3", fieldName: "規格" },
  "1002": { position: "D2", fieldName: "數量" },
  "1003": { position: "E9", fieldName: "校正日" },
});

test("單一 ref 翻譯：A6 → C3", () => {
  const result = translateFormulaPositions({
    formula: "A6",
    sourceByPosition: SOURCE,
    targetPositionByFieldId: TARGET,
  });
  assert.equal(result.translated, "C3");
  assert.deepEqual(result.mapping, [
    { from: "A6", to: "C3", fieldId: "1001", fieldName: "規格" },
  ]);
  assert.equal(result.untranslatable.length, 0);
});

test("多 ref 與運算子：A6+B6 → C3+D2", () => {
  const result = translateFormulaPositions({
    formula: "A6+B6",
    sourceByPosition: SOURCE,
    targetPositionByFieldId: TARGET,
  });
  assert.equal(result.translated, "C3+D2");
  assert.equal(result.mapping.length, 2);
});

test("函式參數內 ref 換、數字常數不動：EOMONTH(D15,6)", () => {
  const result = translateFormulaPositions({
    formula: 'IF(AND(D15!=""),EOMONTH(D15,6),"")',
    sourceByPosition: SOURCE,
    targetPositionByFieldId: TARGET,
  });
  assert.equal(result.translated, 'IF(AND(E9!=""),EOMONTH(E9,6),"")');
});

test("字串字面值內不翻譯：IF(A6=\"A6\",...)", () => {
  const result = translateFormulaPositions({
    formula: 'IF(A6="A6","x","y")',
    sourceByPosition: SOURCE,
    targetPositionByFieldId: TARGET,
  });
  assert.equal(result.translated, 'IF(C3="A6","x","y")');
});

test("單引號字串字面值內不翻譯：IF(A6!='A6',...)", () => {
  const result = translateFormulaPositions({
    formula: "IF(A6!='A6',B6,'A6')",
    sourceByPosition: SOURCE,
    targetPositionByFieldId: TARGET,
  });
  assert.equal(result.translated, "IF(C3!='A6',D2,'A6')");
});

test("重複 ref 都翻譯且 mapping 不重複列：A6+A6", () => {
  const result = translateFormulaPositions({
    formula: "A6+A6",
    sourceByPosition: SOURCE,
    targetPositionByFieldId: TARGET,
  });
  assert.equal(result.translated, "C3+C3");
  assert.equal(result.mapping.length, 1);
});

test(".RAW 後綴保留：A6.RAW → C3.RAW", () => {
  const result = translateFormulaPositions({
    formula: 'UPDATEIF(A6.RAW!="",B6)',
    sourceByPosition: SOURCE,
    targetPositionByFieldId: TARGET,
  });
  assert.equal(result.translated, 'UPDATEIF(C3.RAW!="",D2)');
});

test("字母+數字函式名不誤抓：LOG10(B6)", () => {
  const result = translateFormulaPositions({
    formula: "LOG10(B6)",
    sourceByPosition: SOURCE,
    targetPositionByFieldId: TARGET,
  });
  assert.equal(result.translated, "LOG10(D2)");
});

test("雙字母 ref 支援：AC9", () => {
  const result = translateFormulaPositions({
    formula: "AC9*2",
    sourceByPosition: sourceMap({ AC9: { fieldId: "2001", fieldName: "寬欄位" } }),
    targetPositionByFieldId: targetMap({ "2001": { position: "BR5", fieldName: "寬欄位" } }),
  });
  assert.equal(result.translated, "BR5*2");
});

test("目標表單缺欄位 → 整條拒譯（translated=null）並說明原因", () => {
  const result = translateFormulaPositions({
    formula: "A6+B6",
    sourceByPosition: SOURCE,
    targetPositionByFieldId: targetMap({ "1001": { position: "C3", fieldName: "規格" } }),
  });
  assert.equal(result.translated, null);
  assert.equal(result.untranslatable.length, 1);
  assert.match(result.untranslatable[0].reason, /不存在於目標表單/);
  assert.match(result.untranslatable[0].reason, /數量/);
});

test("來源表單查無此位置 → 拒譯並說明", () => {
  const result = translateFormulaPositions({
    formula: "Z99+A6",
    sourceByPosition: SOURCE,
    targetPositionByFieldId: TARGET,
  });
  assert.equal(result.translated, null);
  assert.equal(result.untranslatable[0].token, "Z99");
  assert.match(result.untranslatable[0].reason, /來源表單沒有位置/);
});

test("含 $ 絕對參照 → 拒譯", () => {
  const result = translateFormulaPositions({
    formula: "$A$6+B6",
    sourceByPosition: SOURCE,
    targetPositionByFieldId: TARGET,
  });
  assert.equal(result.translated, null);
  assert.ok(result.untranslatable.some((item) => item.token === "$"));
});

test("字串字面值內的 $ 不視為絕對參照", () => {
  const result = translateFormulaPositions({
    formula: 'IF(A6>0,"$"&B6,"")',
    sourceByPosition: SOURCE,
    targetPositionByFieldId: TARGET,
  });
  assert.equal(result.translated, 'IF(C3>0,"$"&D2,"")');
  assert.equal(result.untranslatable.length, 0);
});

test("超出支援範圍但形狀像 cell ref 的 token 會拒譯", () => {
  const result = translateFormulaPositions({
    formula: "A12345+B6",
    sourceByPosition: SOURCE,
    targetPositionByFieldId: TARGET,
  });
  assert.equal(result.translated, null);
  assert.ok(
    result.untranslatable.some(
      (item) => item.token === "A12345" && /超出/.test(item.reason)
    )
  );
});

test("tokenizer：識別字邊界不誤切（ABS1 變數樣 token 後接字母不算 ref）", () => {
  const tokens = tokenizeFormula("FOO1BAR+A6");
  const refs = tokens.filter((t) => t.isCellRef).map((t) => t.text);
  assert.deepEqual(refs, ["A6"]);
});

test("無 ref 公式原樣通過：純常數與字串", () => {
  const result = translateFormulaPositions({
    formula: '"固定文字"',
    sourceByPosition: SOURCE,
    targetPositionByFieldId: TARGET,
  });
  assert.equal(result.translated, '"固定文字"');
  assert.equal(result.mapping.length, 0);
});

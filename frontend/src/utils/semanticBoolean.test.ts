import { describe, expect, test } from "vitest";
import {
  FALSE_BOOLEAN_VALUES,
  TRUE_BOOLEAN_VALUES,
  parseSemanticBoolean,
} from "./semanticBoolean";

describe("parseSemanticBoolean", () => {
  test("boolean 值直通不經過字串路徑", () => {
    expect(parseSemanticBoolean(true)).toBe(true);
    expect(parseSemanticBoolean(false)).toBe(false);
  });

  test("null / undefined 一律回 null", () => {
    expect(parseSemanticBoolean(null)).toBe(null);
    expect(parseSemanticBoolean(undefined)).toBe(null);
  });

  test("空字串或純空白回 null", () => {
    expect(parseSemanticBoolean("")).toBe(null);
    expect(parseSemanticBoolean("   ")).toBe(null);
    expect(parseSemanticBoolean("\t\n")).toBe(null);
  });

  test.each([
    ["yes"],
    ["YES"],
    ["Yes"],
    ["true"],
    ["TRUE"],
    ["1"],
    ["v"],
    ["V"],
    ["✓"],
    ["是"],
    ["  yes  "],
  ])("Ragic truthy 字串 %s 回 true", (value) => {
    expect(parseSemanticBoolean(value)).toBe(true);
  });

  test.each([["no"], ["NO"], ["false"], ["FALSE"], ["0"], ["否"], ["  no  "]])(
    "Ragic falsy 字串 %s 回 false",
    (value) => {
      expect(parseSemanticBoolean(value)).toBe(false);
    }
  );

  test("無法辨識的字串回 null（不要當 false）", () => {
    expect(parseSemanticBoolean("maybe")).toBe(null);
    expect(parseSemanticBoolean("2")).toBe(null);
    expect(parseSemanticBoolean("true-ish")).toBe(null);
    expect(parseSemanticBoolean("x")).toBe(null);
  });

  test("數字 1 / 0 會被 String 轉換後進表", () => {
    expect(parseSemanticBoolean(1)).toBe(true);
    expect(parseSemanticBoolean(0)).toBe(false);
  });

  test("其他數字視同未知，回 null", () => {
    expect(parseSemanticBoolean(2)).toBe(null);
    expect(parseSemanticBoolean(-1)).toBe(null);
    expect(parseSemanticBoolean(NaN)).toBe(null);
  });
});

describe("TRUE/FALSE_BOOLEAN_VALUES Sets", () => {
  test("TRUE set 包含所有預期的 Ragic truthy 表示", () => {
    expect(TRUE_BOOLEAN_VALUES.has("yes")).toBe(true);
    expect(TRUE_BOOLEAN_VALUES.has("true")).toBe(true);
    expect(TRUE_BOOLEAN_VALUES.has("1")).toBe(true);
    expect(TRUE_BOOLEAN_VALUES.has("v")).toBe(true);
    expect(TRUE_BOOLEAN_VALUES.has("✓")).toBe(true);
    expect(TRUE_BOOLEAN_VALUES.has("是")).toBe(true);
  });

  test("FALSE set 包含所有預期的 Ragic falsy 表示", () => {
    expect(FALSE_BOOLEAN_VALUES.has("no")).toBe(true);
    expect(FALSE_BOOLEAN_VALUES.has("false")).toBe(true);
    expect(FALSE_BOOLEAN_VALUES.has("0")).toBe(true);
    expect(FALSE_BOOLEAN_VALUES.has("否")).toBe(true);
  });

  test("兩個 set 不重疊：同一字串不會同時被當 true / false", () => {
    for (const value of TRUE_BOOLEAN_VALUES) {
      expect(FALSE_BOOLEAN_VALUES.has(value)).toBe(false);
    }
  });
});

import { describe, expect, test } from "vitest";
import {
  compareAlphaNumeric,
  normalizeColumnText,
  normalizeText,
  toSortableDate,
  toSortableNumber,
} from "./valueUtils";

describe("compareAlphaNumeric", () => {
  test("依數值大小排序，不是字典序", () => {
    const values = ["item10", "item2", "item1"];
    const sorted = [...values].sort(compareAlphaNumeric);
    expect(sorted).toEqual(["item1", "item2", "item10"]);
  });

  test("大小寫不敏感", () => {
    expect(compareAlphaNumeric("abc", "ABC")).toBe(0);
  });

  test("純數字字串也依數值大小排序", () => {
    const values = ["10", "2", "1"];
    const sorted = [...values].sort(compareAlphaNumeric);
    expect(sorted).toEqual(["1", "2", "10"]);
  });
});

describe("toSortableNumber", () => {
  test("一般數字字串轉成 number", () => {
    expect(toSortableNumber("42")).toBe(42);
    expect(toSortableNumber("3.14")).toBe(3.14);
    expect(toSortableNumber("-5")).toBe(-5);
  });

  test("帶逗號的千分位數字正確轉換", () => {
    expect(toSortableNumber("1,234")).toBe(1234);
    expect(toSortableNumber("1,234,567.89")).toBe(1234567.89);
  });

  test("null / undefined / 空字串回 null", () => {
    expect(toSortableNumber(null)).toBe(null);
    expect(toSortableNumber(undefined)).toBe(null);
    expect(toSortableNumber("")).toBe(null);
  });

  test("純空白視同空值", () => {
    expect(toSortableNumber("   ")).toBe(null);
  });

  test("無法解析為數字回 null（不拋錯）", () => {
    expect(toSortableNumber("abc")).toBe(null);
    expect(toSortableNumber("12abc")).toBe(null);
  });

  test("直接傳 number 也能接受，0 會正確回傳 0（不當作空值）", () => {
    expect(toSortableNumber(100)).toBe(100);
    expect(toSortableNumber(0)).toBe(0);
  });
});

describe("toSortableDate", () => {
  test("yyyy-mm-dd 格式正確轉成 timestamp", () => {
    const result = toSortableDate("2026-04-22");
    expect(result).not.toBe(null);
    const date = new Date(result!);
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(3); // 0-indexed
    expect(date.getDate()).toBe(22);
  });

  test("yyyy/mm/dd 格式一樣吃", () => {
    const result = toSortableDate("2026/04/22");
    expect(result).not.toBe(null);
  });

  test("兩種格式解析結果一致（dash 會被轉成 slash 再 new Date）", () => {
    expect(toSortableDate("2026-04-22")).toBe(toSortableDate("2026/04/22"));
  });

  test("null / undefined / 空字串回 null", () => {
    expect(toSortableDate(null)).toBe(null);
    expect(toSortableDate(undefined)).toBe(null);
    expect(toSortableDate("")).toBe(null);
  });

  test("無法解析的字串回 null", () => {
    expect(toSortableDate("not-a-date")).toBe(null);
    expect(toSortableDate("2026-13-99")).toBe(null);
  });
});

describe("normalizeColumnText", () => {
  test("保留原始大小寫，只 trim", () => {
    expect(normalizeColumnText("  Hello  ")).toBe("Hello");
    expect(normalizeColumnText("ABC")).toBe("ABC");
  });

  test("null / undefined 回空字串", () => {
    expect(normalizeColumnText(null)).toBe("");
    expect(normalizeColumnText(undefined)).toBe("");
  });

  test("數字轉成字串", () => {
    expect(normalizeColumnText(42)).toBe("42");
  });
});

describe("normalizeText", () => {
  test("trim + 轉小寫", () => {
    expect(normalizeText("  Hello  ")).toBe("hello");
    expect(normalizeText("ABC")).toBe("abc");
  });

  test("null / undefined 回空字串", () => {
    expect(normalizeText(null)).toBe("");
    expect(normalizeText(undefined)).toBe("");
  });

  test("跟 normalizeColumnText 差別在 lowercase", () => {
    const input = "  Mixed Case  ";
    expect(normalizeColumnText(input)).toBe("Mixed Case");
    expect(normalizeText(input)).toBe("mixed case");
  });
});

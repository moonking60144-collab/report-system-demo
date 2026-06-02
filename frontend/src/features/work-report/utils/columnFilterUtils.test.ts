import { describe, expect, test } from "vitest";
import {
  buildBackendColumnFilters,
  compareColumnCellValues,
  hasActiveColumnFilterRule,
  hasActiveColumnFilters,
} from "./columnFilterUtils";

describe("hasActiveColumnFilterRule", () => {
  test("undefined / null rule 回 false", () => {
    expect(hasActiveColumnFilterRule(undefined)).toBe(false);
  });

  test("rule 無 selectedTokens 也無 textQuery 回 false", () => {
    expect(hasActiveColumnFilterRule({})).toBe(false);
    expect(hasActiveColumnFilterRule({ selectedTokens: [] })).toBe(false);
    expect(hasActiveColumnFilterRule({ textQuery: "" })).toBe(false);
    expect(hasActiveColumnFilterRule({ textQuery: "   " })).toBe(false);
  });

  test("有非空的 selectedTokens 回 true", () => {
    expect(hasActiveColumnFilterRule({ selectedTokens: ["a"] })).toBe(true);
  });

  test("有非空白 textQuery 回 true", () => {
    expect(hasActiveColumnFilterRule({ textQuery: "abc" })).toBe(true);
    expect(hasActiveColumnFilterRule({ textQuery: "  abc  " })).toBe(true);
  });

  test("兩者同時有 一樣 true", () => {
    expect(
      hasActiveColumnFilterRule({ selectedTokens: ["a"], textQuery: "abc" })
    ).toBe(true);
  });
});

describe("hasActiveColumnFilters", () => {
  test("空 state 回 false", () => {
    expect(hasActiveColumnFilters({})).toBe(false);
  });

  test("所有 rule 都是 inactive 回 false", () => {
    expect(
      hasActiveColumnFilters({
        a: {},
        b: { selectedTokens: [] },
        c: { textQuery: "" },
      })
    ).toBe(false);
  });

  test("任一 rule 有 active 就回 true", () => {
    expect(
      hasActiveColumnFilters({
        a: {},
        b: { textQuery: "x" },
      })
    ).toBe(true);
  });
});

describe("compareColumnCellValues / number", () => {
  test("兩個數字比大小", () => {
    expect(compareColumnCellValues(1, 2, "number")).toBeLessThan(0);
    expect(compareColumnCellValues(5, 5, "number")).toBe(0);
    expect(compareColumnCellValues(10, 3, "number")).toBeGreaterThan(0);
  });

  test("null 排到最後（asc 視角）", () => {
    expect(compareColumnCellValues(null, 1, "number")).toBeGreaterThan(0);
    expect(compareColumnCellValues(1, null, "number")).toBeLessThan(0);
    expect(compareColumnCellValues(null, null, "number")).toBe(0);
  });

  test("字串數字會被正確 parse", () => {
    expect(compareColumnCellValues("1", "2", "number")).toBeLessThan(0);
    expect(compareColumnCellValues("1,234", "999", "number")).toBeGreaterThan(0);
  });
});

describe("compareColumnCellValues / date", () => {
  test("早的比晚的小", () => {
    expect(compareColumnCellValues("2026-04-01", "2026-04-22", "date")).toBeLessThan(0);
    expect(compareColumnCellValues("2026-04-22", "2026-04-22", "date")).toBe(0);
  });

  test("null 排最後", () => {
    expect(compareColumnCellValues(null, "2026-04-22", "date")).toBeGreaterThan(0);
    expect(compareColumnCellValues("2026-04-22", null, "date")).toBeLessThan(0);
  });

  test("yyyy-mm-dd vs yyyy/mm/dd 結果一致", () => {
    expect(
      compareColumnCellValues("2026-04-22", "2026/04/22", "date")
    ).toBe(0);
  });
});

describe("compareColumnCellValues / boolean", () => {
  test("true > false > null（null 最小）", () => {
    expect(compareColumnCellValues("Yes", "No", "boolean")).toBeGreaterThan(0);
    expect(compareColumnCellValues("No", "Yes", "boolean")).toBeLessThan(0);
    expect(compareColumnCellValues("Yes", "Yes", "boolean")).toBe(0);
  });

  test("unknown 值被當 null（rank = 0，最小）", () => {
    expect(compareColumnCellValues("maybe", "Yes", "boolean")).toBeLessThan(0);
    expect(compareColumnCellValues("maybe", "maybe", "boolean")).toBe(0);
  });

  test("Ragic 中文語意布林（是/否）", () => {
    expect(compareColumnCellValues("是", "否", "boolean")).toBeGreaterThan(0);
  });
});

describe("compareColumnCellValues / text", () => {
  test("依數值感知 alphanumeric 比較", () => {
    expect(compareColumnCellValues("item2", "item10", "text")).toBeLessThan(0);
  });

  test("空值排最後", () => {
    expect(compareColumnCellValues("", "abc", "text")).toBeGreaterThan(0);
    expect(compareColumnCellValues("abc", "", "text")).toBeLessThan(0);
    expect(compareColumnCellValues("", "", "text")).toBe(0);
  });

  test("大小寫不敏感", () => {
    expect(compareColumnCellValues("abc", "ABC", "text")).toBe(0);
  });
});

describe("buildBackendColumnFilters", () => {
  test("空 state 回 undefined（不送空物件）", () => {
    expect(buildBackendColumnFilters({}, {})).toBeUndefined();
  });

  test("所有 rule 都 inactive 回 undefined", () => {
    const result = buildBackendColumnFilters(
      { a: {}, b: { selectedTokens: [] } },
      { a: "text", b: "text" }
    );
    expect(result).toBeUndefined();
  });

  test("active rule 會帶上 type 欄位", () => {
    const result = buildBackendColumnFilters(
      { machineCode: { textQuery: "F7" } },
      { machineCode: "text" }
    );
    expect(result).toEqual({
      machineCode: { type: "text", textQuery: "F7" },
    });
  });

  test("columnTypeMap 沒指定時 fallback 成 text", () => {
    const result = buildBackendColumnFilters(
      { x: { textQuery: "a" } },
      {}
    );
    expect(result?.x?.type).toBe("text");
  });

  test("selectedTokens 過濾掉 falsy 值", () => {
    const result = buildBackendColumnFilters(
      { x: { selectedTokens: ["a", "", "b"] as string[] } },
      { x: "text" }
    );
    expect(result?.x?.selectedTokens).toEqual(["a", "b"]);
  });

  test("textQuery 前後空白會被 trim", () => {
    const result = buildBackendColumnFilters(
      { x: { textQuery: "  hello  " } },
      { x: "text" }
    );
    expect(result?.x?.textQuery).toBe("hello");
  });

  test("excludeColumnKey 會跳過該欄位（用於 facet 查詢時排除自己）", () => {
    const result = buildBackendColumnFilters(
      {
        x: { textQuery: "a" },
        y: { textQuery: "b" },
      },
      { x: "text", y: "text" },
      { excludeColumnKey: "y" }
    );
    expect(result).toEqual({
      x: { type: "text", textQuery: "a" },
    });
  });

  test("同時有 selectedTokens 與 textQuery 兩者都保留", () => {
    const result = buildBackendColumnFilters(
      { x: { selectedTokens: ["a"], textQuery: "hello" } },
      { x: "text" }
    );
    expect(result?.x).toEqual({
      type: "text",
      selectedTokens: ["a"],
      textQuery: "hello",
    });
  });
});

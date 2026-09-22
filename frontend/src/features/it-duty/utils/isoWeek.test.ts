import { describe, expect, test } from "vitest";
import dayjs from "dayjs";
import {
  buildIsoWeekRange,
  currentIsoWeek,
  formatIsoWeek,
  isoWeekDiff,
  parseIsoWeek,
  shiftIsoWeek,
} from "./isoWeek";

describe("formatIsoWeek", () => {
  test("一般日期格式化為 YYYY-Www", () => {
    expect(formatIsoWeek("2026-04-27")).toBe("2026-W18");
  });

  test("跨年週數歸到 ISO 週年（2025-12-29 屬於 2026-W01）", () => {
    expect(formatIsoWeek("2025-12-29")).toBe("2026-W01");
  });
});

describe("parseIsoWeek", () => {
  test("回傳該 ISO 週的週一 00:00 與週日 23:59", () => {
    const range = parseIsoWeek("2026-W18");
    expect(range.start.format("YYYY-MM-DD")).toBe("2026-04-27");
    expect(range.start.day()).toBe(1); // Monday
    expect(range.end.format("YYYY-MM-DD")).toBe("2026-05-03");
  });

  test("壞格式拋錯", () => {
    expect(() => parseIsoWeek("2026-18")).toThrow();
    expect(() => parseIsoWeek("2026-W00")).toThrow();
    expect(() => parseIsoWeek("2026-W54")).toThrow();
  });
});

describe("isoWeekDiff", () => {
  test("正向相鄰週 = 1", () => {
    expect(isoWeekDiff("2026-W19", "2026-W18")).toBe(1);
  });

  test("跨年相鄰", () => {
    expect(isoWeekDiff("2026-W01", "2025-W52")).toBe(1);
  });

  test("相同週 = 0", () => {
    expect(isoWeekDiff("2026-W18", "2026-W18")).toBe(0);
  });

  test("相隔多週", () => {
    expect(isoWeekDiff("2026-W30", "2026-W10")).toBe(20);
  });
});

describe("shiftIsoWeek", () => {
  test("加減週", () => {
    expect(shiftIsoWeek("2026-W18", 1)).toBe("2026-W19");
    expect(shiftIsoWeek("2026-W18", -1)).toBe("2026-W17");
    expect(shiftIsoWeek("2026-W01", -1)).toBe("2025-W52");
  });
});

describe("buildIsoWeekRange", () => {
  test("中心週 + 過去 1 + 未來 2 = 4 週", () => {
    const list = buildIsoWeekRange("2026-W18", 1, 2);
    expect(list).toEqual(["2026-W17", "2026-W18", "2026-W19", "2026-W20"]);
  });
});

describe("currentIsoWeek", () => {
  test("固定日期可正確 derive", () => {
    expect(currentIsoWeek(dayjs("2026-04-27"))).toBe("2026-W18");
  });
});

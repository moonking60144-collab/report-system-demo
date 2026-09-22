import { afterEach, describe, expect, it, vi } from "vitest";
import { lastMonthInfo } from "./exportDownload";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("lastMonthInfo", () => {
  it("在 6 月時計算上一個月為 5 月", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 10, 12, 0, 0));

    expect(lastMonthInfo()).toEqual({
      label: "2026-05",
      year: 2026,
      month: 5,
      weekdays: 21,
    });
  });

  it("在 1 月時計算上一個月為前一年 12 月", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 10, 12, 0, 0));

    expect(lastMonthInfo()).toEqual({
      label: "2025-12",
      year: 2025,
      month: 12,
      weekdays: 23,
    });
  });

  it("以 Asia/Taipei 判斷跨月且 weekdays 不讀 browser-local timezone", () => {
    vi.spyOn(Date.prototype, "getFullYear").mockImplementation(() => {
      throw new Error("不應讀 browser-local year");
    });
    vi.spyOn(Date.prototype, "getMonth").mockImplementation(() => {
      throw new Error("不應讀 browser-local month");
    });
    vi.spyOn(Date.prototype, "getDate").mockImplementation(() => {
      throw new Error("不應讀 browser-local date");
    });
    vi.spyOn(Date.prototype, "getDay").mockImplementation(() => {
      throw new Error("不應讀 browser-local weekday");
    });

    expect(lastMonthInfo(new Date("2026-05-31T16:30:00.000Z"))).toEqual({
      label: "2026-05",
      year: 2026,
      month: 5,
      weekdays: 21,
    });
  });
});

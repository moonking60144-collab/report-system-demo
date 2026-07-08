import { afterEach, describe, expect, it, vi } from "vitest";
import { lastMonthInfo } from "./exportDownload";

afterEach(() => {
  vi.useRealTimers();
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
});

import { describe, expect, test } from "vitest";
import { maskTimeInputResult, to24HourTime, formatTimeDisplay } from "./timeUtils";

describe("maskTimeInputResult — 無 colon 的 digit-only 快速輸入", () => {
  test("空字串回空字串", () => {
    expect(maskTimeInputResult("")).toEqual({ value: "", invalidAttempt: false });
  });

  test("1 或 2 碼直接回原值（等使用者繼續輸入）", () => {
    expect(maskTimeInputResult("0").value).toBe("0");
    expect(maskTimeInputResult("08").value).toBe("08");
  });

  test("4 碼合法時間自動轉 HH:MM", () => {
    expect(maskTimeInputResult("0830").value).toBe("08:30");
    expect(maskTimeInputResult("1700").value).toBe("17:00");
    expect(maskTimeInputResult("2359").value).toBe("23:59");
  });

  test("3 碼組成部分 HH:M 格式", () => {
    expect(maskTimeInputResult("083").value).toBe("08:3");
    expect(maskTimeInputResult("175").value).toBe("17:5");
  });

  test("非數字字元被濾掉", () => {
    expect(maskTimeInputResult("abc0830").value).toBe("08:30");
  });
});

describe("maskTimeInputResult — 帶 colon 的手動編輯", () => {
  test("完整 HH:MM 保留原樣（可編輯友善）", () => {
    expect(maskTimeInputResult("17:00").value).toBe("17:00");
    expect(maskTimeInputResult("08:30").value).toBe("08:30");
  });

  test("使用者中間 backspace 刪掉小時最後一碼，保留 HH: 狀態不退化", () => {
    // 原本 "17:00" 中間刪掉 7 → raw "1:00"
    // 舊版會 strip ":" 變 "100" → 重組成 "10:0"（反直覺）
    // 新版應該尊重既有 colon，回 "1:00"
    expect(maskTimeInputResult("1:00").value).toBe("1:00");
  });

  test("半打字狀態 HH: 保留（讓使用者繼續打分鐘）", () => {
    expect(maskTimeInputResult("17:").value).toBe("17:");
    expect(maskTimeInputResult("8:").value).toBe("8:");
  });

  test("半打字狀態 HH:M 保留", () => {
    expect(maskTimeInputResult("17:3").value).toBe("17:3");
    expect(maskTimeInputResult("08:4").value).toBe("08:4");
  });

  test("只有 colon 保留", () => {
    expect(maskTimeInputResult(":").value).toBe(":");
  });

  test("小時超出範圍標示 invalidAttempt 但保留輸入", () => {
    const result = maskTimeInputResult("25:00");
    expect(result.value).toBe("25:00");
    expect(result.invalidAttempt).toBe(true);
  });

  test("分鐘超出範圍標示 invalidAttempt 但保留輸入", () => {
    const result = maskTimeInputResult("12:70");
    expect(result.value).toBe("12:70");
    expect(result.invalidAttempt).toBe(true);
  });

  test("合法 HH:MM 不標 invalidAttempt", () => {
    expect(maskTimeInputResult("17:00").invalidAttempt).toBe(false);
    expect(maskTimeInputResult("23:59").invalidAttempt).toBe(false);
    expect(maskTimeInputResult("00:00").invalidAttempt).toBe(false);
  });
});

describe("to24HourTime", () => {
  test("已是 HH:mm 格式 pad 到兩位數", () => {
    expect(to24HourTime("8:30")).toBe("08:30");
    expect(to24HourTime("17:00")).toBe("17:00");
  });

  test("含秒數自動刪掉", () => {
    expect(to24HourTime("08:30:45")).toBe("08:30");
  });

  test("上午/下午 marker 轉 24 小時制", () => {
    expect(to24HourTime("下午 4:30")).toBe("16:30");
    expect(to24HourTime("上午 12:00")).toBe("00:00");
    expect(to24HourTime("pm 3:15")).toBe("15:15");
    expect(to24HourTime("AM 6:45")).toBe("06:45");
  });

  test("空值回空字串", () => {
    expect(to24HourTime(null)).toBe("");
    expect(to24HourTime(undefined)).toBe("");
    expect(to24HourTime("")).toBe("");
    expect(to24HourTime("   ")).toBe("");
  });

  test("無法辨識的字串回空字串", () => {
    expect(to24HourTime("random")).toBe("");
  });
});

describe("formatTimeDisplay", () => {
  test("可解析時 normalize", () => {
    expect(formatTimeDisplay("8:30")).toBe("08:30");
  });

  test("不可解析時 fallback 原字串 trim", () => {
    expect(formatTimeDisplay("  foo  ")).toBe("foo");
  });

  test("空值回空字串", () => {
    expect(formatTimeDisplay(null)).toBe("");
    expect(formatTimeDisplay(undefined)).toBe("");
  });
});

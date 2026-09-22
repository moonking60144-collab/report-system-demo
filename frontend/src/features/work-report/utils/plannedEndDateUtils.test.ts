import { describe, expect, it } from "vitest";
import {
  formatPlannedEndDateDisplay,
  normalizePlannedEndDate,
} from "./plannedEndDateUtils";

describe("plannedEndDateUtils", () => {
  it("把 Ragic 與 input 日期收斂成 canonical value", () => {
    expect(normalizePlannedEndDate("2026/9/5")).toBe("2026-09-05");
    expect(normalizePlannedEndDate("2026-09-05")).toBe("2026-09-05");
  });

  it("拒絕不存在日期並固定列表顯示格式", () => {
    expect(normalizePlannedEndDate("2026-02-30")).toBeNull();
    expect(formatPlannedEndDateDisplay("2026-09-05")).toBe("2026/09/05");
    expect(formatPlannedEndDateDisplay("2026/09/05")).toBe("2026/09/05");
  });
});

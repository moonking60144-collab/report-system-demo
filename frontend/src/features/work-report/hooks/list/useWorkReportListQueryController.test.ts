import { describe, expect, it } from "vitest";
import {
  areColumnSortRulesServerSupported,
  isServerSupportedWorkReportColumn,
} from "./useWorkReportListQueryController";

describe("work report server preview capabilities", () => {
  it("精確欄位與原本未支援的排序欄位都由 server preview 接手", () => {
    expect(isServerSupportedWorkReportColumn("previousMachine")).toBe(true);
    expect(isServerSupportedWorkReportColumn("estimatedHours")).toBe(true);
    expect(
      areColumnSortRulesServerSupported([
        { key: "estimatedHours", direction: "desc", type: "number" },
        { key: "previousMachine", direction: "asc", type: "text" },
      ])
    ).toBe(true);
  });

  it("unknown 欄位不會被送進 backend SQL contract", () => {
    expect(isServerSupportedWorkReportColumn("unknownColumn")).toBe(false);
    expect(
      areColumnSortRulesServerSupported([
        { key: "unknownColumn", direction: "asc", type: "text" },
      ])
    ).toBe(false);
  });
});

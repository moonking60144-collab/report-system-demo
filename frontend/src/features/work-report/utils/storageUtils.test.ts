import { afterEach, describe, expect, it, vi } from "vitest";
import { WORK_REPORT_COLUMN_MODE_STORAGE_KEY } from "../constants";
import {
  createDefaultWorkReportTableLayout,
  readColumnDisplayMode,
  reconcileWorkReportTableLayout,
} from "./storageUtils";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("work report table layout preferences", () => {
  it("新欄位會附加、已刪欄位會移除，且保留合法順序與色票", () => {
    const result = reconcileWorkReportTableLayout(
      {
        version: 2,
        hiddenColumnKeys: ["machineCode", "removed"],
        columnOrder: ["customerPartNo", "removed", "workOrderNo"],
        columnWidths: {
          customerPartNo: 180,
          removed: 200,
          machineCode: 20,
        },
        columnColors: {
          customerPartNo: "amber-soft",
          machineCode: "invalid-color",
          removed: "blue-soft",
        },
      },
      ["workOrderNo", "machineCode", "customerPartNo", "pendingQty"]
    );

    expect(result).toEqual({
      version: 2,
      hiddenColumnKeys: ["machineCode"],
      columnOrder: ["customerPartNo", "workOrderNo", "machineCode", "pendingQty"],
      columnWidths: { customerPartNo: 180 },
      columnColors: { customerPartNo: "amber-soft" },
    });
  });

  it("沒有 v2 設定時沿用既有隱藏欄位與欄寬", () => {
    const result = reconcileWorkReportTableLayout(
      null,
      ["workOrderNo", "machineCode"],
      {
        hiddenColumnKeys: ["machineCode", "removed"],
        columnWidths: { workOrderNo: 168, removed: 200 },
      }
    );

    expect(result).toEqual({
      version: 2,
      hiddenColumnKeys: ["machineCode"],
      columnOrder: ["workOrderNo", "machineCode"],
      columnWidths: { workOrderNo: 168 },
      columnColors: {},
    });
  });

  it("預設版面維持欄位定義順序", () => {
    expect(createDefaultWorkReportTableLayout(["a", "b", "c"])).toEqual({
      version: 2,
      hiddenColumnKeys: [],
      columnOrder: ["a", "b", "c"],
      columnWidths: {},
      columnColors: {},
    });
  });

  it("舊版 full 欄位模式會遷移成 fit", () => {
    const setItem = vi.fn();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn(() => "full"),
        setItem,
      },
    });

    expect(readColumnDisplayMode()).toBe("fit");
    expect(setItem).toHaveBeenCalledWith(
      WORK_REPORT_COLUMN_MODE_STORAGE_KEY,
      "fit"
    );
  });
});

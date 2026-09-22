import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HYDRATION_CACHE_MAX_RECORDS,
  WORK_REPORT_COLUMN_MODE_STORAGE_KEY,
} from "../constants";
import {
  createDefaultWorkReportTableLayout,
  getHydrationCacheKey,
  readColumnDisplayMode,
  reconcileWorkReportTableLayout,
  writeHydrationCache,
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

  it("舊預設順序會把新欄位插回目前定義位置", () => {
    const result = reconcileWorkReportTableLayout(
      {
        version: 2,
        hiddenColumnKeys: [],
        columnOrder: ["workOrderNo", "machineCode", "customerPartNo"],
        columnWidths: { machineCode: 96 },
        columnColors: {},
      },
      ["workOrderNo", "machineCode", "previousMachine", "customerPartNo"]
    );

    expect(result.columnOrder).toEqual([
      "workOrderNo",
      "machineCode",
      "previousMachine",
      "customerPartNo",
    ]);
    expect(result.columnWidths).toEqual({ machineCode: 96 });
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

  it("未設定欄位模式時預設使用 fit，既有 compact 偏好仍保留", () => {
    const getItem = vi.fn(() => null as string | null);
    vi.stubGlobal("window", {
      localStorage: {
        getItem,
        setItem: vi.fn(),
      },
    });

    expect(readColumnDisplayMode()).toBe("fit");

    getItem.mockReturnValue("compact");
    expect(readColumnDisplayMode()).toBe("compact");
  });
});

describe("work report hydration cache budget", () => {
  it("大型 full dataset 不做同步 JSON/localStorage 寫入，並清除舊快取", () => {
    const setItem = vi.fn();
    const removeItem = vi.fn();
    vi.stubGlobal("window", {
      localStorage: {
        setItem,
        removeItem,
      },
    });
    const records = Array.from(
      { length: HYDRATION_CACHE_MAX_RECORDS + 1 },
      (_unused, index) => ({
        id: String(index + 1),
        workOrderNo: null,
        status: null,
        customerPartNo: null,
        erpPartNo: null,
        reports: [],
      })
    );

    writeHydrationCache("902", records);

    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).toHaveBeenCalledWith(getHydrationCacheKey("902"));
  });

  it("bounded dataset 仍保留 local fallback cache", () => {
    const setItem = vi.fn();
    vi.stubGlobal("window", {
      localStorage: {
        setItem,
        removeItem: vi.fn(),
      },
    });

    writeHydrationCache("901", [{
      id: "E-901",
      workOrderNo: null,
      status: null,
      customerPartNo: null,
      erpPartNo: null,
      reports: [],
    }]);

    expect(setItem).toHaveBeenCalledOnce();
  });
});

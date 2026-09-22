import { describe, expect, test } from "vitest";
import {
  resolveLatestWorkOrderProductionProgress,
  resolveWorkOrderProductionProgress,
} from "./workOrderProductionProgress";

describe("resolveWorkOrderProductionProgress", () => {
  test("累計量低於目標量時回傳尚未達標與差額", () => {
    expect(resolveWorkOrderProductionProgress("17,647", "75,000")).toEqual({
      status: "below-target",
      cumulativeQty: 17647,
      targetQty: 75000,
      shortfallQty: 57353,
      progressPercent: (17647 / 75000) * 100,
    });
  });

  test("累計量等於或超過目標量時回傳已達標", () => {
    expect(resolveWorkOrderProductionProgress(100, 100).status).toBe("target-met");
    expect(resolveWorkOrderProductionProgress(120, 100)).toMatchObject({
      status: "target-met",
      shortfallQty: 0,
      progressPercent: 100,
    });
  });

  test("目標量缺失時不做達標判斷", () => {
    expect(resolveWorkOrderProductionProgress(100, null).status).toBe("unavailable");
  });
});

describe("resolveLatestWorkOrderProductionProgress", () => {
  test("依 rowId 取最後一列實際累計量，不依 API 陣列順序誤判", () => {
    const progress = resolveLatestWorkOrderProductionProgress(
      [
        { rowId: "30", cumulativeQty: 90 },
        { rowId: "10", cumulativeQty: 30 },
        { rowId: "20", cumulativeQty: 60 },
      ],
      100
    );

    expect(progress).toMatchObject({
      status: "below-target",
      cumulativeQty: 90,
      shortfallQty: 10,
    });
  });

  test("最新一列累計量缺失時不退回舊列數值", () => {
    const progress = resolveLatestWorkOrderProductionProgress(
      [
        { rowId: "10", cumulativeQty: 100 },
        { rowId: "20", cumulativeQty: null },
      ],
      100
    );

    expect(progress).toMatchObject({
      status: "unavailable",
      cumulativeQty: null,
      shortfallQty: null,
    });
  });

  test("沒有明細或所有累計量缺失時不會把未知值誤報為 0", () => {
    expect(resolveLatestWorkOrderProductionProgress([], 100).status).toBe(
      "unavailable"
    );
    expect(
      resolveLatestWorkOrderProductionProgress(
        [{ rowId: "10", cumulativeQty: null }],
        100
      )
    ).toMatchObject({
      status: "unavailable",
      cumulativeQty: null,
    });
  });
});

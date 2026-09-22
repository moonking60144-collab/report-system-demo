import { describe, expect, it } from "vitest";
import {
  getDefaultWorkReportPrintColumnKeys,
  getWorkReportPrintColumnStorageKey,
  getWorkReportPrintColumnWidthWeights,
  getWorkReportPrintColumnWidths,
  loadWorkReportPrintColumnKeys,
  normalizeWorkReportPrintColumnPreference,
  resetWorkReportPrintColumnKeys,
  saveWorkReportPrintColumnKeys,
} from "./workReportPrintColumns";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("workReportPrintColumns", () => {
  it("預設顯示上一站機台與內製委外，隱藏目前使用來料", () => {
    const defaults = getDefaultWorkReportPrintColumnKeys("901");

    expect(defaults).toContain("previousMachine");
    expect(defaults).toContain("workOrderType");
    expect(defaults).not.toContain("currentMaterial");
  });

  it("901 與 902 分開保存，重設後回到各自預設", () => {
    const storage = new MemoryStorage();
    saveWorkReportPrintColumnKeys("901", ["workOrderNo", "currentMaterial"], storage);
    saveWorkReportPrintColumnKeys("902", ["workOrderNo", "status"], storage);

    expect(loadWorkReportPrintColumnKeys("901", storage)).toEqual([
      "workOrderNo",
      "currentMaterial",
    ]);
    expect(loadWorkReportPrintColumnKeys("902", storage)).toEqual([
      "workOrderNo",
      "status",
    ]);
    expect(getWorkReportPrintColumnStorageKey("901")).not.toBe(
      getWorkReportPrintColumnStorageKey("902")
    );

    expect(resetWorkReportPrintColumnKeys("901", storage)).toEqual(
      getDefaultWorkReportPrintColumnKeys("901")
    );
    expect(loadWorkReportPrintColumnKeys("901", storage)).toEqual(
      getDefaultWorkReportPrintColumnKeys("901")
    );
  });

  it("舊偏好會自動補入後來新增且預設顯示的欄位", () => {
    const normalized = normalizeWorkReportPrintColumnPreference("901", {
      version: 1,
      visibleColumnKeys: ["workOrderNo"],
      knownColumnKeys: ["workOrderNo", "currentMaterial"],
    });

    expect(normalized).toContain("workOrderNo");
    expect(normalized).toContain("previousMachine");
    expect(normalized).toContain("workOrderType");
    expect(normalized).not.toContain("currentMaterial");
  });

  it("排序與急件比前置母件窄，且可見欄寬合計為 100%", () => {
    const visibleKeys = getDefaultWorkReportPrintColumnKeys("901");
    const widths = getWorkReportPrintColumnWidths("901", visibleKeys);

    expect(widths.get("sortOrder")).toBeLessThan(widths.get("forgingMother") ?? 0);
    expect(widths.get("urgent")).toBeLessThan(widths.get("forgingMother") ?? 0);
    expect(
      [...widths.values()].reduce((total, width) => total + width, 0)
    ).toBeCloseTo(100, 8);
  });

  it("依實際內容平衡所有欄位，短機台碼不會佔用前置母件的寬度", () => {
    const weights = getWorkReportPrintColumnWidthWeights(
      "901",
      [
        {
          id: "1",
          workOrderNo: "DEMO-050578",
          status: "未結案",
          customerPartNo: null,
          erpPartNo: null,
          forgingMother: "DEMO-PART-002",
          previousMachine: "MB21",
          currentMaterial: "A",
        },
      ],
      "zh"
    );

    expect(weights.get("previousMachine")).toBeLessThan(
      weights.get("forgingMother") ?? 0
    );
    expect(weights.get("previousMachine")).toBeLessThan(
      weights.get("workOrderNo") ?? 0
    );
  });

  it("同一套 helper 會讓其他長內容欄位取得更多寬度", () => {
    const shortWeights = getWorkReportPrintColumnWidthWeights(
      "901",
      [
        {
          id: "1",
          workOrderNo: "WO-1",
          status: "未結案",
          customerPartNo: null,
          erpPartNo: null,
          currentMaterial: "A",
        },
      ],
      "zh"
    );
    const longWeights = getWorkReportPrintColumnWidthWeights(
      "901",
      [
        {
          id: "1",
          workOrderNo: "WO-1",
          status: "未結案",
          customerPartNo: null,
          erpPartNo: null,
          currentMaterial: "DEMO-LONG-PART-PRINT-001",
        },
      ],
      "zh"
    );

    expect(longWeights.get("currentMaterial")).toBeGreaterThan(
      shortWeights.get("currentMaterial") ?? 0
    );
  });
});

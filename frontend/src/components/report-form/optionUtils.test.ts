import { describe, expect, test } from "vitest";
import type { FormOptionItem } from "../../api/workReport";
import {
  buildMachineStatusSuffix,
  decorateMachineOptionLabel,
  filterActiveMachineOptionsWithCurrentValue,
  isActiveMachineOption,
  withCurrentValue,
} from "./optionUtils";

function makeMachineOption(
  value: string,
  status: string | undefined,
  label?: string
): FormOptionItem {
  return {
    value,
    label: label ?? `${value} - ${value}Process A Machine`,
    display: label ?? `${value} - ${value}Process A Machine`,
    machineDefault: status
      ? {
          machineCode: value,
          status,
        }
      : undefined,
  };
}

describe("filterActiveMachineOptionsWithCurrentValue", () => {
  const inUse1 = makeMachineOption("P10", "使用中");
  const inUse2 = makeMachineOption("P20", "使用中");
  const retired = makeMachineOption("P30", "報廢");
  const sold = makeMachineOption("P40", "售出");
  const noStatus = makeMachineOption("P50", undefined);

  test("僅保留狀態為「使用中」的機台；無狀態視為可選（防禦性）", () => {
    const result = filterActiveMachineOptionsWithCurrentValue(
      [inUse1, retired, sold, noStatus, inUse2],
      ""
    );
    expect(result.map((o) => o.value)).toEqual(["P10", "P50", "P20"]);
  });

  test("當前值為使用中時不動清單", () => {
    const result = filterActiveMachineOptionsWithCurrentValue([inUse1, retired, inUse2], "P20");
    expect(result.map((o) => o.value)).toEqual(["P10", "P20"]);
  });

  test("當前值為報廢時，補回清單頂部並加 status suffix 到 label 跟 display", () => {
    const result = filterActiveMachineOptionsWithCurrentValue([inUse1, retired, inUse2], "P30");
    expect(result.map((o) => o.value)).toEqual(["P30", "P10", "P20"]);
    expect(result[0]?.label).toBe("P30 - P30Process A Machine（報廢）");
    expect(result[0]?.display).toBe("P30 - P30Process A Machine（報廢）");
  });

  test("當前值為售出時也加 status suffix 到兩個欄位", () => {
    const result = filterActiveMachineOptionsWithCurrentValue([inUse1, sold], "P40");
    expect(result[0]?.label).toBe("P40 - P40Process A Machine（售出）");
    expect(result[0]?.display).toBe("P40 - P40Process A Machine（售出）");
  });

  test("當前值空字串時不補位", () => {
    const result = filterActiveMachineOptionsWithCurrentValue([inUse1, retired], "   ");
    expect(result.map((o) => o.value)).toEqual(["P10"]);
  });

  test("當前值不在原始清單中，fallback 用純字串 token 補位（罕見情境）", () => {
    const result = filterActiveMachineOptionsWithCurrentValue([inUse1], "PXX");
    expect(result[0]).toEqual({ value: "PXX", label: "PXX", display: "PXX" });
    expect(result[1]?.value).toBe("P10");
  });

  test("options undefined 時不爆，單純用當前值 fallback 或回空陣列", () => {
    expect(filterActiveMachineOptionsWithCurrentValue(undefined, "")).toEqual([]);
    const withCurrent = filterActiveMachineOptionsWithCurrentValue(undefined, "P10");
    expect(withCurrent).toEqual([{ value: "P10", label: "P10", display: "P10" }]);
  });

  test("status 欄有前後空白也照樣比對成功", () => {
    const spaced = makeMachineOption("P60", "  使用中  ");
    const result = filterActiveMachineOptionsWithCurrentValue([spaced], "");
    expect(result.map((o) => o.value)).toEqual(["P60"]);
  });
});

describe("buildMachineStatusSuffix", () => {
  test("使用中 / 無狀態回空字串（單一 source of truth）", () => {
    expect(buildMachineStatusSuffix({
      value: "P10",
      label: "P10",
      display: "P10",
      machineDefault: { machineCode: "P10", status: "使用中" },
    })).toBe("");
    expect(buildMachineStatusSuffix({ value: "P10", label: "P10", display: "P10" })).toBe("");
  });

  test("報廢 / 售出 回「（xxx）」", () => {
    expect(buildMachineStatusSuffix({
      value: "P30",
      label: "P30",
      display: "P30",
      machineDefault: { machineCode: "P30", status: "報廢" },
    })).toBe("（報廢）");
    expect(buildMachineStatusSuffix({
      value: "P40",
      label: "P40",
      display: "P40",
      machineDefault: { machineCode: "P40", status: "售出" },
    })).toBe("（售出）");
  });
});

describe("decorateMachineOptionLabel", () => {
  test("使用中 / 無狀態回原 label", () => {
    expect(decorateMachineOptionLabel(makeMachineOption("P10", "使用中"))).toBe(
      "P10 - P10Process A Machine"
    );
    expect(decorateMachineOptionLabel(makeMachineOption("P10", undefined))).toBe(
      "P10 - P10Process A Machine"
    );
  });

  test("非使用中加「（狀態）」suffix", () => {
    expect(decorateMachineOptionLabel(makeMachineOption("P30", "報廢"))).toBe(
      "P30 - P30Process A Machine（報廢）"
    );
  });
});

describe("isActiveMachineOption", () => {
  test("使用中 / 無狀態 / null 資料都視為 active（防禦性 - null 回 false 不過濾光）", () => {
    expect(isActiveMachineOption(makeMachineOption("P10", "使用中"))).toBe(true);
    expect(isActiveMachineOption(makeMachineOption("P10", undefined))).toBe(true);
    expect(isActiveMachineOption(null)).toBe(false);
    expect(isActiveMachineOption(undefined)).toBe(false);
  });

  test("報廢 / 售出回 false", () => {
    expect(isActiveMachineOption(makeMachineOption("P30", "報廢"))).toBe(false);
    expect(isActiveMachineOption(makeMachineOption("P40", "售出"))).toBe(false);
  });
});

describe("withCurrentValue（現有行為保留）", () => {
  test("當前值不在清單則補到頂", () => {
    const result = withCurrentValue([{ value: "a", label: "A", display: "A" }], "b");
    expect(result).toEqual([
      { value: "b", label: "b", display: "b" },
      { value: "a", label: "A", display: "A" },
    ]);
  });

  test("當前值已在清單則不動", () => {
    const options = [{ value: "a", label: "A", display: "A" }];
    const result = withCurrentValue(options, "a");
    expect(result).toBe(options);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_FORM } from "./constants";
import {
  applyCreateDefaultsToFormState,
  buildInitialFormState,
} from "./formMemory";
import type { FormOptionItem, WorkReportItem, WorkReportRecord } from "../../api/workReport";

const machineOptions: FormOptionItem[] = [
  {
    value: "R3",
    label: "R3 - 滾牙機",
    display: "滾牙機",
    machineDefault: {
      machineCode: "R3",
      processCategoryCode: "TI",
      processCategoryName: "搓牙",
      processCode: "TI02",
      status: "使用中",
    },
  },
];

const entryContext: WorkReportRecord = {
  id: "31524",
  workOrderNo: "WO-26060522",
  machineCode: "R3",
  defaultProcessCode: "",
  prodType: "TI",
  processName: "TI搓牙",
  status: "未結案",
  customerPartNo: "VN-22353-HR6A-A602-H",
  erpPartNo: null,
  reports: [],
};

const lastReport: WorkReportItem = {
  rowId: "999999",
  date: "2026-07-15",
  plannedIdle: "No",
  processCode: "LAST-PROCESS",
  processCodeDisplay: "上一筆製程",
  machineId: "LAST-MACHINE",
  machineIdDisplay: "上一筆機台",
  operatorId: "LAST-OPERATOR",
  operatorIdDisplay: "上一筆操作員",
  operatorName: "上一筆操作員",
  inputOptions: "整天",
  shiftType: "正常班Reg",
  startTime: "08:00",
  endTime: "17:00",
  breakTime: "1",
  totalWorkTime: "8",
  productionQty: "10",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("formMemory", () => {
  it("工令子製程空白時用機台主檔補初始 processCode", () => {
    const state = buildInitialFormState(
      "create",
      null,
      entryContext,
      machineOptions
    );

    expect(state.machineId).toBe("R3");
    expect(state.processCode).toBe("TI02");
    expect(state.reportType).toBe("TI搓牙");
  });

  it("既有新增草稿 processCode 空白時補回機台預設", () => {
    const state = applyCreateDefaultsToFormState(
      {
        ...EMPTY_FORM,
        date: "2026/07/01",
        machineId: "R3",
        operatorId: "FD1015",
        startTime: "08:00",
        endTime: "17:00",
        productionQty: "10",
      },
      entryContext,
      machineOptions,
      []
    );

    expect(state.processCode).toBe("TI02");
    expect(state.reportType).toBe("TI搓牙");
  });

  it("新增預設只讀工令源頭，不沿用舊 session 或最後一筆報工", () => {
    const getItem = vi.fn(() =>
      JSON.stringify({
        machineId: "LEGACY-MACHINE",
        operatorId: "LEGACY-OPERATOR",
        processCode: "LEGACY-PROCESS",
      })
    );
    vi.stubGlobal("window", {
      sessionStorage: { getItem },
    });
    const sourceContext: WorkReportRecord = {
      ...entryContext,
      reports: [lastReport],
    };

    const state = buildInitialFormState(
      "create",
      null,
      sourceContext,
      machineOptions
    );

    expect(getItem).not.toHaveBeenCalled();
    expect(state.machineId).toBe("R3");
    expect(state.processCode).toBe("TI02");
    expect(state.reportType).toBe("TI搓牙");
    expect(state.operatorId).toBe("");
    expect(state.operatorName).toBe("");
  });

  it("送出前補值也只採用工令源頭，不從最後一筆報工補操作員", () => {
    const sourceContext: WorkReportRecord = {
      ...entryContext,
      reports: [lastReport],
    };

    const state = applyCreateDefaultsToFormState(
      {
        ...EMPTY_FORM,
        date: "2026/07/15",
        startTime: "08:00",
        endTime: "17:00",
        productionQty: "10",
      },
      sourceContext,
      machineOptions,
      []
    );

    expect(state.machineId).toBe("R3");
    expect(state.processCode).toBe("TI02");
    expect(state.reportType).toBe("TI搓牙");
    expect(state.operatorId).toBe("");
    expect(state.operatorName).toBe("");
  });
});

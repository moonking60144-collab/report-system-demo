import { describe, expect, it } from "vitest";
import { EMPTY_FORM } from "./constants";
import {
  applyCreateDefaultsToFormState,
  buildInitialFormState,
} from "./formMemory";
import type { FormOptionItem, WorkReportRecord } from "../../api/workReport";

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

describe("formMemory", () => {
  it("工令子製程空白時用機台主檔補初始 processCode", () => {
    const state = buildInitialFormState(
      "104",
      "create",
      null,
      entryContext,
      machineOptions,
      []
    );

    expect(state.machineId).toBe("R3");
    expect(state.processCode).toBe("TI02");
    expect(state.reportType).toBe("TI搓牙");
  });

  it("既有新增草稿 processCode 空白時補回機台預設", () => {
    const state = applyCreateDefaultsToFormState(
      "104",
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
});

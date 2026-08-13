import { describe, expect, test } from "vitest";
import type { WorkReportRecord } from "../../../../api/workReport";
import { resolveEditableMainMachineCode } from "./useWorkReportMainMachineController";

function makeRecord(
  values: Pick<WorkReportRecord, "machineCode" | "filterMachineCode">
): WorkReportRecord {
  return {
    id: "entry-1",
    workOrderNo: "WO-1",
    status: "",
    customerPartNo: "",
    erpPartNo: "",
    ...values,
  };
}

describe("resolveEditableMainMachineCode", () => {
  test("Form 105 使用內製指定機台，不使用 MIS 車欄位", () => {
    const record = makeRecord({
      machineCode: "MIS-01",
      filterMachineCode: "P10",
    });

    expect(resolveEditableMainMachineCode("105", record)).toBe("P10");
  });

  test("Form 105 內製指定機台為空時不 fallback 到 MIS 車欄位", () => {
    const record = makeRecord({
      machineCode: "MIS-01",
      filterMachineCode: "",
    });

    expect(resolveEditableMainMachineCode("105", record)).toBe("");
  });

  test("Form 104 維持使用 machineCode", () => {
    const record = makeRecord({
      machineCode: "TI01",
      filterMachineCode: "FILTER-IGNORED",
    });

    expect(resolveEditableMainMachineCode("104", record)).toBe("TI01");
  });
});

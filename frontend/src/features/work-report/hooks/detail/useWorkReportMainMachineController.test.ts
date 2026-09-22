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
  test("Form 902 使用內製指定機台，不使用 上游機台欄位", () => {
    const record = makeRecord({
      machineCode: "UPSTREAM-01",
      filterMachineCode: "MB50",
    });

    expect(resolveEditableMainMachineCode("902", record)).toBe("MB50");
  });

  test("Form 902 內製指定機台為空時不 fallback 到 上游機台欄位", () => {
    const record = makeRecord({
      machineCode: "UPSTREAM-01",
      filterMachineCode: "",
    });

    expect(resolveEditableMainMachineCode("902", record)).toBe("");
  });

  test("Form 901 維持使用 machineCode", () => {
    const record = makeRecord({
      machineCode: "A01",
      filterMachineCode: "FILTER-IGNORED",
    });

    expect(resolveEditableMainMachineCode("901", record)).toBe("A01");
  });
});

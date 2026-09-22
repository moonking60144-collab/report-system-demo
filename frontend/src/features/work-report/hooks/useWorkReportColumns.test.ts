import { describe, expect, it } from "vitest";
import type { WorkReportEntryFieldMutationOperation } from "../types";
import {
  getWorkReportColumnInteractionKey,
  isWorkReportEntryFieldColumnSyncing,
} from "./useWorkReportColumns";

describe("isWorkReportEntryFieldColumnSyncing", () => {
  it("urgent pending 不會讓機台、排序、日期或開始排程顯示同步中", () => {
    const syncingEntryIdsByOperation: ReadonlyMap<
      WorkReportEntryFieldMutationOperation,
      ReadonlySet<string>
    > = new Map([["work-report-urgent", new Set(["E-URGENT"])]]);

    expect(
      isWorkReportEntryFieldColumnSyncing(
        syncingEntryIdsByOperation,
        "urgent",
        "E-URGENT"
      )
    ).toBe(true);
    for (const columnKey of [
      "machineCode",
      "sortOrder",
      "plannedEndDate",
      "startSchedule",
    ] as const) {
      expect(
        isWorkReportEntryFieldColumnSyncing(
          syncingEntryIdsByOperation,
          columnKey,
          "E-URGENT"
        )
      ).toBe(false);
    }
  });
});

describe("getWorkReportColumnInteractionKey", () => {
  it("902 本站機台欄的篩選與排序使用 filterMachineCode", () => {
    expect(getWorkReportColumnInteractionKey("902", "machineCode")).toBe(
      "filterMachineCode"
    );
    expect(getWorkReportColumnInteractionKey("901", "machineCode")).toBe("machineCode");
  });
});

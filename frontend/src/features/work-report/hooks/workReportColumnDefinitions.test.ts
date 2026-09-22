import { describe, expect, it } from "vitest";
import {
  buildFormAwareColumns,
  getSelectableWorkReportColumns,
} from "./workReportColumnDefinitions";
import { getColumnHeaderLocaleText } from "../utils/columnFacetUtils";

function getColumns(formId: "901" | "902", mode: "compact" | "fit") {
  return buildFormAwareColumns({
    currentFormId: formId,
    columnDisplayMode: mode,
    renderValue: () => null,
    renderMachineValue: () => null,
    renderPreviousMachineValue: () => null,
    renderWorkOrderValue: () => null,
    renderSortOrderValue: () => null,
    renderPlannedEndDateValue: () => null,
    renderStartSchedule: () => null,
    renderUrgent: () => null,
    renderCheck: () => null,
    toNumber: () => 0,
    toDateValue: () => 0,
  });
}

function getColumnKeys(formId: "901" | "902", mode: "compact" | "fit"): string[] {
  return getColumns(formId, mode).flatMap((column) =>
    "dataIndex" in column && typeof column.dataIndex === "string"
      ? [column.dataIndex]
      : []
  );
}

describe("workReportColumnDefinitions", () => {
  it.each(["901", "902"] as const)(
    "Form %s compact 列表預設顯示上一站機台",
    (formId) => {
      const columnKeys = getColumnKeys(formId, "compact");
      const selectableColumns = getSelectableWorkReportColumns(formId, "compact");

      expect(columnKeys).toContain("previousMachine");
      expect(selectableColumns).toContainEqual({
        key: "previousMachine",
        label: "上一站機台",
      });
      expect(selectableColumns).toContainEqual({
        key: "machineCode",
        label: "本站機台",
      });
    }
  );

  it("上一站機台位於目前機台之後，並在 901/902 fit 列表保留", () => {
    for (const formId of ["901", "902"] as const) {
      const columnKeys = getColumnKeys(formId, "fit");

      expect(columnKeys).toContain("previousMachine");
      expect(columnKeys.indexOf("previousMachine")).toBeGreaterThan(
        columnKeys.indexOf("machineCode")
      );
      expect(columnKeys.indexOf("previousMachine")).toBeLessThan(
        columnKeys.indexOf("forgingMother")
      );
    }
  });

  it("902 沿用 901 的主識別欄順序，只替換表單專屬狀態與日期欄", () => {
    const form901Keys = getColumnKeys("901", "fit");
    const form902Keys = getColumnKeys("902", "fit");

    expect(form901Keys.slice(0, 4)).toEqual([
      "startSchedule",
      "workOrderNo",
      "machineCode",
      "previousMachine",
    ]);
    expect(form902Keys.slice(0, 4)).toEqual([
      "modificationStatus",
      "workOrderNo",
      "machineCode",
      "previousMachine",
    ]);
    expect(form902Keys.indexOf("plannedStartDate")).toBe(
      form902Keys.indexOf("plannedEndDate") - 1
    );

    const form902Columns = getColumns("902", "fit");
    const getColumn = (key: string) =>
      form902Columns.find(
        (column) => "dataIndex" in column && column.dataIndex === key
      );

    expect(getColumn("modificationStatus")?.fixed).toBeUndefined();
    expect(getColumn("workOrderNo")?.fixed).toBe("left");
    expect(getColumn("machineCode")?.fixed).toBe("left");
  });

  it("機台表頭與欄位設定都保留完整語意", () => {
    expect(getColumnHeaderLocaleText("machineCode", "本站機台")).toEqual({
      zh: "本站機台",
      en: "Current Machine",
    });
    expect(getColumnHeaderLocaleText("previousMachine", "上一站機台")).toEqual({
      zh: "上一站機台",
      en: "Previous Machine",
    });
  });

  it("fit 以兩行表頭壓縮機台欄，compact 保留完整單行空間", () => {
    const getWidth = (mode: "compact" | "fit", key: string) => {
      const column = getColumns("901", mode).find(
        (item) => "dataIndex" in item && item.dataIndex === key
      );
      return column && "width" in column ? column.width : null;
    };

    expect(getWidth("fit", "machineCode")).toBe(96);
    expect(getWidth("fit", "workOrderNo")).toBe(152);
    expect(getWidth("fit", "previousMachine")).toBe(116);
    expect(getWidth("fit", "forgingMother")).toBe(144);
    expect(getWidth("fit", "customerPartNo")).toBe(144);
    expect(getWidth("fit", "size")).toBe(112);
    expect(getWidth("compact", "machineCode")).toBe(160);
    expect(getWidth("compact", "previousMachine")).toBe(176);
  });

  it.each(["901", "902"] as const)(
    "Form %s 急件與排序控制欄使用相同的置中對齊契約",
    (formId) => {
      for (const mode of ["compact", "fit"] as const) {
        const columns = getColumns(formId, mode);
        const getColumn = (key: string) =>
          columns.find(
            (column) => "dataIndex" in column && column.dataIndex === key
          );

        expect(getColumn("sortOrder")?.align).toBe("center");
        if (mode === "fit") {
          expect(getColumn("urgent")?.align).toBe("center");
        }
      }
    }
  );

  it("所有可見的開始排程與急件 checkbox 都對齊表頭文字軌道", () => {
    const cases = [
      { formId: "901", mode: "compact", keys: ["startSchedule"] },
      { formId: "901", mode: "fit", keys: ["startSchedule", "urgent"] },
      { formId: "902", mode: "fit", keys: ["urgent"] },
    ] as const;

    for (const { formId, mode, keys } of cases) {
      const columns = getColumns(formId, mode);
      for (const key of keys) {
        const column = columns.find(
          (item) => "dataIndex" in item && item.dataIndex === key
        );

        expect(column?.className).toBe("work-report-boolean-column-cell");
      }
    }
  });
});

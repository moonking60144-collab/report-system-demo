import { describe, expect, test } from "vitest";
import type { WorkReportRecord } from "../../../api/workReport";
import type { WorkReportFilterGroup } from "../types";
import {
  applyWorkReportFilterGroup,
  buildWorkReportFilterGroupFromGlobalFilters,
  isSameWorkReportFilterGroup,
  normalizeWorkReportFilterGroup,
} from "./customFilterUtils";
import { DEFAULT_GLOBAL_FILTERS } from "../constants";

const records = [
  {
    id: "1",
    workOrderNo: "WO-100",
    customerPartNo: "TESTPART-A",
    machineCode: "UPSTREAM-A",
    filterMachineCode: "MA23",
    status: "未結案",
    siteRunning: "Yes",
    lastUpdatedAt: "2026-09-02T23:30:00+08:00",
  },
  {
    id: "2",
    workOrderNo: "WO-200",
    customerPartNo: "NORMAL-B",
    machineCode: "UPSTREAM-B",
    filterMachineCode: "MA18",
    status: "已結案",
    siteRunning: "No",
    lastUpdatedAt: "2026-08-20T10:00:00+08:00",
  },
] as WorkReportRecord[];

describe("work report custom filter group", () => {
  test("同列多值採 OR，跨列 all / any 依 joinMode 套用", () => {
    const group: WorkReportFilterGroup = {
      joinMode: "all",
      conditions: [
        { id: "m", field: "machineCode", operator: "isAnyOf", values: ["MA23", "MA18"] },
        { id: "s", field: "status", operator: "isAnyOf", values: ["未結案"] },
      ],
    };

    expect(applyWorkReportFilterGroup(records, group, "902").map((record) => record.id)).toEqual(["1"]);
    expect(
      applyWorkReportFilterGroup(records, { ...group, joinMode: "any" }, "902").map(
        (record) => record.id
      )
    ).toEqual(["1", "2"]);
  });

  test("902 本站機台只讀 filterMachineCode，不會被 上游機台混入", () => {
    const group: WorkReportFilterGroup = {
      joinMode: "all",
      conditions: [
        { id: "m", field: "machineCode", operator: "isAnyOf", values: ["UPSTREAM-A"] },
      ],
    };

    expect(applyWorkReportFilterGroup(records, group, "902")).toEqual([]);
    expect(applyWorkReportFilterGroup(records, group, "901").map((record) => record.id)).toEqual(["1"]);
  });

  test("由 902 固定條件轉成 builder 時使用 filterMachineCode", () => {
    const group = buildWorkReportFilterGroupFromGlobalFilters(
      { ...DEFAULT_GLOBAL_FILTERS, filterMachineCode: "MA23", status: "未結案" },
      "902"
    );

    expect(group.conditions.map(({ field, values }) => ({ field, values }))).toEqual([
      { field: "machineCode", values: ["MA23"] },
      { field: "status", values: ["未結案"] },
    ]);
  });

  test("正規化會丟棄未知欄位、未完成條件並限制每列值數", () => {
    const normalized = normalizeWorkReportFilterGroup({
      joinMode: "any",
      conditions: [
        { id: "bad", field: "injected", operator: "equals", values: ["x"] },
        { id: "empty", field: "workOrderNo", operator: "contains", values: [] },
        {
          id: "ok",
          field: "machineCode",
          operator: "isAnyOf",
          values: Array.from({ length: 40 }, (_, index) => `W${index}`),
        },
      ],
    });

    expect(normalized.joinMode).toBe("any");
    expect(normalized.conditions).toHaveLength(1);
    expect(normalized.conditions[0]?.values).toHaveLength(30);
  });

  test("語意比較忽略 condition id，但保留未完成草稿差異", () => {
    expect(
      isSameWorkReportFilterGroup(
        { joinMode: "all", conditions: [{ id: "a", field: "status", operator: "isAnyOf", values: ["未結案"] }] },
        { joinMode: "all", conditions: [{ id: "b", field: "status", operator: "isAnyOf", values: ["未結案"] }] }
      )
    ).toBe(true);
    expect(
      isSameWorkReportFilterGroup(
        { joinMode: "all", conditions: [] },
        { joinMode: "all", conditions: [{ id: "draft", field: "machineCode", operator: "isAnyOf", values: [] }] }
      )
    ).toBe(false);
  });

  test("文字精確比對保留內部空白，不把兩個空白折成一個", () => {
    const doubleSpaceRecord = {
      ...records[0],
      workOrderNo: "WO  DOUBLE",
    } as WorkReportRecord;
    const filterGroup: WorkReportFilterGroup = {
      joinMode: "all",
      conditions: [
        {
          id: "exact",
          field: "workOrderNo",
          operator: "equals",
          values: ["WO DOUBLE"],
        },
      ],
    };

    expect(applyWorkReportFilterGroup([doubleSpaceRecord], filterGroup, "901")).toEqual([]);
    expect(
      applyWorkReportFilterGroup(
        [doubleSpaceRecord],
        {
          ...filterGroup,
          conditions: [{ ...filterGroup.conditions[0], values: ["WO  DOUBLE"] }],
        },
        "901"
      ).map((record) => record.id)
    ).toEqual(["1"]);
  });
});

import { describe, expect, test } from "vitest";
import type { WorkReportRecord } from "../../../api/workReport";
import { DEFAULT_GLOBAL_FILTERS } from "../constants";
import type { GlobalFilters } from "../types";
import {
  applyGlobalFilters,
  buildUpdatedDateRangeQuery,
  countActiveGlobalFilters,
  isSameGlobalFilters,
  isValidUpdatedDateRange,
  normalizeFilters,
  writeGlobalFiltersToSearchParams,
} from "./globalFilterUtils";

function buildFilters(overrides: Partial<GlobalFilters> = {}): GlobalFilters {
  return { ...DEFAULT_GLOBAL_FILTERS, ...overrides };
}

describe("globalFilterUtils / active filter semantics", () => {
  test("全部資料不產生假的篩選數量", () => {
    expect(countActiveGlobalFilters(DEFAULT_GLOBAL_FILTERS)).toBe(0);
  });

  test("badge 依啟用的條件欄位計數", () => {
    expect(
      countActiveGlobalFilters(
        buildFilters({
          globalKeyword: "test",
          status: "未結案",
          updatedDateFrom: "2026-08-01",
          updatedDateTo: "2026-08-10",
        })
      )
    ).toBe(4);
  });

  test("日期也參與 draft 與 applied 的差異判斷", () => {
    expect(
      isSameGlobalFilters(
        buildFilters({ updatedDateFrom: "2026-08-01" }),
        buildFilters({ updatedDateFrom: "2026-08-02" })
      )
    ).toBe(false);
  });
});

describe("globalFilterUtils / URL contract", () => {
  test("列表與明細返回路徑共用完整篩選序列化", () => {
    const params = new URLSearchParams("keep=1");
    writeGlobalFiltersToSearchParams(
      params,
      buildFilters({
        workOrderKeyword: " WO-2605 ",
        filterMachineCode: "06",
        ragicUnfinishedStatus: "未結案",
        updatedDateFrom: "2026-08-01",
        updatedDateTo: "2026-08-10",
      })
    );

    expect(params.get("keep")).toBe("1");
    expect(params.get("fWorkOrder")).toBe("WO-2605");
    expect(params.get("fFilterMachine")).toBe("06");
    expect(params.get("fRagicUnfinished")).toBe("未結案");
    expect(params.get("fUpdatedFrom")).toBe("2026-08-01");
    expect(params.get("fUpdatedTo")).toBe("2026-08-10");

    writeGlobalFiltersToSearchParams(params, DEFAULT_GLOBAL_FILTERS);
    expect(params.get("keep")).toBe("1");
    expect(params.get("fWorkOrder")).toBeNull();
    expect(params.get("fFilterMachine")).toBeNull();
    expect(params.get("fRagicUnfinished")).toBeNull();
    expect(params.get("fUpdatedFrom")).toBeNull();
    expect(params.get("fUpdatedTo")).toBeNull();
  });
});

describe("globalFilterUtils / updated date range", () => {
  test("起迄日轉成本機當日的完整時間邊界", () => {
    const query = buildUpdatedDateRangeQuery(
      buildFilters({ updatedDateFrom: "2026-08-01", updatedDateTo: "2026-08-10" })
    );
    const from = new Date(query.updatedDateFrom!);
    const to = new Date(query.updatedDateTo!);

    expect([
      from.getFullYear(),
      from.getMonth() + 1,
      from.getDate(),
      from.getHours(),
      from.getMinutes(),
    ]).toEqual([2026, 8, 1, 0, 0]);
    expect([
      to.getFullYear(),
      to.getMonth() + 1,
      to.getDate(),
      to.getHours(),
      to.getMinutes(),
      to.getSeconds(),
      to.getMilliseconds(),
    ]).toEqual([2026, 8, 10, 23, 59, 59, 999]);
  });

  test("拒絕起日晚於迄日，並清掉不合法日期", () => {
    expect(
      isValidUpdatedDateRange(
        buildFilters({ updatedDateFrom: "2026-08-11", updatedDateTo: "2026-08-10" })
      )
    ).toBe(false);
    expect(normalizeFilters(buildFilters({ updatedDateFrom: "2026-02-30" })).updatedDateFrom).toBe("");
  });

  test("全量與列印 pipeline 以同一日期區間篩選", () => {
    const records: WorkReportRecord[] = [
      {
        id: "1",
        lastUpdatedAt: "2026/08/01 00:00:00",
        workOrderNo: null,
        status: null,
        customerPartNo: null,
        erpPartNo: null,
        reports: [],
      },
      {
        id: "2",
        lastUpdatedAt: "2026/08/10 23:59:59",
        workOrderNo: null,
        status: null,
        customerPartNo: null,
        erpPartNo: null,
        reports: [],
      },
      {
        id: "3",
        lastUpdatedAt: "2026/08/11 00:00:00",
        workOrderNo: null,
        status: null,
        customerPartNo: null,
        erpPartNo: null,
        reports: [],
      },
      {
        id: "4",
        lastUpdatedAt: "",
        workOrderNo: null,
        status: null,
        customerPartNo: null,
        erpPartNo: null,
        reports: [],
      },
    ];

    expect(
      applyGlobalFilters(
        records,
        buildFilters({ updatedDateFrom: "2026-08-01", updatedDateTo: "2026-08-10" })
      ).map((record) => record.id)
    ).toEqual(["1", "2"]);
  });
});

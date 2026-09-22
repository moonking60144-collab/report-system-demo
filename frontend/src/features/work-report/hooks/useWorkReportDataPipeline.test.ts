import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkReportRecord } from "../../../api/workReport";
import {
  buildScopedWorkReportRecords,
  buildWorkReportMachineFilterValues,
  buildRemoteQuerySignature,
  buildWorkReportStatusFilterValues,
  runWorkReportRecordPipeline,
  selectVisibleWorkReportRecords,
  startGlobalFilterFacetLoad,
} from "./useWorkReportDataPipeline";

afterEach(() => {
  vi.useRealTimers();
});

function record(values: Partial<WorkReportRecord>): WorkReportRecord {
  return {
    id: String(values.id ?? "E-1"),
    reports: [],
    ...values,
  } as WorkReportRecord;
}

describe("work report global filter options", () => {
  it("remote request signature 包含完整 column filter 與本機隱藏條件", () => {
    const base = {
      formId: "901",
      columnKey: "machineCode",
      columnFilters: { status: { type: "text", textQuery: "未結案" } },
      excludeTestCustomerPart: true,
      excludeSortOrder99: true,
    };

    expect(buildRemoteQuerySignature(base)).not.toBe(
      buildRemoteQuerySignature({
        ...base,
        columnFilters: { status: { type: "text", textQuery: "已結案" } },
      })
    );
    expect(buildRemoteQuerySignature(base)).not.toBe(
      buildRemoteQuerySignature({ ...base, excludeSortOrder99: false })
    );
  });

  it("狀態選項保留 canonical domain，不受目前未結案頁面限制", () => {
    expect(
      buildWorkReportStatusFilterValues(
        ["未結案", "__blank__", "暫停"],
        [record({ status: "未結案" })]
      )
    ).toEqual(["未結案", "已結案", "已作廢", "暫停"]);
  });

  it("902 機台選項使用 authoritative filterMachineCode，不混入 upstream machineCode", () => {
    expect(
      buildWorkReportMachineFilterValues(
        "902",
        ["MB07"],
        ["PA", "MB41", "__blank__"],
        [record({ machineCode: "UPSTREAM-CAR", filterMachineCode: "MA22" })]
      )
    ).toEqual(["MA22", "MB07", "MB41", "PA"]);
  });

  it("authoritative facet 瞬斷後會有上限地重試並套用結果", async () => {
    vi.useFakeTimers();
    const facetMap = {
      status: [{ token: "未結案", count: 1 }],
      filterMachineCode: [{ token: "PA", count: 1 }],
    };
    const loader = vi
      .fn<() => Promise<typeof facetMap>>()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(facetMap);
    const onSuccess = vi.fn();

    const cancel = startGlobalFilterFacetLoad(loader, onSuccess, [1_000]);
    await vi.advanceTimersByTimeAsync(0);
    expect(loader).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(loader).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(loader).toHaveBeenCalledTimes(2);
    expect(onSuccess).toHaveBeenCalledWith(facetMap);
    cancel();
  });

  it("authoritative facet cleanup 會取消尚未執行的重試", async () => {
    vi.useFakeTimers();
    const loader = vi.fn<() => Promise<Record<string, never[]>>>().mockRejectedValue(
      new Error("temporary failure")
    );

    const cancel = startGlobalFilterFacetLoad(loader, vi.fn(), [1_000]);
    await vi.advanceTimersByTimeAsync(0);
    cancel();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("authoritative facet 用完排定次數後不再重試", async () => {
    vi.useFakeTimers();
    const loader = vi.fn<() => Promise<Record<string, never[]>>>().mockRejectedValue(
      new Error("persistent failure")
    );
    const onSuccess = vi.fn();

    const cancel = startGlobalFilterFacetLoad(loader, onSuccess, [1_000, 3_000]);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(loader).toHaveBeenCalledTimes(3);
    expect(onSuccess).not.toHaveBeenCalled();
    cancel();
  });
});

describe("work report preview settlement membership", () => {
  it("工令改到其他機台後，server preview 不再顯示不符合目前篩選的列", () => {
    const processedPreviewRecords = runWorkReportRecordPipeline(
      [record({ id: "E-1", machineCode: "MA02" })],
      {
        isGlobalFilterActive: false,
        globalFilters: {
          globalKeyword: "",
          workOrderKeyword: "",
          customerPartKeyword: "",
          machineCode: "__all__",
          filterMachineCode: "__all__",
          status: "__all__",
          ragicUnfinishedStatus: "__all__",
          siteRunning: "all",
          startSchedule: "all",
          updatedDateFrom: "",
          updatedDateTo: "",
        },
        customFilters: {
          joinMode: "all",
          conditions: [
            {
              id: "machine-w1",
              field: "machineCode",
              operator: "isAnyOf",
              values: ["MA01"],
            },
          ],
        },
        currentFormId: "901",
        columnFilterState: {},
        sortRules: [],
      }
    );

    expect(
      selectVisibleWorkReportRecords({
        shouldUseFullHydrationForList: false,
        hasHydratedAllRecords: false,
        processedPreviewRecords,
        processedFullRecords: [],
        page: 1,
        pageSize: 25,
      })
    ).toEqual([]);
  });

  it("server preview 切換時不會被上一個 full hydration 狀態短暫蓋掉", () => {
    const previewRecords = [record({ id: "preview" })];

    expect(
      selectVisibleWorkReportRecords({
        shouldUseFullHydrationForList: false,
        hasHydratedAllRecords: true,
        processedPreviewRecords: previewRecords,
        processedFullRecords: [],
        page: 1,
        pageSize: 25,
      })
    ).toBe(previewRecords);
  });
});

describe("work report local visibility preferences", () => {
  it("隱藏一般與尚未可執行的排序 99 工令，保留已可執行的後續 B 站", () => {
    const sourceRecords = [
      record({ id: "number-99", sortOrder: 99 }),
      record({ id: "string-99", sortOrder: "99" }),
      record({
        id: "current-hf03",
        sortOrder: 99,
        prodType: "PB",
        defaultProcessCode: "B03",
        defaultMainMaterial: "PART-A-02PB",
        siteRunning: "Yes",
      }),
      record({
        id: "previous-hf04",
        sortOrder: 99,
        prodType: "PB",
        defaultProcessCode: "B04",
        defaultMainMaterial: "PART-A-03PB",
        prevReportQtyPc: "1,000",
      }),
      record({
        id: "future-hf04",
        sortOrder: 99,
        prodType: "PB",
        defaultProcessCode: "B04",
        defaultMainMaterial: "PART-B-03PB",
      }),
      record({
        id: "non-consecutive-hf",
        sortOrder: 99,
        prodType: "PB",
        defaultProcessCode: "B02",
        defaultMainMaterial: "RAW-MATERIAL",
        prevReportQtyPc: 100,
      }),
      record({ id: "other", sortOrder: 9 }),
    ];

    expect(
      buildScopedWorkReportRecords(sourceRecords, {
        currentFormId: "902",
        pageProdTypeCode: "PB",
        hideTestCustomerPartRecords: false,
        hideSortOrder99Records: true,
      }).map((item) => item.id)
    ).toEqual(["current-hf03", "previous-hf04", "other"]);
  });

  it("901 仍隱藏已執行但排序 99 的資料", () => {
    const sourceRecords = [
      record({
        id: "form-901",
        sortOrder: 99,
        prodType: "PB",
        defaultProcessCode: "B02",
        defaultMainMaterial: "PART-A-01PB",
        siteRunning: "Yes",
      }),
    ];

    expect(
      buildScopedWorkReportRecords(sourceRecords, {
        currentFormId: "901",
        pageProdTypeCode: "PB",
        hideTestCustomerPartRecords: false,
        hideSortOrder99Records: true,
      })
    ).toEqual([]);
  });

  it("只有子表列但報工筆數為 0 時，完整資料與摘要的 PB 可見性一致", () => {
    const detail = record({
      id: "subtable-only-hf",
      reports: [{
        rowId: "empty-report", date: null, plannedIdle: null,
        processCode: null, processCodeDisplay: null,
        machineId: null, machineIdDisplay: null,
        operatorId: null, operatorIdDisplay: null, operatorName: null,
        inputOptions: null, shiftType: null, startTime: null, endTime: null,
        breakTime: null, totalWorkTime: null, productionQty: null,
      }],
      reportCount: 0,
      sortOrder: 99,
      prodType: "PB",
      defaultProcessCode: "B02",
      defaultMainMaterial: "PART-A-01PB",
    });
    const options = {
      currentFormId: "902" as const,
      pageProdTypeCode: "PB",
      hideTestCustomerPartRecords: false,
      hideSortOrder99Records: true,
    };
    expect(buildScopedWorkReportRecords([detail], options)).toEqual([]);
    expect(buildScopedWorkReportRecords([{ ...detail, reports: [] }], options)).toEqual([]);
    expect(buildScopedWorkReportRecords([{ ...detail, reportCount: 1, reports: [] }], options)).toHaveLength(1);
  });

  it("關閉本機隱藏條件後保留排序 99 的工令", () => {
    const sourceRecords = [record({ id: "sort-99", sortOrder: 99 })];

    expect(
      buildScopedWorkReportRecords(sourceRecords, {
        currentFormId: "901",
        pageProdTypeCode: "PA",
        hideTestCustomerPartRecords: false,
        hideSortOrder99Records: false,
      })
    ).toEqual(sourceRecords);
  });
});

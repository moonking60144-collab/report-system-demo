import { describe, expect, it, vi } from "vitest";
import type { WorkReportRecord } from "../../api/workReport";
import { DEFAULT_GLOBAL_FILTERS } from "./constants";
import {
  buildScopedWorkReportRecords,
  runWorkReportRecordPipeline,
} from "./hooks/useWorkReportDataPipeline";
import {
  buildWorkReportPdfFilename,
  buildWorkReportPrintDocument,
  buildWorkReportPrintLoadingDocument,
  fetchWorkReportPrintRecords,
  isWorkReportPrintRecordCountAllowed,
  isWorkReportPrintBlockedByScheduleMutation,
  WORK_REPORT_PRINT_MAX_RECORDS,
} from "./workReportPrint";

function createRecord(
  overrides: Partial<WorkReportRecord> = {}
): WorkReportRecord {
  return {
    id: "1",
    workOrderNo: "WO-1",
    status: "未結案",
    machineCode: "MB50",
    filterMachineCode: "MB50",
    customerPartNo: "PART-A",
    erpPartNo: null,
    prodType: "PA",
    sortOrder: 1,
    forgingMother: "MAT-A",
    workOrderType: "內製",
    previousMachine: "MA10",
    currentMaterial: "WIRE-A",
    size: "08*030",
    targetQtyPc: 1000,
    pendingQty: 500,
    producedQtyStat: 500,
    ...overrides,
  };
}

describe("workReportPrint", () => {
  it("以列表共用規則篩選與排序完整資料，不另做一套列印資料流", () => {
    const sourceRecords = [
      createRecord({ id: "3", workOrderNo: "WO-3", sortOrder: 3 }),
      createRecord({ id: "1", workOrderNo: "WO-1", sortOrder: 1 }),
      createRecord({
        id: "test",
        workOrderNo: "WO-TEST",
        customerPartNo: "TEST-PART",
      }),
      createRecord({ id: "hf", workOrderNo: "WO-PB", prodType: "PB" }),
      createRecord({ id: "done", workOrderNo: "WO-DONE", status: "已結案" }),
      createRecord({ id: "hidden", workOrderNo: "WO-HIDDEN", sortOrder: 99 }),
    ];
    const scopedRecords = buildScopedWorkReportRecords(sourceRecords, {
      currentFormId: "901",
      pageProdTypeCode: "PA",
      hideTestCustomerPartRecords: true,
      hideSortOrder99Records: true,
    });
    const printRecords = runWorkReportRecordPipeline(scopedRecords, {
      isGlobalFilterActive: true,
      globalFilters: {
        ...DEFAULT_GLOBAL_FILTERS,
        status: "未結案",
      },
      columnFilterState: {},
      sortRules: [{ key: "sortOrder", direction: "asc", type: "number" }],
    });

    expect(printRecords.map((record) => record.workOrderNo)).toEqual([
      "WO-1",
      "WO-3",
    ]);
  });

  it("902 列印保留已可執行的後續 B 站，仍隱藏尚未開始的排序 99 工令", () => {
    const readyRecord = createRecord({
      id: "ready",
      workOrderNo: "WO-READY",
      sortOrder: 99,
      prodType: "PB",
      defaultProcessCode: "B03",
      defaultMainMaterial: "PART-A-02PB",
      prevCompletePc: 100,
    });
    const futureRecord = createRecord({
      id: "future",
      workOrderNo: "WO-FUTURE",
      sortOrder: 99,
      prodType: "PB",
      defaultProcessCode: "B04",
      defaultMainMaterial: "PART-B-03PB",
      producedQtyStat: 0,
    });

    expect(
      buildScopedWorkReportRecords([readyRecord, futureRecord], {
        currentFormId: "902",
        pageProdTypeCode: "PB",
        hideTestCustomerPartRecords: false,
        hideSortOrder99Records: true,
      }).map((record) => record.workOrderNo)
    ).toEqual(["WO-READY"]);
  });

  it("產生由報工系統持有的 901 A4 橫式機台分組排程，不含 Ragic 外部網址", () => {
    const html = buildWorkReportPrintDocument({
      formId: "901",
      records: [
        createRecord(),
        createRecord({ id: "2", workOrderNo: "WO-2", machineCode: "MA51" }),
      ],
      language: "zh",
      generatedAt: new Date(2026, 7, 7, 9, 2, 3),
    });

    expect(html).toContain("製程 A 排程表");
    expect(html.match(/<h1>製程 A 排程表<\/h1>/g)).toHaveLength(1);
    expect(html.match(/<header class="machine-header">/g)).toHaveLength(2);
    expect(html).toMatch(
      /<header class="machine-header">\s*<div class="machine-mark"><span>機台<\/span><strong>MB50<\/strong><\/div>/
    );
    expect(html).toContain(".machine-continuation { display: flex; justify-content: flex-start;");
    expect(html).toContain("資料來源：報工系統");
    expect(html).toContain("@page { size: A4 landscape;");
    expect(html).toContain('data-print-layout="compact"');
    expect(html).toContain('data-print-font-size="medium"');
    expect(html).toContain('id="work-report-font-size-action"');
    expect(html).toContain('value="small">較小 100%</option>');
    expect(html).toContain('value="medium" selected>標準 110%</option>');
    expect(html).toContain('value="xx-large">最大 140%</option>');
    expect(html).toContain('id="work-report-layout-action"');
    expect(html).toContain('id="work-report-column-action"');
    expect(html).toContain('id="work-report-column-panel"');
    expect(html).toContain("欄位設定");
    expect(html).toContain('value="compact" selected');
    expect(html).toContain(">連續排列</option>");
    expect(html).toContain("每台機台一頁");
    expect(html).toContain('id="work-report-pdf-action"');
    expect(html).toContain(">下載 PDF</button>");
    expect(html).toContain('data-loading-text="正在產生 PDF…"');
    expect(html).toContain('data-pdf-filename="製程 A 排程表_2026-08-07_090203.pdf"');
    expect(html).toContain("<strong>MB50</strong>");
    expect(html).toContain("<strong>MA51</strong>");
    expect(html).toContain("上一站機台");
    expect(html).toContain("內製／委外");
    expect(html).toContain("MA10");
    expect(html).toMatch(/<th scope="col" data-column-key="currentMaterial" hidden>/);
    expect(html).toMatch(/<th scope="col" data-column-key="previousMachine">/);
    expect(html).toMatch(/data-column-key="sortOrder" data-column-weight="[\d.]+"/);
    expect(html).toMatch(/data-column-key="forgingMother" data-column-weight="[\d.]+"/);
    expect(html).toContain("上一站完工容器");
    expect(html).not.toContain('class="row-number"');
    expect(html).not.toContain('row-number-label">#');
    expect(html).not.toContain("demo.local/default");
    expect(html).not.toContain("onclick=");
  });

  it("瀏覽器將同機台截到續頁時，表格標頭會重複機台識別", () => {
    const html = buildWorkReportPrintDocument({
      formId: "901",
      records: [createRecord()],
      language: "zh",
      generatedAt: new Date(2026, 7, 10, 16, 20, 19),
    });

    expect(html).toMatch(
      /<thead><tr class="native-print-machine-row"><th colspan="\d+"><span class="native-print-machine-code"><span>機台<\/span><strong>MB50<\/strong><\/span>/
    );
    expect(html).toContain(".native-print-machine-row, .native-print-machine-code { display: none; }");
    expect(html).toMatch(
      /@media print \{[\s\S]*?\.native-print-machine-row \{ display: table-row;[\s\S]*?\.native-print-machine-code \{ display: grid;/
    );
  });

  it("未指定機台在左側機台標識與續頁表頭使用相同顯示名稱", () => {
    const html = buildWorkReportPrintDocument({
      formId: "901",
      records: [createRecord({ machineCode: "", filterMachineCode: "" })],
      language: "zh",
      generatedAt: new Date(2026, 7, 10, 16, 20, 19),
    });

    expect(html.match(/<strong>未指定<\/strong>/g)).toHaveLength(2);
    expect(html).not.toContain("未指定機台");
  });

  it("PDF 檔名依表單與產生時間固定，避免下載成無意義名稱", () => {
    const generatedAt = new Date(2026, 7, 10, 13, 22, 38);

    expect(buildWorkReportPdfFilename("901", "zh", generatedAt)).toBe(
      "製程 A 排程表_2026-08-10_132238.pdf"
    );
    expect(buildWorkReportPdfFilename("902", "en", generatedAt)).toBe(
      "Process B Schedule_2026-08-10_132238.pdf"
    );
  });

  it("902 排程包含指定開始日，並正確跳脫 Ragic 與使用者資料", () => {
    const html = buildWorkReportPrintDocument({
      formId: "902",
      records: [
        createRecord({
          prodType: "PB",
          workOrderNo: '<script>alert("x")</script>',
          plannedStartDate: "2026/08/07",
        }),
      ],
      language: "zh",
      generatedAt: new Date(2026, 7, 7, 10, 3, 4),
    });

    expect(html).toContain("製程 B 排程表");
    expect(html).toContain("指定開始日");
    expect(html).toContain('data-pdf-filename="製程 B 排程表_2026-08-07_100304.pdf"');
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).not.toContain('<script>alert("x")</script>');
  });

  it("資料整理期間先顯示可辨識的 loading 文件", () => {
    const html = buildWorkReportPrintLoadingDocument("901", "zh");
    expect(html).toContain("正在整理列印排程");
    expect(html).toContain("prefers-reduced-motion");
  });

  it("列印資料量超過安全上限時拒絕產生，不允許靜默截斷", () => {
    expect(isWorkReportPrintRecordCountAllowed(WORK_REPORT_PRINT_MAX_RECORDS)).toBe(true);
    expect(
      isWorkReportPrintRecordCountAllowed(WORK_REPORT_PRINT_MAX_RECORDS + 1)
    ).toBe(false);
  });

  it("列印前重新讀取 backend snapshot，但不強制重掃 Ragic", async () => {
    const records = [createRecord({ id: "snapshot" })];
    const hydrateAllRecords = vi.fn().mockResolvedValue(records);

    await expect(
      fetchWorkReportPrintRecords(hydrateAllRecords)
    ).resolves.toBe(records);
    expect(hydrateAllRecords).toHaveBeenCalledWith(false, {
      reloadFromBackend: true,
    });
  });

  it("列印 gate 直接採用 backend 無截斷 aggregate", () => {
    expect(
      isWorkReportPrintBlockedByScheduleMutation({
        hasBlockingScheduleMutation: true,
        count: 201,
      })
    ).toBe(true);
    expect(
      isWorkReportPrintBlockedByScheduleMutation({
        hasBlockingScheduleMutation: false,
        count: 0,
      })
    ).toBe(false);
  });
});

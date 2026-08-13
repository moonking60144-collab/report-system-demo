import { describe, expect, it, vi } from "vitest";
import type { WorkReportQueueTask, WorkReportRecord } from "../../api/workReport";
import { DEFAULT_GLOBAL_FILTERS } from "./constants";
import {
  buildScopedWorkReportRecords,
  runWorkReportRecordPipeline,
} from "./hooks/useWorkReportDataPipeline";
import {
  buildWorkReportPdfFilename,
  buildWorkReportPrintDocument,
  buildWorkReportPrintLoadingDocument,
  fetchActiveSortOrderTasks,
  fetchWorkReportPrintRecords,
  isWorkReportPrintRecordCountAllowed,
  isActiveSortOrderTask,
  WORK_REPORT_PRINT_MAX_RECORDS,
} from "./workReportPrint";

function createTask(
  overrides: Partial<WorkReportQueueTask> = {}
): WorkReportQueueTask {
  return {
    taskId: "task-1",
    taskType: "update-report",
    status: "pending",
    formId: "104",
    workOrderNo: "WO-1",
    entryId: "1",
    rowId: null,
    queueKey: "104:1",
    createdAt: "2026-08-07T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    updatedAt: "2026-08-07T00:00:00.000Z",
    message: null,
    errorCode: null,
    errorMessage: null,
    actorClientId: null,
    actorTabId: null,
    actorIp: null,
    actorLabel: null,
    operationKind: "update-sort-order",
    source: null,
    ...overrides,
  };
}

function createRecord(
  overrides: Partial<WorkReportRecord> = {}
): WorkReportRecord {
  return {
    id: "1",
    workOrderNo: "WO-1",
    status: "未結案",
    machineCode: "P10",
    filterMachineCode: "P10",
    customerPartNo: "PART-A",
    erpPartNo: null,
    prodType: "TI",
    sortOrder: 1,
    forgingMother: "MAT-A",
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
      createRecord({ id: "hf", workOrderNo: "WO-HF", prodType: "HF" }),
      createRecord({ id: "done", workOrderNo: "WO-DONE", status: "已結案" }),
    ];
    const scopedRecords = buildScopedWorkReportRecords(sourceRecords, {
      currentFormId: "104",
      pageProdTypeCode: "TI",
      hideTestCustomerPartRecords: true,
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

  it("產生由報工系統持有的 104 A4 橫式機台分組排程，不含 Ragic 外部網址", () => {
    const html = buildWorkReportPrintDocument({
      formId: "104",
      records: [
        createRecord(),
        createRecord({ id: "2", workOrderNo: "WO-2", machineCode: "P11" }),
      ],
      language: "zh",
      generatedAt: new Date(2026, 7, 7, 9, 2, 3),
    });

    expect(html).toContain("搓牙排程表");
    expect(html).toContain("資料來源：報工系統");
    expect(html).toContain("@page { size: A4 landscape;");
    expect(html).toContain('data-print-layout="compact"');
    expect(html).toContain('data-print-font-size="medium"');
    expect(html).toContain('id="work-report-font-size-action"');
    expect(html).toContain('value="small">較小 100%</option>');
    expect(html).toContain('value="medium" selected>標準 110%</option>');
    expect(html).toContain('value="xx-large">最大 140%</option>');
    expect(html).toContain('id="work-report-layout-action"');
    expect(html).toContain('value="compact" selected');
    expect(html).toContain(">連續排列</option>");
    expect(html).toContain("每台機台一頁");
    expect(html).toContain('id="work-report-pdf-action"');
    expect(html).toContain(">下載 PDF</button>");
    expect(html).toContain('data-loading-text="正在產生 PDF…"');
    expect(html).toContain('data-pdf-filename="搓牙排程表_2026-08-07_090203.pdf"');
    expect(html).toContain("<strong>P10</strong>");
    expect(html).toContain("<strong>P11</strong>");
    expect(html).toContain("上一站完工容器");
    expect(html).not.toContain("demo.local/default");
    expect(html).not.toContain("onclick=");
  });

  it("瀏覽器將同機台截到續頁時，表格標頭會重複機台識別", () => {
    const html = buildWorkReportPrintDocument({
      formId: "104",
      records: [createRecord()],
      language: "zh",
      generatedAt: new Date(2026, 7, 10, 16, 20, 19),
    });

    expect(html).toMatch(
      /<thead><tr><th class="row-number"[^>]*><span class="native-print-machine-code"><span>機台<\/span><strong>P10<\/strong><\/span>/
    );
    expect(html).toContain(".native-print-machine-code { display: none; }");
    expect(html).toMatch(
      /@media print \{[\s\S]*?\.native-print-machine-code \{ display: grid;/
    );
  });

  it("未指定機台在主標頭與續頁表頭使用相同顯示名稱", () => {
    const html = buildWorkReportPrintDocument({
      formId: "104",
      records: [createRecord({ machineCode: "", filterMachineCode: "" })],
      language: "zh",
      generatedAt: new Date(2026, 7, 10, 16, 20, 19),
    });

    expect(html.match(/<strong>未指定<\/strong>/g)).toHaveLength(2);
    expect(html).not.toContain("未指定機台");
  });

  it("PDF 檔名依表單與產生時間固定，避免下載成無意義名稱", () => {
    const generatedAt = new Date(2026, 7, 10, 13, 22, 38);

    expect(buildWorkReportPdfFilename("104", "zh", generatedAt)).toBe(
      "搓牙排程表_2026-08-10_132238.pdf"
    );
    expect(buildWorkReportPdfFilename("105", "en", generatedAt)).toBe(
      "Heading Schedule_2026-08-10_132238.pdf"
    );
  });

  it("105 排程包含指定開始日，並正確跳脫 Ragic 與使用者資料", () => {
    const html = buildWorkReportPrintDocument({
      formId: "105",
      records: [
        createRecord({
          prodType: "HF",
          workOrderNo: '<script>alert("x")</script>',
          plannedStartDate: "2026/08/07",
        }),
      ],
      language: "zh",
      generatedAt: new Date(2026, 7, 7, 10, 3, 4),
    });

    expect(html).toContain("打頭排程表");
    expect(html).toContain("指定開始日");
    expect(html).toContain('data-pdf-filename="打頭排程表_2026-08-07_100304.pdf"');
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).not.toContain('<script>alert("x")</script>');
  });

  it("資料整理期間先顯示可辨識的 loading 文件", () => {
    const html = buildWorkReportPrintLoadingDocument("104", "zh");
    expect(html).toContain("正在整理列印排程");
    expect(html).toContain("prefers-reduced-motion");
  });

  it("列印資料量超過安全上限時拒絕產生，不允許靜默截斷", () => {
    expect(isWorkReportPrintRecordCountAllowed(WORK_REPORT_PRINT_MAX_RECORDS)).toBe(true);
    expect(
      isWorkReportPrintRecordCountAllowed(WORK_REPORT_PRINT_MAX_RECORDS + 1)
    ).toBe(false);
  });

  it("列印資料優先沿用 hydrated 或 SQLite snapshot，不強制重掃 Ragic", async () => {
    const records = [createRecord({ id: "snapshot" })];
    const hydrateAllRecords = vi.fn().mockResolvedValue(records);

    await expect(
      fetchWorkReportPrintRecords(hydrateAllRecords)
    ).resolves.toBe(records);
    expect(hydrateAllRecords).toHaveBeenCalledWith(false);
  });

  it("同表單排序更新與缺少 operationKind 的舊 update task 都會阻擋列印", () => {
    expect(isActiveSortOrderTask(createTask(), "104")).toBe(true);
    expect(
      isActiveSortOrderTask(createTask({ status: "running" }), "104")
    ).toBe(true);
    expect(
      isActiveSortOrderTask(createTask({ status: "success" }), "104")
    ).toBe(false);
    expect(
      isActiveSortOrderTask(createTask({ operationKind: null }), "104")
    ).toBe(true);
    expect(
      isActiveSortOrderTask(createTask({ operationKind: undefined }), "104")
    ).toBe(true);
    expect(
      isActiveSortOrderTask(
        createTask({ taskType: "create-report", operationKind: null }),
        "104"
      )
    ).toBe(false);
    expect(isActiveSortOrderTask(createTask({ formId: "105" }), "104")).toBe(
      false
    );
  });

  it("同時查 pending/running，並保守攔住缺少 operationKind 的 legacy update task", async () => {
    const fetchTasks = vi
      .fn()
      .mockResolvedValueOnce([
        createTask(),
        createTask({ taskId: "legacy-update", operationKind: null }),
        createTask({ taskId: "wrong-type", taskType: "create-report" }),
      ])
      .mockResolvedValueOnce([
        createTask({ taskId: "running-sort", status: "running" }),
      ]);

    await expect(fetchActiveSortOrderTasks("104", fetchTasks)).resolves.toEqual([
      createTask(),
      createTask({ taskId: "legacy-update", operationKind: null }),
      createTask({ taskId: "running-sort", status: "running" }),
    ]);
    expect(fetchTasks).toHaveBeenNthCalledWith(1, "104", {
      status: "pending",
      taskType: "update-report",
      limit: 200,
    });
    expect(fetchTasks).toHaveBeenNthCalledWith(2, "104", {
      status: "running",
      taskType: "update-report",
      limit: 200,
    });
  });
});

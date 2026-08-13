import type {
  WorkReportQueueTask,
  WorkReportQueueTaskStatus,
  WorkReportRecord,
} from "../../api/workReport";
import type { UiLanguage, WorkReportFormId } from "./types";
import { getColumnCellValue, parseSemanticBoolean } from "./utils";
import { downloadWorkReportPdf } from "./workReportPdf";

type FetchQueueTasks = (
  formId: string,
  options: {
    status: WorkReportQueueTaskStatus;
    taskType: "update-report";
    limit: number;
  }
) => Promise<WorkReportQueueTask[]>;

interface WorkReportPrintColumn {
  key: string;
  zh: string;
  en: string;
  format?: "number" | "urgent";
}

interface WorkReportPrintDocumentOptions {
  formId: WorkReportFormId;
  records: WorkReportRecord[];
  language: UiLanguage;
  generatedAt?: Date;
}

export const WORK_REPORT_PRINT_MAX_RECORDS = 500;

const FORM_104_PRINT_COLUMNS: readonly WorkReportPrintColumn[] = [
  { key: "sortOrder", zh: "排序", en: "Sort", format: "number" },
  { key: "workOrderNo", zh: "工令單號", en: "Work Order" },
  { key: "forgingMother", zh: "鍛造母件", en: "Forging Base" },
  { key: "size", zh: "尺寸", en: "Size" },
  { key: "currentMaterial", zh: "目前使用來料", en: "Current Material" },
  { key: "urgent", zh: "急件", en: "Urgent", format: "urgent" },
  { key: "estimatedHours", zh: "預估工時", en: "Est. Hours", format: "number" },
  { key: "prevPlanEndDate", zh: "上製程完成日", en: "Prev. End" },
  { key: "plannedEndDate", zh: "指定結束日", en: "Planned End" },
  { key: "targetQtyPc", zh: "目標數 pc", en: "Target pc", format: "number" },
  { key: "pendingQty", zh: "待生產", en: "Pending", format: "number" },
  { key: "producedQtyStat", zh: "已生產", en: "Produced", format: "number" },
  { key: "prevReportQtyPc", zh: "上一站報工 pc", en: "Prev. Report", format: "number" },
  { key: "prevCompleteContainer", zh: "上一站完工容器", en: "Prev. Containers" },
];

const FORM_105_PRINT_COLUMNS: readonly WorkReportPrintColumn[] = [
  { key: "sortOrder", zh: "排序", en: "Sort", format: "number" },
  { key: "workOrderNo", zh: "工令單號", en: "Work Order" },
  { key: "forgingMother", zh: "鍛造母件", en: "Forging Base" },
  { key: "size", zh: "尺寸", en: "Size" },
  { key: "currentMaterial", zh: "目前使用來料", en: "Current Material" },
  { key: "urgent", zh: "急件", en: "Urgent", format: "urgent" },
  { key: "plannedStartDate", zh: "指定開始日", en: "Planned Start" },
  { key: "plannedEndDate", zh: "指定結束日", en: "Planned End" },
  { key: "estimatedHours", zh: "預估工時", en: "Est. Hours", format: "number" },
  { key: "targetQtyPc", zh: "目標數 pc", en: "Target pc", format: "number" },
  { key: "pendingQty", zh: "待生產", en: "Pending", format: "number" },
  { key: "producedQtyStat", zh: "已生產", en: "Produced", format: "number" },
  { key: "prevReportQtyPc", zh: "上一站報工 pc", en: "Prev. Report", format: "number" },
  { key: "status", zh: "工令狀態", en: "Status" },
];

const NUMBER_FORMATTER = new Intl.NumberFormat("zh-TW", {
  maximumFractionDigits: 2,
});

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatPrintValue(
  value: unknown,
  format: WorkReportPrintColumn["format"]
): string {
  const text = String(value ?? "").trim();
  if (format === "urgent") {
    const urgent = parseSemanticBoolean(value);
    if (urgent === true) {
      return "急";
    }
    if (urgent === false || text === "") {
      return "—";
    }
  }
  if (format === "number" && text !== "") {
    const numberValue = Number(text.replaceAll(",", ""));
    if (Number.isFinite(numberValue)) {
      return NUMBER_FORMATTER.format(numberValue);
    }
  }
  return text || "—";
}

function resolveMachineCode(record: WorkReportRecord): string {
  return String(getColumnCellValue(record, "machineCode") ?? "").trim() || "未指定機台";
}

function groupRecordsByMachine(
  records: WorkReportRecord[]
): Array<{ machineCode: string; records: WorkReportRecord[] }> {
  const recordsByMachine = new Map<string, WorkReportRecord[]>();
  for (const record of records) {
    const machineCode = resolveMachineCode(record);
    const machineRecords = recordsByMachine.get(machineCode);
    if (machineRecords) {
      machineRecords.push(record);
    } else {
      recordsByMachine.set(machineCode, [record]);
    }
  }
  return Array.from(recordsByMachine, ([machineCode, machineRecords]) => ({
    machineCode,
    records: machineRecords,
  }));
}

function getPrintCopy(formId: WorkReportFormId, language: UiLanguage) {
  const isEnglish = language === "en";
  return {
    title: isEnglish
      ? formId === "104"
        ? "Thread Rolling Schedule"
        : "Heading Schedule"
      : formId === "104"
        ? "搓牙排程表"
        : "打頭排程表",
    formLabel: isEnglish ? `Form ${formId}` : `表單 ${formId}`,
    machine: isEnglish ? "Machine" : "機台",
    records: isEnglish ? "records" : "筆工令",
    machines: isEnglish ? "machines" : "台機台",
    generatedAt: isEnglish ? "Generated" : "產生時間",
    source: isEnglish ? "Source: Work Report System" : "資料來源：報工系統",
    print: isEnglish ? "Print" : "列印",
    downloadPdf: isEnglish ? "Download PDF" : "下載 PDF",
    downloadingPdf: isEnglish ? "Generating PDF…" : "正在產生 PDF…",
    downloadPdfFailed: isEnglish ? "PDF download failed" : "PDF 下載失敗",
    renderedPages: isEnglish ? "pages" : "頁",
    unassignedMachine: isEnglish ? "Unassigned" : "未指定",
    printOptions: isEnglish ? "Print options" : "列印選項",
    fontSize: isEnglish ? "Font size" : "字體大小",
    fontSmall: isEnglish ? "Smaller 100%" : "較小 100%",
    fontMedium: isEnglish ? "Standard 110%" : "標準 110%",
    fontLarge: isEnglish ? "Large 120%" : "大 120%",
    fontExtraLarge: isEnglish ? "Extra large 130%" : "特大 130%",
    fontExtraExtraLarge: isEnglish ? "Maximum 140%" : "最大 140%",
    layout: isEnglish ? "Layout" : "排版方式",
    compactLayout: isEnglish ? "Continuous" : "連續排列",
    machinePageLayout: isEnglish ? "One machine per page" : "每台機台一頁",
    close: isEnglish ? "Close" : "關閉",
    preparing: isEnglish ? "Preparing print schedule…" : "正在整理列印排程…",
  };
}

function padDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

export function buildWorkReportPdfFilename(
  formId: WorkReportFormId,
  language: UiLanguage,
  generatedAt: Date
): string {
  const { title } = getPrintCopy(formId, language);
  const date = [
    generatedAt.getFullYear(),
    padDatePart(generatedAt.getMonth() + 1),
    padDatePart(generatedAt.getDate()),
  ].join("-");
  const time = [
    padDatePart(generatedAt.getHours()),
    padDatePart(generatedAt.getMinutes()),
    padDatePart(generatedAt.getSeconds()),
  ].join("");
  return `${title}_${date}_${time}.pdf`;
}

export function buildWorkReportPrintLoadingDocument(
  formId: WorkReportFormId,
  language: UiLanguage
): string {
  const copy = getPrintCopy(formId, language);
  return `<!doctype html>
<html lang="${language === "en" ? "en" : "zh-Hant"}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(copy.preparing)}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #eef2f5; color: #183046; font-family: "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif; }
    main { display: grid; justify-items: center; gap: 16px; padding: 32px; }
    .spinner { width: 32px; height: 32px; border: 3px solid #c9d5df; border-top-color: #1f668a; border-radius: 50%; animation: spin 700ms linear infinite; }
    p { margin: 0; font-size: 15px; font-weight: 700; letter-spacing: .02em; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation: none; border-top-color: #c9d5df; } }
  </style>
</head>
<body><main><div class="spinner" aria-hidden="true"></div><p>${escapeHtml(copy.preparing)}</p></main></body>
</html>`;
}

export function buildWorkReportPrintDocument({
  formId,
  records,
  language,
  generatedAt = new Date(),
}: WorkReportPrintDocumentOptions): string {
  const copy = getPrintCopy(formId, language);
  const pdfFilename = buildWorkReportPdfFilename(formId, language, generatedAt);
  const columns = formId === "104" ? FORM_104_PRINT_COLUMNS : FORM_105_PRINT_COLUMNS;
  const machineGroups = groupRecordsByMachine(records);
  const locale = language === "en" ? "en-US" : "zh-TW";
  const generatedAtText = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(generatedAt);
  const columnHeaders = columns
    .map((column) => `<th scope="col">${escapeHtml(language === "en" ? column.en : column.zh)}</th>`)
    .join("");
  const machineSections = machineGroups
    .map(({ machineCode, records: machineRecords }, machineIndex) => {
      const displayMachineCode =
        machineCode === "未指定機台" ? copy.unassignedMachine : machineCode;
      const tableRows = machineRecords
        .map((record, rowIndex) => {
          const cells = columns
            .map((column) => {
              const value = formatPrintValue(record[column.key], column.format);
              const className = column.format === "number" ? " class=\"is-number\"" : "";
              return `<td${className}>${escapeHtml(value)}</td>`;
            })
            .join("");
          return `<tr><td class="row-number">${rowIndex + 1}</td>${cells}</tr>`;
        })
        .join("");
      return `<section class="machine-sheet${machineIndex === 0 ? " is-first" : ""}">
  <header class="report-header">
    <div>
      <p class="report-kicker">FUNDA · ${escapeHtml(copy.formLabel)}</p>
      <h1>${escapeHtml(copy.title)}</h1>
    </div>
    <div class="machine-mark"><span>${escapeHtml(copy.machine)}</span><strong>${escapeHtml(displayMachineCode)}</strong></div>
  </header>
  <div class="report-meta">
    <span>${machineRecords.length} ${escapeHtml(copy.records)}</span>
    <span>${escapeHtml(copy.generatedAt)} ${escapeHtml(generatedAtText)}</span>
    <span>${escapeHtml(copy.source)}</span>
  </div>
  <table>
    <thead><tr><th class="row-number" scope="col"><span class="native-print-machine-code"><span>${escapeHtml(copy.machine)}</span><strong>${escapeHtml(displayMachineCode)}</strong></span><span class="row-number-label">#</span></th>${columnHeaders}</tr></thead>
    <tbody>${tableRows}</tbody>
  </table>
</section>`;
    })
    .join("");

  return `<!doctype html>
<html lang="${language === "en" ? "en" : "zh-Hant"}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(copy.title)} · ${escapeHtml(generatedAtText)}</title>
  <style>
    :root { color-scheme: light; --ink: #152739; --muted: #53697b; --line: #9eafbd; --line-soft: #d8e0e6; --accent: #17688b; --paper: #fff; --screen: #dfe6eb; }
    * { box-sizing: border-box; }
    html { background: var(--screen); }
    body { margin: 0; color: var(--ink); background: var(--screen); font-family: "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif; font-size: var(--print-text-size, 7.5pt); font-variant-numeric: tabular-nums; }
    body[data-print-font-size="small"] { --print-text-size: 6.8pt; }
    body[data-print-font-size="medium"] { --print-text-size: 7.5pt; }
    body[data-print-font-size="large"] { --print-text-size: 8.2pt; }
    body[data-print-font-size="x-large"] { --print-text-size: 8.8pt; }
    body[data-print-font-size="xx-large"] { --print-text-size: 9.5pt; }
    .print-toolbar { position: sticky; top: 0; z-index: 10; display: flex; flex-wrap: wrap; align-items: end; justify-content: flex-end; gap: 12px; padding: 8px 16px; background: #132638; border-bottom: 1px solid #0b1925; }
    .print-options, .print-actions { display: flex; align-items: end; gap: 8px; }
    .print-option { display: grid; gap: 4px; }
    .print-option span { color: #c7d5df; font: 700 11px/1 "Noto Sans TC", "Microsoft JhengHei", sans-serif; letter-spacing: .03em; }
    .print-option select { min-width: 150px; min-height: 44px; padding: 8px 34px 8px 10px; border: 1px solid #7890a2; border-radius: 4px; background: #fff; color: #183046; font: 700 13px/1.2 "Noto Sans TC", "Microsoft JhengHei", sans-serif; cursor: pointer; }
    .print-option:last-child select { min-width: 190px; }
    .print-option select:focus-visible { outline: 3px solid #77c7ec; outline-offset: 2px; }
    .print-option select:disabled { cursor: wait; opacity: .7; }
    .print-toolbar button { min-width: 92px; min-height: 44px; padding: 8px 16px; border: 1px solid #9eb2c3; border-radius: 4px; background: #fff; color: #183046; font: 700 14px/1 "Noto Sans TC", "Microsoft JhengHei", sans-serif; cursor: pointer; }
    .print-actions button:first-child { border-color: #4ca3cb; background: #1e6f95; color: #fff; }
    .print-toolbar button:hover { filter: brightness(.96); }
    .print-toolbar button:disabled { cursor: wait; opacity: .7; }
    .print-toolbar button:focus-visible { outline: 3px solid #77c7ec; outline-offset: 2px; }
    .print-summary { padding: 12px 16px 0; max-width: 1600px; margin: 0 auto; color: #40586a; font-size: 13px; }
    .machine-sheet { width: calc(100% - 32px); max-width: 1600px; min-height: 194mm; margin: 12px auto 24px; padding: 10mm 8mm 8mm; background: var(--paper); box-shadow: 0 8px 24px rgba(27, 48, 65, .14); break-before: page; page-break-before: always; }
    .machine-sheet.is-first { break-before: auto; page-break-before: auto; }
    body[data-print-layout="compact"] main { width: calc(100% - 32px); max-width: 1600px; margin: 12px auto 24px; padding: 10mm 8mm 8mm; background: var(--paper); box-shadow: 0 8px 24px rgba(27, 48, 65, .14); }
    body[data-print-layout="compact"] .machine-sheet { width: 100%; max-width: none; min-height: 0; margin: 0; padding: 0; box-shadow: none; break-before: auto; page-break-before: auto; }
    body[data-print-layout="compact"] .machine-sheet + .machine-sheet { margin-top: 6mm; padding-top: 3mm; border-top: 2px solid var(--ink); }
    .report-header { display: flex; align-items: end; justify-content: space-between; gap: 16px; padding-bottom: 5px; border-bottom: 2px solid var(--ink); }
    .report-kicker { margin: 0 0 3px; color: var(--accent); font-size: 1.18em; font-weight: 800; letter-spacing: .16em; }
    h1 { margin: 0; font-size: 2.65em; line-height: 1.1; letter-spacing: .02em; }
    .machine-mark { display: grid; grid-template-columns: auto auto; align-items: baseline; gap: 8px; min-width: 120px; padding: 5px 8px; border: 1px solid var(--ink); }
    .machine-mark span { color: var(--muted); font-size: 1.18em; font-weight: 700; letter-spacing: .08em; }
    .machine-mark strong { font-size: 2.35em; line-height: 1; }
    .machine-continuation { display: flex; justify-content: flex-end; padding-bottom: 4px; border-bottom: 1px solid var(--ink); }
    .machine-continuation .machine-mark { min-width: 104px; padding: 3px 6px; }
    .machine-continuation .machine-mark strong { font-size: 1.75em; }
    .report-meta { display: flex; flex-wrap: wrap; gap: 6px 18px; padding: 5px 0; color: var(--muted); font-size: 1.03em; border-bottom: 1px solid var(--line-soft); }
    table { width: 100%; margin-top: 5px; border-collapse: collapse; table-layout: fixed; }
    thead { display: table-header-group; }
    .native-print-machine-code { display: none; }
    .report-header, .report-meta, thead { break-after: avoid; page-break-after: avoid; }
    tr { break-inside: avoid; page-break-inside: avoid; }
    th, td { padding: 3px 3px; border: 1px solid var(--line); vertical-align: middle; overflow-wrap: anywhere; }
    th { background: #e9eff3; color: #20384b; font-size: .97em; font-weight: 800; line-height: 1.25; text-align: center; }
    td { font-size: 1em; line-height: 1.3; }
    tbody tr:nth-child(even) td { background: #f7f9fa; }
    .row-number { width: 24px; text-align: center; color: var(--muted); }
    td.is-number { text-align: right; white-space: nowrap; }
    .pdf-render-host { position: fixed; left: 0; top: 0; z-index: -2147483648; width: 281mm; pointer-events: none; }
    .pdf-render-page { width: 281mm; height: 194mm; overflow: hidden; background: #fff; }
    .pdf-render-page .machine-sheet { width: 100%; max-width: none; min-height: 0; margin: 0; padding: 0; box-shadow: none; break-before: auto; page-break-before: auto; }
    .pdf-render-page .machine-sheet.is-compact-following { margin-top: 3mm; padding-top: 2mm; border-top: 2px solid var(--ink); }
    .pdf-render-page table { min-width: 0; }
    @page { size: A4 landscape; margin: 8mm; }
    @media print {
      html, body { background: #fff; }
      .no-print { display: none !important; }
      main, body[data-print-layout="compact"] main { width: auto; max-width: none; margin: 0; padding: 0; background: #fff; box-shadow: none; }
      .machine-sheet { width: auto; max-width: none; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
      body[data-print-layout="compact"] .machine-sheet { break-before: auto; page-break-before: auto; }
      body[data-print-layout="compact"] .machine-sheet + .machine-sheet { margin-top: 3mm; padding-top: 2mm; border-top: 2px solid var(--ink); }
      body[data-print-layout="machine-page"] .machine-sheet { break-before: page; page-break-before: always; }
      body[data-print-layout="machine-page"] .machine-sheet.is-first { break-before: auto; page-break-before: auto; }
      .report-header { padding-top: 0; }
      th.row-number { width: 42px; }
      .native-print-machine-code { display: grid; min-width: 0; max-width: 100%; gap: 1px; color: var(--ink); line-height: 1; white-space: normal; }
      .native-print-machine-code span { color: var(--muted); font-size: .72em; letter-spacing: .04em; white-space: nowrap; }
      .native-print-machine-code strong { min-width: 0; font-size: 1.05em; line-height: 1.05; overflow-wrap: anywhere; }
      .native-print-machine-code + .row-number-label { display: none; }
      * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
    @media screen and (max-width: 900px) {
      .machine-sheet, body[data-print-layout="compact"] main { width: calc(100% - 16px); margin-top: 8px; padding: 16px 12px; }
      .machine-sheet { overflow-x: auto; }
      body[data-print-layout="compact"] .machine-sheet { width: 100%; padding: 0; }
      table { min-width: 1180px; }
    }
    @media screen and (max-width: 700px) {
      .print-toolbar { position: static; align-items: stretch; padding: 8px; }
      .print-options { flex: 1 1 100%; flex-wrap: wrap; }
      .print-actions { margin-left: auto; }
      .print-option { flex: 1 1 180px; }
      .print-option select { width: 100%; min-width: 0; font-size: 16px; }
    }
  </style>
</head>
<body data-print-font-size="medium" data-print-layout="compact">
  <div class="print-toolbar no-print">
    <div class="print-options" role="group" aria-label="${escapeHtml(copy.printOptions)}">
      <label class="print-option"><span>${escapeHtml(copy.fontSize)}</span><select id="work-report-font-size-action" aria-label="${escapeHtml(copy.fontSize)}"><option value="small">${escapeHtml(copy.fontSmall)}</option><option value="medium" selected>${escapeHtml(copy.fontMedium)}</option><option value="large">${escapeHtml(copy.fontLarge)}</option><option value="x-large">${escapeHtml(copy.fontExtraLarge)}</option><option value="xx-large">${escapeHtml(copy.fontExtraExtraLarge)}</option></select></label>
      <label class="print-option"><span>${escapeHtml(copy.layout)}</span><select id="work-report-layout-action" aria-label="${escapeHtml(copy.layout)}"><option value="compact" selected>${escapeHtml(copy.compactLayout)}</option><option value="machine-page">${escapeHtml(copy.machinePageLayout)}</option></select></label>
    </div>
    <div class="print-actions"><button id="work-report-print-action" type="button">${escapeHtml(copy.print)}</button><button id="work-report-pdf-action" type="button" data-pdf-filename="${escapeHtml(pdfFilename)}" data-loading-text="${escapeHtml(copy.downloadingPdf)}" data-error-text="${escapeHtml(copy.downloadPdfFailed)}" data-page-unit="${escapeHtml(copy.renderedPages)}">${escapeHtml(copy.downloadPdf)}</button><button id="work-report-close-action" type="button">${escapeHtml(copy.close)}</button></div>
  </div>
  <p class="print-summary no-print">${records.length} ${escapeHtml(copy.records)} · ${machineGroups.length} ${escapeHtml(copy.machines)}</p>
  <main>${machineSections}</main>
</body>
</html>`;
}

export function writeWorkReportPrintWindow(target: Window, documentHtml: string): void {
  target.document.open();
  target.document.write(documentHtml);
  target.document.close();
  target.document
    .getElementById("work-report-print-action")
    ?.addEventListener("click", () => target.print());
  const fontSizeAction = target.document.getElementById(
    "work-report-font-size-action"
  ) as HTMLSelectElement | null;
  fontSizeAction?.addEventListener("change", () => {
    target.document.body.dataset.printFontSize = fontSizeAction.value;
  });
  const layoutAction = target.document.getElementById(
    "work-report-layout-action"
  ) as HTMLSelectElement | null;
  layoutAction?.addEventListener("change", () => {
    target.document.body.dataset.printLayout = layoutAction.value;
  });
  const pdfAction = target.document.getElementById(
    "work-report-pdf-action"
  ) as HTMLButtonElement | null;
  pdfAction?.addEventListener("click", async () => {
    const idleText = pdfAction.textContent;
    pdfAction.disabled = true;
    if (fontSizeAction) {
      fontSizeAction.disabled = true;
    }
    if (layoutAction) {
      layoutAction.disabled = true;
    }
    pdfAction.setAttribute("aria-busy", "true");
    pdfAction.textContent = pdfAction.dataset.loadingText ?? idleText;
    try {
      await downloadWorkReportPdf(
        target.document,
        pdfAction.dataset.pdfFilename ?? "work-report.pdf",
        ({ completedMachines, totalMachines, renderedPages }) => {
          const pageProgress = renderedPages > 0
            ? ` · ${renderedPages} ${pdfAction.dataset.pageUnit ?? "pages"}`
            : "";
          pdfAction.textContent = `${pdfAction.dataset.loadingText ?? idleText} ${completedMachines}/${totalMachines}${pageProgress}`;
        }
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      target.alert(`${pdfAction.dataset.errorText ?? "PDF download failed"}\n${errorMessage}`);
    } finally {
      pdfAction.disabled = false;
      if (fontSizeAction) {
        fontSizeAction.disabled = false;
      }
      if (layoutAction) {
        layoutAction.disabled = false;
      }
      pdfAction.removeAttribute("aria-busy");
      pdfAction.textContent = idleText;
    }
  });
  target.document
    .getElementById("work-report-close-action")
    ?.addEventListener("click", () => target.close());
}

export function isWorkReportPrintRecordCountAllowed(recordCount: number): boolean {
  return recordCount <= WORK_REPORT_PRINT_MAX_RECORDS;
}

export async function fetchWorkReportPrintRecords(
  hydrateAllRecords: (
    forceRefresh?: boolean,
    options?: { reloadFromBackend?: boolean }
  ) => Promise<WorkReportRecord[]>
): Promise<WorkReportRecord[]> {
  return hydrateAllRecords(false);
}

export function isActiveSortOrderTask(
  task: WorkReportQueueTask,
  formId: WorkReportFormId
): boolean {
  return (
    task.formId === formId &&
    task.taskType === "update-report" &&
    (task.operationKind === "update-sort-order" || task.operationKind == null) &&
    (task.status === "pending" || task.status === "running")
  );
}

export async function fetchActiveSortOrderTasks(
  formId: WorkReportFormId,
  fetchTasks: FetchQueueTasks
): Promise<WorkReportQueueTask[]> {
  const [pendingTasks, runningTasks] = await Promise.all([
    fetchTasks(formId, {
      status: "pending",
      taskType: "update-report",
      limit: 200,
    }),
    fetchTasks(formId, {
      status: "running",
      taskType: "update-report",
      limit: 200,
    }),
  ]);
  return [...pendingTasks, ...runningTasks].filter((task) =>
    isActiveSortOrderTask(task, formId)
  );
}

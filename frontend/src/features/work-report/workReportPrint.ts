import type {
  WorkReportBlockingScheduleMutationSummary,
  WorkReportRecord,
} from "../../api/workReport";
import type { UiLanguage, WorkReportFormId } from "./types";
import { getColumnCellValue, parseSemanticBoolean } from "./utils";
import {
  getDefaultWorkReportPrintColumnKeys,
  getWorkReportPrintColumnLabel,
  getWorkReportPrintColumns,
  getWorkReportPrintColumnWidthWeights,
  getWorkReportPrintColumnWidths,
  loadWorkReportPrintColumnKeys,
  resetWorkReportPrintColumnKeys,
  saveWorkReportPrintColumnKeys,
  type WorkReportPrintColumn,
} from "./workReportPrintColumns";
import { downloadWorkReportPdf } from "./workReportPdf";

interface WorkReportPrintDocumentOptions {
  formId: WorkReportFormId;
  records: WorkReportRecord[];
  language: UiLanguage;
  generatedAt?: Date;
}

export const WORK_REPORT_PRINT_MAX_RECORDS = 500;

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
      ? formId === "901"
        ? "Process A Schedule"
        : "Process B Schedule"
      : formId === "901"
        ? "製程 A 排程表"
        : "製程 B 排程表",
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
    columns: isEnglish ? "Columns" : "欄位設定",
    columnsTitle: isEnglish ? "Print columns" : "列印欄位",
    columnsHint: isEnglish
      ? "Changes apply to preview, print, and PDF."
      : "調整會同步套用預覽、列印與 PDF。",
    selected: isEnglish ? "selected" : "個已選",
    selectAll: isEnglish ? "Select all" : "全選",
    resetColumns: isEnglish ? "Reset defaults" : "重設預設",
    finishColumns: isEnglish ? "Done" : "完成",
    manyColumns: isEnglish
      ? "Many columns selected. Use a smaller font if the table feels crowded."
      : "欄位較多；若表格擁擠，建議改用較小字體。",
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
  const columns = getWorkReportPrintColumns(formId);
  const defaultVisibleColumnKeys = getDefaultWorkReportPrintColumnKeys(formId);
  const defaultVisibleColumnKeySet = new Set(defaultVisibleColumnKeys);
  const columnWidthWeights = getWorkReportPrintColumnWidthWeights(
    formId,
    records,
    language
  );
  const defaultColumnWidths = getWorkReportPrintColumnWidths(
    formId,
    defaultVisibleColumnKeys,
    columnWidthWeights
  );
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
    .map((column) => {
      const hidden = defaultVisibleColumnKeySet.has(column.key) ? "" : " hidden";
      return `<th scope="col" data-column-key="${escapeHtml(column.key)}"${hidden}>${escapeHtml(getWorkReportPrintColumnLabel(column, language))}</th>`;
    })
    .join("");
  const columnGroup = `<colgroup>${columns
    .map((column) => {
      const hidden = defaultVisibleColumnKeySet.has(column.key) ? "" : " hidden";
      const width = defaultColumnWidths.get(column.key) ?? 0;
      const weight = columnWidthWeights.get(column.key) ?? column.widthWeight;
      return `<col data-column-key="${escapeHtml(column.key)}" data-column-weight="${weight.toFixed(4)}" style="width:${width.toFixed(4)}%"${hidden} />`;
    })
    .join("")}</colgroup>`;
  const columnOptions = columns
    .map((column) => {
      const checked = defaultVisibleColumnKeySet.has(column.key) ? " checked" : "";
      return `<label class="print-column-item"><input type="checkbox" value="${escapeHtml(column.key)}"${checked} /><span>${escapeHtml(getWorkReportPrintColumnLabel(column, language))}</span></label>`;
    })
    .join("");
  const documentHeader = `<header class="report-header">
    <div>
      <p class="report-kicker">DEMOCO · ${escapeHtml(copy.formLabel)}</p>
      <h1>${escapeHtml(copy.title)}</h1>
    </div>
  </header>
  <div class="report-meta">
    <span>${records.length} ${escapeHtml(copy.records)}</span>
    <span>${machineGroups.length} ${escapeHtml(copy.machines)}</span>
    <span>${escapeHtml(copy.generatedAt)} ${escapeHtml(generatedAtText)}</span>
    <span>${escapeHtml(copy.source)}</span>
  </div>`;
  const machineSections = machineGroups
    .map(({ machineCode, records: machineRecords }, machineIndex) => {
      const displayMachineCode =
        machineCode === "未指定機台" ? copy.unassignedMachine : machineCode;
      const tableRows = machineRecords
        .map((record) => {
          const cells = columns
            .map((column) => {
              const value = formatPrintValue(
                getColumnCellValue(record, column.key),
                column.format
              );
              const className = column.format === "number" ? " class=\"is-number\"" : "";
              const hidden = defaultVisibleColumnKeySet.has(column.key) ? "" : " hidden";
              return `<td${className} data-column-key="${escapeHtml(column.key)}"${hidden}>${escapeHtml(value)}</td>`;
            })
            .join("");
          return `<tr>${cells}</tr>`;
        })
        .join("");
      return `<section class="machine-sheet${machineIndex === 0 ? " is-first" : ""}">
  ${machineIndex === 0 ? documentHeader : ""}
  <header class="machine-header">
    <div class="machine-mark"><span>${escapeHtml(copy.machine)}</span><strong>${escapeHtml(displayMachineCode)}</strong></div>
    <span class="machine-record-count">${machineRecords.length} ${escapeHtml(copy.records)}</span>
  </header>
  <table>
    ${columnGroup}
    <thead><tr class="native-print-machine-row"><th colspan="${columns.length}"><span class="native-print-machine-code"><span>${escapeHtml(copy.machine)}</span><strong>${escapeHtml(displayMachineCode)}</strong></span></th></tr><tr>${columnHeaders}</tr></thead>
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
    .print-column-control { position: relative; align-self: end; }
    .print-column-trigger { min-width: 132px !important; }
    .print-column-trigger[aria-expanded="true"] { border-color: #77c7ec; box-shadow: inset 0 -3px 0 #1e6f95; }
    .print-column-panel { position: fixed; top: 68px; right: 16px; z-index: 30; width: min(420px, calc(100vw - 32px)); max-height: calc(100vh - 84px); overflow: auto; padding: 16px; border: 1px solid #7890a2; border-radius: 6px; background: #f8fafb; color: #183046; box-shadow: 0 16px 40px rgba(8, 22, 34, .32); }
    .print-column-panel[hidden], [data-column-key][hidden] { display: none !important; }
    .print-column-panel header { padding-bottom: 12px; border-bottom: 1px solid #cbd6de; }
    .print-column-panel h2 { margin: 0; font-size: 18px; line-height: 1.25; }
    .print-column-panel header p { margin: 6px 0 0; color: #52697a; font-size: 13px; line-height: 1.45; }
    .print-column-count { margin: 12px 0 8px; color: #27495f; font-size: 13px; font-weight: 800; }
    .print-column-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 12px; }
    .print-column-item { display: flex; align-items: center; gap: 9px; min-height: 44px; padding: 7px 8px; border-bottom: 1px solid #e1e7eb; cursor: pointer; }
    .print-column-item:hover { background: #eaf2f6; }
    .print-column-item input { width: 18px; height: 18px; margin: 0; accent-color: #17688b; }
    .print-column-item input:focus-visible { outline: 3px solid #77c7ec; outline-offset: 2px; }
    .print-column-item input:disabled + span { color: #8293a0; }
    .print-column-item span { min-width: 0; font-size: 14px; font-weight: 700; line-height: 1.35; }
    .print-column-warning { margin: 10px 0 0; padding: 8px 10px; border-left: 3px solid #bc7a15; background: #fff4df; color: #704809; font-size: 12px; line-height: 1.45; }
    .print-column-panel footer { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; padding-top: 12px; }
    .print-column-panel footer button { min-width: 88px; }
    .print-column-done { border-color: #1e6f95 !important; background: #1e6f95 !important; color: #fff !important; }
    .print-summary { padding: 12px 16px 0; max-width: 1600px; margin: 0 auto; color: #40586a; font-size: 13px; }
    .machine-sheet { width: calc(100% - 32px); max-width: 1600px; min-height: 194mm; margin: 12px auto 24px; padding: 10mm 8mm 8mm; background: var(--paper); box-shadow: 0 8px 24px rgba(27, 48, 65, .14); break-before: page; page-break-before: always; }
    .machine-sheet.is-first { break-before: auto; page-break-before: auto; }
    body[data-print-layout="compact"] main { width: calc(100% - 32px); max-width: 1600px; margin: 12px auto 24px; padding: 10mm 8mm 8mm; background: var(--paper); box-shadow: 0 8px 24px rgba(27, 48, 65, .14); }
    body[data-print-layout="compact"] .machine-sheet { width: 100%; max-width: none; min-height: 0; margin: 0; padding: 0; box-shadow: none; break-before: auto; page-break-before: auto; }
    body[data-print-layout="compact"] .machine-sheet + .machine-sheet { margin-top: 6mm; padding-top: 3mm; border-top: 2px solid var(--ink); }
    .report-header { padding-bottom: 5px; border-bottom: 2px solid var(--ink); }
    .report-kicker { margin: 0 0 3px; color: var(--accent); font-size: 1.18em; font-weight: 800; letter-spacing: .16em; }
    h1 { margin: 0; font-size: 2.65em; line-height: 1.1; letter-spacing: .02em; }
    .machine-header { display: flex; align-items: center; justify-content: flex-start; gap: 10px; padding: 5px 0 2px; border-bottom: 1px solid var(--line-soft); }
    .machine-mark { display: inline-grid; grid-template-columns: auto auto; align-items: baseline; gap: 8px; min-width: 112px; padding: 5px 8px; border: 1px solid var(--ink); }
    .machine-mark span { color: var(--muted); font-size: 1.18em; font-weight: 700; letter-spacing: .08em; }
    .machine-mark strong { font-size: 2.35em; line-height: 1; }
    .machine-record-count { color: var(--muted); font-size: 1.03em; font-weight: 700; }
    .machine-continuation { display: flex; justify-content: flex-start; padding-bottom: 4px; border-bottom: 1px solid var(--ink); }
    .machine-continuation .machine-mark { min-width: 901px; padding: 3px 6px; }
    .machine-continuation .machine-mark strong { font-size: 1.75em; }
    .report-meta { display: flex; flex-wrap: wrap; gap: 6px 18px; padding: 5px 0; color: var(--muted); font-size: 1.03em; border-bottom: 1px solid var(--line-soft); }
    table { width: 100%; margin-top: 5px; border-collapse: collapse; table-layout: fixed; }
    thead { display: table-header-group; }
    .native-print-machine-row, .native-print-machine-code { display: none; }
    .report-header, .report-meta, .machine-header, thead { break-after: avoid; page-break-after: avoid; }
    tr { break-inside: avoid; page-break-inside: avoid; }
    th, td { padding: 3px 3px; border: 1px solid var(--line); vertical-align: middle; overflow-wrap: anywhere; }
    th { background: #e9eff3; color: #20384b; font-size: .97em; font-weight: 800; line-height: 1.25; text-align: center; }
    td { font-size: 1em; line-height: 1.3; }
    tbody tr:nth-child(even) td { background: #f7f9fa; }
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
      .native-print-machine-row { display: table-row; }
      .native-print-machine-row th { padding: 3px 6px; text-align: left; }
      .native-print-machine-code { display: grid; grid-template-columns: max-content max-content; justify-content: start; align-items: baseline; gap: 8px; min-width: 0; max-width: 100%; color: var(--ink); line-height: 1; white-space: normal; }
      .native-print-machine-code span { color: var(--muted); font-size: .72em; letter-spacing: .04em; white-space: nowrap; }
      .native-print-machine-code strong { min-width: 0; font-size: 1.05em; line-height: 1.05; overflow-wrap: anywhere; }
      * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
    @media screen and (max-width: 900px) {
      .machine-sheet, body[data-print-layout="compact"] main { width: calc(100% - 16px); margin-top: 8px; padding: 16px 12px; }
      .machine-sheet { overflow-x: auto; }
      body[data-print-layout="compact"] .machine-sheet { width: 100%; padding: 0; }
      table { min-width: var(--print-table-min-width, 1180px); }
    }
    @media screen and (max-width: 700px) {
      .print-toolbar { position: static; align-items: stretch; padding: 8px; }
      .print-options { flex: 1 1 100%; flex-wrap: wrap; }
      .print-actions { margin-left: auto; }
      .print-option { flex: 1 1 180px; }
      .print-option select { width: 100%; min-width: 0; font-size: 16px; }
      .print-column-control { flex: 1 1 100%; }
      .print-column-trigger { width: 100%; }
      .print-column-panel { inset: 8px; width: auto; max-height: calc(100vh - 16px); }
      .print-column-list { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body data-print-font-size="medium" data-print-layout="compact" data-print-form-id="${formId}" data-print-visible-columns="${escapeHtml(defaultVisibleColumnKeys.join(","))}">
  <div class="print-toolbar no-print">
    <div class="print-options" role="group" aria-label="${escapeHtml(copy.printOptions)}">
      <label class="print-option"><span>${escapeHtml(copy.fontSize)}</span><select id="work-report-font-size-action" aria-label="${escapeHtml(copy.fontSize)}"><option value="small">${escapeHtml(copy.fontSmall)}</option><option value="medium" selected>${escapeHtml(copy.fontMedium)}</option><option value="large">${escapeHtml(copy.fontLarge)}</option><option value="x-large">${escapeHtml(copy.fontExtraLarge)}</option><option value="xx-large">${escapeHtml(copy.fontExtraExtraLarge)}</option></select></label>
      <label class="print-option"><span>${escapeHtml(copy.layout)}</span><select id="work-report-layout-action" aria-label="${escapeHtml(copy.layout)}"><option value="compact" selected>${escapeHtml(copy.compactLayout)}</option><option value="machine-page">${escapeHtml(copy.machinePageLayout)}</option></select></label>
      <div class="print-column-control">
        <button id="work-report-column-action" class="print-column-trigger" type="button" aria-expanded="false" aria-controls="work-report-column-panel" data-label="${escapeHtml(copy.columns)}">${escapeHtml(copy.columns)} · ${defaultVisibleColumnKeys.length}</button>
        <section id="work-report-column-panel" class="print-column-panel" role="dialog" aria-modal="false" aria-label="${escapeHtml(copy.columnsTitle)}" hidden>
          <header><h2>${escapeHtml(copy.columnsTitle)}</h2><p>${escapeHtml(copy.columnsHint)}</p></header>
          <p id="work-report-column-count" class="print-column-count">${defaultVisibleColumnKeys.length} ${escapeHtml(copy.selected)}</p>
          <div id="work-report-column-list" class="print-column-list">${columnOptions}</div>
          <p id="work-report-column-warning" class="print-column-warning"${defaultVisibleColumnKeys.length > 12 ? "" : " hidden"}>${escapeHtml(copy.manyColumns)}</p>
          <footer><button id="work-report-column-all" type="button">${escapeHtml(copy.selectAll)}</button><button id="work-report-column-reset" type="button">${escapeHtml(copy.resetColumns)}</button><button id="work-report-column-done" class="print-column-done" type="button">${escapeHtml(copy.finishColumns)}</button></footer>
        </section>
      </div>
    </div>
    <div class="print-actions"><button id="work-report-print-action" type="button">${escapeHtml(copy.print)}</button><button id="work-report-pdf-action" type="button" data-pdf-filename="${escapeHtml(pdfFilename)}" data-loading-text="${escapeHtml(copy.downloadingPdf)}" data-error-text="${escapeHtml(copy.downloadPdfFailed)}" data-page-unit="${escapeHtml(copy.renderedPages)}">${escapeHtml(copy.downloadPdf)}</button><button id="work-report-close-action" type="button">${escapeHtml(copy.close)}</button></div>
  </div>
  <p class="print-summary no-print">${records.length} ${escapeHtml(copy.records)} · ${machineGroups.length} ${escapeHtml(copy.machines)}</p>
  <main>${machineSections}</main>
</body>
</html>`;
}

function applyWorkReportPrintColumnSelection(
  document: Document,
  formId: WorkReportFormId,
  visibleColumnKeys: readonly string[]
): void {
  const columns = getWorkReportPrintColumns(formId);
  const availableKeys = new Set(columns.map((column) => column.key));
  const visibleKeys = new Set(
    visibleColumnKeys.filter((key) => availableKeys.has(key))
  );
  if (visibleKeys.size === 0) {
    for (const key of getDefaultWorkReportPrintColumnKeys(formId)) {
      visibleKeys.add(key);
    }
  }
  const orderedVisibleKeys = columns
    .map((column) => column.key)
    .filter((key) => visibleKeys.has(key));
  const widthWeights = new Map(
    Array.from(
      document.querySelectorAll<HTMLTableColElement>("col[data-column-key]")
    ).map((column) => [
      column.dataset.columnKey ?? "",
      Number.parseFloat(column.dataset.columnWeight ?? ""),
    ])
  );
  const widths = getWorkReportPrintColumnWidths(
    formId,
    orderedVisibleKeys,
    widthWeights
  );

  document.body.dataset.printVisibleColumns = orderedVisibleKeys.join(",");
  document.documentElement.style.setProperty(
    "--print-table-min-width",
    `${Math.max(760, 180 + orderedVisibleKeys.length * 68)}px`
  );
  for (const element of document.querySelectorAll<HTMLElement>("[data-column-key]")) {
    const key = element.dataset.columnKey ?? "";
    const visible = visibleKeys.has(key);
    element.hidden = !visible;
    if (element.tagName === "COL") {
      element.style.width = visible ? `${(widths.get(key) ?? 0).toFixed(4)}%` : "0";
    }
  }

  const checkboxes = Array.from(
    document.querySelectorAll<HTMLInputElement>("#work-report-column-list input[type=checkbox]")
  );
  for (const checkbox of checkboxes) {
    checkbox.checked = visibleKeys.has(checkbox.value);
    checkbox.disabled = visibleKeys.size === 1 && checkbox.checked;
  }
  const action = document.getElementById(
    "work-report-column-action"
  ) as HTMLButtonElement | null;
  if (action) {
    action.textContent = `${action.dataset.label ?? "Columns"} · ${visibleKeys.size}`;
  }
  const count = document.getElementById("work-report-column-count");
  if (count) {
    const language: UiLanguage = document.documentElement.lang === "en" ? "en" : "zh";
    count.textContent = `${visibleKeys.size} ${getPrintCopy(formId, language).selected}`;
  }
  const warning = document.getElementById("work-report-column-warning");
  if (warning) {
    warning.hidden = visibleKeys.size <= 12;
  }
}

function setupWorkReportPrintColumnControls(target: Window): {
  setDisabled: (disabled: boolean) => void;
} {
  const { document } = target;
  const formId = document.body.dataset.printFormId;
  if (formId !== "901" && formId !== "902") {
    return { setDisabled: () => undefined };
  }
  let storage: Storage | null = null;
  try {
    storage = target.localStorage;
  } catch {
    storage = null;
  }

  const action = document.getElementById(
    "work-report-column-action"
  ) as HTMLButtonElement | null;
  const panel = document.getElementById("work-report-column-panel");
  const allAction = document.getElementById(
    "work-report-column-all"
  ) as HTMLButtonElement | null;
  const resetAction = document.getElementById(
    "work-report-column-reset"
  ) as HTMLButtonElement | null;
  const doneAction = document.getElementById(
    "work-report-column-done"
  ) as HTMLButtonElement | null;
  const checkboxes = Array.from(
    document.querySelectorAll<HTMLInputElement>("#work-report-column-list input[type=checkbox]")
  );

  const closePanel = () => {
    if (!panel || !action) return;
    panel.hidden = true;
    action.setAttribute("aria-expanded", "false");
  };
  const setSelection = (keys: readonly string[], persist: boolean) => {
    const selectedKeys = persist && storage
      ? saveWorkReportPrintColumnKeys(formId, keys, storage)
      : keys;
    applyWorkReportPrintColumnSelection(document, formId, selectedKeys);
  };

  const initialKeys = storage
    ? loadWorkReportPrintColumnKeys(formId, storage)
    : getDefaultWorkReportPrintColumnKeys(formId);
  setSelection(initialKeys, false);

  action?.addEventListener("click", () => {
    if (!panel) return;
    panel.hidden = !panel.hidden;
    action.setAttribute("aria-expanded", panel.hidden ? "false" : "true");
  });
  for (const checkbox of checkboxes) {
    checkbox.addEventListener("change", () => {
      const selectedKeys = checkboxes
        .filter((item) => item.checked)
        .map((item) => item.value);
      if (selectedKeys.length === 0) {
        checkbox.checked = true;
        return;
      }
      setSelection(selectedKeys, true);
    });
  }
  allAction?.addEventListener("click", () => {
    setSelection(getWorkReportPrintColumns(formId).map((column) => column.key), true);
  });
  resetAction?.addEventListener("click", () => {
    const defaults = storage
      ? resetWorkReportPrintColumnKeys(formId, storage)
      : getDefaultWorkReportPrintColumnKeys(formId);
    setSelection(defaults, false);
  });
  doneAction?.addEventListener("click", () => {
    closePanel();
    action?.focus();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && panel && !panel.hidden) {
      closePanel();
      action?.focus();
    }
  });
  document.addEventListener("click", (event) => {
    if (!panel || panel.hidden || !action) return;
    const targetNode = event.target as Node | null;
    if (targetNode && !panel.contains(targetNode) && !action.contains(targetNode)) {
      closePanel();
    }
  });

  return {
    setDisabled(disabled) {
      if (action) action.disabled = disabled;
      for (const control of [allAction, resetAction, doneAction, ...checkboxes]) {
        if (control) control.disabled = disabled;
      }
      if (!disabled) {
        applyWorkReportPrintColumnSelection(
          document,
          formId,
          document.body.dataset.printVisibleColumns?.split(",").filter(Boolean) ?? []
        );
      }
    },
  };
}

export function writeWorkReportPrintWindow(target: Window, documentHtml: string): void {
  target.document.open();
  target.document.write(documentHtml);
  target.document.close();
  const columnControls = setupWorkReportPrintColumnControls(target);
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
    columnControls.setDisabled(true);
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
      columnControls.setDisabled(false);
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
  return hydrateAllRecords(false, { reloadFromBackend: true });
}

export function isWorkReportPrintBlockedByScheduleMutation(
  summary: WorkReportBlockingScheduleMutationSummary
): boolean {
  return summary.hasBlockingScheduleMutation || summary.count > 0;
}

import { readFile } from "fs/promises";
import axios from "axios";
import JSZip from "jszip";
import { env } from "../../config/env";
import { HttpError } from "../../utils/httpError";

export interface PivotAnalysisExport {
  filename: string;
  contentType: string;
  body: Buffer;
}

// 抓 REPORT_EXCEL_CSV（Ragic 發佈網址、view 已篩好）→ 解析 CSV →
// 灌進 templates/pivot-analysis-template.xlsx 的「Ragic列表」分頁 → 回成品 xlsx。
// 範本的 10 張樞紐/分析表一個位元組都不動；樞紐快取設 refreshOnLoad，
// 使用者用 Excel 開檔時會自動以新資料重整（LibreOffice 不支援，需手動 refresh）。
// 注入手法與驗證過的 fill_report.py 相同：值用 inlineStr/數值寫入、樣式沿用範本
// 各欄既有 style，完全不碰 sharedStrings 索引。

const TEMPLATE_PATH = "./templates/pivot-analysis-template.xlsx";
const COLUMN_COUNT = 65;

// CSV 欄型別（0-based，對應範本 A..BM）：
//   TEXT_FORCE = 代碼/編號欄。'202605'、'20260501'、客戶代碼這種「長得像數字的代碼」
//                一轉數字就掉前導零/變型，樞紐與 SUMIFS 分組會對不上，必須鎖文字。
//   DATE_COL / DATETIME_COL = 轉 Excel 日期序號（範本該欄樣式本來就是日期格式）。
//   其餘欄：能 parse 成數字就存數字（分鐘/數量/時數要可加總），不能就存文字。
const TEXT_FORCE = new Set([
  0, 1, 2, 3, 4, 6, 7, 8, 9, 18, 19, 20, 21,
  45, 46, 47, 49, 50, 51, 52, 53, 56, 62, 63,
]);
const DATE_COL = 5;
const DATETIME_COL = 48;
// Excel 日期序號的 epoch（1900 系統含 1900/2/29 bug 的慣例基準）
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

function columnLetter(index1: number): string {
  let n = index1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const COLS = Array.from({ length: COLUMN_COUNT }, (_, i) => columnLetter(i + 1));

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unescapeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// RFC 4180：引號欄位可含逗號/換行/雙引號跳脫（Remark備註會有），不能用 split 偷懶。
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function toSerialDate(value: string): number | null {
  const m = value.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (!m) return null;
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(utc)) return null;
  return Math.round((utc - EXCEL_EPOCH_UTC) / 86_400_000);
}

function toSerialDatetime(value: string): number | null {
  const m = value.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(utc)) return null;
  const days = Math.round((utc - EXCEL_EPOCH_UTC) / 86_400_000);
  const secs = Number(m[4]) * 3600 + Number(m[5]) * 60 + Number(m[6] ?? 0);
  return days + secs / 86_400;
}

// sharedStrings 的 <si> 可能是 rich text（多段 <t>），串接所有 <t> 內文
function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml)) !== null) {
    const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let t: RegExpExecArray | null;
    let s = "";
    while ((t = tRe.exec(m[1])) !== null) {
      s += unescapeXml(t[1]);
    }
    out.push(s);
  }
  return out;
}

// 範本 Ragic列表 第 1 列的 65 個欄名（用來核對 CSV 欄序，欄序錯資料會全灌錯欄）
function readTemplateHeaders(sheetXml: string, sst: string[]): string[] {
  const sd = sheetXml.indexOf("<sheetData>");
  const row1End = sheetXml.indexOf("</row>", sd);
  const row1 = sheetXml.slice(sd, row1End);
  const headers = new Map<string, string>();
  const cellRe = /<c r="([A-Z]+)1"([^>]*)>([\s\S]*?)<\/c>/g;
  let m: RegExpExecArray | null;
  while ((m = cellRe.exec(row1)) !== null) {
    const v = m[3].match(/<v>(\d+)<\/v>/);
    if (m[2].includes('t="s"') && v) {
      headers.set(m[1], sst[Number(v[1])] ?? "");
    }
  }
  return COLS.map((col) => headers.get(col) ?? "");
}

interface CellValue {
  kind: "text" | "num";
  value: string;
}

function classifyCsvValue(colIndex: number, value: string): CellValue {
  if (colIndex === DATE_COL) {
    const serial = toSerialDate(value);
    return serial !== null ? { kind: "num", value: String(serial) } : { kind: "text", value };
  }
  if (colIndex === DATETIME_COL) {
    const serial = toSerialDatetime(value);
    return serial !== null ? { kind: "num", value: String(serial) } : { kind: "text", value };
  }
  if (TEXT_FORCE.has(colIndex)) {
    return { kind: "text", value };
  }
  return value !== "" && Number.isFinite(Number(value))
    ? { kind: "num", value }
    : { kind: "text", value };
}

class Form16PivotAnalysisExportService {
  // 灌「應出勤天數」進 3 張機台運轉分析表的 F 欄（A 欄有機台的列才填，總計列跳過）。
  // 這欄是人工月參數（當月工作天數），不在 Ragic 資料裡；不填的話
  // 量產應稼動天數 = 0 − 停機 + 加班，整張表會是負數。
  private async fillAttendanceDays(zip: JSZip, sst: string[], days: number): Promise<void> {
    const readEntry = async (name: string): Promise<string> => {
      const file = zip.file(name);
      if (!file) {
        throw new HttpError(500, `分析表範本缺少 ${name}，範本檔可能毀損。`, "PIVOT_TEMPLATE_BROKEN");
      }
      return file.async("string");
    };
    const relsXml = await readEntry("xl/_rels/workbook.xml.rels");
    const workbookXml = await readEntry("xl/workbook.xml");
    const rels = new Map<string, string>();
    const relRe = /<Relationship Id="(rId\d+)"[^>]*Target="([^"]+)"/g;
    let rm: RegExpExecArray | null;
    while ((rm = relRe.exec(relsXml)) !== null) {
      rels.set(rm[1], rm[2]);
    }
    const sheetRe = /<sheet name="([^"]*)"[^>]*r:id="(rId\d+)"/g;
    let sm: RegExpExecArray | null;
    while ((sm = sheetRe.exec(workbookXml)) !== null) {
      if (!sm[1].includes("機台運轉分析表")) continue;
      const target = rels.get(sm[2]);
      if (!target) continue;
      const path = target.startsWith("xl/") ? target : `xl/${target.replace(/^\//, "")}`;
      let sheetXml = await readEntry(path);

      // A 欄有文字（機台代號）且非總計的列 = 機台列
      const machineRows: number[] = [];
      const aCellRe = /<c r="A(\d+)"([^>]*)>([\s\S]*?)<\/c>/g;
      let am: RegExpExecArray | null;
      while ((am = aCellRe.exec(sheetXml)) !== null) {
        const rowNum = Number(am[1]);
        if (rowNum < 4) continue;
        let text = "";
        const v = am[3].match(/<v>(\d+)<\/v>/);
        if (am[2].includes('t="s"') && v) {
          text = sst[Number(v[1])] ?? "";
        } else if (am[2].includes('t="inlineStr"')) {
          const t = am[3].match(/<t[^>]*>([\s\S]*?)<\/t>/);
          text = t ? unescapeXml(t[1]) : "";
        }
        if (text.trim() !== "" && !text.includes("總計")) {
          machineRows.push(rowNum);
        }
      }
      for (const rowNum of machineRows) {
        const cellRe = new RegExp(`<c r="F${rowNum}"([^>]*?)(?:/>|>[\\s\\S]*?</c>)`);
        const cm = cellRe.exec(sheetXml);
        if (!cm) continue;
        const attrs = cm[1].replace(/\s*t="[^"]*"/, "");
        sheetXml =
          sheetXml.slice(0, cm.index) +
          `<c r="F${rowNum}"${attrs}><v>${days}</v></c>` +
          sheetXml.slice(cm.index + cm[0].length);
      }
      zip.file(path, sheetXml);
    }
  }

  // 拆出來讓測試可以直接餵 CSV 文字 + 範本 buffer，不用過 HTTP / 不用打 Ragic
  async buildWorkbook(csvText: string, templateBuf: Buffer, attendanceDays?: number): Promise<Buffer> {
    const zip = await JSZip.loadAsync(templateBuf);
    const readEntry = async (name: string): Promise<string> => {
      const file = zip.file(name);
      if (!file) {
        throw new HttpError(500, `分析表範本缺少 ${name}，範本檔可能毀損。`, "PIVOT_TEMPLATE_BROKEN");
      }
      return file.async("string");
    };

    const sheetXml = await readEntry("xl/worksheets/sheet1.xml");
    const sstXml = await readEntry("xl/sharedStrings.xml");
    const sst = parseSharedStrings(sstXml);

    const rows = parseCsv(csvText).filter((row) => row.some((c) => c.trim() !== ""));
    if (rows.length < 2) {
      throw new HttpError(502, "Ragic 發佈網址回的 CSV 沒有資料列。", "PIVOT_CSV_EMPTY");
    }
    const expected = readTemplateHeaders(sheetXml, sst).map((h) => h.trim());
    const got = rows[0].slice(0, COLUMN_COUNT).map((h) => h.trim());
    const mismatches = expected
      .map((exp, i) => ({ i, exp, got: got[i] ?? "" }))
      .filter((x) => x.exp !== x.got);
    if (mismatches.length > 0) {
      const detail = mismatches
        .slice(0, 3)
        .map((x) => `第${x.i + 1}欄 CSV=${JSON.stringify(x.got)} 範本=${JSON.stringify(x.exp)}`)
        .join("；");
      throw new HttpError(
        500,
        `CSV 欄位與範本不一致，停止匯出（欄序錯資料會全灌錯欄）：${detail}`,
        "PIVOT_CSV_HEADER_MISMATCH"
      );
    }

    // 各欄標準 style 取自範本 row2（母版每欄格式已設好），新資料列全部沿用
    const row2Match = sheetXml.match(/<row r="2"( [^>]*)>([\s\S]*?)<\/row>/);
    if (!row2Match) {
      throw new HttpError(500, "分析表範本 Ragic列表 缺少樣式列(row2)。", "PIVOT_TEMPLATE_BROKEN");
    }
    const rowAttr = row2Match[1];
    const colStyle = new Map<string, string>();
    const styleRe = /<c r="([A-Z]+)\d+" s="(\d+)"/g;
    let sm: RegExpExecArray | null;
    while ((sm = styleRe.exec(row2Match[0])) !== null) {
      colStyle.set(sm[1], sm[2]);
    }

    const parts: string[] = [];
    let rowNumber = 1;
    for (const row of rows.slice(1)) {
      rowNumber += 1;
      parts.push(`<row r="${rowNumber}"${rowAttr}>`);
      for (let i = 0; i < COLUMN_COUNT; i += 1) {
        const ref = `${COLS[i]}${rowNumber}`;
        const style = colStyle.get(COLS[i]) ?? "0";
        const raw = (row[i] ?? "").trim();
        if (raw === "") {
          parts.push(`<c r="${ref}" s="${style}"/>`);
          continue;
        }
        const cell = classifyCsvValue(i, raw);
        if (cell.kind === "num") {
          parts.push(`<c r="${ref}" s="${style}"><v>${cell.value}</v></c>`);
        } else {
          parts.push(
            `<c r="${ref}" s="${style}" t="inlineStr"><is>` +
              `<t xml:space="preserve">${escapeXml(cell.value)}</t></is></c>`
          );
        }
      }
      parts.push("</row>");
    }
    const maxRow = rowNumber;

    const sd = sheetXml.indexOf("<sheetData>") + "<sheetData>".length;
    const row1End = sheetXml.indexOf("</row>", sd) + "</row>".length;
    const sdEnd = sheetXml.indexOf("</sheetData>");
    const newSheet = sheetXml.slice(0, row1End) + parts.join("") + sheetXml.slice(sdEnd);

    const tableXml = (await readEntry("xl/tables/table1.xml")).replace(
      /ref="A1:BM\d+"/,
      `ref="A1:BM${maxRow}"`
    );

    // 分析表公式用 INDIRECT 動態指向 Ragic列表，純改檔不會更新公式 cached 值；
    // 設 fullCalcOnLoad 讓 Excel 開檔強制全算，否則會顯示範本舊值（全 0）。
    let workbookXml = await readEntry("xl/workbook.xml");
    if (!workbookXml.includes("fullCalcOnLoad")) {
      workbookXml = workbookXml.replace(
        /<calcPr\b([^>]*?)\/?>/,
        (_, attrs: string) => `<calcPr${attrs} fullCalcOnLoad="1"/>`
      );
    }
    let pcdXml = await readEntry("xl/pivotCache/pivotCacheDefinition1.xml");
    if (!pcdXml.includes("refreshOnLoad")) {
      pcdXml = pcdXml.replace("<pivotCacheDefinition ", '<pivotCacheDefinition refreshOnLoad="1" ');
    }

    zip.file("xl/worksheets/sheet1.xml", newSheet);
    zip.file("xl/tables/table1.xml", tableXml);
    zip.file("xl/workbook.xml", workbookXml);
    zip.file("xl/pivotCache/pivotCacheDefinition1.xml", pcdXml);
    if (attendanceDays !== undefined) {
      await this.fillAttendanceDays(zip, sst, attendanceDays);
    }
    return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  }

  async exportAnalysisXlsx(attendanceDays?: number): Promise<PivotAnalysisExport> {
    const url = env.REPORT_EXCEL_CSV.trim();
    if (!url) {
      throw new HttpError(
        503,
        "尚未設定 REPORT_EXCEL_CSV（Ragic 發佈到網路的完整下載網址），無法匯出分析表。",
        "REPORT_EXCEL_CSV_NOT_CONFIGURED"
      );
    }
    if (!/^https?:\/\//i.test(url)) {
      throw new HttpError(
        500,
        "REPORT_EXCEL_CSV 需為完整網址（含 https://、APIKey、view），目前看起來不是網址。",
        "REPORT_EXCEL_CSV_NOT_A_URL"
      );
    }

    let templateBuf: Buffer;
    try {
      templateBuf = await readFile(TEMPLATE_PATH);
    } catch {
      throw new HttpError(
        500,
        `找不到分析表範本 ${TEMPLATE_PATH}，請確認部署有帶到 backend/templates/。`,
        "PIVOT_TEMPLATE_MISSING"
      );
    }

    let csvText: string;
    try {
      const response = await axios.get<ArrayBuffer>(url, {
        responseType: "arraybuffer",
        timeout: env.REPORT_EXCEL_CSV_TIMEOUT_MS,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });
      csvText = Buffer.from(response.data).toString("utf-8");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new HttpError(502, `抓取 Ragic 發佈網址失敗：${detail}`, "RAGIC_PUBLISHED_FETCH_FAILED");
    }

    const body = await this.buildWorkbook(csvText, templateBuf, attendanceDays);
    return {
      filename: "c1-6-analysis.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      body,
    };
  }
}

export const form16PivotAnalysisExportService = new Form16PivotAnalysisExportService();

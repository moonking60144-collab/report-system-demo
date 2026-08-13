import { createHash } from "node:crypto";
import { HttpError } from "../../utils/httpError";

export const FORM16_PUBLISHED_COLUMN_COUNT = 65;
export const FORM16_PUBLISHED_DATE_COLUMN_INDEX = 5;

export function parseForm16PublishedCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let index = 0;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  while (index < source.length) {
    const character = source[index];
    if (inQuotes) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += character;
      index += 1;
      continue;
    }
    if (character === '"') {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (character === ",") {
      row.push(field);
      field = "";
      index += 1;
      continue;
    }
    if (character === "\r") {
      index += 1;
      continue;
    }
    if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      index += 1;
      continue;
    }
    field += character;
    index += 1;
  }

  if (inQuotes) {
    throw new HttpError(502, "Ragic 發佈 CSV 含有未結束的引號欄位。", "PUBLISHED_CSV_INVALID");
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function normalizeDateMonth(value: string): string | null {
  const match = value.trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${match[1]}-${String(month).padStart(2, "0")}`;
}

export interface InspectedForm16PublishedCsv {
  sourceHash: string;
  rowCount: number;
  rows: string[][];
}

export function inspectForm16PublishedCsv(
  csvText: string,
  expectedPeriodMonth: string,
  maxRows: number
): InspectedForm16PublishedCsv {
  const rows = parseForm16PublishedCsv(csvText).filter((row) =>
    row.some((value) => value.trim() !== "")
  );
  if (rows.length < 2) {
    throw new HttpError(502, "Ragic 發佈網址回的 CSV 沒有資料列。", "PUBLISHED_CSV_EMPTY");
  }

  const dataRows = rows.slice(1);
  if (dataRows.length > maxRows) {
    throw new HttpError(
      413,
      `Ragic 發佈 CSV 共 ${dataRows.length} 筆，超過上限 ${maxRows} 筆。`,
      "EFFICIENCY_REPORT_SOURCE_ROW_LIMIT_EXCEEDED"
    );
  }

  const header = rows[0].map((value) => value.trim());
  if (header.length < FORM16_PUBLISHED_COLUMN_COUNT) {
    throw new HttpError(
      502,
      `Ragic 發佈 CSV 欄位數為 ${header.length}，預期 ${FORM16_PUBLISHED_COLUMN_COUNT} 欄。`,
      "PUBLISHED_CSV_HEADER_INVALID"
    );
  }

  const normalizedRows = dataRows.map((row, rowIndex) => {
    if (row.length < FORM16_PUBLISHED_COLUMN_COUNT) {
      throw new HttpError(
        502,
        `Ragic 發佈 CSV 第 ${rowIndex + 2} 列只有 ${row.length} 欄，預期至少 ${FORM16_PUBLISHED_COLUMN_COUNT} 欄。`,
        "PUBLISHED_CSV_ROW_INVALID"
      );
    }
    const normalized = row.map((value) => value.trim());
    const actualMonth = normalizeDateMonth(normalized[FORM16_PUBLISHED_DATE_COLUMN_INDEX] ?? "");
    if (actualMonth !== expectedPeriodMonth) {
      throw new HttpError(
        409,
        `Ragic 發佈 CSV 第 ${rowIndex + 2} 列日期不屬於 ${expectedPeriodMonth}。`,
        "EFFICIENCY_REPORT_PERIOD_MISMATCH"
      );
    }
    return normalized;
  });

  const stableRowKeys = normalizedRows.map((row) => JSON.stringify(row)).sort();
  const hash = createHash("sha256").update(`[${JSON.stringify(header)},[`);
  stableRowKeys.forEach((rowKey, index) => {
    if (index > 0) hash.update(",");
    hash.update(rowKey);
  });
  const sourceHash = hash.update("]]").digest("hex");

  return {
    sourceHash,
    rowCount: normalizedRows.length,
    rows,
  };
}

export function previousCompleteTaipeiMonth(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const previous = new Date(Date.UTC(year, month - 2, 1));
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function efficiencyReportRetentionCutoffMonth(now: Date, retentionMonths: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const cutoff = new Date(Date.UTC(year, month - 1 - retentionMonths, 1));
  return `${cutoff.getUTCFullYear()}-${String(cutoff.getUTCMonth() + 1).padStart(2, "0")}`;
}

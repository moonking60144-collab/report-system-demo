import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import {
  FORM16_PIVOT_CALCULATION_VERSION,
  form16PivotAnalysisExportService,
} from "../../../src/services/form16/form16PivotAnalysisExportService";

const TEMPLATE_PATH = path.resolve("templates/pivot-analysis-template.xlsx");

function unescapeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10))
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

async function buildCsvFromTemplate(templateBody: Buffer, dataRows: number): Promise<string> {
  const zip = await JSZip.loadAsync(templateBody);
  const sheetXml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
  const sharedStringsXml = await zip.file("xl/sharedStrings.xml")!.async("string");
  const sharedStrings = Array.from(sharedStringsXml.matchAll(/<si>([\s\S]*?)<\/si>/g), (match) =>
    Array.from(match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g), (text) => unescapeXml(text[1])).join("")
  );
  const row1 = sheetXml.match(/<row r="1"[^>]*>([\s\S]*?)<\/row>/)?.[1] ?? "";
  const headers = Array.from({ length: 65 }, () => "");
  for (const cell of row1.matchAll(/<c r="([A-Z]+)1"[^>]*t="s"[^>]*>[\s\S]*?<v>(\d+)<\/v>[\s\S]*?<\/c>/g)) {
    let column = 0;
    for (const character of cell[1]) {
      column = column * 26 + character.charCodeAt(0) - 64;
    }
    headers[column - 1] = sharedStrings[Number(cell[2])] ?? "";
  }

  const rows = [headers];
  for (let index = 0; index < dataRows; index += 1) {
    const row = Array.from({ length: 65 }, () => "");
    row[0] = `202606-${index + 1}`;
    row[5] = "2026/06/15";
    rows.push(row);
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function refForTag(xml: string, tag: string): string | undefined {
  return xml.match(new RegExp(`<${tag}\\b[^>]*\\bref="([^"]+)"`))?.[1];
}

test("real template 的 table、autoFilter 與 worksheet dimension 跟實際資料列同步", async (t) => {
  const templateBody = await readFile(TEMPLATE_PATH);
  assert.equal(FORM16_PIVOT_CALCULATION_VERSION, "v2");

  for (const { name, dataRows } of [
    { name: "低於範本既有範圍", dataRows: 1 },
    { name: "等於範本既有範圍", dataRows: 1938 },
    { name: "高於範本既有範圍", dataRows: 1939 },
  ]) {
    await t.test(name, async () => {
      const csvText = await buildCsvFromTemplate(templateBody, dataRows);
      const workbook = await form16PivotAnalysisExportService.buildWorkbook(csvText, templateBody);
      const zip = await JSZip.loadAsync(workbook);
      const sheetXml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
      const tableXml = await zip.file("xl/tables/table1.xml")!.async("string");
      const expectedRef = `A1:BM${dataRows + 1}`;

      assert.equal(refForTag(tableXml, "table"), expectedRef);
      assert.equal(refForTag(tableXml, "autoFilter"), expectedRef);
      assert.equal(refForTag(sheetXml, "dimension"), expectedRef);
    });
  }
});

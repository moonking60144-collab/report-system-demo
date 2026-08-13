import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

interface PdfButtonState {
  text: string;
  disabled: boolean;
  busy: string | null;
}

declare global {
  interface Window {
    __pdfQaReady?: boolean;
    __pdfButtonStates?: PdfButtonState[];
  }
}

const PDF_TEST_DOCUMENT = `<!doctype html>
<html lang="zh-Hant">
<head><meta charset="utf-8"><title>Work Report PDF Test</title><style>html, body { margin: 0; height: 100%; } iframe { width: 100%; height: 100%; border: 0; }</style></head>
<body>
  <iframe id="print-target" title="PDF test target"></iframe>
  <script type="module">
    import {
      buildWorkReportPrintDocument,
      writeWorkReportPrintWindow,
    } from "/src/features/work-report/workReportPrint.ts";

    const testCase = new URLSearchParams(window.location.search).get("case");
    const oversized = testCase === "oversized";
    const rowCounts = oversized
      ? [1]
      : testCase === "layout"
        ? [1, 1, 1]
        : [55, 30].concat(Array.from({ length: 23 }, (_, index) => index < 9 ? 8 : 7));
    const records = [];
    for (let machineIndex = 0; machineIndex < rowCounts.length; machineIndex += 1) {
      const machineCode = "M" + String(machineIndex + 1).padStart(2, "0");
      const recordMachineCode = testCase === "layout" && machineIndex === 2 ? "" : machineCode;
      for (let rowIndex = 0; rowIndex < rowCounts[machineIndex]; rowIndex += 1) {
        const workOrderNo = oversized
          ? "WO-OVERSIZED"
          : "WO-" + machineCode + "-" + String(rowIndex + 1).padStart(3, "0");
        records.push({
          id: machineCode + "-" + rowIndex,
          workOrderNo,
          status: "未結案",
          machineCode: recordMachineCode,
          filterMachineCode: recordMachineCode,
          customerPartNo: "PART-" + machineCode,
          erpPartNo: null,
          prodType: "TI",
          sortOrder: rowIndex + 1,
          forgingMother: "MAT-" + machineCode,
          size: "08*030",
          currentMaterial: oversized ? "超長內容".repeat(20000) : "MATERIAL-" + machineCode,
          estimatedHours: 8,
          prevPlanEndDate: "2026/08/09",
          plannedEndDate: "2026/08/10",
          targetQtyPc: 1000,
          pendingQty: 500,
          producedQtyStat: 500,
          prevReportQtyPc: 400,
          prevCompleteContainer: 10,
        });
      }
    }

    const target = document.querySelector("#print-target").contentWindow;
    writeWorkReportPrintWindow(
      target,
      buildWorkReportPrintDocument({
        formId: "104",
        records,
        language: "zh",
        generatedAt: new Date(2026, 7, 10, 14, 0, 0),
      })
    );

    const pdfButton = target.document.querySelector("#work-report-pdf-action");
    window.__pdfButtonStates = [];
    const captureButtonState = () => {
      window.__pdfButtonStates.push({
        text: pdfButton.textContent || "",
        disabled: pdfButton.disabled,
        busy: pdfButton.getAttribute("aria-busy"),
      });
    };
    captureButtonState();
    new MutationObserver(captureButtonState).observe(pdfButton, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    window.__pdfQaReady = true;
  </script>
</body>
</html>`;

async function openPdfTestDocument(
  page: import("@playwright/test").Page,
  testCase: "normal" | "oversized" | "layout"
) {
  await page.route("**/__work-report-pdf-test__*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: PDF_TEST_DOCUMENT,
    });
  });
  await page.goto(`/__work-report-pdf-test__?case=${testCase}`);
  await page.waitForFunction(() => window.__pdfQaReady === true);
  return page.frameLocator("#print-target");
}

function getPdfPageCount(pdfBytes: Buffer): number {
  return pdfBytes.toString("latin1").match(/\/Type\s*\/Page\b/g)?.length ?? 0;
}

test("255 筆／25 台以連續排列跨頁下載並恢復操作狀態", async ({
  page,
}, testInfo) => {
  const printFrame = await openPdfTestDocument(page, "normal");
  const pdfButton = printFrame.getByRole("button", { name: "下載 PDF" });
  const downloadPromise = page.waitForEvent("download");

  await pdfButton.click();
  const download = await downloadPromise;
  expect(await download.failure()).toBeNull();
  expect(download.suggestedFilename()).toBe("搓牙排程表_2026-08-10_140000.pdf");

  const pdfPath = testInfo.outputPath("work-report-255-records.pdf");
  await download.saveAs(pdfPath);
  await expect(pdfButton).toBeEnabled();
  await expect(pdfButton).toHaveText("下載 PDF");
  await expect(pdfButton).not.toHaveAttribute("aria-busy", "true");
  await expect(printFrame.locator('iframe[title="PDF render"]')).toHaveCount(0);

  const buttonStates = await page.evaluate(() => window.__pdfButtonStates ?? []);
  expect(buttonStates.some((state) => state.text.includes("0/25"))).toBe(true);
  expect(buttonStates.some((state) => state.text.includes("25/25"))).toBe(true);
  expect(buttonStates.some((state) => /\/25 · [1-9]\d* 頁/.test(state.text))).toBe(true);
  expect(buttonStates.some((state) => state.disabled && state.busy === "true")).toBe(true);

  const pdfBytes = await readFile(pdfPath);
  expect(pdfBytes.byteLength).toBeLessThan(6 * 1024 * 1024);
  const pdfText = pdfBytes.toString("latin1");
  const pageCount = getPdfPageCount(pdfBytes);
  expect(pageCount).toBeGreaterThanOrEqual(18);
  expect(pageCount).toBeLessThanOrEqual(20);
  const mediaBox = pdfText.match(
    /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/
  );
  expect(Number(mediaBox?.[1])).toBeCloseTo(841.89, 1);
  expect(Number(mediaBox?.[2])).toBeCloseTo(595.28, 1);
});

test("字級與排版選項同步控制預覽及 PDF 分頁", async ({ page }, testInfo) => {
  const printFrame = await openPdfTestDocument(page, "layout");
  const body = printFrame.locator("body");
  const fontSize = printFrame.locator("#work-report-font-size-action");
  const layout = printFrame.locator("#work-report-layout-action");
  const firstCell = printFrame.locator("tbody td").first();
  const nativePrintMachineCode = printFrame.locator(".native-print-machine-code").first();
  const unassignedMachineCode = printFrame.locator(".native-print-machine-code", {
    hasText: "未指定",
  });
  const unassignedMachineMark = printFrame.locator(".machine-sheet").last().locator(
    ".machine-mark strong"
  );

  await expect(body).toHaveAttribute("data-print-font-size", "medium");
  await expect(body).toHaveAttribute("data-print-layout", "compact");
  await expect(nativePrintMachineCode).toBeHidden();
  await page.emulateMedia({ media: "print" });
  await expect(nativePrintMachineCode).toHaveCSS("display", "grid");
  await expect(nativePrintMachineCode).toContainText("機台");
  await expect(nativePrintMachineCode).toContainText("M01");
  await expect(unassignedMachineCode).toHaveCount(1);
  await expect(unassignedMachineCode.locator("strong")).toHaveText("未指定");
  await expect(unassignedMachineMark).toHaveText("未指定");
  const unassignedOverflow = await unassignedMachineCode.evaluate((element) => {
    const cell = element.closest("th");
    if (!cell) {
      throw new Error("未指定機台標記缺少表頭儲存格");
    }
    const codeBounds = element.getBoundingClientRect();
    const cellBounds = cell.getBoundingClientRect();
    return {
      hasHorizontalOverflow: element.scrollWidth > element.clientWidth,
      staysWithinCell: codeBounds.left >= cellBounds.left && codeBounds.right <= cellBounds.right,
    };
  });
  expect(unassignedOverflow).toEqual({
    hasHorizontalOverflow: false,
    staysWithinCell: true,
  });
  await page.emulateMedia({ media: "screen" });
  const renderedFontSizes: number[] = [];
  for (const option of ["small", "medium", "large", "x-large", "xx-large"]) {
    await fontSize.selectOption(option);
    renderedFontSizes.push(
      await firstCell.evaluate((cell) => Number.parseFloat(getComputedStyle(cell).fontSize))
    );
  }
  expect(renderedFontSizes).toEqual([...renderedFontSizes].sort((left, right) => left - right));
  expect(new Set(renderedFontSizes).size).toBe(5);
  await layout.selectOption("machine-page");
  await expect(body).toHaveAttribute("data-print-font-size", "xx-large");
  await expect(body).toHaveAttribute("data-print-layout", "machine-page");

  const machinePageDownloadPromise = page.waitForEvent("download");
  await printFrame.getByRole("button", { name: "下載 PDF" }).click();
  const machinePageDownload = await machinePageDownloadPromise;
  const machinePagePath = testInfo.outputPath("work-report-machine-pages.pdf");
  await machinePageDownload.saveAs(machinePagePath);
  expect(getPdfPageCount(await readFile(machinePagePath))).toBe(3);

  await layout.selectOption("compact");
  const compactDownloadPromise = page.waitForEvent("download");
  await printFrame.getByRole("button", { name: "下載 PDF" }).click();
  const compactDownload = await compactDownloadPromise;
  const compactPath = testInfo.outputPath("work-report-compact.pdf");
  await compactDownload.saveAs(compactPath);
  expect(getPdfPageCount(await readFile(compactPath))).toBe(1);

  await page.setViewportSize({ width: 375, height: 812 });
  await layout.selectOption("machine-page");
  const overflowState = await printFrame.locator("body").evaluate((documentBody) => {
    const documentElement = documentBody.ownerDocument.documentElement;
    const machineSheet = documentBody.querySelector<HTMLElement>(".machine-sheet");
    if (!machineSheet) {
      throw new Error("缺少機台列印區塊");
    }
    return {
      documentOverflow: documentElement.scrollWidth > documentElement.clientWidth,
      machineSheetScrollable: machineSheet.scrollWidth > machineSheet.clientWidth,
      machineSheetOverflowX: getComputedStyle(machineSheet).overflowX,
    };
  });
  expect(overflowState).toEqual({
    documentOverflow: false,
    machineSheetScrollable: true,
    machineSheetOverflowX: "auto",
  });
});

test("單一資料列超過 A4 時拒絕不完整下載並恢復按鈕", async ({ page }) => {
  const printFrame = await openPdfTestDocument(page, "oversized");
  const pdfButton = printFrame.getByRole("button", { name: "下載 PDF" });
  let downloadCount = 0;
  page.on("download", () => {
    downloadCount += 1;
  });
  const dialogPromise = page.waitForEvent("dialog");

  await pdfButton.click();
  const dialog = await dialogPromise;
  expect(dialog.message()).toContain("工令 WO-OVERSIZED 的資料列內容超過 A4 可用高度");
  await dialog.dismiss();

  await expect(pdfButton).toBeEnabled();
  await expect(pdfButton).toHaveText("下載 PDF");
  await expect(pdfButton).not.toHaveAttribute("aria-busy", "true");
  await expect(printFrame.locator('iframe[title="PDF render"]')).toHaveCount(0);
  expect(downloadCount).toBe(0);
});

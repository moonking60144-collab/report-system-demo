import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

interface PdfButtonState {
  text: string;
  disabled: boolean;
  busy: string | null;
}

interface PdfColumnSnapshot {
  sortOrderWidth: number;
  workOrderNoWidth: number;
  forgingMotherWidth: number;
  previousMachineWidth: number;
  previousMachineHidden: boolean;
  currentMaterialHidden: boolean;
}

declare global {
  interface Window {
    __pdfQaReady?: boolean;
    __pdfButtonStates?: PdfButtonState[];
    __pdfColumnSnapshots?: PdfColumnSnapshot[];
    __printCallCount?: number;
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
          prodType: "PA",
          sortOrder: rowIndex + 1,
          forgingMother: oversized ? "超長內容".repeat(20000) : "MAT-" + machineCode,
          size: "08*030",
          workOrderType: machineIndex % 2 === 0 ? "內製" : "委外",
          previousMachine: machineIndex % 2 === 0 ? "MA51" : "MB21",
          currentMaterial: "MATERIAL-" + machineCode,
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
        formId: "901",
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
    window.__pdfColumnSnapshots = [];
    window.setInterval(() => {
      const renderFrame = target.document.querySelector('iframe[title="PDF render"]');
      const renderTable = renderFrame?.contentDocument?.querySelector("table");
      const sortOrder = renderTable?.querySelector('col[data-column-key="sortOrder"]');
      const workOrderNo = renderTable?.querySelector('col[data-column-key="workOrderNo"]');
      const forgingMother = renderTable?.querySelector('col[data-column-key="forgingMother"]');
      const previousMachine = renderTable?.querySelector('col[data-column-key="previousMachine"]');
      const currentMaterial = renderTable?.querySelector('col[data-column-key="currentMaterial"]');
      if (!sortOrder || !workOrderNo || !forgingMother || !previousMachine || !currentMaterial) {
        return;
      }
      const snapshot = {
        sortOrderWidth: Number.parseFloat(sortOrder.style.width),
        workOrderNoWidth: Number.parseFloat(workOrderNo.style.width),
        forgingMotherWidth: Number.parseFloat(forgingMother.style.width),
        previousMachineWidth: Number.parseFloat(previousMachine.style.width),
        previousMachineHidden: previousMachine.hidden,
        currentMaterialHidden: currentMaterial.hidden,
      };
      const previousSnapshot = window.__pdfColumnSnapshots.at(-1);
      if (JSON.stringify(previousSnapshot) !== JSON.stringify(snapshot)) {
        window.__pdfColumnSnapshots.push(snapshot);
      }
    }, 5);
    window.__pdfQaReady = true;
  </script>
</body>
</html>`;

const PRINT_SESSION_TEST_DOCUMENT = `<!doctype html>
<html lang="zh-Hant">
<head><meta charset="utf-8"><title>Work Report Print Session Test</title></head>
<body>
  <button id="open-print" type="button">開啟列印預覽</button>
  <script type="module">
    import {
      buildWorkReportPrintDocument,
      buildWorkReportPrintLoadingDocument,
      writeWorkReportPrintWindow,
    } from "/src/features/work-report/workReportPrint.ts";
    import { createWorkReportPrintSession } from "/src/features/work-report/workReportPrintSession.ts";

    document.querySelector("#open-print").addEventListener("click", () => {
      const popup = window.open("about:blank", "_blank");
      if (!popup) throw new Error("popup blocked");
      popup.opener = null;
      writeWorkReportPrintWindow(
        popup,
        buildWorkReportPrintLoadingDocument("901", "zh")
      );
      const session = createWorkReportPrintSession(
        popup.sessionStorage,
        buildWorkReportPrintDocument({
          formId: "901",
          language: "zh",
          generatedAt: new Date(2026, 7, 18, 14, 0, 0),
          records: [{
            id: "print-session-record",
            workOrderNo: "WO-PRINT-001",
            status: "未結案",
            machineCode: "MA51",
            filterMachineCode: "MA51",
            customerPartNo: "PART-PRINT",
            erpPartNo: null,
            prodType: "PA",
            sortOrder: 1,
            forgingMother: "MAT-PRINT",
            size: "08*030",
            workOrderType: "內製",
            previousMachine: "MB21",
            currentMaterial: null,
            estimatedHours: 8,
            prevPlanEndDate: "2026/08/17",
            plannedEndDate: "2026/08/18",
            targetQtyPc: 1000,
            pendingQty: 500,
            producedQtyStat: 500,
            prevReportQtyPc: 400,
            prevCompleteContainer: 10,
          }],
        }),
        "zh"
      );
      popup.location.replace(new URL(session.path, window.location.origin).toString());
    });
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
  expect(download.suggestedFilename()).toBe("製程 A 排程表_2026-08-10_140000.pdf");

  const pdfPath = testInfo.outputPath("work-report-255-records.pdf");
  await download.saveAs(pdfPath);
  await expect(pdfButton).toBeEnabled();
  await expect(pdfButton).toHaveText("下載 PDF");
  await expect(pdfButton).not.toHaveAttribute("aria-busy", "true");
  await expect(printFrame.locator('iframe[title="PDF render"]')).toHaveCount(0);

  const defaultPdfColumnSnapshots = await page.evaluate(
    () => window.__pdfColumnSnapshots ?? []
  );
  expect(
    defaultPdfColumnSnapshots.some(
      (snapshot) =>
        snapshot.forgingMotherWidth > snapshot.sortOrderWidth &&
        snapshot.forgingMotherWidth > snapshot.previousMachineWidth &&
        snapshot.workOrderNoWidth > snapshot.previousMachineWidth &&
        !snapshot.previousMachineHidden &&
        snapshot.currentMaterialHidden
    )
  ).toBe(true);

  const buttonStates = await page.evaluate(() => window.__pdfButtonStates ?? []);
  expect(buttonStates.some((state) => state.text.includes("0/25"))).toBe(true);
  expect(buttonStates.some((state) => state.text.includes("25/25"))).toBe(true);
  expect(buttonStates.some((state) => /\/25 · [1-9]\d* 頁/.test(state.text))).toBe(true);
  expect(buttonStates.some((state) => state.disabled && state.busy === "true")).toBe(true);

  const pdfBytes = await readFile(pdfPath);
  expect(pdfBytes.byteLength).toBeLessThan(6 * 1024 * 1024);
  const pdfText = pdfBytes.toString("latin1");
  const pageCount = getPdfPageCount(pdfBytes);
  // 單一文件表頭讓 Linux Chromium 固定降到 12 頁；macOS PingFang 可能多 1 頁。
  expect(pageCount).toBeGreaterThanOrEqual(12);
  expect(pageCount).toBeLessThanOrEqual(13);
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
  const columnAction = printFrame.getByRole("button", { name: /欄位設定/ });
  const firstCell = printFrame.locator("tbody td").first();
  const nativePrintMachineCode = printFrame.locator(".native-print-machine-code").first();
  const unassignedMachineCode = printFrame.locator(".native-print-machine-code", {
    hasText: "未指定",
  });
  const unassignedMachineMark = printFrame.locator(".machine-sheet").last().locator(
    ".machine-mark strong"
  );
  const reportHeading = printFrame.locator(".report-header h1");
  const machineHeaders = printFrame.locator(".machine-header");

  await expect(body).toHaveAttribute("data-print-font-size", "medium");
  await expect(body).toHaveAttribute("data-print-layout", "compact");
  await expect(reportHeading).toHaveCount(1);
  await expect(reportHeading).toHaveText("製程 A 排程表");
  await expect(machineHeaders).toHaveCount(3);
  const firstMachineAlignment = await machineHeaders.first().evaluate((header) => {
    const mark = header.querySelector<HTMLElement>(".machine-mark");
    if (!mark) {
      throw new Error("機台區塊缺少機台標識");
    }
    const headerBounds = header.getBoundingClientRect();
    const markBounds = mark.getBoundingClientRect();
    return Math.abs(markBounds.left - headerBounds.left);
  });
  expect(firstMachineAlignment).toBeLessThanOrEqual(1);
  await expect(printFrame.locator('th[data-column-key="previousMachine"]').first()).toBeVisible();
  await expect(printFrame.locator('th[data-column-key="workOrderType"]').first()).toBeVisible();
  await expect(printFrame.locator('th[data-column-key="currentMaterial"]').first()).toBeHidden();
  await columnAction.click();
  await expect(printFrame.getByRole("dialog", { name: "列印欄位" })).toBeVisible();
  await printFrame.getByLabel("上一站機台").uncheck();
  await printFrame.getByLabel("目前使用來料").check();
  await expect(printFrame.locator('th[data-column-key="previousMachine"]').first()).toBeHidden();
  await expect(printFrame.locator('th[data-column-key="currentMaterial"]').first()).toBeVisible();
  await expect(body).toHaveAttribute("data-print-visible-columns", /currentMaterial/);
  await expect(body).not.toHaveAttribute("data-print-visible-columns", /previousMachine/);
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("work-report:print-columns:901") ?? "null")
    )
  ).toMatchObject({
    version: 1,
    visibleColumnKeys: expect.arrayContaining(["currentMaterial"]),
  });
  await printFrame.getByRole("button", { name: "完成" }).click();
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
  const pdfColumnSnapshots = await page.evaluate(() => window.__pdfColumnSnapshots ?? []);
  expect(
    pdfColumnSnapshots.some(
      (snapshot) =>
        snapshot.forgingMotherWidth > snapshot.sortOrderWidth &&
        snapshot.previousMachineHidden &&
        !snapshot.currentMaterialHidden
    )
  ).toBe(true);

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

test("列印預覽使用可重載 route，重新整理後仍可列印", async ({ page, context }) => {
  await page.route("**/__work-report-print-session-test__", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: PRINT_SESSION_TEST_DOCUMENT,
    });
  });
  await page.goto("/__work-report-print-session-test__");
  const popupPromise = context.waitForEvent("page");
  await page.getByRole("button", { name: "開啟列印預覽" }).click();
  const popup = await popupPromise;

  await popup.waitForURL(/\/work-report\/print\/[^/]+$/);
  await expect(popup.locator(".report-header h1")).toHaveText("製程 A 排程表");
  await expect(popup.locator(".machine-mark strong")).toHaveText("MA51");
  expect(popup.url()).not.toBe("about:blank");

  await popup.evaluate(() => {
    window.__printCallCount = 0;
    window.print = () => {
      window.__printCallCount = (window.__printCallCount ?? 0) + 1;
    };
  });
  await popup.getByRole("button", { name: "列印", exact: true }).click();
  expect(await popup.evaluate(() => window.__printCallCount)).toBe(1);

  const previewUrl = popup.url();
  await popup.reload();
  await expect(popup).toHaveURL(previewUrl);
  await expect(popup.locator(".report-header h1")).toHaveText("製程 A 排程表");
  const reloadedPrintButton = popup.getByRole("button", { name: "列印", exact: true });
  await expect(reloadedPrintButton).toBeEnabled();
  await popup.evaluate(() => {
    window.__printCallCount = 0;
    window.print = () => {
      window.__printCallCount = (window.__printCallCount ?? 0) + 1;
    };
  });
  await reloadedPrintButton.click();
  expect(await popup.evaluate(() => window.__printCallCount)).toBe(1);

  await popup.close();
});

test("列印 session 遺失時顯示明確說明而不是白畫面", async ({ page }) => {
  await page.goto("/work-report/print/missing-session-123456");

  await expect(page.getByRole("heading", { name: "列印預覽無法還原" })).toBeVisible();
  await expect(page.getByText("找不到有效的列印工作階段")).toBeVisible();
  await expect(page.getByRole("button", { name: "關閉" })).toBeVisible();
  await expect(page.locator("body")).not.toBeEmpty();
});

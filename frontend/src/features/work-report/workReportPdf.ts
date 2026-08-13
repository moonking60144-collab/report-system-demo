const A4_LANDSCAPE_WIDTH_MM = 297;
const A4_LANDSCAPE_HEIGHT_MM = 210;
const PAGE_MARGIN_MM = 8;
const PAGE_CONTENT_WIDTH_MM = A4_LANDSCAPE_WIDTH_MM - PAGE_MARGIN_MM * 2;
const PAGE_CONTENT_HEIGHT_MM = A4_LANDSCAPE_HEIGHT_MM - PAGE_MARGIN_MM * 2;
const PDF_RENDER_SCALE = 1.5;
const PDF_JPEG_QUALITY = 0.9;
const PDF_RENDER_BATCH_SIZE = 4;
const PDF_CAPTURE_PADDING_PX = 2;

type WorkReportPdfLayout = "compact" | "machine-page";

export interface WorkReportPdfProgress {
  completedMachines: number;
  totalMachines: number;
  renderedPages: number;
}

function createRenderFrame(sourceDocument: Document): {
  frame: HTMLIFrameElement;
  renderDocument: Document;
  renderHost: HTMLElement;
} {
  const frame = sourceDocument.createElement("iframe");
  frame.title = "PDF render";
  frame.tabIndex = -1;
  frame.setAttribute("aria-hidden", "true");
  Object.assign(frame.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: `${PAGE_CONTENT_WIDTH_MM}mm`,
    height: `${PAGE_CONTENT_HEIGHT_MM}mm`,
    border: "0",
    zIndex: "-2147483648",
    pointerEvents: "none",
  });
  sourceDocument.body.append(frame);

  const renderDocument = frame.contentDocument;
  if (!renderDocument) {
    frame.remove();
    throw new Error("無法建立 PDF 渲染文件");
  }

  renderDocument.open();
  renderDocument.write(
    '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"></head><body></body></html>'
  );
  renderDocument.close();
  for (const style of sourceDocument.querySelectorAll("style")) {
    renderDocument.head.append(renderDocument.importNode(style, true));
  }
  renderDocument.body.dataset.printFontSize =
    sourceDocument.body.dataset.printFontSize ?? "medium";
  renderDocument.body.dataset.printLayout =
    sourceDocument.body.dataset.printLayout ?? "compact";

  const renderHost = renderDocument.createElement("div");
  renderHost.className = "pdf-render-host";
  renderDocument.body.append(renderHost);
  return { frame, renderDocument, renderHost };
}

function createRenderPage(
  renderDocument: Document,
  renderHost: HTMLElement
): HTMLElement {
  const page = renderDocument.createElement("div");
  page.className = "pdf-render-page";
  renderHost.append(page);
  return page;
}

function appendRenderMachineSection(
  renderDocument: Document,
  page: HTMLElement,
  sourceSheet: HTMLElement,
  includeReportHeader: boolean,
  followsExistingSection: boolean
): {
  sheet: HTMLElement;
  body: HTMLTableSectionElement;
} {
  const sourceTable = sourceSheet.querySelector<HTMLTableElement>("table");
  const sourceTableHead = sourceTable?.querySelector<HTMLTableSectionElement>("thead");
  if (!sourceTable || !sourceTableHead) {
    throw new Error("列印排程缺少表格或表頭");
  }

  const sheet = renderDocument.createElement("section");
  sheet.className = "machine-sheet is-first";
  if (followsExistingSection) {
    sheet.classList.add("is-compact-following");
  }
  if (includeReportHeader) {
    const reportHeader = sourceSheet.querySelector(".report-header");
    const reportMeta = sourceSheet.querySelector(".report-meta");
    if (reportHeader) {
      sheet.append(renderDocument.importNode(reportHeader, true));
    }
    if (reportMeta) {
      sheet.append(renderDocument.importNode(reportMeta, true));
    }
  } else {
    const machineMark = sourceSheet.querySelector(".machine-mark");
    if (machineMark) {
      const continuationHeader = renderDocument.createElement("div");
      continuationHeader.className = "machine-continuation";
      continuationHeader.append(renderDocument.importNode(machineMark, true));
      sheet.append(continuationHeader);
    }
  }

  const table = renderDocument.importNode(sourceTable, false);
  table.append(renderDocument.importNode(sourceTableHead, true));
  const body = renderDocument.createElement("tbody");
  table.append(body);
  const tableBottom = renderDocument.createElement("div");
  tableBottom.style.height = "1px";
  tableBottom.style.background = "#9eafbd";
  sheet.append(table, tableBottom);
  page.append(sheet);

  return { sheet, body };
}

async function encodeCanvasAsJpeg(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) => {
        if (result) {
          resolve(result);
        } else {
          reject(new Error("無法編碼 PDF 頁面"));
        }
      },
      "image/jpeg",
      PDF_JPEG_QUALITY
    );
  });
  return new Uint8Array(await blob.arrayBuffer());
}

function downloadBlob(sourceDocument: Document, blob: Blob, filename: string): void {
  const sourceWindow = sourceDocument.defaultView;
  if (!sourceWindow) {
    throw new Error("列印視窗已關閉");
  }

  const objectUrl = sourceWindow.URL.createObjectURL(blob);
  const anchor = sourceDocument.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  sourceDocument.body.append(anchor);
  anchor.click();
  anchor.remove();
  sourceWindow.setTimeout(() => sourceWindow.URL.revokeObjectURL(objectUrl), 0);
}

export async function downloadWorkReportPdf(
  sourceDocument: Document,
  filename: string,
  onProgress?: (progress: WorkReportPdfProgress) => void
): Promise<void> {
  const machineSheets = Array.from(
    sourceDocument.querySelectorAll<HTMLElement>(".machine-sheet")
  );
  if (machineSheets.length === 0) {
    throw new Error("列印排程沒有可匯出的機台資料");
  }

  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
    import("html2canvas"),
    import("jspdf"),
  ]);
  const { frame, renderDocument, renderHost } = createRenderFrame(sourceDocument);
  await renderDocument.fonts.ready;
  const layout: WorkReportPdfLayout =
    sourceDocument.body.dataset.printLayout === "machine-page"
      ? "machine-page"
      : "compact";

  const pdf = new jsPDF({
    orientation: "landscape",
    unit: "mm",
    format: "a4",
    compress: true,
  });
  let renderedPageCount = 0;
  let completedMachineCount = 0;
  const queuedPages: Array<{
    page: HTMLElement;
    completedMachineCount: number;
  }> = [];

  const renderQueuedPages = async () => {
    if (queuedPages.length === 0) {
      return;
    }

    const hostRect = renderHost.getBoundingClientRect();
    const pageMetrics = queuedPages.map(({ page, completedMachineCount }) => {
      const pageRect = page.getBoundingClientRect();
      return {
        top: pageRect.top - hostRect.top,
        height: pageRect.height,
        completedMachineCount,
      };
    });
    const batchCanvas = await html2canvas(renderHost, {
      backgroundColor: "#ffffff",
      logging: false,
      scale: PDF_RENDER_SCALE,
      useCORS: true,
    });
    const canvasScale = batchCanvas.height / hostRect.height;

    for (const pageMetric of pageMetrics) {
      const sourceY = Math.round(pageMetric.top * canvasScale);
      const sourceEndY = Math.round(
        (pageMetric.top + pageMetric.height) * canvasScale
      );
      const pageCanvas = renderDocument.createElement("canvas");
      pageCanvas.width = batchCanvas.width;
      pageCanvas.height = sourceEndY - sourceY;
      const pageContext = pageCanvas.getContext("2d");
      if (!pageContext) {
        throw new Error("無法建立 PDF 頁面影像");
      }
      pageContext.drawImage(
        batchCanvas,
        0,
        sourceY,
        batchCanvas.width,
        pageCanvas.height,
        0,
        0,
        pageCanvas.width,
        pageCanvas.height
      );

      const imageData = await encodeCanvasAsJpeg(pageCanvas);
      const imageHeightMm = Math.min(
        PAGE_CONTENT_HEIGHT_MM,
        PAGE_CONTENT_WIDTH_MM * (pageCanvas.height / pageCanvas.width)
      );
      if (renderedPageCount > 0) {
        pdf.addPage("a4", "landscape");
      }
      pdf.addImage(
        imageData,
        "JPEG",
        PAGE_MARGIN_MM,
        PAGE_MARGIN_MM,
        PAGE_CONTENT_WIDTH_MM,
        imageHeightMm,
        undefined,
        "FAST"
      );
      pageCanvas.width = 0;
      pageCanvas.height = 0;
      renderedPageCount += 1;
      completedMachineCount = Math.max(
        completedMachineCount,
        pageMetric.completedMachineCount
      );
    }

    batchCanvas.width = 0;
    batchCanvas.height = 0;
    renderHost.replaceChildren();
    queuedPages.length = 0;
    onProgress?.({
      completedMachines: completedMachineCount,
      totalMachines: machineSheets.length,
      renderedPages: renderedPageCount,
    });
  };

  onProgress?.({
    completedMachines: 0,
    totalMachines: machineSheets.length,
    renderedPages: 0,
  });

  try {
    let currentPage: HTMLElement | null = null;
    let currentPageCompletedMachineCount = 0;

    const getCurrentPage = (): HTMLElement => {
      if (!currentPage) {
        currentPage = createRenderPage(renderDocument, renderHost);
      }
      return currentPage;
    };

    const queueCurrentPage = async (): Promise<void> => {
      if (!currentPage) {
        return;
      }
      currentPage.style.height = "auto";
      currentPage.style.overflow = "visible";
      currentPage.style.paddingBottom = `${PDF_CAPTURE_PADDING_PX}px`;
      queuedPages.push({
        page: currentPage,
        completedMachineCount: currentPageCompletedMachineCount,
      });
      currentPage = null;
      if (queuedPages.length >= PDF_RENDER_BATCH_SIZE) {
        await renderQueuedPages();
      }
    };

    for (const [machineIndex, sourceSheet] of machineSheets.entries()) {
      const sourceRows = Array.from(
        sourceSheet.querySelectorAll<HTMLTableRowElement>("tbody > tr")
      );
      let rowIndex = 0;
      let includeReportHeader = true;
      let machineComplete = false;

      do {
        const page = getCurrentPage();
        const followsExistingSection =
          layout === "compact" && page.childElementCount > 0;
        const { sheet, body } = appendRenderMachineSection(
          renderDocument,
          page,
          sourceSheet,
          includeReportHeader,
          followsExistingSection
        );
        let rowsInSection = 0;
        let retryOnNewPage = false;

        while (rowIndex < sourceRows.length) {
          const row = renderDocument.importNode(sourceRows[rowIndex], true);
          body.append(row);

          if (page.scrollHeight > page.clientHeight) {
            row.remove();
            if (rowsInSection === 0 && followsExistingSection) {
              sheet.remove();
              await queueCurrentPage();
              retryOnNewPage = true;
              break;
            }
            if (rowsInSection > 0 || includeReportHeader) {
              await queueCurrentPage();
              includeReportHeader = false;
              retryOnNewPage = true;
              break;
            }
            const workOrderNo = sourceRows[rowIndex].cells[2]?.textContent?.trim();
            throw new Error(
              `${workOrderNo ? `工令 ${workOrderNo} 的資料列` : "工令資料列"}內容超過 A4 可用高度`
            );
          }

          rowIndex += 1;
          rowsInSection += 1;
        }

        if (retryOnNewPage) {
          continue;
        }

        currentPageCompletedMachineCount = machineIndex + 1;
        machineComplete = true;
        if (layout === "machine-page") {
          await queueCurrentPage();
        }
      } while (!machineComplete);
    }

    await queueCurrentPage();
    await renderQueuedPages();
    downloadBlob(sourceDocument, pdf.output("blob"), filename);
  } finally {
    frame.remove();
  }
}

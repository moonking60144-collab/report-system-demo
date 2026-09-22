import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { WorkReportRecord } from "../../../api/workReport";
import "../../../i18n";
import { WorkReportSortOrderCell } from "./WorkReportSortOrderCell";

function renderCell(status: string): string {
  const record = {
    id: "E-901",
    workOrderNo: "DEMO-030703",
    status,
  } as WorkReportRecord;

  return renderToStaticMarkup(
    <WorkReportSortOrderCell
      value={10}
      record={record}
      displayValue={10}
      onSubmit={vi.fn()}
    />
  );
}

describe("WorkReportSortOrderCell", () => {
  it("已結案工令只顯示排序值，不提供編輯按鈕", () => {
    const html = renderCell("已結案");

    expect(html).toContain("work-report-editable-disabled");
    expect(html).not.toContain("work-report-sort-order-edit-btn");
  });

  it("未結案工令保留排序編輯按鈕", () => {
    const html = renderCell("未結案");

    expect(html).toContain("work-report-sort-order-edit-btn");
  });
});

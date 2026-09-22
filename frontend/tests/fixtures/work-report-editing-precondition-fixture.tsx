import React from "react";
import { createRoot } from "react-dom/client";
import { WorkReportEditableCell } from "../../src/features/work-report/components/WorkReportEditableCell";

const root = createRoot(document.getElementById("root")!);
const render = (value: number) => root.render(React.createElement(WorkReportEditableCell<number>, {
  kind: "sort-order", value,
  record: { id: "E1", workOrderNo: "WO1", status: "未結案", customerPartNo: null, erpPartNo: null, sortOrder: value, lastUpdatedAt: "v" + value },
  displayValue: value, toDraft: String, parseDraft: Number, isUnchanged: (a, b) => a === b,
  onSubmit: async (record, value) => { document.getElementById("submitted")!.textContent = JSON.stringify({ previous: record.sortOrder, value }); },
  label: "排序", invalidMessage: "invalid", submittingLabel: "saving", saveLabel: "儲存", cancelLabel: "取消", editAriaLabel: "編輯排序", inputProps: { type: "number" },
}));
render(5);
document.getElementById("refresh")!.onclick = () => render(9);

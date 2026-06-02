import type { ColumnsType } from "antd/es/table";
import type { ReactNode } from "react";
import type { WorkReportRecord } from "../../../api/workReport";
import type { ColumnDisplayMode, ColumnKey, WorkReportFormId } from "../types";

export interface WorkReportSelectableColumnMeta {
  key: ColumnKey;
  label: string;
}

interface BuildWorkReportColumnDefinitionsArgs {
  currentFormId: WorkReportFormId;
  columnDisplayMode: ColumnDisplayMode;
  renderValue: (value: unknown) => ReactNode;
  renderMachineValue: (value: unknown, record: WorkReportRecord) => ReactNode;
  renderWorkOrderValue: (value: unknown, record: WorkReportRecord) => ReactNode;
  renderCheck: (value: unknown) => ReactNode;
  toNumber: (value: unknown) => number;
  toDateValue: (value: unknown) => number;
}

const DEFAULT_VISIBLE_COLUMN_KEYS_BY_FORM: Record<WorkReportFormId, ReadonlySet<string>> = {
  "104": new Set([
    "startSchedule",
    "workOrderNo",
    "machineCode",
    "customerPartNo",
    "sortOrder",
    "plannedEndDate",
    "targetQtyPc",
    "pendingQty",
    "producedQtyStat",
    "processName",
    "status",
    "siteRunning",
    "lastUpdatedAt",
  ]),
  "105": new Set([
    "modificationStatus",
    "machineCode",
    "plannedStartDate",
    "plannedEndDate",
    "sortOrder",
    "workOrderNo",
    "customerPartNo",
    "targetQtyPc",
    "pendingQty",
    "producedQtyStat",
    "processName",
    "status",
    "siteRunning",
    "lastUpdatedAt",
  ]),
};

const FIT_WIDTH_OVERRIDES: Readonly<Record<string, number>> = {
  modificationStatus: 92,
  startSchedule: 64,
  workOrderNo: 128,
  machineCode: 64,
  forgingMother: 118,
  customerPartNo: 118,
  urgent: 52,
  sortOrder: 52,
  size: 86,
  plannedStartDate: 116,
  plannedEndDate: 116,
  estimatedHours: 96,
  prevPlanEndDate: 124,
  targetQtyPc: 96,
  pendingQty: 104,
  producedQtyStat: 124,
  prevReportQtyPc: 116,
  prevReportQtyKg: 116,
  prevReportContainerQty: 120,
  processName: 116,
  workOrderType: 96,
  currentMaterial: 118,
  completedQty: 128,
  processLossPc: 104,
  finishedWireSize: 94,
  status: 88,
  misCloseStatus: 102,
  workOrderRemark: 124,
  productUsageType: 124,
  moldCondition: 88,
  createdBy: 104,
  lastUpdatedAt: 116,
  primaryMaterial: 118,
  defaultMainMaterial: 124,
  prevStationRunning: 96,
  prevStationStatus: 96,
  siteRunning: 96,
  prevCompletePc: 116,
  prevCompleteKg: 116,
  prevCompleteContainer: 120,
};

function getDataColumnKey(column: ColumnsType<WorkReportRecord>[number]): string | null {
  if (!("dataIndex" in column)) {
    return null;
  }
  return typeof column.dataIndex === "string" ? column.dataIndex : null;
}

function applyFitColumnWidths(
  columns: ColumnsType<WorkReportRecord>
): ColumnsType<WorkReportRecord> {
  return columns.map((column) => {
    const key = getDataColumnKey(column);
    const currentWidth =
      "width" in column && typeof column.width === "number" ? column.width : null;
    if (!key || currentWidth === null) {
      return column;
    }
    const nextWidth =
      FIT_WIDTH_OVERRIDES[key] ?? Math.max(72, Math.round(currentWidth * 0.84));
    return {
      ...column,
      width: nextWidth,
    };
  });
}

function reorderColumnsForForm105(
  baseColumns: ColumnsType<WorkReportRecord>,
  renderValue: (value: unknown) => ReactNode,
  renderMachineValue: (value: unknown, record: WorkReportRecord) => ReactNode,
  toDateValue: (value: unknown) => number
): ColumnsType<WorkReportRecord> {
  const byKey = new Map<string, ColumnsType<WorkReportRecord>[number]>();
  for (const column of baseColumns) {
    const key = getDataColumnKey(column);
    if (key) {
      byKey.set(key, column);
    }
  }

  const modificationStatusColumn: ColumnsType<WorkReportRecord>[number] = {
    title: "修改狀態",
    dataIndex: "modificationStatus",
    width: 110,
    fixed: "left",
    render: renderValue,
  };

  const plannedStartDateColumn: ColumnsType<WorkReportRecord>[number] = {
    title: "指定開始日期",
    dataIndex: "plannedStartDate",
    width: 140,
    sorter: (a, b) => toDateValue(a.plannedStartDate) - toDateValue(b.plannedStartDate),
    render: renderValue,
  };

  const machineColumn = byKey.get("machineCode");
  const plannedEndDateColumn = byKey.get("plannedEndDate");
  const sortOrderColumn = byKey.get("sortOrder");
  const workOrderNoColumn = byKey.get("workOrderNo");

  const prefixedColumns: ColumnsType<WorkReportRecord> = [
    modificationStatusColumn,
    ...(machineColumn
      ? [
          {
            ...machineColumn,
            render: renderMachineValue,
          },
        ]
      : []),
    plannedStartDateColumn,
    ...(plannedEndDateColumn ? [plannedEndDateColumn] : []),
    ...(sortOrderColumn ? [sortOrderColumn] : []),
    ...(workOrderNoColumn
      ? [
          {
            ...workOrderNoColumn,
            fixed: undefined,
          },
        ]
      : []),
  ];

  const excludedKeys = new Set<string>([
    "startSchedule",
    "machineCode",
    "plannedStartDate",
    "plannedEndDate",
    "sortOrder",
    "workOrderNo",
  ]);

  const remainingColumns = baseColumns.filter((column) => {
    const key = getDataColumnKey(column);
    if (!key) {
      return true;
    }
    return !excludedKeys.has(key);
  });

  return [...prefixedColumns, ...remainingColumns];
}

export function buildFormAwareColumns(args: BuildWorkReportColumnDefinitionsArgs): ColumnsType<WorkReportRecord> {
  const {
    currentFormId,
    columnDisplayMode,
    renderValue,
    renderMachineValue,
    renderWorkOrderValue,
    renderCheck,
    toNumber,
    toDateValue,
  } = args;

  const baseColumns: ColumnsType<WorkReportRecord> = [
    {
      title: "開始排程?",
      dataIndex: "startSchedule",
      width: 90,
      align: "center",
      render: renderCheck,
    },
    {
      title: "工令單號",
      dataIndex: "workOrderNo",
      width: 140,
      fixed: "left",
      render: renderWorkOrderValue,
    },
    {
      title: "機台",
      dataIndex: "machineCode",
      width: 90,
      fixed: "left",
      render: renderMachineValue,
    },
    {
      title: "鍛造母件",
      dataIndex: "forgingMother",
      width: 140,
      render: renderValue,
    },
    {
      title: "客戶料號",
      dataIndex: "customerPartNo",
      width: 140,
      render: renderValue,
    },
    {
      title: "急件",
      dataIndex: "urgent",
      width: 80,
      align: "center",
      render: renderCheck,
    },
    {
      title: "排序",
      dataIndex: "sortOrder",
      width: 80,
      sorter: (a, b) => toNumber(a.sortOrder) - toNumber(b.sortOrder),
      render: renderValue,
    },
    {
      title: "尺寸",
      dataIndex: "size",
      width: 100,
      render: renderValue,
    },
    {
      title: "指定結束日期",
      dataIndex: "plannedEndDate",
      width: 140,
      sorter: (a, b) => toDateValue(a.plannedEndDate) - toDateValue(b.plannedEndDate),
      render: renderValue,
    },
    {
      title: "預估所需工時",
      dataIndex: "estimatedHours",
      width: 120,
      sorter: (a, b) => toNumber(a.estimatedHours) - toNumber(b.estimatedHours),
      render: renderValue,
    },
    {
      title: "[上製程]指定結束日期",
      dataIndex: "prevPlanEndDate",
      width: 160,
      sorter: (a, b) => toDateValue(a.prevPlanEndDate) - toDateValue(b.prevPlanEndDate),
      render: renderValue,
    },
    {
      title: "目標數pc",
      dataIndex: "targetQtyPc",
      width: 110,
      sorter: (a, b) => toNumber(a.targetQtyPc) - toNumber(b.targetQtyPc),
      render: renderValue,
    },
    {
      title: "待生產數量",
      dataIndex: "pendingQty",
      width: 120,
      sorter: (a, b) => toNumber(a.pendingQty) - toNumber(b.pendingQty),
      render: renderValue,
    },
    {
      title: "已生產數量統計(pc)",
      dataIndex: "producedQtyStat",
      width: 160,
      sorter: (a, b) => toNumber(a.producedQtyStat) - toNumber(b.producedQtyStat),
      render: renderValue,
    },
    {
      title: "[上一站]報工數pc",
      dataIndex: "prevReportQtyPc",
      width: 140,
      sorter: (a, b) => toNumber(a.prevReportQtyPc) - toNumber(b.prevReportQtyPc),
      render: renderValue,
    },
    {
      title: "[上一站]報工重kg",
      dataIndex: "prevReportQtyKg",
      width: 140,
      sorter: (a, b) => toNumber(a.prevReportQtyKg) - toNumber(b.prevReportQtyKg),
      render: renderValue,
    },
    {
      title: "[上一站]報工容器數",
      dataIndex: "prevReportContainerQty",
      width: 150,
      sorter: (a, b) => toNumber(a.prevReportContainerQty) - toNumber(b.prevReportContainerQty),
      render: renderValue,
    },
    {
      title: "主製程簡稱",
      dataIndex: "processName",
      width: 140,
      render: renderValue,
    },
    {
      title: "工令單種類",
      dataIndex: "workOrderType",
      width: 120,
      render: renderValue,
    },
    {
      title: "目前使用來料",
      dataIndex: "currentMaterial",
      width: 140,
      render: renderValue,
    },
    {
      title: "完工量(扣除製程耗損)",
      dataIndex: "completedQty",
      width: 170,
      sorter: (a, b) => toNumber(a.completedQty) - toNumber(b.completedQty),
      render: renderValue,
    },
    {
      title: "製程損耗(pc)",
      dataIndex: "processLossPc",
      width: 130,
      sorter: (a, b) => toNumber(a.processLossPc) - toNumber(b.processLossPc),
      render: renderValue,
    },
    {
      title: "成品線徑",
      dataIndex: "finishedWireSize",
      width: 110,
      render: renderValue,
    },
    {
      title: "工令狀態",
      dataIndex: "status",
      width: 110,
      render: renderValue,
    },
    {
      title: "結案狀態",
      dataIndex: "misCloseStatus",
      width: 130,
      render: renderValue,
    },
    {
      title: "工令單備註",
      dataIndex: "workOrderRemark",
      width: 160,
      render: renderValue,
    },
    {
      title: "產品料號用途種類",
      dataIndex: "productUsageType",
      width: 160,
      render: renderValue,
    },
    {
      title: "模具況狀",
      dataIndex: "moldCondition",
      width: 110,
      render: renderValue,
    },
    {
      title: "建立者帳號",
      dataIndex: "createdBy",
      width: 130,
      render: renderValue,
    },
    {
      title: "最後更新日期",
      dataIndex: "lastUpdatedAt",
      width: 140,
      sorter: (a, b) => toDateValue(a.lastUpdatedAt) - toDateValue(b.lastUpdatedAt),
      render: renderValue,
    },
    {
      title: "指定主要來料",
      dataIndex: "primaryMaterial",
      width: 140,
      render: renderValue,
    },
    {
      title: "[預設]主要製程來料",
      dataIndex: "defaultMainMaterial",
      width: 160,
      render: renderValue,
    },
    {
      title: "上一站執行中",
      dataIndex: "prevStationRunning",
      width: 120,
      align: "center",
      render: renderCheck,
    },
    {
      title: "上一站狀態",
      dataIndex: "prevStationStatus",
      width: 110,
      render: renderValue,
    },
    {
      title: "本站執行中?",
      dataIndex: "siteRunning",
      width: 120,
      align: "center",
      render: renderCheck,
    },
    {
      title: "[上一站]完工數pc",
      dataIndex: "prevCompletePc",
      width: 140,
      sorter: (a, b) => toNumber(a.prevCompletePc) - toNumber(b.prevCompletePc),
      render: renderValue,
    },
    {
      title: "[上一站]完工重kg",
      dataIndex: "prevCompleteKg",
      width: 140,
      sorter: (a, b) => toNumber(a.prevCompleteKg) - toNumber(b.prevCompleteKg),
      render: renderValue,
    },
    {
      title: "[上一站]完工容器數",
      dataIndex: "prevCompleteContainer",
      width: 150,
      sorter: (a, b) => toNumber(a.prevCompleteContainer) - toNumber(b.prevCompleteContainer),
      render: renderValue,
    },
  ];

  const formAwareColumns =
    currentFormId === "105"
      ? reorderColumnsForForm105(baseColumns, renderValue, renderMachineValue, toDateValue)
      : baseColumns;

  const widthAwareColumns =
    columnDisplayMode === "fit"
      ? applyFitColumnWidths(formAwareColumns)
      : formAwareColumns;

  if (columnDisplayMode === "full" || columnDisplayMode === "fit") {
    return widthAwareColumns;
  }

  const visibleKeys = DEFAULT_VISIBLE_COLUMN_KEYS_BY_FORM[currentFormId];
  return widthAwareColumns.filter((column) => {
    const key = getDataColumnKey(column);
    if (!key) {
      return true;
    }
    return visibleKeys.has(key);
  });
}

export function getSelectableWorkReportColumns(
  currentFormId: WorkReportFormId,
  columnDisplayMode: ColumnDisplayMode
): WorkReportSelectableColumnMeta[] {
  const columns = buildFormAwareColumns({
    currentFormId,
    columnDisplayMode,
    renderValue: () => null,
    renderMachineValue: () => null,
    renderWorkOrderValue: () => null,
    renderCheck: () => null,
    toNumber: () => 0,
    toDateValue: () => 0,
  });

  return columns
    .map((column) => {
      const key = getDataColumnKey(column);
      const label = typeof column.title === "string" ? column.title : null;
      if (!key || !label) {
        return null;
      }
      return { key, label };
    })
    .filter((value): value is WorkReportSelectableColumnMeta => value !== null);
}

import type {
  ColumnDataType,
  ColumnHeaderLocaleText,
  ColumnKey,
  FixedFilterPreset,
  FixedFilterPresetId,
  GlobalFilters,
  SidebarPlaceholderView,
  WorkReportLandingPageConfig,
  WorkReportLandingPageKey,
  WorkReportLocalPreferences,
} from "./types";

export const FORM_ID = "104";
export const ALL_FILTER_VALUE = "__all__";
export const HYDRATION_CACHE_VERSION = "v3";
export const HYDRATION_CACHE_TTL_MS = 48 * 60 * 60 * 1000;
export const CREATE_TASK_POLL_INTERVAL_MS = 3000;
export const CREATE_TASK_POLL_TIMEOUT_MS = 180000;
export const MAX_CREATE_TASK_MONITORS = 12;
export const CREATE_TASK_AUTO_CLEAR_MS = 4000;
export const COLUMN_TEXT_FILTER_MAX_LENGTH = 60;
export const BACKEND_FACET_COLUMN_KEYS = [
  "status",
  "machineCode",
  "siteRunning",
  "startSchedule",
  "lastUpdatedAt",
] as const;
export const BACKEND_ANALYSIS_COLUMN_KEYS = [
  "status",
  "machineCode",
  "siteRunning",
  "startSchedule",
  "lastUpdatedAt",
] as const;
export const UI_LANGUAGE_STORAGE_KEY = `work-reports:${FORM_ID}:ui-language`;
export const WORK_REPORT_LOCAL_PREFS_VERSION = 1;
export const WORK_REPORT_LOCAL_PREFS_STORAGE_KEY = "work-reports:local-preferences";
export const WORK_REPORT_LIST_ANCHOR_STORAGE_KEY = "work-reports:list-anchor";
export const WORK_REPORT_LIST_HIGHLIGHT_STORAGE_KEY = "work-reports:list-highlight";
export const WORK_REPORT_COLUMN_MODE_STORAGE_KEY = "work-reports:column-mode";
export const WORK_REPORT_TASK_MONITOR_STORAGE_KEY = "work-reports:task-monitor";
export const WORK_REPORT_PENDING_MUTATION_REPLAY_STORAGE_KEY = "work-report:pending-mutation-replay:v1";
export const WORK_REPORT_LANDING_PAGE_KEYS = ["thread-rolling-104", "heading-105"] as const satisfies readonly WorkReportLandingPageKey[];
export const WORK_REPORT_LANDING_PAGE_CONFIGS: Record<
  WorkReportLandingPageKey,
  WorkReportLandingPageConfig
> = {
  "thread-rolling-104": {
    key: "thread-rolling-104",
    formId: "104",
    prodTypeCode: "TI",
    groupLabelI18nKey: "workReport:page.groupThreadRolling",
    defaultFixedPresetPreferenceKey: "defaultFixedPresetId104",
    fallbackFixedPresetId: "unfinished-runnable",
  },
  "heading-105": {
    key: "heading-105",
    formId: "105",
    prodTypeCode: "HF",
    groupLabelI18nKey: "workReport:page.groupHeading",
    defaultFixedPresetPreferenceKey: "defaultFixedPresetId105",
    fallbackFixedPresetId: "unfinished-orders",
    resetPresetIdOnSelect: "unfinished-orders",
  },
};

export const COLUMN_HEADER_LOCALE_MAP: Partial<Record<string, ColumnHeaderLocaleText>> = {
  modificationStatus: { zh: "修改狀態", en: "Modify Status" },
  startSchedule: { zh: "開始排程?", en: "Sched?" },
  workOrderNo: { zh: "工令單號", en: "WO No." },
  machineCode: { zh: "機台", en: "Machine" },
  forgingMother: { zh: "鍛造母件", en: "Forging Base" },
  customerPartNo: { zh: "客戶料號", en: "Cust Part No." },
  urgent: { zh: "急件", en: "Urgent" },
  sortOrder: { zh: "排序", en: "Sort" },
  size: { zh: "尺寸", en: "Size" },
  plannedStartDate: { zh: "指定開始日期", en: "Planned Start" },
  plannedEndDate: { zh: "指定結束日期", en: "Planned End" },
  estimatedHours: { zh: "預估所需工時", en: "Est. Hours" },
  prevPlanEndDate: { zh: "[上製程]指定結束日期", en: "[Prev Proc] End" },
  targetQtyPc: { zh: "目標數pc", en: "Target pc" },
  pendingQty: { zh: "待生產數量", en: "Pending Qty" },
  producedQtyStat: { zh: "已生產數量統計(pc)", en: "Produced (pc)" },
  prevReportQtyPc: { zh: "[上一站]報工數pc", en: "[Prev] Report pc" },
  prevReportQtyKg: { zh: "[上一站]報工重kg", en: "[Prev] Report kg" },
  prevReportContainerQty: { zh: "[上一站]報工容器數", en: "[Prev] Report Ctn" },
  processName: { zh: "主製程簡稱", en: "Main Process" },
  workOrderType: { zh: "工令單種類", en: "WO Type" },
  currentMaterial: { zh: "目前使用來料", en: "Current Material" },
  completedQty: { zh: "完工量(扣除製程耗損)", en: "Completed Qty" },
  processLossPc: { zh: "製程損耗(pc)", en: "Process Loss" },
  finishedWireSize: { zh: "成品線徑", en: "Wire Size" },
  status: { zh: "工令狀態", en: "WO Status" },
  misCloseStatus: { zh: "結案狀態", en: "Close Status" },
  workOrderRemark: { zh: "工令單備註", en: "WO Remark" },
  productUsageType: { zh: "產品料號用途種類", en: "Usage Type" },
  moldCondition: { zh: "模具況狀", en: "Mold Cond." },
  createdBy: { zh: "建立者帳號", en: "Created By" },
  lastUpdatedAt: { zh: "最後更新日期", en: "Last Updated" },
  primaryMaterial: { zh: "指定主要來料", en: "Primary Material" },
  defaultMainMaterial: { zh: "[預設]主要製程來料", en: "[Default] Main Mat." },
  prevStationRunning: { zh: "上一站執行中", en: "Prev Running" },
  prevStationStatus: { zh: "上一站狀態", en: "Prev Status" },
  siteRunning: { zh: "本站執行中?", en: "Site Running?" },
  prevCompletePc: { zh: "[上一站]完工數pc", en: "[Prev] Done pc" },
  prevCompleteKg: { zh: "[上一站]完工重kg", en: "[Prev] Done kg" },
  prevCompleteContainer: { zh: "[上一站]完工容器數", en: "[Prev] Done Ctn" },
};

export const DEFAULT_GLOBAL_FILTERS: GlobalFilters = {
  globalKeyword: "",
  workOrderKeyword: "",
  customerPartKeyword: "",
  machineCode: ALL_FILTER_VALUE,
  filterMachineCode: ALL_FILTER_VALUE,
  status: ALL_FILTER_VALUE,
  ragicUnfinishedStatus: ALL_FILTER_VALUE,
  siteRunning: "all",
  startSchedule: "all",
};

export const DEFAULT_FIXED_FILTER_PRESET_ID: FixedFilterPresetId = "unfinished-runnable";
export const DEFAULT_WORK_REPORT_LOCAL_PREFERENCES: WorkReportLocalPreferences = {
  version: WORK_REPORT_LOCAL_PREFS_VERSION,
  defaultLandingPageKey: "thread-rolling-104",
  defaultFixedPresetId104: DEFAULT_FIXED_FILTER_PRESET_ID,
  defaultFixedPresetId105: "unfinished-orders",
  hideTestCustomerPartRecords: true,
};
export const FIXED_FILTER_QUERY_KEYS = [
  "fGlobal",
  "fWorkOrder",
  "fPart",
  "fMachine",
  "fFilterMachine",
  "fStatus",
  "fRagicUnfinished",
  "fSite",
  "fStartSchedule",
] as const;
export const FIXED_FILTER_PRESETS: FixedFilterPreset[] = [
  {
    id: "all-data",
    label: "所有資料",
    shortLabel: "全部",
    description: "清空固定篩選，顯示所有資料",
    filters: {
      ...DEFAULT_GLOBAL_FILTERS,
    },
  },
  {
    id: "unfinished-runnable",
    label: "未結案可執行",
    shortLabel: "可執行",
    description: "預設視圖：未結案 + 開始排程=是",
    filters: {
      ...DEFAULT_GLOBAL_FILTERS,
      status: "未結案",
      startSchedule: "yes",
    },
  },
  {
    id: "unfinished-orders",
    label: "未結案工令單",
    shortLabel: "未結案",
    description: "工令狀態＝未結案",
    filters: {
      ...DEFAULT_GLOBAL_FILTERS,
      status: "未結案",
    },
  },
  {
    id: "finished-orders",
    label: "已結案工令單",
    shortLabel: "已結案",
    description: "工令狀態＝已結案",
    filters: {
      ...DEFAULT_GLOBAL_FILTERS,
      status: "已結案",
    },
  },
];

export const FIXED_FILTER_PRESET_IDS_BY_FORM: Record<"104" | "105", readonly FixedFilterPresetId[]> = {
  "104": ["all-data", "unfinished-runnable", "unfinished-orders", "finished-orders"],
  "105": ["unfinished-orders", "all-data", "finished-orders"],
} as const;

export const SIDEBAR_PLACEHOLDER_VIEWS: SidebarPlaceholderView[] = [
  {
    id: "starred",
    label: "今日修改工令單",
    shortLabel: "今日修改",
    description: "僅顯示最後更新日期為今天的工令",
  },
  {
    id: "last-updated",
    label: "依最後修改時間排序",
    shortLabel: "最後修改",
    description: "依最後更新日期由新到舊排序",
  },
];

export const SIDEBAR_PRIMARY_ITEM_ORDER_BY_FORM: Record<
  "104" | "105",
  ReadonlyArray<FixedFilterPresetId | SidebarPlaceholderView["id"]>
> = {
  "104": [
    "all-data",
    "starred",
    "last-updated",
    "unfinished-runnable",
    "unfinished-orders",
    "finished-orders",
  ],
  "105": [
    "all-data",
    "starred",
    "last-updated",
    "unfinished-orders",
    "finished-orders",
  ],
} as const;

// 機台快捷篩選順序，放在最前面，並且維持原始Ragic的穩定排序
export const RAGIC_UNFINISHED_MACHINE_SHORTCUT_ORDER = [
  "W1",
  "W5",
  "W9",
  "W11",
  "W15",
  "W17",
  "W18",
  "W19",
  "W20",
  "W22",
  "W23",
  "W24",
  "W25",
  "W26",
  "W27",
  "W28",
  "W29",
  "R2",
  "R3",
  "R5",
  "R6",
  "R9",
  "R10",
  "P11",
] as const;

export const RAGIC_UNFINISHED_MACHINE_SHORTCUT_ORDER_SET = new Set<string>(
  RAGIC_UNFINISHED_MACHINE_SHORTCUT_ORDER
);

export const RAGIC_UNFINISHED_MACHINE_SHORTCUT_ORDER_105 = [
  "F7",
  "F9",
  "FC",
  "FF",
  "FH",
  "FI",
  "FJ",
  "FK",
  "FL",
  "FM",
  "FN",
  "FO",
  "FP",
  "FQ",
  "H1",
  "HE",
  "P8",
  "P10",
] as const;

export const RAGIC_UNFINISHED_MACHINE_SHORTCUT_ORDER_105_SET = new Set<string>(
  RAGIC_UNFINISHED_MACHINE_SHORTCUT_ORDER_105
);

export const COLUMN_BLANK_TOKEN = "__blank__";
export const COLUMN_BOOL_TRUE_TOKEN = "__bool_true__";
export const COLUMN_BOOL_FALSE_TOKEN = "__bool_false__";

export const COLUMN_TYPE_MAP: Record<string, ColumnDataType> = {
  modificationStatus: "text",
  startSchedule: "boolean",
  workOrderNo: "text",
  machineCode: "text",
  forgingMother: "text",
  customerPartNo: "text",
  urgent: "boolean",
  sortOrder: "number",
  size: "text",
  plannedStartDate: "date",
  plannedEndDate: "date",
  estimatedHours: "number",
  prevPlanEndDate: "date",
  targetQtyPc: "number",
  pendingQty: "number",
  producedQtyStat: "number",
  prevReportQtyPc: "number",
  prevReportQtyKg: "number",
  prevReportContainerQty: "number",
  processName: "text",
  workOrderType: "text",
  currentMaterial: "text",
  completedQty: "number",
  processLossPc: "number",
  finishedWireSize: "text",
  status: "text",
  misCloseStatus: "text",
  workOrderRemark: "text",
  productUsageType: "text",
  moldCondition: "text",
  createdBy: "text",
  lastUpdatedAt: "date",
  primaryMaterial: "text",
  defaultMainMaterial: "text",
  prevStationRunning: "boolean",
  prevStationStatus: "text",
  siteRunning: "boolean",
  prevCompletePc: "number",
  prevCompleteKg: "number",
  prevCompleteContainer: "number",
};

// 上方全域搜尋比對範圍：主表顯示欄位（排除布林勾選欄與操作欄）
export const GLOBAL_SEARCH_COLUMN_KEYS: readonly ColumnKey[] = [
  "modificationStatus",
  "workOrderNo",
  "machineCode",
  "forgingMother",
  "customerPartNo",
  "sortOrder",
  "size",
  "plannedStartDate",
  "plannedEndDate",
  "estimatedHours",
  "prevPlanEndDate",
  "targetQtyPc",
  "pendingQty",
  "producedQtyStat",
  "prevReportQtyPc",
  "prevReportQtyKg",
  "prevReportContainerQty",
  "processName",
  "workOrderType",
  "currentMaterial",
  "completedQty",
  "processLossPc",
  "finishedWireSize",
  "status",
  "misCloseStatus",
  "workOrderRemark",
  "productUsageType",
  "moldCondition",
  "createdBy",
  "lastUpdatedAt",
  "primaryMaterial",
  "defaultMainMaterial",
  "prevStationStatus",
  "prevCompletePc",
  "prevCompleteKg",
  "prevCompleteContainer",
];


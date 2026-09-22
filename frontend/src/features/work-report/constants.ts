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

export const FORM_ID = "901";
export const ALL_FILTER_VALUE = "__all__";
export const WORK_REPORT_STATUS_FILTER_VALUES = ["未結案", "已結案", "已作廢"] as const;
export const HYDRATION_CACHE_VERSION = "v3";
export const HYDRATION_CACHE_TTL_MS = 48 * 60 * 60 * 1000;
export const HYDRATION_CACHE_MAX_RECORDS = 3_000;
export const CREATE_TASK_POLL_INTERVAL_MS = 5000;
export const CREATE_TASK_POLL_TIMEOUT_MS = 180000;
export const CREATE_TASK_STALE_POLL_INTERVAL_MS = 30000;
export const MAX_CREATE_TASK_MONITORS = 12;
export const CREATE_TASK_AUTO_CLEAR_MS = 4000;
export const CREATE_TASK_STALE_AUTO_CLEAR_MS = 30000;
export const COLUMN_TEXT_FILTER_MAX_LENGTH = 60;
export const UI_LANGUAGE_STORAGE_KEY = `work-reports:${FORM_ID}:ui-language`;
export const WORK_REPORT_LOCAL_PREFS_VERSION = 3;
export const WORK_REPORT_LOCAL_PREFS_STORAGE_KEY = "work-reports:local-preferences";
export const WORK_REPORT_LIST_ANCHOR_STORAGE_KEY = "work-reports:list-anchor";
export const WORK_REPORT_LIST_HIGHLIGHT_STORAGE_KEY = "work-reports:list-highlight";
export const WORK_REPORT_COLUMN_MODE_STORAGE_KEY = "work-reports:column-mode";
export const WORK_REPORT_TASK_MONITOR_STORAGE_KEY = "work-reports:task-monitor";
export const WORK_REPORT_SAVED_FILTERS_STORAGE_KEY = "work-reports:saved-filters:v1";
export const WORK_REPORT_SAVED_FILTER_SCHEMA_VERSION = 1;
export const WORK_REPORT_MAX_SAVED_FILTERS = 8;
export const WORK_REPORT_MAX_FILTER_CONDITIONS = 12;
export const WORK_REPORT_MAX_FILTER_VALUES = 30;
export const WORK_REPORT_MAX_SAVED_FILTER_NAME_LENGTH = 24;
export const WORK_REPORT_PENDING_MUTATION_REPLAY_STORAGE_KEY = "work-report:pending-mutation-replay:v1";
export const WORK_REPORT_LANDING_PAGE_KEYS = ["line-a-901", "line-b-902"] as const satisfies readonly WorkReportLandingPageKey[];
export const WORK_REPORT_LANDING_PAGE_CONFIGS: Record<
  WorkReportLandingPageKey,
  WorkReportLandingPageConfig
> = {
  "line-a-901": {
    key: "line-a-901",
    formId: "901",
    prodTypeCode: "PA",
    groupLabelI18nKey: "workReport:page.groupLineA",
    defaultFixedPresetPreferenceKey: "defaultFixedPresetId901",
    fallbackFixedPresetId: "unfinished-runnable",
  },
  "line-b-902": {
    key: "line-b-902",
    formId: "902",
    prodTypeCode: "PB",
    groupLabelI18nKey: "workReport:page.groupLineB",
    defaultFixedPresetPreferenceKey: "defaultFixedPresetId902",
    fallbackFixedPresetId: "unfinished-orders",
    resetPresetIdOnSelect: "unfinished-orders",
  },
};

export const COLUMN_HEADER_LOCALE_MAP: Partial<Record<string, ColumnHeaderLocaleText>> = {
  modificationStatus: { zh: "修改狀態", en: "Modify Status" },
  startSchedule: { zh: "開始排程?", en: "Sched?" },
  workOrderNo: { zh: "工令單號", en: "WO No." },
  machineCode: { zh: "本站機台", en: "Current Machine" },
  previousMachine: { zh: "上一站機台", en: "Previous Machine" },
  forgingMother: { zh: "前置母件", en: "Forging Base" },
  customerPartNo: { zh: "客戶料號", en: "Cust Part No." },
  urgent: { zh: "急件", en: "Urgent" },
  sortOrder: { zh: "排序", en: "Sort" },
  size: { zh: "尺寸", en: "Size" },
  plannedStartDate: { zh: "指定開始日期", en: "Planned Start" },
  plannedEndDate: { zh: "指定結束日期", en: "Planned End" },
  estimatedHours: { zh: "預估所需工時", en: "Est. Hours" },
  prevPlanEndDate: { zh: "[上製程]指定結束日期", en: "[Prev Proc] End" },
  targetQtyPc: { zh: "目標數pc", en: "Target pc" },
  pendingQty: { zh: "待生產數量(上一站)", en: "Pending Qty (Previous Station)" },
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
  sourceCloseStatus: { zh: "上游結案狀態", en: "Upstream Close" },
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
  updatedDateFrom: "",
  updatedDateTo: "",
};

export const DEFAULT_FIXED_FILTER_PRESET_ID: FixedFilterPresetId = "unfinished-runnable";
export const DEFAULT_WORK_REPORT_LOCAL_PREFERENCES: WorkReportLocalPreferences = {
  version: WORK_REPORT_LOCAL_PREFS_VERSION,
  defaultLandingPageKey: "line-a-901",
  defaultFixedPresetId901: DEFAULT_FIXED_FILTER_PRESET_ID,
  defaultFixedPresetId902: "unfinished-orders",
  hideTestCustomerPartRecords: true,
  hideSortOrder99Records: true,
  showListScrollHintButton: true,
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
  "fUpdatedFrom",
  "fUpdatedTo",
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

export const FIXED_FILTER_PRESET_IDS_BY_FORM: Record<"901" | "902", readonly FixedFilterPresetId[]> = {
  "901": ["all-data", "unfinished-runnable", "unfinished-orders", "finished-orders"],
  "902": ["unfinished-orders", "all-data", "finished-orders"],
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
  "901" | "902",
  ReadonlyArray<FixedFilterPresetId | SidebarPlaceholderView["id"]>
> = {
  "901": [
    "all-data",
    "starred",
    "last-updated",
    "unfinished-runnable",
    "unfinished-orders",
    "finished-orders",
  ],
  "902": [
    "all-data",
    "starred",
    "last-updated",
    "unfinished-orders",
    "finished-orders",
  ],
} as const;

// Demo 機台快捷篩選順序，放在最前面並維持穩定排序。
export const RAGIC_UNFINISHED_MACHINE_SHORTCUT_ORDER = [
  "MA01",
  "MA05",
  "MA09",
  "MA11",
  "MA15",
  "MA17",
  "MA18",
  "MA19",
  "MA20",
  "MA22",
  "MA23",
  "MA24",
  "MA25",
  "MA26",
  "MA27",
  "MA28",
  "MA29",
  "MA32",
  "MA33",
  "MA35",
  "MA36",
  "MA39",
  "MA40",
  "MA51",
] as const;

export const RAGIC_UNFINISHED_MACHINE_SHORTCUT_ORDER_SET = new Set<string>(
  RAGIC_UNFINISHED_MACHINE_SHORTCUT_ORDER
);

export const RAGIC_UNFINISHED_MACHINE_SHORTCUT_ORDER_902 = [
  "MB07",
  "MB09",
  "MB12",
  "MB15",
  "MB17",
  "MB18",
  "MB19",
  "MB20",
  "MB21",
  "MB22",
  "MB23",
  "MB24",
  "MB25",
  "MB26",
  "MB31",
  "MB35",
  "MB48",
  "MB50",
] as const;

export const RAGIC_UNFINISHED_MACHINE_SHORTCUT_ORDER_902_SET = new Set<string>(
  RAGIC_UNFINISHED_MACHINE_SHORTCUT_ORDER_902
);

export const COLUMN_BLANK_TOKEN = "__blank__";
export const COLUMN_BOOL_TRUE_TOKEN = "__bool_true__";
export const COLUMN_BOOL_FALSE_TOKEN = "__bool_false__";

export const COLUMN_TYPE_MAP: Record<string, ColumnDataType> = {
  modificationStatus: "text",
  startSchedule: "boolean",
  workOrderNo: "text",
  machineCode: "text",
  filterMachineCode: "text",
  previousMachine: "text",
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
  sourceCloseStatus: "text",
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

export const BACKEND_FACET_COLUMN_KEYS: readonly string[] = Object.freeze(
  Object.keys(COLUMN_TYPE_MAP)
);
export const BACKEND_ANALYSIS_COLUMN_KEYS: readonly string[] =
  BACKEND_FACET_COLUMN_KEYS;

// 上方全域搜尋比對範圍：主表顯示欄位（排除布林勾選欄與操作欄）
export const GLOBAL_SEARCH_COLUMN_KEYS: readonly ColumnKey[] = [
  "modificationStatus",
  "workOrderNo",
  "machineCode",
  "previousMachine",
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
  "sourceCloseStatus",
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

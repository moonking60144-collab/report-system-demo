import type { CreateReportTaskStatus, WorkReportItem, WorkReportRecord } from "../../api/workReport";
import type { MutationLifecycleState } from "../../api/mutationLifecycleTypes";
import type { WorkReportOptimisticMutation } from "./workReportOptimisticMutation";

export type WorkReportMutationTaskKind =
  | "create"
  | "create-batch"
  | "update"
  | "delete"
  | "delete-batch";

export type HydrationSource = "network" | "cache" | "sqlite" | null;
export type BackendCacheState = "fresh" | "stale" | "building" | null;

export interface NoticeState {
  type: "success" | "error" | "warn" | "info" | "loading";
  message: string;
  sticky?: boolean;
  displayAsHumanStatus?: boolean;
}

export interface ModalState {
  open: boolean;
  mode: "create" | "edit";
  entryId: string;
  row: WorkReportItem | null;
}

export interface CreateTaskMonitor {
  taskId: string;
  kind: WorkReportMutationTaskKind;
  formId: string;
  entryId: string;
  workOrderNo: string;
  status: CreateReportTaskStatus;
  lifecycleState?: MutationLifecycleState;
  acceptedAt?: string | null;
  confirmedAt?: string | null;
  message: string;
  updatedAt: string;
  rowId?: string;
  stale?: boolean;
  deletedCount?: number;
  deleteFinalizeFailed?: boolean;
  batchCreatedRowIds?: string[];
  optimisticMutation?: WorkReportOptimisticMutation;
}

export interface GlobalFilters {
  globalKeyword: string;
  workOrderKeyword: string;
  customerPartKeyword: string;
  machineCode: string;
  filterMachineCode: string;
  status: string;
  ragicUnfinishedStatus: string;
  siteRunning: "all" | "yes" | "no";
  startSchedule: "all" | "yes" | "no";
  updatedDateFrom: string;
  updatedDateTo: string;
}

export type FixedFilterPresetId =
  | "all-data"
  | "unfinished-runnable"
  | "unfinished-orders"
  | "finished-orders";

export interface FixedFilterPreset {
  id: FixedFilterPresetId;
  label: string;
  shortLabel: string;
  description: string;
  filters: GlobalFilters;
}

export type WorkReportLandingPageKey = "thread-rolling-104" | "heading-105";
export type WorkReportFormId = "104" | "105";
export type WorkReportTopView = "report" | "technical-info" | "local-settings";

export interface WorkReportLandingPageConfig {
  key: WorkReportLandingPageKey;
  formId: WorkReportFormId;
  prodTypeCode: string;
  groupLabelI18nKey: string;
  defaultFixedPresetPreferenceKey: "defaultFixedPresetId104" | "defaultFixedPresetId105";
  fallbackFixedPresetId: FixedFilterPresetId;
  resetPresetIdOnSelect?: FixedFilterPresetId;
}

export interface WorkReportLocalPreferences {
  version: number;
  defaultLandingPageKey: WorkReportLandingPageKey;
  defaultFixedPresetId104: FixedFilterPresetId;
  defaultFixedPresetId105: FixedFilterPresetId;
  hideTestCustomerPartRecords: boolean;
}

export interface WorkReportListAnchor {
  entryId: string;
  scrollY: number;
  at: number;
}

export interface WorkReportListViewState {
  landingPageKey?: WorkReportLandingPageKey;
  activePlaceholderViewId?: SidebarPlaceholderView["id"] | null;
  globalFilterDraft?: GlobalFilters;
  globalFilters?: GlobalFilters;
  page?: number;
  pageSize?: number;
  columnFilterState?: ColumnFilterState;
  columnSortRules?: ColumnSortRule[];
}

export interface WorkReportListLocationState {
  listSearch?: string;
  listAnchor?: WorkReportListAnchor;
  listViewState?: WorkReportListViewState;
}

export interface SidebarPlaceholderView {
  id: "starred" | "last-updated";
  label: string;
  shortLabel: string;
  description: string;
}

export interface SidebarMachinePreset {
  key: string;
  machineCode: string;
  filters: GlobalFilters;
  sortRules: ColumnSortRule[];
}

export interface MergeResult {
  next: WorkReportRecord[];
  replaced: boolean;
}

export interface HydrationCachePayload {
  version: string;
  formId: string;
  records: WorkReportRecord[];
  hydratedAt: number;
}

export interface HydrationCacheWriteJob {
  formId: string;
  records: WorkReportRecord[];
}

export type ColumnDataType = "text" | "number" | "date" | "boolean";
export type ColumnKey = string;
export type ColumnSortDirection = "asc" | "desc";
export type UiLanguage = "zh" | "en";
export type ColumnDisplayMode = "compact" | "fit";
export type ColumnWidthOverrides = Partial<Record<ColumnKey, number>>;
export type WorkReportColumnColor =
  | "none"
  | "gray-soft"
  | "amber-soft"
  | "blue-soft"
  | "cyan-soft"
  | "green-soft"
  | "rose-soft"
  | "violet-soft";
export type ColumnColorOverrides = Partial<Record<ColumnKey, WorkReportColumnColor>>;

export interface WorkReportTableLayoutPreferences {
  version: 2;
  hiddenColumnKeys: ColumnKey[];
  columnOrder: ColumnKey[];
  columnWidths: ColumnWidthOverrides;
  columnColors: ColumnColorOverrides;
}

export interface ColumnFilterRule {
  selectedTokens?: string[];
  textQuery?: string;
}

export type ColumnFilterState = Partial<Record<ColumnKey, ColumnFilterRule>>;
export type ColumnMenuSearchState = Partial<Record<ColumnKey, string>>;

export interface BackendColumnFilterRule extends ColumnFilterRule {
  type: ColumnDataType;
}

export type BackendColumnFilterState = Partial<Record<ColumnKey, BackendColumnFilterRule>>;

export interface ColumnSortRule {
  key: ColumnKey;
  direction: ColumnSortDirection;
  type: ColumnDataType;
}

export interface ColumnAnalysisState {
  open: boolean;
  columnKey: ColumnKey | null;
}

export interface ColumnTextFilterDialogState {
  open: boolean;
  columnKey: ColumnKey | null;
  columnLabel: string;
  draftValue: string;
}

export interface ColumnMenuMeta {
  key: ColumnKey;
  label: string;
  type: ColumnDataType;
}

export interface ColumnFacetOption {
  token: string;
  label: string;
}

export interface ColumnAnalysisSummary {
  totalCount: number;
  nonEmptyCount: number;
  blankCount: number;
  distinctCount: number;
  numberStats?: {
    sum: number;
    avg: number;
    min: number;
    max: number;
    count: number;
  };
  dateStats?: {
    earliest: string | null;
    latest: string | null;
    count: number;
  };
  booleanStats?: {
    yes: number;
    no: number;
    blank: number;
  };
  topValues?: Array<{ label: string; count: number }>;
}

export interface ColumnHeaderLocaleText {
  zh: string;
  en: string;
}

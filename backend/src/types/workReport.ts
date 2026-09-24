import type { WorkReportFilterGroup } from "@shared-types/workReportFilter";

export interface WorkReportItem extends Record<string, unknown> {
  rowId: string;
  snapshotHash?: string;
  remark?: string | null;
}

export type ReportColumnFilterType = "text" | "number" | "date" | "boolean";
export const REPORT_COLUMN_BLANK_TOKEN = "__blank__";
export const REPORT_COLUMN_BOOL_TRUE_TOKEN = "__bool_true__";
export const REPORT_COLUMN_BOOL_FALSE_TOKEN = "__bool_false__";

export const REPORT_COLUMN_TYPE_BY_KEY = {
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
} as const satisfies Record<string, ReportColumnFilterType>;

export type ReportColumnKey = keyof typeof REPORT_COLUMN_TYPE_BY_KEY;

export function isReportColumnKey(value: string): value is ReportColumnKey {
  return Object.prototype.hasOwnProperty.call(REPORT_COLUMN_TYPE_BY_KEY, value);
}

export interface ReportColumnFilterRule {
  type: ReportColumnFilterType;
  selectedTokens?: string[];
  textQuery?: string;
}

export type ReportColumnFilterState = Partial<Record<ReportColumnKey, ReportColumnFilterRule>>;

export interface ReportSortRule {
  key: ReportColumnKey;
  direction: "asc" | "desc";
}

export interface WorkReportRecord {
  id: string;
  entrySnapshotHash?: string;
  reports: WorkReportItem[];
  [key: string]: unknown;
}

export interface ReportQueryOptions {
  formId?: "901" | "902";
  entryId?: string;
  keyword?: string;
  workOrderKeyword?: string;
  customerPartKeyword?: string;
  prodType?: string;
  excludeTestCustomerPart?: boolean;
  excludeSortOrder99?: boolean;
  refresh?: boolean;
  limit: number;
  offset: number;
  status?: string;
  ragicUnfinishedStatus?: string;
  machineCode?: string;
  filterMachineCode?: string;
  siteRunning?: "all" | "yes" | "no";
  startSchedule?: "all" | "yes" | "no";
  updatedDateFrom?: string;
  updatedDateTo?: string;
  columnFilters?: ReportColumnFilterState;
  filterGroup?: WorkReportFilterGroup;
  sortRules?: ReportSortRule[];
}

export type ReportFullCacheSource = "file-cache" | "memory-cache" | "sqlite" | "ragic-live";
export type ReportFullCacheState = "fresh" | "stale" | "building";

export interface ReportReadMeta {
  cacheSource: ReportFullCacheSource;
  cacheState: ReportFullCacheState;
  snapshotAt: string | null;
}

export interface ReportQueryResult {
  data: WorkReportRecord[];
  count: number;
  totalCount: number;
  hasMore: boolean;
  meta: ReportReadMeta;
}

export interface ReportFacetCount {
  token: string;
  count: number;
}

export interface ReportFacetQueryOptions extends Omit<ReportQueryOptions, "limit" | "offset" | "sortRules" | "entryId"> {}

export interface ReportFacetQueryResult {
  data: Record<string, ReportFacetCount[]>;
  meta: ReportReadMeta;
}

export interface ReportAnalysisSummary {
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

export interface ReportAnalysisQueryOptions extends ReportFacetQueryOptions {
  field: ReportColumnKey;
  columnType: "text" | "number" | "date" | "boolean";
}

export interface ReportAnalysisQueryResult {
  data: ReportAnalysisSummary;
  meta: ReportReadMeta;
}

export interface ReportEntryQueryResult {
  data: WorkReportRecord;
  meta: ReportReadMeta;
}

export interface ReportFullCacheMeta extends ReportReadMeta {
  formId: string;
  count: number;
  expiresAt: string | null;
  refreshTriggered: boolean;
  truncated: boolean;
  truncatedCount?: number;
}

export interface ReportFullSnapshotPayload {
  version: string;
  formId: string;
  snapshotAt: string;
  expiresAt: string;
  records: WorkReportRecord[];
  truncated?: boolean;
  truncatedCount?: number;
}

export interface ReportFullQueryOptions {
  refresh?: boolean;
}

export interface ReportFullQueryResult {
  data: WorkReportRecord[];
  meta: ReportFullCacheMeta;
}

export type ReportWritePayload = Record<string, unknown>;

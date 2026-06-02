export interface WorkReportItem extends Record<string, unknown> {
  rowId: string;
  remark?: string | null;
}

export type ReportColumnFilterType = "text" | "number" | "date" | "boolean";

export interface ReportColumnFilterRule {
  type: ReportColumnFilterType;
  selectedTokens?: string[];
  textQuery?: string;
}

export type ReportColumnFilterState = Partial<Record<string, ReportColumnFilterRule>>;

export interface WorkReportRecord {
  id: string;
  reports: WorkReportItem[];
  [key: string]: unknown;
}

export interface ReportQueryOptions {
  entryId?: string;
  keyword?: string;
  workOrderKeyword?: string;
  customerPartKeyword?: string;
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
  sortRules?: Array<{
    key: "machineCode" | "sortOrder" | "lastUpdatedAt" | "plannedStartDate";
    direction: "asc" | "desc";
  }>;
}

export interface ReportQueryResult {
  data: WorkReportRecord[];
  count: number;
  totalCount: number;
  hasMore: boolean;
}

export interface ReportFacetCount {
  token: string;
  count: number;
}

export interface ReportFacetQueryOptions extends Omit<ReportQueryOptions, "limit" | "offset" | "sortRules" | "entryId"> {}

export interface ReportFacetQueryResult {
  data: Record<string, ReportFacetCount[]>;
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
  field: string;
  columnType: "text" | "number" | "date" | "boolean";
}

export type ReportFullCacheSource = "file-cache" | "memory-cache" | "sqlite" | "ragic-live";
export type ReportFullCacheState = "fresh" | "stale" | "building";

export interface ReportFullCacheMeta {
  formId: string;
  count: number;
  cacheSource: ReportFullCacheSource;
  cacheState: ReportFullCacheState;
  snapshotAt: string | null;
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

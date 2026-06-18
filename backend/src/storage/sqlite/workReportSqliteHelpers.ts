import type {
  ReportFacetQueryOptions,
  WorkReportRecord,
} from "../../types/workReport";
export { parseSemanticBooleanToInteger } from "../../utils/semanticBoolean";

export const FACET_BLANK_TOKEN = "__blank__";
export const FACET_BOOL_TRUE_TOKEN = "__bool_true__";
export const FACET_BOOL_FALSE_TOKEN = "__bool_false__";

export type SupportedFacetField =
  | "status"
  | "machineCode"
  | "siteRunning"
  | "startSchedule"
  | "lastUpdatedAt";

export interface EntryRowRecord {
  entry_id: string;
  summary_json: string;
}

export interface EntryDetailRecord {
  detail_json: string;
}

export interface SqliteReportQueryOptions {
  limit: number;
  offset: number;
  keyword?: string;
  workOrderKeyword?: string;
  customerPartKeyword?: string;
  entryId?: string;
  status?: string;
  ragicUnfinishedStatus?: string;
  machineCode?: string;
  filterMachineCode?: string;
  siteRunning?: "all" | "yes" | "no";
  startSchedule?: "all" | "yes" | "no";
  updatedDateFrom?: string;
  updatedDateTo?: string;
  sortRules?: Array<{
    key: "machineCode" | "sortOrder" | "lastUpdatedAt" | "plannedStartDate";
    direction: "asc" | "desc";
  }>;
}

export function toNullableText(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

export function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  if (items.length === 0) {
    return [];
  }
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}


export function toNullableNumber(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = String(value).replace(/,/g, "").trim();
  if (!normalized) {
    return null;
  }
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toNullableIsoDateTime(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = String(value).trim();
  if (!normalized) {
    return null;
  }
  const parsed = new Date(normalized.replace(/-/g, "/"));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function buildSearchText(record: WorkReportRecord): string | null {
  const parts = Object.entries(record)
    .filter(([key, value]) => key !== "reports" && key !== "id" && value !== null && value !== undefined)
    .map(([, value]) => String(value).trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  return parts.join(" ").toLowerCase();
}

export function dedupeRecordsByEntryId(records: WorkReportRecord[]): WorkReportRecord[] {
  const recordByEntryId = new Map<string, WorkReportRecord>();

  for (const record of records) {
    const entryId = toNullableText(record.id);
    if (!entryId) {
      continue;
    }
    if (recordByEntryId.has(entryId)) {
      // NOTE: 防守式處理重複 entry，保留最後一份快照內容。
      recordByEntryId.delete(entryId);
    }
    recordByEntryId.set(entryId, {
      ...record,
      id: entryId,
    });
  }

  return Array.from(recordByEntryId.values());
}

export function parseRecordPayload(
  payloadJson: string,
  fallbackEntryId: string
): WorkReportRecord | null {
  try {
    const parsed = JSON.parse(payloadJson) as Partial<WorkReportRecord>;
    const recordId = toNullableText(parsed.id) ?? fallbackEntryId;
    if (!recordId) {
      return null;
    }
    return {
      ...(parsed as WorkReportRecord),
      id: recordId,
      reports: Array.isArray(parsed.reports) ? parsed.reports : [],
    };
  } catch (_error) {
    return null;
  }
}

export function toFacetToken(
  field: SupportedFacetField,
  value: string | number | null
): string {
  if (value === null || value === undefined || String(value).trim() === "") {
    return FACET_BLANK_TOKEN;
  }

  if (field === "siteRunning" || field === "startSchedule") {
    return Number(value) === 1 ? FACET_BOOL_TRUE_TOKEN : FACET_BOOL_FALSE_TOKEN;
  }

  return String(value).trim();
}

export function compareFacetTokens(
  field: SupportedFacetField,
  left: string,
  right: string
): number {
  if (left === right) {
    return 0;
  }
  if (left === FACET_BLANK_TOKEN) {
    return 1;
  }
  if (right === FACET_BLANK_TOKEN) {
    return -1;
  }

  if (field === "siteRunning" || field === "startSchedule") {
    const rank = (token: string) => {
      if (token === FACET_BOOL_FALSE_TOKEN) {
        return 1;
      }
      if (token === FACET_BOOL_TRUE_TOKEN) {
        return 2;
      }
      return 3;
    };
    return rank(left) - rank(right);
  }

  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
    return leftTime - rightTime;
  }
  return String(left).localeCompare(String(right), "zh-Hant", {
    numeric: true,
    sensitivity: "base",
  });
}

export function buildEntryWhereClauses(
  formId: string,
  options:
    | SqliteReportQueryOptions
    | (ReportFacetQueryOptions & { entryId?: string }),
  generationId?: string
): { whereClauses: string[]; whereParams: Array<string | number> } {
  const whereClauses: string[] = ["form_id = ?"];
  const whereParams: Array<string | number> = [formId];

  const normalizedGenerationId = toNullableText(generationId);
  if (normalizedGenerationId) {
    whereClauses.push("generation_id = ?");
    whereParams.push(normalizedGenerationId);
  }

  const entryId = toNullableText(options.entryId);
  if (entryId) {
    whereClauses.push("entry_id = ?");
    whereParams.push(entryId);
  }

  const keyword = toNullableText(options.keyword);
  if (keyword) {
    whereClauses.push("search_text LIKE ?");
    whereParams.push(`%${keyword.toLowerCase()}%`);
  }

  const workOrderKeyword = toNullableText(options.workOrderKeyword);
  if (workOrderKeyword) {
    whereClauses.push("work_order_no LIKE ?");
    whereParams.push(`%${workOrderKeyword}%`);
  }

  const customerPartKeyword = toNullableText(options.customerPartKeyword);
  if (customerPartKeyword) {
    whereClauses.push("customer_part_no LIKE ?");
    whereParams.push(`%${customerPartKeyword}%`);
  }

  const status = toNullableText(options.status);
  if (status) {
    whereClauses.push("status = ?");
    whereParams.push(status);
  }

  const ragicUnfinishedStatus = toNullableText(options.ragicUnfinishedStatus);
  if (ragicUnfinishedStatus) {
    whereClauses.push("ragic_unfinished_status = ?");
    whereParams.push(ragicUnfinishedStatus);
  }

  const machineCode = toNullableText(options.machineCode);
  if (machineCode) {
    whereClauses.push("COALESCE(NULLIF(machine_code, ''), NULLIF(filter_machine_code, '')) = ?");
    whereParams.push(machineCode);
  }

  const filterMachineCode = toNullableText(options.filterMachineCode);
  if (filterMachineCode) {
    whereClauses.push("filter_machine_code = ?");
    whereParams.push(filterMachineCode);
  }

  if (options.siteRunning === "yes" || options.siteRunning === "no") {
    whereClauses.push("site_running = ?");
    whereParams.push(options.siteRunning === "yes" ? 1 : 0);
  }

  if (options.startSchedule === "yes" || options.startSchedule === "no") {
    whereClauses.push("start_schedule = ?");
    whereParams.push(options.startSchedule === "yes" ? 1 : 0);
  }

  const updatedDateFrom = toNullableIsoDateTime(options.updatedDateFrom);
  if (updatedDateFrom) {
    whereClauses.push("last_updated_at >= ?");
    whereParams.push(updatedDateFrom);
  }

  const updatedDateTo = toNullableIsoDateTime(options.updatedDateTo);
  if (updatedDateTo) {
    whereClauses.push("last_updated_at <= ?");
    whereParams.push(updatedDateTo);
  }

  return { whereClauses, whereParams };
}

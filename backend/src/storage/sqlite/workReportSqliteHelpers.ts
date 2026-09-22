import type {
  ReportColumnFilterState,
  ReportColumnKey,
  ReportFacetQueryOptions,
  ReportSortRule,
  WorkReportRecord,
} from "../../types/workReport";
import type {
  WorkReportFilterCondition,
  WorkReportFilterGroup,
} from "@shared-types/workReportFilter";
import {
  REPORT_COLUMN_BLANK_TOKEN,
  REPORT_COLUMN_BOOL_FALSE_TOKEN,
  REPORT_COLUMN_BOOL_TRUE_TOKEN,
  REPORT_COLUMN_TYPE_BY_KEY,
} from "../../types/workReport";
import { parseDateTimeTimestamp } from "../../utils/dateTime";
export { parseSemanticBooleanToInteger } from "../../utils/semanticBoolean";

export const FACET_BLANK_TOKEN = REPORT_COLUMN_BLANK_TOKEN;
export const FACET_BOOL_TRUE_TOKEN = REPORT_COLUMN_BOOL_TRUE_TOKEN;
export const FACET_BOOL_FALSE_TOKEN = REPORT_COLUMN_BOOL_FALSE_TOKEN;

const REPORT_COLUMN_SQL_BY_KEY: Partial<Record<ReportColumnKey, string>> = {
  startSchedule: "start_schedule",
  workOrderNo: "work_order_no",
  machineCode: "COALESCE(NULLIF(machine_code, ''), NULLIF(filter_machine_code, ''))",
  filterMachineCode: "filter_machine_code",
  customerPartNo: "customer_part_no",
  sortOrder: "sort_order",
  plannedStartDate: "planned_start_date",
  status: "status",
  lastUpdatedAt: "last_updated_at",
  siteRunning: "site_running",
};

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
  prodType?: string;
  excludeTestCustomerPart?: boolean;
  excludeSortOrder99?: boolean;
  entryId?: string;
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

export function getReportColumnSqlExpression(columnKey: ReportColumnKey): string {
  return (
    REPORT_COLUMN_SQL_BY_KEY[columnKey] ??
    `json_extract(summary_json, '$.${columnKey}')`
  );
}

export function getReportColumnTokenSqlExpression(columnKey: ReportColumnKey): string {
  const valueExpression = getReportColumnSqlExpression(columnKey);
  if (REPORT_COLUMN_TYPE_BY_KEY[columnKey] === "boolean") {
    const normalized = `LOWER(TRIM(CAST(${valueExpression} AS TEXT)))`;
    return `CASE
      WHEN ${normalized} IN ('yes', 'true', '1', 'v', '✓', '是') THEN '${FACET_BOOL_TRUE_TOKEN}'
      WHEN ${normalized} IN ('no', 'false', '0', '否') THEN '${FACET_BOOL_FALSE_TOKEN}'
      ELSE '${FACET_BLANK_TOKEN}'
    END`;
  }
  return `CASE
    WHEN ${valueExpression} IS NULL OR TRIM(CAST(${valueExpression} AS TEXT)) = ''
      THEN '${FACET_BLANK_TOKEN}'
    ELSE TRIM(CAST(${valueExpression} AS TEXT))
  END`;
}

export function buildReportColumnSortClauses(rule: ReportSortRule): string[] {
  const valueExpression = getReportColumnSqlExpression(rule.key);
  const tokenExpression = getReportColumnTokenSqlExpression(rule.key);
  const direction = rule.direction === "desc" ? "DESC" : "ASC";
  const type = REPORT_COLUMN_TYPE_BY_KEY[rule.key];

  if (type === "number") {
    return [
      `CASE WHEN ${tokenExpression} = '${FACET_BLANK_TOKEN}' THEN 1 ELSE 0 END`,
      `CAST(REPLACE(CAST(${valueExpression} AS TEXT), ',', '') AS REAL) ${direction}`,
    ];
  }
  if (type === "date") {
    return [
      `CASE WHEN ${tokenExpression} = '${FACET_BLANK_TOKEN}' THEN 1 ELSE 0 END`,
      `COALESCE(julianday(REPLACE(CAST(${valueExpression} AS TEXT), '/', '-')), 0) ${direction}`,
      `CAST(${valueExpression} AS TEXT) ${direction}`,
    ];
  }
  if (type === "boolean") {
    return [
      `CASE WHEN ${tokenExpression} = '${FACET_BLANK_TOKEN}' THEN 1 ELSE 0 END`,
      `CASE ${tokenExpression}
        WHEN '${FACET_BOOL_TRUE_TOKEN}' THEN 2
        WHEN '${FACET_BOOL_FALSE_TOKEN}' THEN 1
        ELSE 0
      END ${direction}`,
    ];
  }
  return [
    `CASE WHEN ${tokenExpression} = '${FACET_BLANK_TOKEN}' THEN 1 ELSE 0 END`,
    `CAST(${valueExpression} AS TEXT) COLLATE NOCASE ${direction}`,
  ];
}

export function escapeSqliteLikeLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function appendColumnFilterClauses(
  whereClauses: string[],
  whereParams: Array<string | number>,
  columnFilters?: ReportColumnFilterState
): void {
  for (const [rawColumnKey, rule] of Object.entries(columnFilters ?? {})) {
    if (!rule) {
      continue;
    }
    const columnKey = rawColumnKey as ReportColumnKey;
    const tokenExpression = getReportColumnTokenSqlExpression(columnKey);
    if (rule.type === "text" && rule.textQuery?.trim()) {
      const valueExpression = getReportColumnSqlExpression(columnKey);
      whereClauses.push(
        `LOWER(TRIM(CAST(${valueExpression} AS TEXT))) LIKE ? ESCAPE '\\'`
      );
      whereParams.push(
        `%${escapeSqliteLikeLiteral(rule.textQuery.trim().toLowerCase())}%`
      );
    }
    const selectedTokens = (rule.selectedTokens ?? []).filter(Boolean);
    if (selectedTokens.length > 0) {
      whereClauses.push(
        `${tokenExpression} IN (${selectedTokens.map(() => "?").join(", ")})`
      );
      whereParams.push(...selectedTokens);
    }
  }
}

function buildCustomFilterConditionClause(
  condition: WorkReportFilterCondition,
  formId: string
): { clause: string; params: Array<string | number> } {
  const valueExpression =
    condition.field === "machineCode" && formId === "902"
      ? "filter_machine_code"
      : getReportColumnSqlExpression(condition.field);
  const trimmedTextExpression = `LOWER(TRIM(CAST(${valueExpression} AS TEXT)))`;
  const values = condition.values.map((value) => value.trim());
  const lowerValues = values.map((value) => value.toLowerCase());
  const blankClause = `(${valueExpression} IS NULL OR TRIM(CAST(${valueExpression} AS TEXT)) = '')`;

  switch (condition.operator) {
    case "contains":
      return {
        clause: `${trimmedTextExpression} LIKE ? ESCAPE '\\'`,
        params: [`%${escapeSqliteLikeLiteral(lowerValues[0] ?? "")}%`],
      };
    case "notContains":
      return {
        clause: `(${blankClause} OR ${trimmedTextExpression} NOT LIKE ? ESCAPE '\\')`,
        params: [`%${escapeSqliteLikeLiteral(lowerValues[0] ?? "")}%`],
      };
    case "equals":
      return { clause: `${trimmedTextExpression} = ?`, params: [lowerValues[0] ?? ""] };
    case "startsWith":
      return {
        clause: `${trimmedTextExpression} LIKE ? ESCAPE '\\'`,
        params: [`${escapeSqliteLikeLiteral(lowerValues[0] ?? "")}%`],
      };
    case "isAnyOf":
    case "isNotAnyOf": {
      const booleanField = condition.field === "siteRunning" || condition.field === "startSchedule";
      const tokenExpression = booleanField
        ? getReportColumnTokenSqlExpression(condition.field)
        : `CASE
            WHEN ${valueExpression} IS NULL OR TRIM(CAST(${valueExpression} AS TEXT)) = ''
              THEN '${FACET_BLANK_TOKEN}'
            ELSE TRIM(CAST(${valueExpression} AS TEXT))
          END`;
      const normalizedValues = booleanField
        ? lowerValues.map((value) =>
            value === "yes" ? FACET_BOOL_TRUE_TOKEN : FACET_BOOL_FALSE_TOKEN
          )
        : lowerValues;
      const comparableExpression = booleanField ? tokenExpression : `LOWER(${tokenExpression})`;
      return {
        clause: `${comparableExpression} ${condition.operator === "isAnyOf" ? "IN" : "NOT IN"} (${normalizedValues
          .map(() => "?")
          .join(", ")})`,
        params: normalizedValues,
      };
    }
    case "isEmpty":
      return { clause: blankClause, params: [] };
    case "isNotEmpty":
      return { clause: `NOT ${blankClause}`, params: [] };
    case "before":
      return {
        clause: `date(${valueExpression}, 'localtime') <= date(?)`,
        params: [values[0] ?? ""],
      };
    case "after":
      return {
        clause: `date(${valueExpression}, 'localtime') >= date(?)`,
        params: [values[0] ?? ""],
      };
    case "between":
      return {
        clause: `date(${valueExpression}, 'localtime') BETWEEN date(?) AND date(?)`,
        params: [values[0] ?? "", values[1] ?? ""],
      };
  }
}

function appendCustomFilterGroupClause(
  whereClauses: string[],
  whereParams: Array<string | number>,
  formId: string,
  filterGroup?: WorkReportFilterGroup
): void {
  if (!filterGroup || filterGroup.conditions.length === 0) {
    return;
  }
  const fragments = filterGroup.conditions.map((condition) =>
    buildCustomFilterConditionClause(condition, formId)
  );
  const joiner = filterGroup.joinMode === "any" ? " OR " : " AND ";
  whereClauses.push(`(${fragments.map((fragment) => fragment.clause).join(joiner)})`);
  for (const fragment of fragments) {
    whereParams.push(...fragment.params);
  }
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
  const timestamp = parseDateTimeTimestamp(value);
  return timestamp === null ? null : new Date(timestamp).toISOString();
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
  field: ReportColumnKey,
  value: string | number | null
): string {
  if (value === null || value === undefined || String(value).trim() === "") {
    return FACET_BLANK_TOKEN;
  }

  if (REPORT_COLUMN_TYPE_BY_KEY[field] === "boolean") {
    return Number(value) === 1 ? FACET_BOOL_TRUE_TOKEN : FACET_BOOL_FALSE_TOKEN;
  }

  return String(value).trim();
}

export function compareFacetTokens(
  field: ReportColumnKey,
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

  if (REPORT_COLUMN_TYPE_BY_KEY[field] === "boolean") {
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
    whereClauses.push("search_text LIKE ? ESCAPE '\\'");
    whereParams.push(`%${escapeSqliteLikeLiteral(keyword.toLowerCase())}%`);
  }

  const workOrderKeyword = toNullableText(options.workOrderKeyword);
  if (workOrderKeyword) {
    whereClauses.push("work_order_no LIKE ? ESCAPE '\\'");
    whereParams.push(`%${escapeSqliteLikeLiteral(workOrderKeyword)}%`);
  }

  const customerPartKeyword = toNullableText(options.customerPartKeyword);
  if (customerPartKeyword) {
    whereClauses.push("customer_part_no LIKE ? ESCAPE '\\'");
    whereParams.push(`%${escapeSqliteLikeLiteral(customerPartKeyword)}%`);
  }

  const prodType = toNullableText(options.prodType);
  if (prodType) {
    whereClauses.push(
      "LOWER(TRIM(CAST(json_extract(summary_json, '$.prodType') AS TEXT))) = ?"
    );
    whereParams.push(prodType.toLowerCase());
  }

  if (options.excludeTestCustomerPart) {
    whereClauses.push("LOWER(COALESCE(customer_part_no, '')) NOT LIKE '%test%'");
  }

  if (options.excludeSortOrder99) {
    const readyConsecutiveLineBClause = formId === "902" ? " OR sort_order_99_auto_visible = 1" : "";
    whereClauses.push(`(sort_order IS NULL OR sort_order <> 99${readyConsecutiveLineBClause})`);
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

  appendColumnFilterClauses(whereClauses, whereParams, options.columnFilters);
  appendCustomFilterGroupClause(whereClauses, whereParams, formId, options.filterGroup);

  return { whereClauses, whereParams };
}

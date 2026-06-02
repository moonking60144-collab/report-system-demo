import { shouldUseSqliteReadForForm } from "../../../config/env";
import type {
  ReportAnalysisQueryOptions,
  ReportAnalysisSummary,
  ReportColumnFilterState,
  ReportFacetCount,
  ReportFacetQueryOptions,
  ReportQueryOptions,
  ReportQueryResult,
  WorkReportRecord,
} from "../../../types/workReport";
import type { StoredSyncState } from "../../../storage/sqlite/workReportSqliteRepository";
import { hasReadableSqliteSnapshot } from "../readModelState";
import { parseSemanticBoolean } from "../../../utils/semanticBoolean";
import { normalizeComparableValue, parseNumericValue } from "./valueUtils";

const COLUMN_BLANK_TOKEN = "__blank__";
const COLUMN_BOOL_TRUE_TOKEN = "__bool_true__";
const COLUMN_BOOL_FALSE_TOKEN = "__bool_false__";

export class WorkReportReadSupport {
  private readonly alphaNumericCollator = new Intl.Collator("zh-Hant", {
    numeric: true,
    sensitivity: "base",
  });

  shouldUseSqliteRead(formId: string): boolean {
    return shouldUseSqliteReadForForm(formId);
  }

  isSqliteSnapshotReady(syncState: StoredSyncState | null): boolean {
    return hasReadableSqliteSnapshot(syncState);
  }

  filterSortAndPaginateReports(
    records: WorkReportRecord[],
    options: ReportQueryOptions
  ): ReportQueryResult {
    const keyword = normalizeComparableValue(options.keyword).toLowerCase();
    const workOrderKeyword = normalizeComparableValue(options.workOrderKeyword).toLowerCase();
    const customerPartKeyword = normalizeComparableValue(options.customerPartKeyword).toLowerCase();
    const status = normalizeComparableValue(options.status);
    const ragicUnfinishedStatus = normalizeComparableValue(options.ragicUnfinishedStatus);
    const machineCode = normalizeComparableValue(options.machineCode);
    const filterMachineCode = normalizeComparableValue(options.filterMachineCode);
    const updatedDateFrom = this.parseTimestamp(options.updatedDateFrom);
    const updatedDateTo = this.parseTimestamp(options.updatedDateTo);
    const globallyFiltered = records.filter((record) => {
      if (status && normalizeComparableValue(record.status) !== status) {
        return false;
      }
      if (
        ragicUnfinishedStatus &&
        normalizeComparableValue(record.ragicUnfinishedStatus) !== ragicUnfinishedStatus
      ) {
        return false;
      }
      if (
        machineCode &&
        normalizeComparableValue(record.machineCode || record.filterMachineCode) !== machineCode
      ) {
        return false;
      }
      if (
        filterMachineCode &&
        normalizeComparableValue(record.filterMachineCode) !== filterMachineCode
      ) {
        return false;
      }
      if (workOrderKeyword) {
        const workOrderNo = normalizeComparableValue(record.workOrderNo).toLowerCase();
        if (!workOrderNo.includes(workOrderKeyword)) {
          return false;
        }
      }
      if (customerPartKeyword) {
        const nextCustomerPartNo = normalizeComparableValue(record.customerPartNo).toLowerCase();
        if (!nextCustomerPartNo.includes(customerPartKeyword)) {
          return false;
        }
      }
      if (options.siteRunning && options.siteRunning !== "all") {
        const siteRunning = parseSemanticBoolean(record.siteRunning);
        if (options.siteRunning === "yes" && siteRunning !== true) {
          return false;
        }
        if (options.siteRunning === "no" && siteRunning !== false) {
          return false;
        }
      }
      if (options.startSchedule && options.startSchedule !== "all") {
        const startSchedule = parseSemanticBoolean(record.startSchedule);
        if (options.startSchedule === "yes" && startSchedule !== true) {
          return false;
        }
        if (options.startSchedule === "no" && startSchedule !== false) {
          return false;
        }
      }
      if (keyword) {
        const workOrderNo = normalizeComparableValue(record.workOrderNo).toLowerCase();
        const customerPartNo = normalizeComparableValue(record.customerPartNo).toLowerCase();
        const recordMachineCode = normalizeComparableValue(
          record.machineCode || record.filterMachineCode
        ).toLowerCase();
        if (
          !workOrderNo.includes(keyword) &&
          !customerPartNo.includes(keyword) &&
          !recordMachineCode.includes(keyword)
        ) {
          return false;
        }
      }
      const updatedAt = this.parseTimestamp(record.lastUpdatedAt);
      if (updatedDateFrom !== null && (updatedAt === null || updatedAt < updatedDateFrom)) {
        return false;
      }
      if (updatedDateTo !== null && (updatedAt === null || updatedAt > updatedDateTo)) {
        return false;
      }
      if (options.entryId && String(record.id) !== options.entryId) {
        return false;
      }
      return true;
    });

    const filtered = this.applyReportColumnFilters(globallyFiltered, options.columnFilters);

    const sorted =
      options.sortRules && options.sortRules.length > 0
        ? [...filtered].sort((left, right) => this.compareBySortRules(left, right, options.sortRules ?? []))
        : filtered;

    const safeLimit = Math.max(1, Math.trunc(options.limit));
    const safeOffset = Math.max(0, Math.trunc(options.offset));
    const data = sorted.slice(safeOffset, safeOffset + safeLimit);

    return {
      data,
      count: data.length,
      totalCount: sorted.length,
      hasMore: safeOffset + safeLimit < sorted.length,
    };
  }

  buildFacetCountsFromRecords(
    records: WorkReportRecord[],
    fields: string[],
    options: ReportFacetQueryOptions
  ): Record<string, ReportFacetCount[]> {
    const filtered = this.filterSortAndPaginateReports(records, {
      ...options,
      limit: records.length || 1,
      offset: 0,
      sortRules: [],
    }).data;

    const result: Record<string, ReportFacetCount[]> = {};
    for (const field of fields) {
      if (
        field !== "status" &&
        field !== "machineCode" &&
        field !== "siteRunning" &&
        field !== "startSchedule" &&
        field !== "lastUpdatedAt"
      ) {
        result[field] = [];
        continue;
      }

      const counts = new Map<string, number>();
      for (const record of filtered) {
        const token = this.toFacetTokenFromRecord(record[field], field);
        counts.set(token, (counts.get(token) ?? 0) + 1);
      }

      result[field] = Array.from(counts.entries())
        .map(([token, count]) => ({ token, count }))
        .sort((left, right) => this.compareFacetTokens(field, left.token, right.token));
    }
    return result;
  }

  buildAnalysisSummaryFromRecords(
    records: WorkReportRecord[],
    options: ReportFacetQueryOptions & ReportAnalysisQueryOptions
  ): ReportAnalysisSummary {
    const filtered = this.filterSortAndPaginateReports(records, {
      ...options,
      limit: records.length || 1,
      offset: 0,
      sortRules: [],
    }).data;

    const values = filtered.map((record) => record[options.field]);
    const tokens = values.map((value) => this.toFacetTokenFromRecord(value, options.field));
    const nonBlankTokens = tokens.filter((token) => token !== COLUMN_BLANK_TOKEN);
    const distinctCount = new Set(tokens).size;
    const topValueCountMap = new Map<string, number>();

    for (const token of tokens) {
      const label = this.getFacetLabelFromToken(token, options.columnType);
      topValueCountMap.set(label, (topValueCountMap.get(label) ?? 0) + 1);
    }

    const topValues = Array.from(topValueCountMap.entries())
      .sort((left, right) => {
        if (right[1] !== left[1]) {
          return right[1] - left[1];
        }
        return this.alphaNumericCollator.compare(left[0], right[0]);
      })
      .slice(0, 10)
      .map(([label, count]) => ({ label, count }));

    const summary: ReportAnalysisSummary = {
      totalCount: filtered.length,
      nonEmptyCount: nonBlankTokens.length,
      blankCount: tokens.length - nonBlankTokens.length,
      distinctCount,
      topValues,
    };

    if (options.columnType === "number") {
      const numericValues = values
        .map((value) => parseNumericValue(value))
        .filter((value): value is number => value !== null);
      if (numericValues.length > 0) {
        const sum = numericValues.reduce((acc, value) => acc + value, 0);
        summary.numberStats = {
          sum,
          avg: sum / numericValues.length,
          min: Math.min(...numericValues),
          max: Math.max(...numericValues),
          count: numericValues.length,
        };
      }
    }

    if (options.columnType === "date") {
      const dateValues = values
        .map((value) => {
          const timestamp = this.parseTimestamp(value);
          return timestamp === null ? null : { timestamp, raw: String(value) };
        })
        .filter((value): value is { timestamp: number; raw: string } => value !== null)
        .sort((left, right) => left.timestamp - right.timestamp);
      if (dateValues.length > 0) {
        summary.dateStats = {
          earliest: dateValues[0].raw,
          latest: dateValues[dateValues.length - 1].raw,
          count: dateValues.length,
        };
      }
    }

    if (options.columnType === "boolean") {
      let yes = 0;
      let no = 0;
      let blank = 0;
      for (const token of tokens) {
        if (token === COLUMN_BOOL_TRUE_TOKEN) {
          yes += 1;
        } else if (token === COLUMN_BOOL_FALSE_TOKEN) {
          no += 1;
        } else {
          blank += 1;
        }
      }
      summary.booleanStats = { yes, no, blank };
    }

    return summary;
  }

  private compareBySortRules(
    left: WorkReportRecord,
    right: WorkReportRecord,
    sortRules: NonNullable<ReportQueryOptions["sortRules"]>
  ): number {
    for (const rule of sortRules) {
      let diff = 0;
      if (rule.key === "sortOrder") {
        const leftValue = parseNumericValue(left.sortOrder) ?? Number.POSITIVE_INFINITY;
        const rightValue = parseNumericValue(right.sortOrder) ?? Number.POSITIVE_INFINITY;
        diff = leftValue - rightValue;
      } else if (rule.key === "lastUpdatedAt") {
        const leftValue = this.parseTimestamp(left.lastUpdatedAt) ?? 0;
        const rightValue = this.parseTimestamp(right.lastUpdatedAt) ?? 0;
        diff = leftValue - rightValue;
      } else if (rule.key === "plannedStartDate") {
        const leftValue = this.parseTimestamp(left.plannedStartDate) ?? Number.POSITIVE_INFINITY;
        const rightValue = this.parseTimestamp(right.plannedStartDate) ?? Number.POSITIVE_INFINITY;
        diff = leftValue - rightValue;
      } else {
        const leftMachineCode = normalizeComparableValue(left.machineCode || left.filterMachineCode);
        const rightMachineCode = normalizeComparableValue(
          right.machineCode || right.filterMachineCode
        );
        if (!leftMachineCode && !rightMachineCode) {
          diff = 0;
        } else if (!leftMachineCode) {
          diff = 1;
        } else if (!rightMachineCode) {
          diff = -1;
        } else {
          diff = this.alphaNumericCollator.compare(leftMachineCode, rightMachineCode);
        }
      }

      if (diff !== 0) {
        return rule.direction === "desc" ? diff * -1 : diff;
      }
    }

    return this.alphaNumericCollator.compare(
      normalizeComparableValue(left.id),
      normalizeComparableValue(right.id)
    );
  }

  private normalizeColumnFilterText(value: unknown): string {
    return normalizeComparableValue(value).replace(/\s+/g, " ").trim().toLowerCase();
  }

  private getColumnFilterValue(record: WorkReportRecord, columnKey: string): unknown {
    if (columnKey === "machineCode") {
      return record.machineCode || record.filterMachineCode;
    }
    return record[columnKey];
  }

  private getColumnFilterToken(
    value: unknown,
    type: ReportAnalysisQueryOptions["columnType"]
  ): string {
    if (type === "boolean") {
      const parsed = parseSemanticBoolean(value);
      if (parsed === true) {
        return COLUMN_BOOL_TRUE_TOKEN;
      }
      if (parsed === false) {
        return COLUMN_BOOL_FALSE_TOKEN;
      }
      return COLUMN_BLANK_TOKEN;
    }

    const text = normalizeComparableValue(value);
    return text || COLUMN_BLANK_TOKEN;
  }

  private applyReportColumnFilters(
    records: WorkReportRecord[],
    columnFilters?: ReportColumnFilterState
  ): WorkReportRecord[] {
    const activeEntries = Object.entries(columnFilters ?? {}).filter(
      (entry): entry is [string, NonNullable<typeof entry[1]>] => {
        const [, rule] = entry;
        const hasSelectedTokens =
          Array.isArray(rule?.selectedTokens) && rule.selectedTokens.length > 0;
        const hasTextQuery = typeof rule?.textQuery === "string" && rule.textQuery.trim() !== "";
        return hasSelectedTokens || hasTextQuery;
      }
    );

    if (activeEntries.length === 0) {
      return records;
    }

    return records.filter((record) =>
      activeEntries.every(([columnKey, rule]) => {
        const value = this.getColumnFilterValue(record, columnKey);

        if (rule.type === "text" && rule.textQuery) {
          const textQuery = this.normalizeColumnFilterText(rule.textQuery);
          if (textQuery && !this.normalizeColumnFilterText(value).includes(textQuery)) {
            return false;
          }
        }

        if (rule.selectedTokens?.length) {
          const token = this.getColumnFilterToken(value, rule.type);
          if (!rule.selectedTokens.includes(token)) {
            return false;
          }
        }

        return true;
      })
    );
  }

  private toFacetTokenFromRecord(value: unknown, field: string): string {
    if (field === "siteRunning" || field === "startSchedule") {
      const parsed = parseSemanticBoolean(value);
      if (parsed === true) {
        return COLUMN_BOOL_TRUE_TOKEN;
      }
      if (parsed === false) {
        return COLUMN_BOOL_FALSE_TOKEN;
      }
      return COLUMN_BLANK_TOKEN;
    }

    return normalizeComparableValue(value) || COLUMN_BLANK_TOKEN;
  }

  private compareFacetTokens(field: string, left: string, right: string): number {
    if (left === right) {
      return 0;
    }
    if (left === COLUMN_BLANK_TOKEN) {
      return 1;
    }
    if (right === COLUMN_BLANK_TOKEN) {
      return -1;
    }
    if (field === "siteRunning" || field === "startSchedule") {
      const rank = (token: string) => {
        if (token === COLUMN_BOOL_FALSE_TOKEN) {
          return 1;
        }
        if (token === COLUMN_BOOL_TRUE_TOKEN) {
          return 2;
        }
        return 3;
      };
      return rank(left) - rank(right);
    }
    return this.alphaNumericCollator.compare(left, right);
  }

  private getFacetLabelFromToken(
    token: string,
    columnType: ReportAnalysisQueryOptions["columnType"]
  ): string {
    if (token === COLUMN_BLANK_TOKEN) {
      return "（空白）";
    }
    if (columnType === "boolean") {
      if (token === COLUMN_BOOL_TRUE_TOKEN) {
        return "是";
      }
      if (token === COLUMN_BOOL_FALSE_TOKEN) {
        return "否";
      }
    }
    return token;
  }

  private parseTimestamp(value: unknown): number | null {
    if (value === undefined || value === null) {
      return null;
    }
    const normalized = String(value).trim();
    if (!normalized) {
      return null;
    }
    const parsed = new Date(normalized.replace(/-/g, "/"));
    return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
  }
}

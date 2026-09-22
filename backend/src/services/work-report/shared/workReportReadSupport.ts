import { env, shouldUseSqliteReadForForm } from "../../../config/env";
import type {
  ReportAnalysisQueryOptions,
  ReportAnalysisSummary,
  ReportColumnFilterState,
  ReportFacetCount,
  ReportFacetQueryOptions,
  ReportQueryOptions,
  ReportQueryResult,
  ReportColumnKey,
  ReportColumnFilterType,
  WorkReportRecord,
} from "../../../types/workReport";
import type {
  WorkReportFilterCondition,
  WorkReportFilterGroup,
} from "@shared-types/workReportFilter";
import {
  isReportColumnKey,
  REPORT_COLUMN_BLANK_TOKEN,
  REPORT_COLUMN_BOOL_FALSE_TOKEN,
  REPORT_COLUMN_BOOL_TRUE_TOKEN,
  REPORT_COLUMN_TYPE_BY_KEY,
} from "../../../types/workReport";
import type { StoredSyncState } from "../../../storage/sqlite/workReportSqliteRepository";
import { hasReadableSqliteSnapshot, isSqliteSnapshotStale } from "../readModelState";
import { parseDateTimeTimestamp } from "../../../utils/dateTime";
import { parseSemanticBoolean } from "../../../utils/semanticBoolean";
import { normalizeComparableValue, parseNumericValue } from "./valueUtils";
import { shouldExcludeSortOrder99Record } from "./workReportSortOrderVisibility";

const COLUMN_BLANK_TOKEN = REPORT_COLUMN_BLANK_TOKEN;
const COLUMN_BOOL_TRUE_TOKEN = REPORT_COLUMN_BOOL_TRUE_TOKEN;
const COLUMN_BOOL_FALSE_TOKEN = REPORT_COLUMN_BOOL_FALSE_TOKEN;
const STALE_SNAPSHOT_WARN_INTERVAL_MS = 5 * 60 * 1000;

export class WorkReportReadSupport {
  private readonly alphaNumericCollator = new Intl.Collator("zh-Hant", {
    numeric: true,
    sensitivity: "base",
  });
  private readonly staleSnapshotWarnAtByForm = new Map<string, number>();

  shouldUseSqliteRead(formId: string): boolean {
    return shouldUseSqliteReadForForm(formId);
  }

  isSqliteSnapshotReady(
    syncState: StoredSyncState | null,
    options: { allowStale?: boolean } = {}
  ): boolean {
    if (!syncState || !hasReadableSqliteSnapshot(syncState)) {
      return false;
    }
    if (isSqliteSnapshotStale(syncState, env.SQLITE_READ_MAX_STALENESS_MS)) {
      const allowStale = Boolean(options.allowStale);
      this.warnStaleSnapshot(syncState, allowStale ? "used" : "fallback");
      return allowStale;
    }
    return true;
  }

  private warnStaleSnapshot(syncState: StoredSyncState, mode: "fallback" | "used"): void {
    // 每個 form 每 5 分鐘最多 warn 一次：stale 期間所有列表/詳情請求都會走到
    // 這裡，不 throttle 會洗版。
    const now = Date.now();
    const lastWarnAt = this.staleSnapshotWarnAtByForm.get(syncState.formId) ?? 0;
    if (now - lastWarnAt < STALE_SNAPSHOT_WARN_INTERVAL_MS) {
      return;
    }
    this.staleSnapshotWarnAtByForm.set(syncState.formId, now);
    console.warn(
      mode === "used"
        ? "[sqlite-read][stale-snapshot-used]"
        : "[sqlite-read][stale-snapshot-fallback]",
      {
        formId: syncState.formId,
        snapshotAt: syncState.snapshotAt,
        maxStalenessMs: env.SQLITE_READ_MAX_STALENESS_MS,
      }
    );
  }

  filterSortAndPaginateReports(
    records: WorkReportRecord[],
    options: ReportQueryOptions
  ): Omit<ReportQueryResult, "meta"> {
    const keyword = normalizeComparableValue(options.keyword).toLowerCase();
    const workOrderKeyword = normalizeComparableValue(options.workOrderKeyword).toLowerCase();
    const customerPartKeyword = normalizeComparableValue(options.customerPartKeyword).toLowerCase();
    const prodType = normalizeComparableValue(options.prodType).toUpperCase();
    const status = normalizeComparableValue(options.status);
    const ragicUnfinishedStatus = normalizeComparableValue(options.ragicUnfinishedStatus);
    const machineCode = normalizeComparableValue(options.machineCode);
    const filterMachineCode = normalizeComparableValue(options.filterMachineCode);
    const updatedDateFrom = this.parseTimestamp(options.updatedDateFrom);
    const updatedDateTo = this.parseTimestamp(options.updatedDateTo);
    const globallyFiltered = records.filter((record) => {
      if (
        prodType &&
        normalizeComparableValue(record.prodType).toUpperCase() !== prodType
      ) {
        return false;
      }
      if (
        options.excludeTestCustomerPart &&
        normalizeComparableValue(record.customerPartNo).toLowerCase().includes("test")
      ) {
        return false;
      }
      if (shouldExcludeSortOrder99Record(record, options.formId, options.excludeSortOrder99)) {
        return false;
      }
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

    const customFiltered = this.applyCustomFilterGroup(
      globallyFiltered,
      options.filterGroup,
      options.formId
    );
    const filtered = this.applyReportColumnFilters(customFiltered, options.columnFilters);

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
      if (!isReportColumnKey(field)) {
        result[field] = [];
        continue;
      }

      const counts = new Map<string, number>();
      for (const record of filtered) {
        const token = this.getColumnFilterToken(
          this.getReportColumnValue(record, field),
          REPORT_COLUMN_TYPE_BY_KEY[field]
        );
        counts.set(token, (counts.get(token) ?? 0) + 1);
      }

      result[field] = Array.from(counts.entries())
        .map(([token, count]) => ({ token, count }))
        .sort((left, right) =>
          this.compareFacetTokens(
            REPORT_COLUMN_TYPE_BY_KEY[field],
            left.token,
            right.token
          )
        );
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
    return this.buildAnalysisSummaryFromValues(values, options.columnType);
  }

  buildAnalysisSummaryFromValues(
    values: unknown[],
    columnType: ReportAnalysisQueryOptions["columnType"]
  ): ReportAnalysisSummary {
    const tokens = values.map((value) => this.getColumnFilterToken(value, columnType));
    const nonBlankTokens = tokens.filter((token) => token !== COLUMN_BLANK_TOKEN);
    const distinctCount = new Set(tokens).size;
    const topValueCountMap = new Map<string, number>();

    for (const token of tokens) {
      const label = this.getFacetLabelFromToken(token, columnType);
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
      totalCount: values.length,
      nonEmptyCount: nonBlankTokens.length,
      blankCount: tokens.length - nonBlankTokens.length,
      distinctCount,
      topValues,
    };

    if (columnType === "number") {
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

    if (columnType === "date") {
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

    if (columnType === "boolean") {
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
      const type = REPORT_COLUMN_TYPE_BY_KEY[rule.key];
      const leftValue = this.getReportColumnValue(left, rule.key);
      const rightValue = this.getReportColumnValue(right, rule.key);
      const leftBlank = this.isBlankSortValue(leftValue, type);
      const rightBlank = this.isBlankSortValue(rightValue, type);
      if (leftBlank !== rightBlank) {
        return leftBlank ? 1 : -1;
      }
      if (leftBlank && rightBlank) {
        continue;
      }
      const diff = this.compareReportColumnValues(leftValue, rightValue, type);
      if (diff !== 0) {
        return rule.direction === "desc" ? diff * -1 : diff;
      }
    }

    return 0;
  }

  private normalizeColumnFilterText(value: unknown): string {
    return normalizeComparableValue(value).trim().toLowerCase();
  }

  private getReportColumnValue(record: WorkReportRecord, columnKey: ReportColumnKey): unknown {
    if (columnKey === "machineCode") {
      return record.machineCode || record.filterMachineCode;
    }
    return record[columnKey];
  }

  private isBlankSortValue(value: unknown, type: ReportColumnFilterType): boolean {
    if (type === "boolean") {
      return parseSemanticBoolean(value) === null;
    }
    return normalizeComparableValue(value) === "";
  }

  private compareReportColumnValues(
    left: unknown,
    right: unknown,
    type: ReportColumnFilterType
  ): number {
    if (type === "number") {
      const toNumber = (value: unknown): number => {
        const normalized = normalizeComparableValue(value).replace(/,/g, "");
        const parsed = Number(normalized);
        return Number.isFinite(parsed) ? parsed : 0;
      };
      return toNumber(left) - toNumber(right);
    }
    if (type === "date") {
      return (this.parseTimestamp(left) ?? 0) - (this.parseTimestamp(right) ?? 0);
    }
    if (type === "boolean") {
      const toRank = (value: unknown): number => (parseSemanticBoolean(value) ? 2 : 1);
      return toRank(left) - toRank(right);
    }
    return this.alphaNumericCollator.compare(
      normalizeComparableValue(left),
      normalizeComparableValue(right)
    );
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
      (entry): entry is [ReportColumnKey, NonNullable<typeof entry[1]>] => {
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
        const value = this.getReportColumnValue(record, columnKey);

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

  private applyCustomFilterGroup(
    records: WorkReportRecord[],
    filterGroup?: WorkReportFilterGroup,
    formId?: "901" | "902"
  ): WorkReportRecord[] {
    if (!filterGroup || filterGroup.conditions.length === 0) {
      return records;
    }
    return records.filter((record) => {
      const matches = (condition: WorkReportFilterCondition): boolean => {
        const rawValue =
          condition.field === "machineCode" && formId === "902"
            ? record.filterMachineCode
            : this.getReportColumnValue(record, condition.field);
        const text = this.normalizeColumnFilterText(rawValue);
        const values = condition.values.map((value) => this.normalizeColumnFilterText(value));
        switch (condition.operator) {
          case "contains":
            return text.includes(values[0] ?? "");
          case "notContains":
            return !text.includes(values[0] ?? "");
          case "equals":
            return text === (values[0] ?? "");
          case "startsWith":
            return text.startsWith(values[0] ?? "");
          case "isAnyOf":
          case "isNotAnyOf": {
            const semanticBoolean = parseSemanticBoolean(rawValue);
            const comparable =
              condition.field === "siteRunning" || condition.field === "startSchedule"
                ? semanticBoolean === true
                  ? "yes"
                  : semanticBoolean === false
                    ? "no"
                    : ""
                : text;
            const included = values.includes(comparable);
            return condition.operator === "isAnyOf" ? included : !included;
          }
          case "isEmpty":
            return text === "";
          case "isNotEmpty":
            return text !== "";
          case "before":
          case "after":
          case "between": {
            const timestamp = this.parseTimestamp(rawValue);
            if (timestamp === null) {
              return false;
            }
            const date = new Date(timestamp);
            const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
              date.getDate()
            ).padStart(2, "0")}`;
            if (condition.operator === "before") {
              return dateKey <= (condition.values[0] ?? "");
            }
            if (condition.operator === "after") {
              return dateKey >= (condition.values[0] ?? "");
            }
            return (
              dateKey >= (condition.values[0] ?? "") &&
              dateKey <= (condition.values[1] ?? "")
            );
          }
        }
      };
      return filterGroup.joinMode === "any"
        ? filterGroup.conditions.some(matches)
        : filterGroup.conditions.every(matches);
    });
  }

  private compareFacetTokens(
    type: ReportColumnFilterType,
    left: string,
    right: string
  ): number {
    if (left === right) {
      return 0;
    }
    if (left === COLUMN_BLANK_TOKEN) {
      return 1;
    }
    if (right === COLUMN_BLANK_TOKEN) {
      return -1;
    }
    if (type === "boolean") {
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
    return parseDateTimeTimestamp(value);
  }
}

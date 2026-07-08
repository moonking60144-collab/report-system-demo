import { workReportSqliteRepository } from "../../storage/sqlite/workReportSqliteRepository";
import type {
  ReportAnalysisQueryOptions,
  ReportAnalysisSummary,
  ReportFacetCount,
  ReportFacetQueryOptions,
  ReportFullQueryResult,
} from "../../types/workReport";
import { WorkReportReadSupport } from "./shared/workReportReadSupport";

export class WorkReportAnalysisReadService {
  constructor(
    private readonly support: WorkReportReadSupport,
    private readonly getFullReports: (
      formId: string,
      options: { refresh: boolean }
    ) => Promise<ReportFullQueryResult>
  ) {}

  async getReportFacets(
    formId: string,
    fields: string[],
    options: ReportFacetQueryOptions
  ): Promise<Record<string, ReportFacetCount[]>> {
    if (!fields.length) {
      return {};
    }

    if (!options.refresh && !options.columnFilters) {
      const sqliteResult = await this.tryGetReportFacetsFromSqlite(formId, fields, options);
      if (sqliteResult) {
        return sqliteResult;
      }
    }

    const sourceRecords = (await this.getFullReports(formId, { refresh: Boolean(options.refresh) })).data;
    return this.support.buildFacetCountsFromRecords(sourceRecords, fields, options);
  }

  async getReportAnalysis(
    formId: string,
    options: ReportAnalysisQueryOptions & ReportFacetQueryOptions
  ): Promise<ReportAnalysisSummary> {
    const sourceRecords = (await this.getFullReports(formId, { refresh: Boolean(options.refresh) })).data;
    return this.support.buildAnalysisSummaryFromRecords(sourceRecords, options);
  }

  private async tryGetReportFacetsFromSqlite(
    formId: string,
    fields: string[],
    options: ReportFacetQueryOptions
  ): Promise<Record<string, ReportFacetCount[]> | null> {
    if (!this.support.shouldUseSqliteRead(formId)) {
      return null;
    }

    try {
      const syncState = await workReportSqliteRepository.getSyncState(formId);
      if (!this.support.isSqliteSnapshotReady(syncState)) {
        return null;
      }
      return await workReportSqliteRepository.getFacetCounts(formId, options, fields);
    } catch (error) {
      console.warn("[sqlite-read-fallback][report-facets]", {
        formId,
        fields,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

import { workReportSqliteRepository } from "../../storage/sqlite/workReportSqliteRepository";
import type {
  ReportAnalysisQueryResult,
  ReportAnalysisQueryOptions,
  ReportFacetQueryOptions,
  ReportFacetQueryResult,
  ReportFullQueryResult,
} from "../../types/workReport";
import { createRagicLiveReadMeta, resolveSqliteReadMeta } from "./readModelState";
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
  ): Promise<ReportFacetQueryResult> {
    if (!fields.length) {
      return { data: {}, meta: createRagicLiveReadMeta() };
    }

    if (!options.refresh) {
      const sqliteResult = await this.tryGetReportFacetsFromSqlite(formId, fields, options);
      if (sqliteResult) {
        return sqliteResult;
      }
    }

    const fullResult = await this.getFullReports(formId, {
      refresh: Boolean(options.refresh),
    });
    return {
      data: this.support.buildFacetCountsFromRecords(fullResult.data, fields, options),
      meta: {
        cacheSource: fullResult.meta.cacheSource,
        cacheState: fullResult.meta.cacheState,
        snapshotAt: fullResult.meta.snapshotAt,
      },
    };
  }

  async getReportAnalysis(
    formId: string,
    options: ReportAnalysisQueryOptions & ReportFacetQueryOptions
  ): Promise<ReportAnalysisQueryResult> {
    if (!options.refresh) {
      const sqliteResult = await this.tryGetReportAnalysisFromSqlite(formId, options);
      if (sqliteResult) {
        return sqliteResult;
      }
    }

    const fullResult = await this.getFullReports(formId, {
      refresh: Boolean(options.refresh),
    });
    return {
      data: this.support.buildAnalysisSummaryFromRecords(fullResult.data, options),
      meta: {
        cacheSource: fullResult.meta.cacheSource,
        cacheState: fullResult.meta.cacheState,
        snapshotAt: fullResult.meta.snapshotAt,
      },
    };
  }

  private async tryGetReportAnalysisFromSqlite(
    formId: string,
    options: ReportAnalysisQueryOptions & ReportFacetQueryOptions
  ): Promise<ReportAnalysisQueryResult | null> {
    if (!this.support.shouldUseSqliteRead(formId)) {
      return null;
    }
    try {
      const syncState = await workReportSqliteRepository.getSyncState(formId);
      if (!this.support.isSqliteSnapshotReady(syncState, { allowStale: true })) {
        return null;
      }
      const values = await workReportSqliteRepository.getColumnValues(
        formId,
        options,
        options.field
      );
      return {
        data: this.support.buildAnalysisSummaryFromValues(values, options.columnType),
        meta: resolveSqliteReadMeta(syncState),
      };
    } catch (error) {
      console.warn("[sqlite-read-fallback][report-analysis]", {
        formId,
        field: options.field,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async tryGetReportFacetsFromSqlite(
    formId: string,
    fields: string[],
    options: ReportFacetQueryOptions
  ): Promise<ReportFacetQueryResult | null> {
    if (!this.support.shouldUseSqliteRead(formId)) {
      return null;
    }

    try {
      const syncState = await workReportSqliteRepository.getSyncState(formId);
      if (!this.support.isSqliteSnapshotReady(syncState, { allowStale: true })) {
        return null;
      }
      return {
        data: await workReportSqliteRepository.getFacetCounts(formId, options, fields),
        meta: resolveSqliteReadMeta(syncState),
      };
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

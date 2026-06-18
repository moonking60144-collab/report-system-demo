import type { RagicReadPriority } from "../../infra/ragicRequestScheduler";
import type {
  ReportAnalysisQueryOptions,
  ReportAnalysisSummary,
  ReportFacetCount,
  ReportFacetQueryOptions,
  ReportFacetQueryResult,
  ReportFullQueryOptions,
  ReportFullQueryResult,
  ReportQueryOptions,
  ReportQueryResult,
  WorkReportRecord,
} from "../../types/workReport";
import { WorkReportReadSupport } from "./shared/workReportReadSupport";
import {
  type FormOptionMap,
  WorkReportOptionsReadService,
} from "./workReportOptionsReadService";
import { WorkReportReportsReadService } from "./workReportReportsReadService";
import { WorkReportAnalysisReadService } from "./workReportAnalysisReadService";
import { WorkReportEntryReadService } from "./workReportEntryReadService";

export { type FormOptionMap } from "./workReportOptionsReadService";

export class WorkReportReadService {
  private readonly support = new WorkReportReadSupport();
  private readonly optionsReadService = new WorkReportOptionsReadService();
  private readonly reportsReadService = new WorkReportReportsReadService(this.support);
  private readonly analysisReadService = new WorkReportAnalysisReadService(
    this.support,
    this.reportsReadService.getFullReports.bind(this.reportsReadService)
  );
  private readonly entryReadService = new WorkReportEntryReadService(
    this.support,
    this.optionsReadService
  );

  async getFormOptions(
    formId: string,
    fields?: string[],
    priority: RagicReadPriority = "user"
  ): Promise<FormOptionMap> {
    return this.optionsReadService.getFormOptions(formId, fields, priority);
  }

  async getRawPreview(formId: string, limit: number) {
    return this.optionsReadService.getRawPreview(formId, limit);
  }

  async getReports(
    formId: string,
    options: ReportQueryOptions
  ): Promise<ReportQueryResult> {
    return this.reportsReadService.getReports(formId, options);
  }

  async getFullReports(
    formId: string,
    options: ReportFullQueryOptions
  ): Promise<ReportFullQueryResult> {
    return this.reportsReadService.getFullReports(formId, options);
  }

  async getReportFacets(
    formId: string,
    fields: string[],
    options: ReportFacetQueryOptions
  ): Promise<ReportFacetQueryResult["data"]> {
    return this.analysisReadService.getReportFacets(formId, fields, options);
  }

  async getReportAnalysis(
    formId: string,
    options: ReportAnalysisQueryOptions & ReportFacetQueryOptions
  ): Promise<ReportAnalysisSummary> {
    return this.analysisReadService.getReportAnalysis(formId, options);
  }

  prewarmFullReports(formId: string): boolean {
    return this.reportsReadService.prewarmFullReports(formId);
  }

  async getReportByEntryId(
    formId: string,
    entryId: string,
    options: {
      refresh?: boolean;
      allowSqliteFallbackOnRefresh?: boolean;
      ragicReadTimeoutMs?: number;
      ragicReadMaxRetries?: number;
      priority?: RagicReadPriority;
    } = {}
  ): Promise<WorkReportRecord> {
    return this.entryReadService.getReportByEntryId(formId, entryId, options);
  }

  async buildFullReportRecords(formId: string): Promise<WorkReportRecord[]> {
    return this.reportsReadService.buildFullReportRecords(formId);
  }
}

export const workReportReadService = new WorkReportReadService();

export type WorkReportEntryFieldMutationOperation =
  | "work-report-start-schedule"
  | "work-report-main-machine"
  | "work-report-sort-order"
  | "work-report-planned-end-date"
  | "work-report-urgent";

export interface WorkReportConfirmedEntryFieldObservation {
  entryId: string;
  operation: WorkReportEntryFieldMutationOperation;
  observedAt: string;
  entryLastUpdatedAt?: string;
  patch: Record<string, unknown>;
}

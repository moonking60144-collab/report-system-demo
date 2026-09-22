export type RealtimeEventType =
  | "meeting-state-changed"
  | "sqlite-auto-sync-status"
  | "work-report-task-updated"
  | "work-report-form-updated"
  | "work-report-entry-updated"
  | "work-report-entries-updated"
  | "system-notice-force-refresh"
  | "system-notice-content-updated"
  | "ragic-definitions-sync-status"
  | "ragic-formula-patch-task-status";

export type RagicDefinitionsSyncStatus =
  | "disabled"
  | "watching"
  | "syncing"
  | "synced"
  | "error";

export interface RagicDefinitionsSyncPayload {
  status: RagicDefinitionsSyncStatus;
  message: string;
  changedCount?: number;
  summary?: {
    forms: number;
    fields: number;
    formulas: number;
    workflows: number;
  };
}

export interface RealtimeEventPayload {
  id: string;
  type: RealtimeEventType;
  occurredAt: string;
  formId?: string;
  entryId?: string;
  entryIds?: string[];
  sqliteAutoSync?: { activeFormIds: string[] };
  workReportTask?: {
    taskId: string;
    taskType: string;
    status: "pending" | "running" | "success" | "failed";
    updatedAt: string;
  };
  forceRefreshToken?: string;
  noticeRevision?: number;
  ragicDefinitions?: RagicDefinitionsSyncPayload;
  ragicFormulaPatchTask?: {
    taskId: string;
    status: "pending" | "running" | "success" | "failed";
  };
}

export type RagicFormulaPatchTaskRealtimePayload = Pick<
  RealtimeEventPayload,
  "id" | "occurredAt"
> & {
  taskId: string;
  status: "pending" | "running" | "success" | "failed";
};

export type RagicDefinitionsRealtimePayload =
  Pick<RealtimeEventPayload, "id" | "occurredAt"> & RagicDefinitionsSyncPayload;

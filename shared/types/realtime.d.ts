export type RealtimeEventType =
  | "work-report-form-updated"
  | "work-report-entry-updated"
  | "work-report-entries-updated"
  | "system-notice-force-refresh"
  | "system-notice-content-updated"
  | "ragic-definitions-sync-status";

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
  forceRefreshToken?: string;
  noticeRevision?: number;
  ragicDefinitions?: RagicDefinitionsSyncPayload;
}

export type RagicDefinitionsRealtimePayload =
  Pick<RealtimeEventPayload, "id" | "occurredAt"> & RagicDefinitionsSyncPayload;

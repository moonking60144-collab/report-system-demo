import type { BackendCacheState, HydrationSource } from "../types";

export type WorkReportFrontendEventCategory =
  | "ui"
  | "api"
  | "task"
  | "realtime"
  | "navigation";

export const WORK_REPORT_FRONTEND_EVENT_CONTRACT = {
  "fixed-filter-applied": { category: "ui", scope: "list" },
  "machine-shortcut-applied": { category: "ui", scope: "list" },
  "quick-view-applied": { category: "ui", scope: "list" },
  "filter-chip-removed": { category: "ui", scope: "list" },
  "sort-chip-removed": { category: "ui", scope: "list" },
  "filters-applied": { category: "ui", scope: "list" },
  "filters-cleared": { category: "ui", scope: "list" },
  "local-settings-saved": { category: "ui", scope: "list" },
  "landing-page-opened": { category: "navigation", scope: "list" },
  "top-view-opened": { category: "navigation", scope: "list" },
  "mobile-fixed-filters-opened": { category: "ui", scope: "list" },
  "manual-refresh-started": { category: "api", scope: "list" },
  "manual-refresh-request-started": { category: "api", scope: "list" },
  "manual-refresh-accepted": { category: "task", scope: "list" },
  "manual-refresh-sync-succeeded": { category: "task", scope: "list" },
  "manual-refresh-data-refresh-started": { category: "api", scope: "list" },
  "manual-refresh-data-refresh-completed": { category: "api", scope: "list" },
  "manual-refresh-timeout": { category: "task", scope: "list" },
  "manual-refresh-failed": { category: "api", scope: "list" },
  "manual-refresh-completed": { category: "api", scope: "list" },
  "list-sse-connected": { category: "realtime", scope: "list" },
  "list-sse-disconnected": { category: "realtime", scope: "list" },
  "auto-refresh-started": { category: "realtime", scope: "list" },
  "auto-refresh-completed": { category: "realtime", scope: "list" },

  "inline-edit-opened": { category: "ui", scope: "detail" },
  "inline-create-opened": { category: "ui", scope: "detail" },
  "inline-edit-cancelled": { category: "ui", scope: "detail" },
  "inline-save-validation-failed": { category: "api", scope: "detail" },
  "inline-create-started": { category: "api", scope: "detail" },
  "inline-create-request-started": { category: "api", scope: "detail" },
  "inline-create-submit": { category: "api", scope: "detail" },
  "inline-create-accepted": { category: "task", scope: "detail" },
  "inline-update-started": { category: "api", scope: "detail" },
  "inline-update-request-started": { category: "api", scope: "detail" },
  "inline-update-submit": { category: "api", scope: "detail" },
  "inline-update-accepted": { category: "task", scope: "detail" },
  "inline-save-failed": { category: "api", scope: "detail" },
  "modal-create-started": { category: "api", scope: "detail" },
  "modal-create-request-started": { category: "api", scope: "detail" },
  "modal-create-submit": { category: "api", scope: "detail" },
  "modal-create-accepted": { category: "task", scope: "detail" },
  "modal-update-started": { category: "api", scope: "detail" },
  "modal-update-request-started": { category: "api", scope: "detail" },
  "modal-update-submit": { category: "api", scope: "detail" },
  "modal-update-accepted": { category: "task", scope: "detail" },
  "modal-submit-validation-failed": { category: "api", scope: "detail" },
  "modal-submit-blocked-options-loading": { category: "api", scope: "detail" },
  "modal-submit-failed": { category: "api", scope: "detail" },
  "detail-delete-started": { category: "api", scope: "detail" },
  "detail-delete-lock-acquire-started": { category: "api", scope: "detail" },
  "detail-delete-lock-acquired": { category: "api", scope: "detail" },
  "detail-delete-lock-failed": { category: "api", scope: "detail" },
  "detail-delete-request-started": { category: "api", scope: "detail" },
  "detail-delete-succeeded": { category: "api", scope: "detail" },
  "detail-delete-refresh-started": { category: "realtime", scope: "detail" },
  "detail-delete-refresh-completed": { category: "realtime", scope: "detail" },
  "detail-delete-failed": { category: "api", scope: "detail" },
  "main-machine-dialog-opened": { category: "ui", scope: "detail" },
  "main-machine-update-validation-failed": { category: "api", scope: "detail" },
  "main-machine-update-started": { category: "api", scope: "detail" },
  "main-machine-update-request-started": { category: "api", scope: "detail" },
  "main-machine-update-succeeded": { category: "api", scope: "detail" },
  "main-machine-update-refresh-completed": { category: "realtime", scope: "detail" },
  "main-machine-update-failed": { category: "api", scope: "detail" },
  "accepted-mutation-task-registered": { category: "task", scope: "detail" },
  "sse-connected": { category: "realtime", scope: "detail" },
  "sse-disconnected": { category: "realtime", scope: "detail" },
  "refresh-deferred": { category: "realtime", scope: "detail" },
  "refresh-immediate": { category: "realtime", scope: "detail" },
  "refresh-applied": { category: "realtime", scope: "detail" },
  "fallback-refresh-triggered": { category: "realtime", scope: "detail" },

  "system-notice-login-succeeded": { category: "ui", scope: "system-notice" },
  "system-notice-login-failed": { category: "ui", scope: "system-notice" },
  "system-notice-save-succeeded": { category: "ui", scope: "system-notice" },
  "system-notice-save-failed": { category: "ui", scope: "system-notice" },

  // Audit history modal（看歷史）
  "audit-history-opened": { category: "ui", scope: "audit" },
  "audit-history-loaded": { category: "api", scope: "audit" },
  "audit-history-load-failed": { category: "api", scope: "audit" },
  // downtime mutation 觸發點（work-report 已由既有 detail-delete-* / inline-update-* 涵蓋，不另開）
  "downtime-mutation-submitted": { category: "api", scope: "detail" },
  "downtime-mutation-failed": { category: "api", scope: "detail" },
} as const satisfies Record<
  string,
  { category: WorkReportFrontendEventCategory; scope: "list" | "detail" | "system-notice" | "audit" }
>;

export type WorkReportFrontendEventAction = keyof typeof WORK_REPORT_FRONTEND_EVENT_CONTRACT;

export function resolveWorkReportFrontendEventCategory(
  action: WorkReportFrontendEventAction
): WorkReportFrontendEventCategory {
  return WORK_REPORT_FRONTEND_EVENT_CONTRACT[action].category;
}

export const WORK_REPORT_REQUIRED_FRONTEND_EVENT_ACTIONS = {
  list: [
    "fixed-filter-applied",
    "machine-shortcut-applied",
    "quick-view-applied",
    "filters-applied",
    "filters-cleared",
    "landing-page-opened",
    "top-view-opened",
    "manual-refresh-started",
    "manual-refresh-request-started",
    "manual-refresh-accepted",
    "manual-refresh-sync-succeeded",
    "manual-refresh-data-refresh-started",
    "manual-refresh-data-refresh-completed",
    "manual-refresh-completed",
    "manual-refresh-failed",
    "list-sse-connected",
    "list-sse-disconnected",
    "auto-refresh-started",
    "auto-refresh-completed",
  ],
  detail: [
    "inline-edit-opened",
    "inline-create-opened",
    "inline-edit-cancelled",
    "inline-save-validation-failed",
    "inline-create-started",
    "inline-create-request-started",
    "inline-create-submit",
    "inline-create-accepted",
    "inline-update-started",
    "inline-update-request-started",
    "inline-update-submit",
    "inline-update-accepted",
    "modal-create-started",
    "modal-create-request-started",
    "modal-create-submit",
    "modal-create-accepted",
    "modal-update-started",
    "modal-update-request-started",
    "modal-update-submit",
    "modal-update-accepted",
    "modal-submit-validation-failed",
    "modal-submit-blocked-options-loading",
    "detail-delete-started",
    "detail-delete-lock-acquire-started",
    "detail-delete-lock-acquired",
    "detail-delete-lock-failed",
    "detail-delete-request-started",
    "detail-delete-succeeded",
    "detail-delete-refresh-started",
    "detail-delete-refresh-completed",
    "detail-delete-failed",
    "main-machine-update-started",
    "main-machine-update-validation-failed",
    "main-machine-update-request-started",
    "main-machine-update-succeeded",
    "main-machine-update-refresh-completed",
    "main-machine-update-failed",
    "accepted-mutation-task-registered",
    "sse-connected",
    "sse-disconnected",
    "refresh-deferred",
    "refresh-applied",
    "refresh-immediate",
    "fallback-refresh-triggered",
  ],
  systemNotice: [
    "system-notice-login-succeeded",
    "system-notice-login-failed",
    "system-notice-save-succeeded",
    "system-notice-save-failed",
  ],
} as const;

export const WORK_REPORT_DEVELOPER_DIAGNOSTIC_FIELDS = [
  "currentFormId",
  "activeLandingPageKey",
  "activeTopView",
  "shouldUseServerSidePreview",
  "shouldUseFullHydrationForList",
  "hasHydratedAllRecords",
  "isHydratingAllRecords",
  "loading",
  "previewRecordsCount",
  "previewTotalCount",
  "allRecordsCount",
  "hydratedCount",
  "hasMore",
  "hydrationSource",
  "backendCacheState",
  "backendSnapshotAt",
  "backendExpiresAt",
  "fullDataHydratedAt",
  "fullDataReady",
  "realtimeConnected",
  "realtimeDisconnectedSince",
] as const;

export type WorkReportDeveloperDiagnosticField =
  (typeof WORK_REPORT_DEVELOPER_DIAGNOSTIC_FIELDS)[number];

export interface WorkReportDeveloperDiagnosticsSnapshot {
  currentFormId: string;
  activeLandingPageKey: string;
  activeTopView: string;
  shouldUseServerSidePreview: boolean;
  shouldUseFullHydrationForList: boolean;
  hasHydratedAllRecords: boolean;
  isHydratingAllRecords: boolean;
  loading: boolean;
  previewRecordsCount: number;
  previewTotalCount: number;
  allRecordsCount: number;
  hydratedCount: number;
  hasMore: boolean;
  hydrationSource: HydrationSource;
  backendCacheState: BackendCacheState;
  backendSnapshotAt: string | null;
  backendExpiresAt: string | null;
  fullDataHydratedAt: number | null;
  fullDataReady: boolean | null;
  realtimeConnected: boolean;
  realtimeDisconnectedSince: number | null;
}

export function buildWorkReportDeveloperDiagnosticsSnapshot(input: {
  currentFormId: string;
  activeLandingPageKey: string;
  activeTopView: string;
  shouldUseServerSidePreview: boolean;
  shouldUseFullHydrationForList: boolean;
  hasHydratedAllRecords: boolean;
  isHydratingAllRecords: boolean;
  loading: boolean;
  previewRecordsCount: number;
  previewTotalCount: number;
  allRecordsCount: number;
  hydratedCount: number;
  hasMore: boolean;
  hydrationSource: HydrationSource;
  backendCacheState: BackendCacheState;
  backendSnapshotAt: string | null;
  backendExpiresAt: string | null;
  fullDataHydratedAt: number | null;
  realtimeConnected: boolean;
  realtimeDisconnectedSince: number | null;
}): WorkReportDeveloperDiagnosticsSnapshot {
  return {
    ...input,
    fullDataReady: input.shouldUseFullHydrationForList ? input.hasHydratedAllRecords : null,
  };
}

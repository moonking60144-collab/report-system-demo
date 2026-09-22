import { memo } from "react";
import type { CreateTaskMonitor, NoticeState, UiLanguage } from "../types";
import { useTranslation } from "react-i18next";
import { formatStatusDateTime, getCreateTaskStatusText } from "../utils";
import { deriveWorkReportHumanStatus } from "../statusHumanStatus";
import { entryFieldConfirmationMessage, isEntryFieldConfirmationPending } from "../entryFieldMutationSettlement";

interface WorkReportStatusHydrationProps {
  shouldUseFullHydrationForList: boolean;
  hasHydratedAllRecords: boolean;
  backendSnapshotAt: string | null;
  truncated: boolean;
  truncatedCount: number;
  realtimeConnected: boolean;
  realtimeDisconnectedSince: number | null;
  previewRevalidating: boolean;
  previewRevalidationError: string | null;
}

interface WorkReportStatusSummaryProps {
  sortedFilteredRecordsLength: number;
  visibleRecordsLength: number;
  currentPageReportCount: number;
}

interface WorkReportStatusTaskMonitorProps {
  createTaskMonitors: CreateTaskMonitor[];
  taskMonitorExpanded: boolean;
  hasFinishedTaskMonitors: boolean;
  taskRunningCount: number;
  taskFailedCount: number;
  latestTaskMonitor: CreateTaskMonitor | null;
  onToggleTaskMonitorExpanded: () => void;
  onCollapseTaskMonitor: () => void;
  onClearFinishedTaskMonitors: () => void;
  onRetryEntryFieldConfirmation?: (taskId: string) => void;
}

interface WorkReportStatusAreaProps {
  uiLanguage: UiLanguage;
  hydration: WorkReportStatusHydrationProps;
  summary: WorkReportStatusSummaryProps;
  isSyncingFromRagic: boolean;
  notice: NoticeState | null;
  suppressSuccessHumanNote?: boolean;
  suppressInlineNotice?: boolean;
  taskMonitor: WorkReportStatusTaskMonitorProps;
  loading: boolean;
  error: string | null;
  hasRenderableContent: boolean;
}

export const WorkReportStatusArea = memo(function WorkReportStatusArea({
  uiLanguage,
  hydration,
  summary,
  isSyncingFromRagic,
  notice,
  suppressSuccessHumanNote = false,
  suppressInlineNotice = false,
  taskMonitor,
  loading,
  error,
  hasRenderableContent,
}: WorkReportStatusAreaProps) {
  const { t } = useTranslation(["workReport", "common"]);
  const backendSnapshotAtText = formatStatusDateTime(hydration.backendSnapshotAt);
  const summarySnapshotText = hydration.backendSnapshotAt ? backendSnapshotAtText : "--";
  const matchedCount = summary.sortedFilteredRecordsLength;
  const baseHumanStatus = deriveWorkReportHumanStatus({
    t,
    hydration,
    isSyncingFromRagic,
    loading,
    error,
    summarySnapshotText,
  });
  const getTaskMonitorStatusLabel = (task: CreateTaskMonitor): string =>
    task.stale === true || task.lifecycleState === "unknown" || task.lifecycleState === "indeterminate"
      ? t("workReport:status.taskStatusUnknown")
      : isEntryFieldConfirmationPending(task)
      ? t(task.entryFieldSettlementErrorCode ? "workReport:status.taskConfirmationBlocked" : "workReport:status.taskConfirmationPending")
      : getCreateTaskStatusText(task.status, uiLanguage, t);
  const getTaskMonitorStatusClass = (task: CreateTaskMonitor): string =>
    task.stale === true || isEntryFieldConfirmationPending(task) ? "pending" : task.status;
  const confirmingCount = taskMonitor.createTaskMonitors.filter(isEntryFieldConfirmationPending).length;

  const shouldPromoteNoticeIntoSystemNoticeCard = Boolean(notice?.displayAsHumanStatus);
  const humanNoteStatus =
    shouldPromoteNoticeIntoSystemNoticeCard
      ? {
          tone: baseHumanStatus.tone,
          detail: baseHumanStatus.detail,
          extraClassName: "",
        }
      : notice?.displayAsHumanStatus
      ? {
          tone: notice.type,
          detail: notice.message,
          extraClassName: "status-human-note--sticky-update",
        }
      : {
          tone: baseHumanStatus.tone,
          detail: baseHumanStatus.detail,
          extraClassName: "",
        };

  return (
    <>
      <div className="status-summary-strip" role="status" aria-live="polite">
        <span className="status-summary-item">
          <span className="status-summary-label">{t("workReport:status.summary.dataStatus")}</span>
          <span className={`status-summary-value status-summary-value--${baseHumanStatus.tone}`}>
            {baseHumanStatus.title}
          </span>
        </span>
        <span className="status-summary-item">
          <span className="status-summary-label">{t("workReport:status.summary.lastUpdate")}</span>
          <span className="status-summary-value">{summarySnapshotText}</span>
        </span>
        <span className="status-summary-item">
          <span className="status-summary-label">{t("workReport:status.summary.matches")}</span>
          <strong className="status-summary-count">{matchedCount}</strong>
        </span>
        <span className="status-summary-item">
          <span className="status-summary-label">{t("workReport:status.summary.pageOrders")}</span>
          <strong className="status-summary-count">{summary.visibleRecordsLength}</strong>
        </span>
        <span className="status-summary-item">
          <span className="status-summary-label">{t("workReport:status.summary.pageDetails")}</span>
          <strong className="status-summary-count">{summary.currentPageReportCount}</strong>
        </span>
      </div>

      {!suppressInlineNotice &&
        !shouldPromoteNoticeIntoSystemNoticeCard &&
        (!suppressSuccessHumanNote || humanNoteStatus.tone !== "success") && (
        <p
          className={`status-human-note status-human-note--${humanNoteStatus.tone}${
            humanNoteStatus.extraClassName ? ` ${humanNoteStatus.extraClassName}` : ""
          }`}
        >
          {humanNoteStatus.detail}
        </p>
      )}

      {!suppressInlineNotice && notice && !notice.displayAsHumanStatus && (
        <p className={`state ${notice.type}`}>{notice.message}</p>
      )}
      {taskMonitor.createTaskMonitors.length > 0 && (
        <div className="task-monitor-corner">
          <button
            type="button"
            className={`task-monitor-mini ${taskMonitor.taskMonitorExpanded ? "is-expanded" : ""}`}
            onClick={taskMonitor.onToggleTaskMonitorExpanded}
            aria-expanded={taskMonitor.taskMonitorExpanded}
          >
            <span className="task-monitor-mini-title">{t("workReport:status.backgroundTasks")}</span>
            <span className="task-monitor-mini-counts">
              {t(confirmingCount ? "workReport:status.taskCountsWithConfirmation" : "workReport:status.taskCounts", {
                running: taskMonitor.taskRunningCount,
                failed: taskMonitor.taskFailedCount,
                confirming: confirmingCount,
              })}
            </span>
            {taskMonitor.latestTaskMonitor && (
              <span className={`task-status task-status--${getTaskMonitorStatusClass(taskMonitor.latestTaskMonitor)}`}>
                {getTaskMonitorStatusLabel(taskMonitor.latestTaskMonitor)}
              </span>
            )}
          </button>

          {taskMonitor.taskMonitorExpanded && (
            <section className="state task-monitor task-monitor-panel">
              <header className="task-monitor-header">
                <strong>{t("workReport:status.taskMonitorTitle")}</strong>
                <div className="task-monitor-actions">
                  <button type="button" onClick={taskMonitor.onCollapseTaskMonitor}>
                    {t("common:actions.collapse")}
                  </button>
                  {taskMonitor.hasFinishedTaskMonitors && (
                    <button type="button" onClick={taskMonitor.onClearFinishedTaskMonitors}>
                      {t("common:actions.clearFinished")}
                    </button>
                  )}
                </div>
              </header>
              <ul className="task-monitor-list">
                {taskMonitor.createTaskMonitors.map((task) => (
                  <li key={task.taskId} className={`task-monitor-item task-monitor-item--${getTaskMonitorStatusClass(task)}`}>
                    <span className={`task-status task-status--${getTaskMonitorStatusClass(task)}`}>
                      {getTaskMonitorStatusLabel(task)}
                    </span>
                    <span className="task-label">
                      {t("workReport:status.taskLabel", {
                        workOrderNo: task.workOrderNo,
                      })}
                    </span>
                    <span className="task-message">
                      {entryFieldConfirmationMessage(task, t) ?? task.message}
                      {task.entryFieldSettlementErrorCode && isEntryFieldConfirmationPending(task) && taskMonitor.onRetryEntryFieldConfirmation && (
                        <button type="button" onClick={() => taskMonitor.onRetryEntryFieldConfirmation?.(task.taskId)}>
                          {t("workReport:messages.entryFieldConfirmationRetry")}
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
      {hasRenderableContent && !error && summary.visibleRecordsLength === 0 && (
        <p className="state">{t("common:states.noData")}</p>
      )}
    </>
  );
});

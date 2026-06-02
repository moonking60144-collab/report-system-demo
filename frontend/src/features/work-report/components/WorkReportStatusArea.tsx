import { memo } from "react";
import type { CreateTaskMonitor, HydrationSource, NoticeState, UiLanguage } from "../types";
import { useTranslation } from "react-i18next";
import { formatStatusDateTime, getCreateTaskStatusText } from "../utils";
import { deriveWorkReportHumanStatus } from "../statusHumanStatus";

interface WorkReportStatusHydrationProps {
  isHydratingAllRecords: boolean;
  hydratedCount: number;
  shouldUseFullHydrationForList: boolean;
  hasHydratedAllRecords: boolean;
  hydrationSource: HydrationSource;
  backendCacheState: "fresh" | "stale" | "building" | null;
  backendSnapshotAt: string | null;
  backendExpiresAt: string | null;
  fullDataHydratedAt: number | null;
  truncated: boolean;
  truncatedCount: number;
  realtimeConnected: boolean;
  realtimeDisconnectedSince: number | null;
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
}: WorkReportStatusAreaProps) {
  const { t } = useTranslation(["workReport", "common"]);
  const backendSnapshotAtText = formatStatusDateTime(hydration.backendSnapshotAt);
  const summarySnapshotText =
    hydration.shouldUseFullHydrationForList && hydration.hasHydratedAllRecords ? backendSnapshotAtText : "--";
  const matchedCount = summary.sortedFilteredRecordsLength;
  const isBackendCacheRefreshing =
    !hydration.isHydratingAllRecords &&
    hydration.shouldUseFullHydrationForList &&
    hydration.hasHydratedAllRecords &&
    hydration.hydrationSource !== "network" &&
    hydration.backendCacheState === "building";
  const showSyncProgressBar = hydration.isHydratingAllRecords || isBackendCacheRefreshing;
  const syncProgressLabel = hydration.isHydratingAllRecords
    ? summary.visibleRecordsLength > 0
      ? t("workReport:status.syncProgress.backgroundHydration", {
          visible: summary.visibleRecordsLength,
        })
      : t("workReport:status.syncProgress.initialLoading")
    : t("workReport:status.syncProgress.backendRefreshing");
  const baseHumanStatus = deriveWorkReportHumanStatus({
    t,
    hydration,
    isSyncingFromRagic,
    loading,
    error,
    summarySnapshotText,
  });

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

      {showSyncProgressBar && (
        <div className="sync-progress-strip" role="status" aria-live="polite">
          <div className="sync-progress-label">{syncProgressLabel}</div>
          <div className="sync-progress-track" aria-hidden="true">
            <div className="sync-progress-bar" />
          </div>
        </div>
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
              {t("workReport:status.taskCounts", {
                running: taskMonitor.taskRunningCount,
                failed: taskMonitor.taskFailedCount,
              })}
            </span>
            {taskMonitor.latestTaskMonitor && (
              <span className={`task-status task-status--${taskMonitor.latestTaskMonitor.status}`}>
                {getCreateTaskStatusText(taskMonitor.latestTaskMonitor.status, uiLanguage, t)}
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
                  <li key={task.taskId} className={`task-monitor-item task-monitor-item--${task.status}`}>
                    <span className={`task-status task-status--${task.status}`}>
                      {getCreateTaskStatusText(task.status, uiLanguage, t)}
                    </span>
                    <span className="task-label">
                      {t("workReport:status.taskLabel", {
                        workOrderNo: task.workOrderNo,
                      })}
                    </span>
                    <span className="task-message">{task.message}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
      {loading && !hydration.shouldUseFullHydrationForList && (
        <p className="state">{t("common:states.loadingData")}</p>
      )}
      {error && <p className="state error">{t("workReport:status.loadFailed", { error })}</p>}
      {!loading && !error && summary.visibleRecordsLength === 0 && (
        <p className="state">{t("common:states.noData")}</p>
      )}
    </>
  );
});

import { Modal, Progress } from "antd";
import { useTranslation } from "react-i18next";
import type { WorkReportSyncTask } from "../../../api/workReport";

interface WorkReportSyncProgressModalProps {
  open: boolean;
  task: WorkReportSyncTask | null;
  errorMessage: string | null;
  onClose: () => void;
}

function resolveProgressPercent(task: WorkReportSyncTask | null): number {
  if (!task) {
    return 0;
  }

  if (task.status === "success" || task.status === "failed") {
    return 100;
  }

  const message = String(task.message ?? "").trim();
  if (message.includes("回補")) {
    return 92;
  }
  if (message.includes("寫入 SQLite")) {
    return 72;
  }
  if (task.scannedEntries > 0) {
    return Math.min(58, 10 + Math.floor(task.scannedEntries / 250));
  }
  return 8;
}

function resolveProgressStatus(task: WorkReportSyncTask | null): "active" | "success" | "exception" {
  if (!task || task.status === "running" || task.status === "pending") {
    return "active";
  }
  if (task.status === "failed") {
    return "exception";
  }
  return "success";
}

export function WorkReportSyncProgressModal({
  open,
  task,
  errorMessage,
  onClose,
}: WorkReportSyncProgressModalProps) {
  const { t } = useTranslation(["workReport", "common"]);
  const isRunning = Boolean(task && (task.status === "running" || task.status === "pending"));
  const progressPercent = resolveProgressPercent(task);
  const progressStatus = resolveProgressStatus(task);
  const phaseText = errorMessage
    ? t("workReport:toolbar.refreshProgress.failed")
    : task?.status === "success"
      ? t("workReport:toolbar.refreshProgress.completed")
      : task?.status === "failed"
        ? t("workReport:toolbar.refreshProgress.failed")
        : t("workReport:toolbar.refreshProgress.running");

  return (
    <Modal
      open={open}
      title={t("workReport:toolbar.refreshProgress.title")}
      onCancel={isRunning ? undefined : onClose}
      maskClosable={!isRunning}
      closable={!isRunning}
      footer={
        isRunning
          ? null
          : [
              <button
                key="close"
                type="button"
                className="toolbar-btn toolbar-btn--primary"
                onClick={onClose}
              >
                {t("common:actions.close")}
              </button>,
            ]
      }
      centered
    >
      <div className="refresh-sync-progress-modal">
        <p className="refresh-sync-progress-message">
          {errorMessage || task?.message || t("workReport:toolbar.refreshProgress.preparing")}
        </p>
        <Progress percent={progressPercent} status={progressStatus} />
        <div className="refresh-sync-progress-grid">
          <span>{t("workReport:toolbar.refreshProgress.phaseLabel")}</span>
          <strong>{phaseText}</strong>
          <span>{t("workReport:toolbar.refreshProgress.scannedEntriesLabel")}</span>
          <strong>{task?.scannedEntries ?? 0}</strong>
          <span>{t("workReport:toolbar.refreshProgress.syncedEntriesLabel")}</span>
          <strong>{task?.syncedEntries ?? 0}</strong>
          <span>{t("workReport:toolbar.refreshProgress.syncedRowsLabel")}</span>
          <strong>{task?.syncedRows ?? 0}</strong>
        </div>
        {isRunning && (
          <p className="refresh-sync-progress-hint">
            {t("workReport:toolbar.refreshProgress.runningHint")}
          </p>
        )}
      </div>
    </Modal>
  );
}

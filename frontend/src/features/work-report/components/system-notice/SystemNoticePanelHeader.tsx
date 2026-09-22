import { useTranslation } from "react-i18next";
import { LoadingSpinner } from "../../../../components/PageLoadingBoundary";

interface SystemNoticePanelHeaderProps {
  autoSyncForms?: string[] | null;
  noticeExists: boolean;
  activeState: boolean;
  shouldShowHeaderActions: boolean;
  showDismissButton: boolean;
  dismissButtonText: string;
  editing: boolean;
  inlineStatusMessage: string | null;
  inlineStatusType: "success" | "warn" | "error" | "loading" | "info";
  isInlineStatusSpinning: boolean;
  onDismissToggle: () => void;
  onEditToggle: () => void;
}

export function SystemNoticePanelHeader({
  autoSyncForms,
  noticeExists,
  activeState,
  shouldShowHeaderActions,
  showDismissButton,
  dismissButtonText,
  editing,
  inlineStatusMessage,
  inlineStatusType,
  isInlineStatusSpinning,
  onEditToggle,
  onDismissToggle,
}: SystemNoticePanelHeaderProps) {
  const { t } = useTranslation(["workReport", "common"]);
  const loadingLabel = t(inlineStatusType === "loading" ? "common:states.loadingData" : "common:states.backgroundLoading");

  const inlineStatusPrefix =
    inlineStatusType === "success"
      ? "✓"
      : inlineStatusType === "warn" || inlineStatusType === "error"
        ? "!"
        : "↻";

  return (
    <header className="system-notice-panel-header">
      <div className="system-notice-panel-title-wrap">
        <strong className="system-notice-panel-title">{t("workReport:systemNotice.title")}</strong>
        {noticeExists ? (
          <span
            className={`system-notice-status-chip ${
              activeState ? "is-active" : "is-inactive"
            }`}
          >
            {activeState
              ? t("workReport:systemNotice.status.active")
              : t("workReport:systemNotice.status.inactive")}
          </span>
        ) : null}
        {autoSyncForms && autoSyncForms.length > 0 ? (
          <span className="system-notice-inline-status-pill system-notice-inline-status-pill--warn" role="status">
            <span className="system-notice-inline-status-icon" aria-hidden="true"><LoadingSpinner size="small" /></span>{" "}
            {t("workReport:systemNotice.autoSyncRunning", { forms: autoSyncForms.join("／") })}
          </span>
        ) : null}
        {inlineStatusMessage ? (
          <span
            className={`system-notice-inline-status-pill system-notice-inline-status-pill--${inlineStatusType}`}
            role="status"
            aria-label={isInlineStatusSpinning ? `${loadingLabel} ${inlineStatusMessage}` : inlineStatusMessage}
            title={isInlineStatusSpinning ? loadingLabel : undefined}
          >
            <span
              className="system-notice-inline-status-icon"
              aria-hidden="true"
            >
              {isInlineStatusSpinning ? <LoadingSpinner size="small" /> : inlineStatusPrefix}
            </span>{" "}
            {inlineStatusMessage}
          </span>
        ) : null}
      </div>
      {shouldShowHeaderActions && (
        <div className="system-notice-panel-actions">
          {showDismissButton ? (
            <button
              type="button"
              className="system-notice-dismiss-btn"
              onClick={onDismissToggle}
            >
              {dismissButtonText}
            </button>
          ) : null}
          <button
            type="button"
            className="system-notice-edit-btn"
            onClick={onEditToggle}
          >
            {editing ? t("common:actions.cancel") : t("workReport:systemNotice.actions.edit")}
          </button>
        </div>
      )}
    </header>
  );
}

import { useTranslation } from "react-i18next";

interface ReportFormFooterProps {
  mode: "create" | "edit";
  submitting: boolean;
  submitDisabled?: boolean;
  saveProgress: number;
  error: string | null;
  optionsLoading: boolean;
  onClose: () => void;
  onClearForm: () => void;
}

export function ReportFormFooter({
  mode,
  submitting,
  submitDisabled = false,
  saveProgress,
  error,
  optionsLoading,
  onClose,
  onClearForm,
}: ReportFormFooterProps) {
  const { t: tr } = useTranslation(["workReport", "common"]);

  return (
    <div className="modal-footer">
      {(submitting || saveProgress > 0) && (
        <div className="modal-save-progress" aria-label={tr("common:actions.saving")}>
          <div className="modal-save-progress-track">
            <div
              className="modal-save-progress-fill"
              style={{ width: `${Math.max(0, Math.min(100, saveProgress))}%` }}
            />
          </div>
        </div>
      )}
      {error && <p className="modal-error">{error}</p>}

      <div className="modal-actions">
        <button
          type="button"
          className="modal-actions-ghost"
          onClick={onClearForm}
          disabled={submitting}
        >
          {tr("workReport:reportForm.actions.clearAll")}
        </button>
        <button type="button" onClick={onClose} disabled={submitting}>
          {tr("common:actions.cancel")}
        </button>
        {mode === "create" && (
          <button
          type="submit"
          value="save-and-next"
          data-submit-intent="save-and-next"
          className="modal-actions-secondary"
          disabled={submitting || optionsLoading || submitDisabled}
        >
          {tr("workReport:reportForm.actions.saveAndNext")}
        </button>
      )}
      <button
        type="submit"
        value="save"
        data-submit-intent="save"
        disabled={submitting || optionsLoading || submitDisabled}
      >
        {submitting ? tr("common:actions.saving") : tr("common:actions.save")}
      </button>
      </div>
    </div>
  );
}

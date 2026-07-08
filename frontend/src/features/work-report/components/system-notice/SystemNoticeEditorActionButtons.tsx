import { useTranslation } from "react-i18next";

interface SystemNoticeEditorActionButtonsProps {
  saveError: string | null;
  saveNotice: string | null;
  saving: boolean;
  onSave: () => void;
  onLogout: () => void;
}

export function SystemNoticeEditorActionButtons({
  saveError,
  saveNotice,
  saving,
  onSave,
  onLogout,
}: SystemNoticeEditorActionButtonsProps) {
  const { t } = useTranslation(["workReport", "common"]);

  return (
    <>
      {saveError ? (
        <p className="system-notice-error">{t("systemNotice.errors.saveFailed", { error: saveError })}</p>
      ) : null}
      {saveNotice ? <p className="system-notice-success">{saveNotice}</p> : null}

      <div className="system-notice-editor-actions">
        <button
          type="button"
          className="system-notice-submit-btn"
          onClick={() => onSave()}
          disabled={saving}
        >
          {saving ? t("common:actions.saving") : t("systemNotice.actions.save")}
        </button>
        <button
          type="button"
          className="system-notice-logout-btn"
          onClick={() => onLogout()}
        >
          {t("systemNotice.actions.logout")}
        </button>
      </div>
    </>
  );
}

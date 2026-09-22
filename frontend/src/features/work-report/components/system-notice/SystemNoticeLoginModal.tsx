import { useTranslation } from "react-i18next";

interface SystemNoticeLoginModalProps {
  open: boolean;
  username: string;
  password: string;
  loginError: string | null;
  submittingLogin: boolean;
  onUsernameChange: (username: string) => void;
  onPasswordChange: (password: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}

export function SystemNoticeLoginModal({
  open,
  username,
  password,
  loginError,
  submittingLogin,
  onUsernameChange,
  onPasswordChange,
  onSubmit,
  onClose,
}: SystemNoticeLoginModalProps) {
  const { t } = useTranslation(["workReport", "common"]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="system-notice-login-modal-backdrop"
      onClick={() => {
        onClose();
      }}
    >
      <section
        className="system-notice-login-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("workReport:systemNotice.actions.login")}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="system-notice-login-modal-header">
          <strong>{t("workReport:systemNotice.actions.login")}</strong>
          <button
            type="button"
            className="system-notice-login-close-btn"
            onClick={() => {
              onClose();
            }}
          >
            {t("common:actions.cancel")}
          </button>
        </header>

        <div className="system-notice-login">
          <label>
            <span>{t("workReport:systemNotice.fields.username")}</span>
            <input
              type="text"
              value={username}
              onChange={(event) => onUsernameChange(event.target.value)}
            />
          </label>
          <label>
            <span>{t("workReport:systemNotice.fields.password")}</span>
            <input
              type="password"
              value={password}
              onChange={(event) => onPasswordChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  onSubmit();
                }
              }}
            />
          </label>
          {loginError && (
            <p className="system-notice-error">
              {t("workReport:systemNotice.errors.loginFailed", { error: loginError })}
            </p>
          )}
          <button
            type="button"
            className="system-notice-submit-btn"
            onClick={() => {
              onSubmit();
            }}
            disabled={submittingLogin}
          >
            {submittingLogin
              ? t("common:actions.saving")
              : t("workReport:systemNotice.actions.login")}
          </button>
        </div>
      </section>
    </div>
  );
}

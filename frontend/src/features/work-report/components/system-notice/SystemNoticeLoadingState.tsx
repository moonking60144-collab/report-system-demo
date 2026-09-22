import { useTranslation } from "react-i18next";

interface SystemNoticeLoadingStateProps {
  loading: boolean;
  error: string | null;
}

export function SystemNoticeLoadingState({ loading, error }: SystemNoticeLoadingStateProps) {
  const { t } = useTranslation("workReport");

  if (loading) {
    return <p className="system-notice-meta">{t("systemNotice.loading")}</p>;
  }

  if (error) {
    return <p className="system-notice-error">{t("systemNotice.errors.loadFailed", { error })}</p>;
  }

  return null;
}

import { useTranslation } from "react-i18next";

interface SystemNoticeEditorLinkSectionProps {
  linkText: string;
  linkUrl: string;
  onLinkTextChange: (value: string) => void;
  onLinkUrlChange: (value: string) => void;
}

export function SystemNoticeEditorLinkSection({
  linkText,
  linkUrl,
  onLinkTextChange,
  onLinkUrlChange,
}: SystemNoticeEditorLinkSectionProps) {
  const { t } = useTranslation("workReport");

  return (
    <div className="system-notice-datetime-grid">
      <label>
        <span>{t("systemNotice.fields.linkText")}</span>
        <input type="text" value={linkText} onChange={(event) => onLinkTextChange(event.target.value)} />
      </label>
      <label>
        <span>{t("systemNotice.fields.linkUrl")}</span>
        <input
          type="url"
          value={linkUrl}
          onChange={(event) => onLinkUrlChange(event.target.value)}
        />
      </label>
    </div>
  );
}

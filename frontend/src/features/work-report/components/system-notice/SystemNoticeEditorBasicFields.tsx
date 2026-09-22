import { useTranslation } from "react-i18next";
import type { SystemNoticeLevel } from "../../../../api/systemNotice";

interface SystemNoticeEditorBasicFieldsProps {
  level: SystemNoticeLevel;
  title: string;
  message: string;
  onLevelChange: (value: SystemNoticeLevel) => void;
  onTitleChange: (value: string) => void;
  onMessageChange: (value: string) => void;
}

export function SystemNoticeEditorBasicFields({
  level,
  title,
  message,
  onLevelChange,
  onTitleChange,
  onMessageChange,
}: SystemNoticeEditorBasicFieldsProps) {
  const { t } = useTranslation("workReport");

  return (
    <>
      <label>
        <span>{t("systemNotice.fields.level")}</span>
        <select value={level} onChange={(event) => onLevelChange(event.target.value as SystemNoticeLevel)}>
          <option value="info">{t("systemNotice.levels.info")}</option>
          <option value="warn">{t("systemNotice.levels.warn")}</option>
          <option value="error">{t("systemNotice.levels.error")}</option>
        </select>
      </label>

      <label>
        <span>{t("systemNotice.fields.title")}</span>
        <input
          type="text"
          value={title}
          onChange={(event) => onTitleChange(event.target.value)}
        />
      </label>

      <label>
        <span>{t("systemNotice.fields.message")}</span>
        <textarea
          rows={3}
          value={message}
          onChange={(event) => onMessageChange(event.target.value)}
        />
      </label>
    </>
  );
}

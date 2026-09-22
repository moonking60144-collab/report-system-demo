import { useTranslation } from "react-i18next";
import { SystemNoticeNoticeContent } from "./SystemNoticeNoticeContent";
import type { SystemNoticeRecord } from "../../../../api/systemNotice";

interface SystemNoticePopupProps {
  open: boolean;
  notice: SystemNoticeRecord | null;
  onClose: () => void;
  emptyTitle: string;
  emptyMessage: string;
  effectiveRange: string;
  updatedMeta: string;
}

export function SystemNoticePopup({
  open,
  notice,
  onClose,
  emptyTitle,
  emptyMessage,
  effectiveRange,
  updatedMeta,
}: SystemNoticePopupProps) {
  const { t } = useTranslation(["workReport", "common"]);

  if (!open || !notice) {
    return null;
  }

  return (
    <div className="system-notice-popup-backdrop" onClick={onClose}>
      <section
        className={`system-notice-popup level-${notice.level}`}
        role="dialog"
        aria-modal="true"
        aria-label={t("workReport:systemNotice.title")}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="system-notice-popup-close-btn"
          aria-label={t("common:actions.cancel")}
          onClick={onClose}
        >
          ×
        </button>
        <SystemNoticeNoticeContent
          notice={notice}
          emptyTitle={emptyTitle}
          emptyMessage={emptyMessage}
          effectiveRange={effectiveRange}
          updatedMeta={updatedMeta}
          className="system-notice-content"
          asWrapper={false}
        />
      </section>
    </div>
  );
}

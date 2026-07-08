import type { SystemNoticeRecord } from "../../../../api/systemNotice";

interface SystemNoticeNoticeContentProps {
  notice: SystemNoticeRecord;
  emptyTitle: string;
  emptyMessage: string;
  effectiveRange: string;
  updatedMeta: string;
  className: string;
  asWrapper?: boolean;
}

export function SystemNoticeNoticeContent({
  notice,
  emptyTitle,
  emptyMessage,
  effectiveRange,
  updatedMeta,
  className,
  asWrapper = true,
}: SystemNoticeNoticeContentProps) {
  const content = (
    <>
      <p className="system-notice-title">{notice.title || emptyTitle}</p>
      <p className="system-notice-message">
        {notice.message || emptyMessage}
      </p>
      <p className="system-notice-meta">{effectiveRange}</p>
      <p className="system-notice-meta">{updatedMeta}</p>
      {notice.linkUrl && (
        <p className="system-notice-link-row">
          <a href={notice.linkUrl} target="_blank" rel="noreferrer">
            {notice.linkText || notice.linkUrl}
          </a>
        </p>
      )}
    </>
  );

  if (!asWrapper) {
    return content;
  }

  return (
    <div className={className}>
      {content}
    </div>
  );
}

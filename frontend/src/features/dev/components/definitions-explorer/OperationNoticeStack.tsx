import type { OperationNotice } from "./operationNoticeTypes";

export function OperationNoticeStack({
  notices,
  onDismiss,
}: {
  notices: OperationNotice[];
  onDismiss: (key: string) => void;
}) {
  if (notices.length === 0) return null;

  return (
    <div className="ragic-defs__notice-stack" aria-live="polite">
      {notices.map((notice) => (
        <section
          key={notice.key}
          className={`ragic-defs__notice is-${notice.tone}`}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          <div className="ragic-defs__notice-main">
            <strong>{notice.title}</strong>
            {notice.message ? <span>{notice.message}</span> : null}
          </div>
          <button
            type="button"
            className="ragic-defs__notice-close"
            onClick={() => onDismiss(notice.key)}
            aria-label={`關閉通知：${notice.title}`}
          >
            關閉
          </button>
        </section>
      ))}
    </div>
  );
}

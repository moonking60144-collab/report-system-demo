import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, message } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  RETRYABLE_BATCH_CREATE_CHANGED_EVENT,
  deleteRetryableBatchCreateRecordChain,
  listRetryableBatchCreateRecords,
  type RetryableBatchCreateRecord,
} from "../taskBatchRetryStore";
import { retryBatchCreateFromRecord } from "../retryBatchCreate";

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

function formatRelativeTime(iso: string, t: TranslateFn): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return t("workReport:pendingBatchTasks.relativeTime.justNow");
  if (minutes < 60) {
    return t("workReport:pendingBatchTasks.relativeTime.minutes", { count: minutes });
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return t("workReport:pendingBatchTasks.relativeTime.hours", { count: hours });
  }
  const days = Math.floor(hours / 24);
  return t("workReport:pendingBatchTasks.relativeTime.days", { count: days });
}

export function PendingBatchTasksBadge() {
  const { t } = useTranslation(["workReport"]);
  const navigate = useNavigate();
  const [records, setRecords] = useState<RetryableBatchCreateRecord[]>([]);
  const [open, setOpen] = useState(false);
  const [retryingRootIds, setRetryingRootIds] = useState<Set<string>>(() => new Set());
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 頁面 focus / storage（跨 tab）/ 同 tab 自訂事件 都觸發 refresh
  useEffect(() => {
    const refresh = () => setRecords(listRetryableBatchCreateRecords());
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", refresh);
    window.addEventListener(RETRYABLE_BATCH_CREATE_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", refresh);
      window.removeEventListener(RETRYABLE_BATCH_CREATE_CHANGED_EVENT, refresh);
    };
  }, []);

  // 點 panel 外面就收起來
  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (!rootRef.current) return;
      if (event.target instanceof Node && rootRef.current.contains(event.target)) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [open]);

  const count = records.length;

  const groupedByEntry = useMemo(() => {
    const map = new Map<
      string,
      { formId: string; entryId: string; items: RetryableBatchCreateRecord[] }
    >();
    for (const record of records) {
      // 用 unit separator 避免 formId 或 entryId 本身含特殊字元踩雷
      const key = `${record.formId}${record.entryId}`;
      const bucket = map.get(key);
      if (bucket) {
        bucket.items.push(record);
      } else {
        map.set(key, {
          formId: record.formId,
          entryId: record.entryId,
          items: [record],
        });
      }
    }
    return Array.from(map.values());
  }, [records]);

  if (count === 0) return null;

  const handleNavigate = (formId: string, entryId: string) => {
    setOpen(false);
    navigate(`/reports/${formId}/${entryId}`);
  };

  const handleDismissEntry = (items: RetryableBatchCreateRecord[]) => {
    // 一次刪完再 refresh，避免每刪一筆觸發一次 listRetryableBatchCreateRecords
    for (const item of items) {
      deleteRetryableBatchCreateRecordChain(item.taskId);
    }
    setRecords(listRetryableBatchCreateRecords());
  };

  const handleRetryEntry = async (
    targetFormId: string,
    targetEntryId: string,
    items: RetryableBatchCreateRecord[]
  ) => {
    // 同一 entry 可能有多條 retry chain；每條都要各自 retry
    const groupKey = items.map((item) => item.retryRootTaskId || item.taskId).join("|");
    if (retryingRootIds.has(groupKey)) return;
    setRetryingRootIds((prev) => {
      const next = new Set(prev);
      next.add(groupKey);
      return next;
    });
    try {
      for (const item of items) {
        await retryBatchCreateFromRecord(item);
      }
      setRecords(listRetryableBatchCreateRecords());
      Modal.confirm({
        title: t("workReport:taskQueue.retrySubmittedModal.title"),
        content: t("workReport:taskQueue.retrySubmittedModal.content"),
        okText: t("workReport:taskQueue.retrySubmittedModal.ok"),
        cancelText: t("workReport:taskQueue.retrySubmittedModal.cancel"),
        onOk: () => {
          setOpen(false);
          navigate(`/reports/${targetFormId}/${targetEntryId}`, {
            state: { openTaskQueueDrawer: true },
          });
        },
      });
    } catch (nextError) {
      const errorMessage = nextError instanceof Error ? nextError.message : String(nextError);
      void message.error(errorMessage);
    } finally {
      setRetryingRootIds((prev) => {
        const next = new Set(prev);
        next.delete(groupKey);
        return next;
      });
    }
  };

  return (
    <div className="pending-batch-tasks-badge" ref={rootRef}>
      <button
        type="button"
        className="pending-batch-tasks-badge__button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
      >
        <span className="pending-batch-tasks-badge__dot" aria-hidden="true" />
        {t("workReport:pendingBatchTasks.badgeCount", { count })}
        <span className="pending-batch-tasks-badge__caret" aria-hidden="true">
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open && (
        <div className="pending-batch-tasks-badge__panel" role="dialog">
          <div className="pending-batch-tasks-badge__panel-header">
            {t("workReport:pendingBatchTasks.panelTitle")}
          </div>
          <ul className="pending-batch-tasks-badge__list">
            {groupedByEntry.map(({ formId, entryId, items }) => {
              const groupKey = items.map((item) => item.retryRootTaskId || item.taskId).join("|");
              const isRetrying = retryingRootIds.has(groupKey);
              return (
                <li key={`${formId}:${entryId}`} className="pending-batch-tasks-badge__entry">
                  <button
                    type="button"
                    className="pending-batch-tasks-badge__entry-main"
                    onClick={() => handleNavigate(formId, entryId)}
                  >
                    <span className="pending-batch-tasks-badge__entry-title">
                      {items[0].workOrderNo || entryId}
                    </span>
                    <span className="pending-batch-tasks-badge__entry-meta">
                      {t("workReport:pendingBatchTasks.entryMeta", {
                        formId,
                        count: items.length,
                      })}
                    </span>
                    <span className="pending-batch-tasks-badge__entry-time">
                      {formatRelativeTime(items[0].createdAt, t)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="pending-batch-tasks-badge__retry"
                    onClick={() => void handleRetryEntry(formId, entryId, items)}
                    disabled={isRetrying}
                    title={t("workReport:pendingBatchTasks.retry")}
                  >
                    {isRetrying
                      ? t("workReport:pendingBatchTasks.retrying")
                      : t("workReport:pendingBatchTasks.retry")}
                  </button>
                  <button
                    type="button"
                    className="pending-batch-tasks-badge__dismiss"
                    onClick={() => handleDismissEntry(items)}
                    title={t("workReport:pendingBatchTasks.dismissTitle")}
                    aria-label={t("workReport:pendingBatchTasks.dismissAria")}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="pending-batch-tasks-badge__footer">
            {t("workReport:pendingBatchTasks.footer")}
          </div>
        </div>
      )}
    </div>
  );
}

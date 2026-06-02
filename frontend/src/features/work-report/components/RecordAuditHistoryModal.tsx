import { useEffect, useState } from "react";
import { Modal } from "antd";
import { useTranslation } from "react-i18next";
import {
  fetchRecordAuditLog,
  type RecordAuditLogApiEntry,
  type RecordAuditScope,
} from "../../../api/recordAuditLog";
import { pushFrontendEvent } from "../logging/frontendEventLog";

interface RecordAuditHistoryModalProps {
  open: boolean;
  onClose: () => void;
  scope: RecordAuditScope;
  formId: string;
  /** 不指定時拉該 scope+formId 全部 entry 的歷史 */
  entryId?: string;
  rowId?: string;
  recordLabel?: string;
}

function formatTimestamp(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function shortenClientId(clientId: string | null): string {
  if (!clientId) return "";
  return clientId.length <= 6 ? clientId : `…${clientId.slice(-6)}`;
}

const AUDIT_FETCH_LIMIT = 500;

export function RecordAuditHistoryModal({
  open,
  onClose,
  scope,
  formId,
  entryId,
  rowId,
  recordLabel,
}: RecordAuditHistoryModalProps) {
  const { t } = useTranslation(["workReport"]);
  const [entries, setEntries] = useState<RecordAuditLogApiEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [truncatedLimit, setTruncatedLimit] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // 把 state 設定推進 async function，避免 react-hooks/set-state-in-effect 規則誤判；
    // modal 開啟時 fetch 一次的 cascading render 對效能無影響
    const run = async () => {
      setLoading(true);
      setErrorMessage(null);
      setTruncatedLimit(null);
      try {
        const result = await fetchRecordAuditLog({
          scope,
          formId,
          limit: AUDIT_FETCH_LIMIT,
          ...(entryId ? { entryId } : {}),
          ...(rowId ? { rowId } : {}),
        });
        if (cancelled) return;
        setEntries(result.data);
        // server 回傳 limit 跟 count 相等時代表打到上限，還有更舊的紀錄未被列出
        if (result.meta.count >= result.meta.limit) {
          setTruncatedLimit(result.meta.limit);
        }
        pushFrontendEvent({
          level: "info",
          category: "api",
          action: "audit-history-loaded",
          summary: `載入操作紀錄 ${result.meta.count} 筆`,
          formId,
          ...(entryId ? { entryId } : {}),
          ...(rowId ? { rowId } : {}),
          meta: { count: result.meta.count, limit: result.meta.limit, scope },
        });
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setErrorMessage(message);
        pushFrontendEvent({
          level: "error",
          category: "api",
          action: "audit-history-load-failed",
          summary: `載入操作紀錄失敗：${message}`,
          formId,
          ...(entryId ? { entryId } : {}),
          ...(rowId ? { rowId } : {}),
          meta: { error: message, scope },
        });
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [open, scope, formId, entryId, rowId]);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={720}
      title={
        <div className="audit-history-modal__title">
          <strong>{t("workReport:auditHistory.title")}</strong>
          {recordLabel ? (
            <span className="audit-history-modal__label">{recordLabel}</span>
          ) : null}
        </div>
      }
    >
      <div className="audit-history-modal__scope-hint">
        {t("workReport:auditHistory.scopeHint")}
      </div>
      {truncatedLimit !== null ? (
        <div className="audit-history-modal__truncated-notice">
          {t("workReport:auditHistory.truncatedNotice", { limit: truncatedLimit })}
        </div>
      ) : null}
      {loading ? (
        <div className="audit-history-modal__state">
          <span
            className="toolbar-btn-spinner audit-history-modal__loading-spinner"
            aria-hidden="true"
          />
          {t("workReport:auditHistory.loading")}
        </div>
      ) : errorMessage ? (
        <div className="audit-history-modal__state audit-history-modal__state--error">
          {t("workReport:auditHistory.loadFailed")}：{errorMessage}
        </div>
      ) : entries.length === 0 ? (
        <div className="audit-history-modal__state">
          {t("workReport:auditHistory.emptyText")}
        </div>
      ) : (
        <ul className="audit-history-timeline">
          {entries.map((entry) => (
            <li key={entry.id} className="audit-history-timeline__entry">
              <div className="audit-history-timeline__head">
                <span className="audit-history-timeline__time">
                  {formatTimestamp(entry.occurredAt)}
                </span>
                <span
                  className={`audit-history-timeline__action audit-history-timeline__action--${entry.action}`}
                >
                  {entry.action === "update"
                    ? t("workReport:auditHistory.actionUpdate")
                    : t("workReport:auditHistory.actionDelete")}
                </span>
                {entry.rowId ? (
                  <span className="audit-history-timeline__row-id">
                    {t("workReport:auditHistory.rowIdShort")}: {entry.rowId}
                  </span>
                ) : (
                  <span className="audit-history-timeline__row-id">
                    {t("workReport:auditHistory.entryIdShort")}: {entry.entryId}
                  </span>
                )}
              </div>
              <div className="audit-history-timeline__actor">
                <span>
                  {t("workReport:auditHistory.actorIp")}: {entry.actor.ip || "--"}
                </span>
                {entry.actor.label ? (
                  <span>
                    {t("workReport:auditHistory.actorDevice")}: {entry.actor.label}
                  </span>
                ) : null}
                {entry.actor.clientId ? (
                  <span>
                    {t("workReport:auditHistory.actorClientId")}: {shortenClientId(entry.actor.clientId)}
                  </span>
                ) : null}
              </div>
              {entry.taskId ? (
                <div className="audit-history-timeline__task">
                  {t("workReport:auditHistory.taskIdLabel")}: {entry.taskId}
                </div>
              ) : null}
              {entry.action === "update" && entry.changedFields.length > 0 ? (
                <div className="audit-history-timeline__fields">
                  <span className="audit-history-timeline__fields-label">
                    {t("workReport:auditHistory.changedFieldsLabel")}:
                  </span>
                  {entry.changedFields.map((field) => (
                    <span key={field} className="audit-history-timeline__field-chip">
                      {field}
                    </span>
                  ))}
                </div>
              ) : null}
              <details className="audit-history-timeline__diff">
                <summary>JSON</summary>
                <div className="audit-history-timeline__diff-grid">
                  <div>
                    <strong>{t("workReport:auditHistory.beforeSnapshotLabel")}</strong>
                    <pre>{JSON.stringify(entry.beforeSnapshot, null, 2)}</pre>
                  </div>
                  <div>
                    <strong>{t("workReport:auditHistory.afterPatchLabel")}</strong>
                    <pre>{JSON.stringify(entry.afterPatch, null, 2)}</pre>
                  </div>
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

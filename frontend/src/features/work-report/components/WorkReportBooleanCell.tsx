import { useEffect, useRef, useState } from "react";
import { LoadingOutlined } from "@ant-design/icons";
import { message, Popover } from "antd";
import { useTranslation } from "react-i18next";
import type { WorkReportRecord } from "../../../api/workReport";
import { WORK_REPORT_BOOLEAN_EDIT_EVENT } from "../workReportCellCopy";
import {
  getErrorMessage,
  isWorkOrderClosedStatus,
  parseSemanticBoolean,
} from "../utils";

interface WorkReportBooleanCellProps {
  value: unknown;
  record: WorkReportRecord;
  label: string;
  onSubmit: (record: WorkReportRecord, value: boolean) => Promise<void>;
  syncing?: boolean;
  blocked?: boolean;
  editable?: boolean;
  urgent?: boolean;
}

export function WorkReportBooleanCell({
  value,
  record,
  label,
  onSubmit,
  syncing = false,
  blocked = false,
  editable = true,
  urgent = false,
}: WorkReportBooleanCellProps) {
  const { t } = useTranslation("common");
  const [submitting, setSubmitting] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const editingSnapshotRef = useRef({ record, checked: parseSemanticBoolean(value) === true });
  const submitInFlightRef = useRef(false);
  const checked = parseSemanticBoolean(value) === true;
  const isSyncing = syncing || submitting;
  const disabled =
    !editable ||
    isWorkOrderClosedStatus(record.status) ||
    blocked ||
    syncing ||
    submitting;

  useEffect(() => {
    const button = buttonRef.current;
    if (!button) return;
    const openEditor = () => {
      if (disabled) return;
      editingSnapshotRef.current = { record: { ...record }, checked };
      setDraft(checked);
      setEditorOpen(true);
    };
    button.addEventListener(WORK_REPORT_BOOLEAN_EDIT_EVENT, openEditor);
    return () => button.removeEventListener(WORK_REPORT_BOOLEAN_EDIT_EVENT, openEditor);
  }, [checked, disabled, record]);

  const handleSubmit = async (nextValue: boolean, snapshot = record) => {
    if (disabled || submitInFlightRef.current || String(snapshot.id) !== String(record.id)) return;
    submitInFlightRef.current = true;
    setSubmitting(true);
    try {
      await onSubmit(snapshot, nextValue);
      setEditorOpen(false);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <Popover open={editorOpen && !disabled} trigger={["click"]} placement="bottomLeft" overlayClassName="work-report-editable-popover"
      onOpenChange={open => { if (!open && !submitting) setEditorOpen(false); }}
      content={<div className="work-report-editable-editor" onClick={event => event.stopPropagation()}>
        <label htmlFor={`boolean-${label}-${record.id}`}>{label}</label>
        <select id={`boolean-${label}-${record.id}`} value={draft ? "yes" : "no"}
          onChange={event => setDraft(event.target.value === "yes")} disabled={submitting}>
          <option value="yes">{t("yesNo.yes")}</option><option value="no">{t("yesNo.no")}</option>
        </select>
        <div className="work-report-editable-actions">
          <button type="button" disabled={submitting} onClick={() => setEditorOpen(false)}>{t("actions.cancel")}</button>
          <button type="button" className="is-primary" disabled={submitting}
            onClick={() => {
              const snapshot = editingSnapshotRef.current;
              if (snapshot.checked === draft) {
                setEditorOpen(false);
                return;
              }
              void handleSubmit(draft, snapshot.record);
            }}>{t("actions.save")}</button>
        </div>
      </div>}>
    <button
      ref={buttonRef}
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={isSyncing ? `${label}，${t("actions.saving")}` : label}
      title={isSyncing ? `${label}｜${t("actions.saving")}` : label}
      className={`work-report-boolean-toggle${urgent ? " is-urgent" : ""}${
        checked ? " is-checked" : ""
      }${isSyncing ? " is-syncing" : ""}`}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        void handleSubmit(!checked);
      }}
    >
      <span aria-hidden="true">
        {isSyncing ? <LoadingOutlined spin /> : checked ? "✓" : ""}
      </span>
    </button>
    </Popover>
  );
}

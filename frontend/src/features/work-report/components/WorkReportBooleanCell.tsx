import { useRef, useState } from "react";
import { LoadingOutlined } from "@ant-design/icons";
import { message } from "antd";
import { useTranslation } from "react-i18next";
import type { WorkReportRecord } from "../../../api/workReport";
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
  const submitInFlightRef = useRef(false);
  const checked = parseSemanticBoolean(value) === true;
  const isSyncing = syncing || submitting;
  const disabled =
    !editable ||
    isWorkOrderClosedStatus(record.status) ||
    blocked ||
    syncing ||
    submitting;

  const handleToggle = async () => {
    if (disabled || submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setSubmitting(true);
    try {
      await onSubmit(record, !checked);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <button
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
        void handleToggle();
      }}
    >
      <span aria-hidden="true">
        {isSyncing ? <LoadingOutlined spin /> : checked ? "✓" : ""}
      </span>
    </button>
  );
}

import { useRef, useState, type ReactNode } from "react";
import { EditOutlined } from "@ant-design/icons";
import { Popover } from "antd";
import { useTranslation } from "react-i18next";
import type { WorkReportRecord } from "../../../api/workReport";
import { getErrorMessage } from "../utils";

interface WorkReportSortOrderCellProps {
  value: unknown;
  record: WorkReportRecord;
  displayValue: ReactNode;
  onSubmit: (record: WorkReportRecord, sortOrder: number) => Promise<void>;
}

function toDraftValue(value: unknown): string {
  if (value === null || value === undefined || String(value).trim() === "") {
    return "";
  }
  return String(value).trim();
}

export function WorkReportSortOrderCell({
  value,
  record,
  displayValue,
  onSubmit,
}: WorkReportSortOrderCellProps) {
  const { t } = useTranslation(["workReport", "common"]);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => toDraftValue(value));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitInFlightRef = useRef(false);

  const handleOpenChange = (nextOpen: boolean) => {
    if (submitting) {
      return;
    }
    setOpen(nextOpen);
    setError(null);
    if (nextOpen) {
      setDraft(toDraftValue(value));
    }
  };

  const handleSubmit = async () => {
    if (submitInFlightRef.current) {
      return;
    }
    const parsed = Number(draft);
    if (draft.trim() === "" || !Number.isInteger(parsed) || parsed < 0) {
      setError(t("table.sortOrderInvalid"));
      return;
    }

    submitInFlightRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(record, parsed);
      setOpen(false);
    } catch (submitError) {
      setError(getErrorMessage(submitError));
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div
      className="work-report-sort-order-cell"
      onClick={(event) => event.stopPropagation()}
    >
      <span className="work-report-sort-order-value">{displayValue}</span>
      <Popover
        trigger="click"
        placement="bottomLeft"
        open={open}
        onOpenChange={handleOpenChange}
        overlayClassName="work-report-sort-order-popover"
        content={
          <div className="work-report-sort-order-editor">
            <label htmlFor={`sort-order-${record.id}`}>
              {t("table.sortOrderEditorLabel")}
            </label>
            <input
              id={`sort-order-${record.id}`}
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              value={draft}
              disabled={submitting}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void handleSubmit();
                }
              }}
            />
            {error ? <p role="alert">{error}</p> : null}
            <div className="work-report-sort-order-actions">
              <button
                type="button"
                disabled={submitting}
                onClick={() => handleOpenChange(false)}
              >
                {t("common:actions.cancel")}
              </button>
              <button
                type="button"
                className="is-primary"
                disabled={submitting}
                onClick={() => void handleSubmit()}
              >
                {submitting
                  ? t("table.sortOrderSubmitting")
                  : t("common:actions.save")}
              </button>
            </div>
          </div>
        }
      >
        <button
          type="button"
          className="work-report-sort-order-edit-btn"
          aria-label={t("table.sortOrderEditAria", {
            workOrderNo: record.workOrderNo ?? record.id,
          })}
        >
          <EditOutlined />
        </button>
      </Popover>
    </div>
  );
}

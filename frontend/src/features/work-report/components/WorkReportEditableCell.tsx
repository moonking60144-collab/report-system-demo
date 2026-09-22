import { useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { EditOutlined } from "@ant-design/icons";
import { Popover } from "antd";
import type { WorkReportRecord } from "../../../api/workReport";
import { getErrorMessage } from "../utils";

interface WorkReportEditableCellProps<TValue> {
  kind: "sort-order" | "planned-end-date" | "main-machine";
  value: unknown;
  record: WorkReportRecord;
  displayValue: ReactNode;
  disabled?: boolean;
  disabledStatusLabel?: string;
  toDraft: (value: unknown) => string;
  parseDraft: (draft: string) => TValue | null;
  isUnchanged?: (parsed: TValue, value: unknown) => boolean;
  onSubmit: (record: WorkReportRecord, value: TValue) => Promise<void>;
  label: string;
  invalidMessage: string;
  submittingLabel: string;
  saveLabel: string;
  cancelLabel: string;
  editAriaLabel: string;
  inputProps: Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "id" | "value" | "disabled" | "onChange" | "onKeyDown"
  >;
  options?: readonly { value: string; label: string }[];
}

export function WorkReportEditableCell<TValue>({
  kind,
  value,
  record,
  displayValue,
  disabled = false,
  disabledStatusLabel,
  toDraft,
  parseDraft,
  isUnchanged,
  onSubmit,
  label,
  invalidMessage,
  submittingLabel,
  saveLabel,
  cancelLabel,
  editAriaLabel,
  inputProps,
  options = [],
}: WorkReportEditableCellProps<TValue>) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => toDraft(value));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitInFlightRef = useRef(false);
  const editingSnapshotRef = useRef({ record, value });
  const classPrefix = `work-report-${kind}`;
  const inputId = `${kind}-${record.id}`;
  const optionsId = `${inputId}-options`;

  const handleOpenChange = (nextOpen: boolean) => {
    if (submitting || disabled) return;
    setOpen(nextOpen);
    setError(null);
    if (nextOpen) {
      editingSnapshotRef.current = { record: { ...record }, value };
      setDraft(toDraft(value));
    }
  };

  const handleSubmit = async () => {
    if (submitInFlightRef.current) return;
    const snapshot = editingSnapshotRef.current;
    if (disabled || String(snapshot.record.id) !== String(record.id)) {
      setOpen(false);
      return;
    }
    const parsed = parseDraft(draft);
    if (parsed === null) {
      setError(invalidMessage);
      return;
    }
    if (isUnchanged?.(parsed, snapshot.value)) {
      setOpen(false);
      return;
    }

    submitInFlightRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(snapshot.record, parsed);
      setOpen(false);
    } catch (submitError) {
      setError(getErrorMessage(submitError));
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
    }
  };

  const valueNode = (
    <span className={`work-report-editable-value ${classPrefix}-value`}>
      {displayValue}
    </span>
  );
  if (disabled) {
    return (
      <span className="work-report-editable-disabled">
        {valueNode}
        {disabledStatusLabel ? (
          <span className="work-report-editable-status">{disabledStatusLabel}</span>
        ) : null}
      </span>
    );
  }

  return (
    <div
      className={`work-report-editable-cell ${classPrefix}-cell`}
      onClick={(event) => event.stopPropagation()}
    >
      {valueNode}
      <Popover
        trigger="click"
        placement="bottomLeft"
        open={open}
        onOpenChange={handleOpenChange}
        overlayClassName="work-report-editable-popover"
        content={
          <div className={`work-report-editable-editor ${classPrefix}-editor`}>
            <label htmlFor={inputId}>{label}</label>
            <input
              {...inputProps}
              id={inputId}
              list={options.length > 0 ? optionsId : inputProps.list}
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
            {options.length > 0 ? (
              <datalist id={optionsId}>
                {options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </datalist>
            ) : null}
            {error ? <p role="alert">{error}</p> : null}
            <div className="work-report-editable-actions">
              <button
                type="button"
                disabled={submitting}
                onClick={() => handleOpenChange(false)}
              >
                {cancelLabel}
              </button>
              <button
                type="button"
                className="is-primary"
                disabled={submitting}
                onClick={() => void handleSubmit()}
              >
                {submitting ? submittingLabel : saveLabel}
              </button>
            </div>
          </div>
        }
      >
        <button
          type="button"
          className={`work-report-editable-edit-btn ${classPrefix}-edit-btn`}
          aria-label={editAriaLabel}
        >
          <EditOutlined />
        </button>
      </Popover>
    </div>
  );
}

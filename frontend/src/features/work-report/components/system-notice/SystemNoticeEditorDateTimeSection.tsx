import type { RefObject } from "react";
import { useTranslation } from "react-i18next";

interface SystemNoticeEditorDateTimeSectionProps {
  startAtInput: string;
  endAtInput: string;
  startAtPickerValue: string;
  endAtPickerValue: string;
  dateTimeInputError: string | null;
  startAtPickerInputRef: RefObject<HTMLInputElement | null>;
  endAtPickerInputRef: RefObject<HTMLInputElement | null>;
  onOpenDateTimePicker: (field: "startAtInput" | "endAtInput") => void;
  onDateTimePickerChange: (field: "startAtInput" | "endAtInput", rawValue: string) => void;
  onDateTimeInputChange: (field: "startAtInput" | "endAtInput", value: string) => void;
  onDateTimeInputBlur: (field: "startAtInput" | "endAtInput", value: string) => string;
}

export function SystemNoticeEditorDateTimeSection({
  startAtInput,
  endAtInput,
  startAtPickerValue,
  endAtPickerValue,
  dateTimeInputError,
  startAtPickerInputRef,
  endAtPickerInputRef,
  onOpenDateTimePicker,
  onDateTimePickerChange,
  onDateTimeInputChange,
  onDateTimeInputBlur,
}: SystemNoticeEditorDateTimeSectionProps) {
  const { t } = useTranslation("workReport");

  return (
    <>
      <div className="system-notice-datetime-grid">
        <label>
          <span>{t("systemNotice.fields.startAt")}</span>
          <div className="system-notice-datetime-input-wrap">
            <input
              type="text"
              value={startAtInput}
              placeholder={t("systemNotice.fields.dateTimePlaceholder")}
              onChange={(event) => onDateTimeInputChange("startAtInput", event.target.value)}
              onBlur={(event) =>
                onDateTimeInputChange(
                  "startAtInput",
                  onDateTimeInputBlur("startAtInput", event.target.value)
                )
              }
            />
            <button
              type="button"
              className="system-notice-datetime-picker-btn"
              onClick={() => onOpenDateTimePicker("startAtInput")}
              aria-label={t("systemNotice.fields.openDateTimePicker")}
              title={t("systemNotice.fields.openDateTimePicker")}
            >
              📅
            </button>
            <input
              ref={startAtPickerInputRef}
              type="datetime-local"
              tabIndex={-1}
              aria-hidden="true"
              className="system-notice-datetime-picker-native"
              value={startAtPickerValue}
              onChange={(event) => onDateTimePickerChange("startAtInput", event.target.value)}
            />
          </div>
        </label>
        <label>
          <span>{t("systemNotice.fields.endAt")}</span>
          <div className="system-notice-datetime-input-wrap">
            <input
              type="text"
              value={endAtInput}
              placeholder={t("systemNotice.fields.dateTimePlaceholder")}
              onChange={(event) => onDateTimeInputChange("endAtInput", event.target.value)}
              onBlur={(event) =>
                onDateTimeInputChange(
                  "endAtInput",
                  onDateTimeInputBlur("endAtInput", event.target.value)
                )
              }
            />
            <button
              type="button"
              className="system-notice-datetime-picker-btn"
              onClick={() => onOpenDateTimePicker("endAtInput")}
              aria-label={t("systemNotice.fields.openDateTimePicker")}
              title={t("systemNotice.fields.openDateTimePicker")}
            >
              📅
            </button>
            <input
              ref={endAtPickerInputRef}
              type="datetime-local"
              tabIndex={-1}
              aria-hidden="true"
              className="system-notice-datetime-picker-native"
              value={endAtPickerValue}
              onChange={(event) => onDateTimePickerChange("endAtInput", event.target.value)}
            />
          </div>
        </label>
      </div>
      <p className="system-notice-field-hint">{t("systemNotice.fields.dateTimeHint")}</p>
      {dateTimeInputError ? <p className="system-notice-error">{dateTimeInputError}</p> : null}
    </>
  );
}

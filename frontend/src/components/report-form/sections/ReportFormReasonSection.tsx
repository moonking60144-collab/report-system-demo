import { useTranslation } from "react-i18next";
import type { Dispatch, SetStateAction } from "react";
import { REASON_MINUTE_FIELD_DEFS } from "../constants";
import type { FormState } from "../types";

interface ReportFormReasonSectionProps {
  formState: FormState;
  setFormState: Dispatch<SetStateAction<FormState>>;
  disabled: boolean;
}

export function ReportFormReasonSection({
  formState,
  setFormState,
  disabled,
}: ReportFormReasonSectionProps) {
  const { t: tr } = useTranslation(["workReport", "common"]);

  return (
    <section className="modal-reason-section">
      <h3>{tr("workReport:reportForm.reasonSection.title")}</h3>
      <p>{tr("workReport:reportForm.reasonSection.hint")}</p>
      <div className="modal-reason-grid">
        {REASON_MINUTE_FIELD_DEFS.map((field) => (
          <label key={field.key}>
            {tr(field.i18nKey)}
            <input
              type="number"
              min="0"
              step="1"
              value={formState[field.key]}
              disabled={disabled}
              data-inline-editor-key={`modal-${field.key}`}
              onChange={(event) =>
                setFormState((prev) => ({
                  ...prev,
                  [field.key]: event.target.value,
                }))
              }
            />
          </label>
        ))}
      </div>
    </section>
  );
}

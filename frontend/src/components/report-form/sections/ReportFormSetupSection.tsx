import { useTranslation } from "react-i18next";
import type { Dispatch, SetStateAction } from "react";
import type { FormOptionItem } from "../../../api/workReport";
import type { FormState } from "../types";
import { SearchableSelect } from "../../SearchableSelect";

interface ReportFormSetupSectionProps {
  formState: FormState;
  setFormState: Dispatch<SetStateAction<FormState>>;
  setupAdjustTypeOptions: FormOptionItem[];
  countSetupTimeFlagOptions: FormOptionItem[];
  containerUnitOptions: FormOptionItem[];
  disabled: boolean;
}

export function ReportFormSetupSection({
  formState,
  setFormState,
  setupAdjustTypeOptions,
  countSetupTimeFlagOptions,
  containerUnitOptions,
  disabled,
}: ReportFormSetupSectionProps) {
  const { t: tr } = useTranslation(["workReport", "common"]);

  return (
    <section className="modal-reason-section">
      <h3>{tr("workReport:reportForm.setupSection.title")}</h3>
      <p>{tr("workReport:reportForm.setupSection.hint")}</p>
      <div className="modal-reason-grid">
        <label>
          {tr("workReport:reportForm.setupSection.fields.setupAdjustType")}
          <SearchableSelect
            value={formState.setupAdjustType}
            options={setupAdjustTypeOptions}
            placeholder={tr("common:options.select")}
            disabled={disabled}
            labelMode="value-only"
            editorKey="modal-setupAdjustType"
            onChange={(value) =>
              setFormState((prev) => ({ ...prev, setupAdjustType: value }))
            }
          />
        </label>
        <label>
          {tr("workReport:reportForm.setupSection.fields.setupAdjustMinutes")}
          <input
            type="number"
            min="0"
            step="1"
            value={formState.setupAdjustMinutes}
            disabled={disabled}
            data-inline-editor-key="modal-setupAdjustMinutes"
            onChange={(event) =>
              setFormState((prev) => ({
                ...prev,
                setupAdjustMinutes: event.target.value,
              }))
            }
          />
        </label>
        <label>
          {tr("workReport:reportForm.setupSection.fields.countSetupTimeFlag")}
          <SearchableSelect
            value={formState.countSetupTimeFlag}
            options={countSetupTimeFlagOptions}
            placeholder={tr("common:options.select")}
            disabled={disabled}
            labelMode="value-display"
            editorKey="modal-countSetupTimeFlag"
            onChange={(value) =>
              setFormState((prev) => ({ ...prev, countSetupTimeFlag: value }))
            }
          />
        </label>
        <label>
          {tr("workReport:reportForm.setupSection.fields.setupTimeStandardHours")}
          <input
            type="text"
            value={formState.setupTimeStandardHours}
            readOnly
            disabled
          />
        </label>
        <label>
          {tr("workReport:reportForm.setupSection.fields.setupLossQtyPerPcs")}
          <input
            type="number"
            min="0"
            step="1"
            value={formState.setupLossQtyPerPcs}
            disabled={disabled}
            data-inline-editor-key="modal-setupLossQtyPerPcs"
            onChange={(event) =>
              setFormState((prev) => ({
                ...prev,
                setupLossQtyPerPcs: event.target.value,
              }))
            }
          />
        </label>
        <label>
          {tr("workReport:reportForm.setupSection.fields.processLossQtyPerPcs")}
          <input
            type="number"
            min="0"
            step="1"
            value={formState.processLossQtyPerPcs}
            disabled={disabled}
            data-inline-editor-key="modal-processLossQtyPerPcs"
            onChange={(event) =>
              setFormState((prev) => ({
                ...prev,
                processLossQtyPerPcs: event.target.value,
              }))
            }
          />
        </label>
        <label>
          {tr("workReport:reportForm.setupSection.fields.totalContainerQty")}
          <input
            type="number"
            min="0"
            step="1"
            value={formState.totalContainerQty}
            disabled={disabled}
            data-inline-editor-key="modal-totalContainerQty"
            onChange={(event) =>
              setFormState((prev) => ({
                ...prev,
                totalContainerQty: event.target.value,
              }))
            }
          />
        </label>
        <label>
          {tr("workReport:reportForm.setupSection.fields.containerUnit")}
          <SearchableSelect
            value={formState.containerUnit}
            options={containerUnitOptions}
            placeholder={tr("common:options.select")}
            disabled={disabled}
            labelMode="value-only"
            editorKey="modal-containerUnit"
            onChange={(value) =>
              setFormState((prev) => ({ ...prev, containerUnit: value }))
            }
          />
        </label>
      </div>
    </section>
  );
}

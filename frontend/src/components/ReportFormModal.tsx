import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { predictModalCumulative } from "../features/work-report/utils/predictedCumulative";
import type {
  FormOptionMap,
  ReportMutationPayload,
  WorkReportItem,
  WorkReportRecord,
} from "../api/workReport";
import type { WorkReportFormId } from "../features/work-report/types";
import type { OperatorGroupOption } from "./report-form/operatorGroupPreferences";
import { OperatorGroupFilter } from "./report-form/OperatorGroupFilter";
import { DetailInlinePickerTrigger, DetailLinkedPickerModal } from "../features/work-report/components/DetailLinkedPicker";
import { SearchableSelect } from "./SearchableSelect";
import { WorkOrderContextCard } from "./WorkOrderContextCard";
import { ReportFormFooter } from "./report-form/sections/ReportFormFooter";
import { ReportFormReasonSection } from "./report-form/sections/ReportFormReasonSection";
import { ReportFormSetupSection } from "./report-form/sections/ReportFormSetupSection";
import { useReportFormModalFocusController } from "./report-form/modal/useReportFormModalFocusController";
import { useReportFormModalFormController } from "./report-form/modal/useReportFormModalFormController";
import { useReportFormModalPickerController } from "./report-form/modal/useReportFormModalPickerController";

const TIME_SHORTCUT_VALUES = ["08:00", "12:00", "13:00", "17:00", "17:30"] as const;

interface ReportFormModalProps {
  formId: WorkReportFormId;
  open: boolean;
  mode: "create" | "edit";
  resetToken?: number;
  uiLanguage?: "zh" | "en";
  initialValue?: WorkReportItem | null;
  entryContext?: WorkReportRecord | null;
  entryContextLoading?: boolean;
  options: FormOptionMap;
  operatorGroupOptions: OperatorGroupOption[];
  selectedOperatorGroupKey: string;
  onOperatorGroupChange: (groupKey: string) => void;
  optionsLoading: boolean;
  submitting: boolean;
  submitDisabled?: boolean;
  onClose: () => void;
  onSubmit: (
    payload: ReportMutationPayload,
    options?: { continueAfterSave?: boolean }
  ) => Promise<void>;
  onDebugEvent?: (
    action:
      | "modal-submit-validation-failed"
      | "modal-submit-blocked-options-loading",
    summary: string,
    meta?: Record<string, string | number | boolean | null | undefined | string[]>
  ) => void;
}

export function ReportFormModal({
  formId,
  open,
  mode,
  uiLanguage = "zh",
  initialValue,
  entryContext,
  entryContextLoading = false,
  options,
  operatorGroupOptions,
  selectedOperatorGroupKey,
  onOperatorGroupChange,
  optionsLoading,
  submitting,
  submitDisabled = false,
  onClose,
  onSubmit,
  onDebugEvent,
}: ReportFormModalProps) {
  const { t: tr } = useTranslation(["workReport", "common"]);
  const {
    formRef,
    getModalFieldEl,
    focusModalField,
    focusModalSubmitButton,
    focusNextEmptyModalField,
    modalFieldOrder,
  } = useReportFormModalFocusController();
  const {
    formState,
    setFormState,
    isPlannedIdleYes,
    error,
    saveProgress,
    title,
    plannedIdleOptions,
    reportTypeOptions,
    inputOptions,
    shiftTypeOptions,
    setupAdjustTypeOptions,
    countSetupTimeFlagOptions,
    containerUnitOptions,
    timeInputWarningField,
    handleSubmit,
    setMaskedTimeField,
    handleInputOptionsChange,
    handlePlannedIdleChange,
    handleShiftTypeChange,
    handleDateChange,
    isAutofilledField,
    resetToEmptyForm,
  } = useReportFormModalFormController({
    formId,
    mode,
    initialValue,
    entryContext,
    options,
    optionsLoading,
    submitting,
    onSubmit,
    onDebugEvent,
    tr,
    focusNextEmptyModalField,
  });
  const {
    machinePickerOpen,
    setMachinePickerOpen,
    machinePickerSearch,
    setMachinePickerSearch,
    operatorPickerOpen,
    setOperatorPickerOpen,
    operatorPickerSearch,
    setOperatorPickerSearch,
    processPickerOpen,
    setProcessPickerOpen,
    processPickerSearch,
    setProcessPickerSearch,
    selectedMachineGroupKey,
    selectedProcessGroupKey,
    machineGroupOptions,
    processGroupOptions,
    effectiveSelectedMachineGroupKey,
    effectiveSelectedProcessGroupKey,
    filteredMachinePickerOptions,
    filteredOperatorPickerOptions,
    filteredProcessPickerOptions,
    currentMachinePickerOption,
    currentOperatorPickerOption,
    currentProcessPickerOption,
    selectedMachineOption,
    selectedOperatorOption,
    selectedProcessOption,
    handleOperatorChange,
    handleMachineChange,
    handleMachineGroupPreferenceChange,
    handleProcessGroupPreferenceChange,
    handleProcessChange,
    onOperatorGroupChange: handleOperatorGroupChange,
  } = useReportFormModalPickerController({
    formId,
    mode,
    entryContext,
    options,
    formState,
    setFormState,
    operatorGroupOptions,
    selectedOperatorGroupKey,
    onOperatorGroupChange,
    focusNextEmptyModalField,
  });

  // 計算預估累計量：編輯時排除自己這筆，新增時全加
  const predictedCumulative = useMemo(() => {
    const reports = entryContext?.reports ?? [];
    if (!formState.productionQty.trim()) {
      return null;
    }
    const excludeRowId = mode === "edit" && initialValue?.rowId ? String(initialValue.rowId) : null;
    return predictModalCumulative(reports, formState.productionQty, excludeRowId);
  }, [entryContext?.reports, formState.productionQty, initialValue?.rowId, mode]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) {
        event.preventDefault();
        if (machinePickerOpen) {
          setMachinePickerOpen(false);
          setMachinePickerSearch("");
          return;
        }
        if (operatorPickerOpen) {
          setOperatorPickerOpen(false);
          setOperatorPickerSearch("");
          return;
        }
        if (processPickerOpen) {
          setProcessPickerOpen(false);
          setProcessPickerSearch("");
          return;
        }
        onClose();
        return;
      }

      if (event.key === "Enter" && !submitting) {
        const activeEl = document.activeElement as HTMLElement | null;
        if (!activeEl) return;
        if (activeEl instanceof HTMLTextAreaElement && event.shiftKey) return;
        if (activeEl instanceof HTMLButtonElement) return;
        if (machinePickerOpen || operatorPickerOpen || processPickerOpen) return;

        const currentKeyIndex = modalFieldOrder.findIndex((key) => {
          const el = getModalFieldEl(key);
          return el === activeEl || el?.contains(activeEl);
        });

        const currentKey =
          currentKeyIndex >= 0 ? modalFieldOrder[currentKeyIndex] : null;
        const found =
          currentKey !== null
            ? focusNextEmptyModalField(currentKey, formState, { wrap: false })
            : false;
        if (!found) {
          const submitIntent = mode === "create" ? "save-and-next" : "save";
          if (focusModalSubmitButton(submitIntent)) {
            event.preventDefault();
          }
          return;
        }
        event.preventDefault();
        return;
      }

      const isSaveShortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s";
      if (!isSaveShortcut) {
        return;
      }
      event.preventDefault();
      const submitIntent = event.shiftKey ? "save-and-next" : "save";
      const button = document.querySelector<HTMLButtonElement>(
        `.modal-actions button[data-submit-intent="${submitIntent}"]`
      );
      button?.click();
    };

    window.addEventListener("keydown", handleKeydown);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
    };
  }, [
    focusModalField,
    focusModalSubmitButton,
    focusNextEmptyModalField,
    formState,
    getModalFieldEl,
    machinePickerOpen,
    modalFieldOrder,
    mode,
    onClose,
    open,
    operatorPickerOpen,
    processPickerOpen,
    setMachinePickerOpen,
    setMachinePickerSearch,
    setOperatorPickerOpen,
    setOperatorPickerSearch,
    setProcessPickerOpen,
    setProcessPickerSearch,
    submitting,
  ]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) {
          onClose();
        }
      }}
    >
      <div className="modal-panel" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <h2>{title}</h2>
          <button type="button" onClick={onClose} disabled={submitting}>
            {tr("common:actions.close")}
          </button>
        </header>

        <div className="modal-context">
          <WorkOrderContextCard
            record={entryContext}
            uiLanguage={uiLanguage}
            compact
            loading={entryContextLoading}
            detailCollapsible
            detailDefaultCollapsed
          />
        </div>

        <form className="modal-form" ref={formRef} onSubmit={handleSubmit}>
          <div className="modal-field modal-field--required">
            <span className="modal-field-label">{tr("workReport:reportForm.fields.operatorIdRequired")}</span>
            <DetailInlinePickerTrigger
              value={formState.operatorId}
              hint={selectedOperatorOption?.display ?? null}
              blankLabel={tr("common:options.select")}
              editorKey="modal-operatorId"
              disabled={optionsLoading || submitting}
              onOpen={() => {
                setOperatorPickerOpen(true);
                setOperatorPickerSearch("");
              }}
            />
          </div>

          <label className="modal-field modal-field--readonly">
            <span className="modal-field-label modal-field-label--muted">
              {tr("workReport:reportForm.fields.operatorName")}
            </span>
            <input type="text" value={formState.operatorName} readOnly disabled />
          </label>

          <label className="modal-field modal-field--required">
            <span className="modal-field-label">{tr("workReport:reportForm.fields.dateRequired")}</span>
            <input
              type="date"
              value={formState.date}
              min="1900-01-01"
              max="9999-12-31"
              disabled={optionsLoading || submitting}
              data-inline-editor-key="modal-date"
              onChange={(event) => handleDateChange(event.target.value)}
              onBlur={(event) => handleDateChange(event.target.value)}
            />
          </label>

          <label className="modal-field modal-field--optional">
            <span className="modal-field-label">
              {tr("workReport:reportForm.fields.plannedIdle")}
            </span>
            <SearchableSelect
              value={formState.plannedIdle}
              options={plannedIdleOptions}
              placeholder={tr("common:options.select")}
              disabled={optionsLoading || submitting}
              labelMode="value-display"
              editorKey="modal-plannedIdle"
              onChange={handlePlannedIdleChange}
              onSelect={handlePlannedIdleChange}
            />
          </label>

          <label className="modal-field modal-field--required">
            <span className="modal-field-label">{tr("workReport:reportForm.fields.machineRequired")}</span>
            <DetailInlinePickerTrigger
              value={formState.machineId}
              hint={
                selectedMachineOption?.display &&
                selectedMachineOption.display !== selectedMachineOption.value
                  ? selectedMachineOption.display
                  : null
              }
              blankLabel={tr("common:options.select")}
              editorKey="modal-machineId"
              disabled={optionsLoading || submitting}
              onOpen={() => {
                setMachinePickerOpen(true);
                setMachinePickerSearch("");
              }}
            />
          </label>

          <label className="modal-field modal-field--optional">
            <span className="modal-field-label">{tr("workReport:reportForm.fields.quickFill")}</span>
            <span className="modal-field-hint">{tr("workReport:reportForm.hints.quickFill")}</span>
            <SearchableSelect
              value={formState.inputOptions}
              options={inputOptions}
              placeholder={tr("workReport:reportForm.placeholders.inputOptionsAutoFillShiftTime")}
              disabled={optionsLoading || submitting}
              labelMode="value-only"
              editorKey="modal-inputOptions"
              onChange={handleInputOptionsChange}
              onSelect={handleInputOptionsChange}
            />
          </label>

          <label className={`modal-field modal-field--optional ${isAutofilledField("shiftType") ? "is-autofilled" : ""}`}>
            <span className="modal-field-label">{tr("workReport:reportForm.fields.shiftTypeManual")}</span>
            <SearchableSelect
              value={formState.shiftType}
              options={shiftTypeOptions}
              placeholder={tr("common:options.select")}
              disabled={optionsLoading || submitting}
              labelMode="value-only"
              editorKey="modal-shiftType"
              onChange={handleShiftTypeChange}
              onSelect={handleShiftTypeChange}
            />
          </label>

          <label className={`modal-field modal-field--required ${isAutofilledField("startTime") ? "is-autofilled" : ""}`}>
            <span className="modal-field-label">{tr("workReport:reportForm.fields.startTimeRequired")}</span>
            <input
              type="text"
              value={formState.startTime}
              inputMode="numeric"
              maxLength={5}
              placeholder={tr("workReport:reportForm.placeholders.timeInput")}
              disabled={optionsLoading || submitting}
              data-inline-editor-key="modal-startTime"
              onChange={(event) => setMaskedTimeField("startTime", event.target.value)}
            />
            {timeInputWarningField === "startTime" ? (
              <span className="modal-field-error">{tr("workReport:reportForm.validation.invalidTimeHint")}</span>
            ) : null}
            <div className="modal-time-shortcuts" role="group" aria-label={tr("workReport:reportForm.fields.startTimeRequired")}>
              {TIME_SHORTCUT_VALUES.map((time) => (
                <button
                  key={`start-${time}`}
                  type="button"
                  className="modal-time-chip"
                  disabled={optionsLoading || submitting}
                  onClick={() => setMaskedTimeField("startTime", time)}
                >
                  {time}
                </button>
              ))}
            </div>
          </label>

          <label className={`modal-field modal-field--required ${isAutofilledField("endTime") ? "is-autofilled" : ""}`}>
            <span className="modal-field-label">{tr("workReport:reportForm.fields.endTimeRequired")}</span>
            <input
              type="text"
              value={formState.endTime}
              inputMode="numeric"
              maxLength={5}
              placeholder={tr("workReport:reportForm.placeholders.timeInput")}
              disabled={optionsLoading || submitting}
              data-inline-editor-key="modal-endTime"
              onChange={(event) => setMaskedTimeField("endTime", event.target.value)}
            />
            {timeInputWarningField === "endTime" ? (
              <span className="modal-field-error">{tr("workReport:reportForm.validation.invalidTimeHint")}</span>
            ) : null}
            <div className="modal-time-shortcuts" role="group" aria-label={tr("workReport:reportForm.fields.endTimeRequired")}>
              {TIME_SHORTCUT_VALUES.map((time) => (
                <button
                  key={`end-${time}`}
                  type="button"
                  className="modal-time-chip"
                  disabled={optionsLoading || submitting}
                  onClick={() => setMaskedTimeField("endTime", time)}
                >
                  {time}
                </button>
              ))}
            </div>
          </label>

          <label className={`modal-field modal-field--optional ${isAutofilledField("breakTime") ? "is-autofilled" : ""}`}>
            <span className="modal-field-label">{tr("workReport:reportForm.fields.breakTime")}</span>
            <input
              type="number"
              min="0"
              step="0.1"
              value={formState.breakTime}
              disabled={optionsLoading || submitting}
              data-inline-editor-key="modal-breakTime"
              onChange={(event) =>
                setFormState((prev) => ({ ...prev, breakTime: event.target.value }))
              }
            />
          </label>

          <label className={`modal-field ${isPlannedIdleYes ? "modal-field--optional" : "modal-field--required"}`}>
            <span className="modal-field-label">{tr("workReport:reportForm.fields.productionQtyRequired")}</span>
            <input
              type="number"
              min="0"
              step="1"
              value={formState.productionQty}
              disabled={optionsLoading || submitting || isPlannedIdleYes}
              data-inline-editor-key="modal-productionQty"
              onChange={(event) =>
                setFormState((prev) => ({ ...prev, productionQty: event.target.value }))
              }
            />
            {predictedCumulative !== null && !isPlannedIdleYes && (
              <span className="modal-field-hint modal-field-hint--predicted" title="預估值（儲存後以 Ragic 計算為準）">
                預估依序累計量：<strong>{predictedCumulative}</strong>
                <span className="detail-cell-predicted-badge" aria-hidden="true">預估</span>
              </span>
            )}
          </label>

          <label className="modal-field modal-field--optional">
            <span className="modal-field-label">{tr("workReport:reportForm.fields.subProcess")}</span>
            <DetailInlinePickerTrigger
              value={selectedProcessOption?.value || formState.processCode}
              hint={
                selectedProcessOption?.display &&
                selectedProcessOption.display !== selectedProcessOption.value
                  ? selectedProcessOption.display
                  : null
              }
              blankLabel={tr("common:options.select")}
              editorKey="modal-processCode"
              disabled={optionsLoading || submitting}
              onOpen={() => {
                setProcessPickerOpen(true);
                setProcessPickerSearch("");
              }}
            />
          </label>

          <label className="modal-field modal-field--optional">
            <span className="modal-field-label modal-field-label--muted">
              {tr("workReport:reportForm.fields.reportTypeAutoFill")}
            </span>
            <SearchableSelect
              value={formState.reportType}
              options={reportTypeOptions}
              placeholder={tr("workReport:reportForm.placeholders.reportTypeAutoFill")}
              disabled={optionsLoading || submitting}
              labelMode="value-only"
              editorKey="modal-reportType"
              onChange={(value) => setFormState((prev) => ({ ...prev, reportType: value }))}
            />
          </label>

          <label className="modal-field modal-field--optional modal-field--full">
            <span className="modal-field-label modal-field-label--muted">
              {tr("workReport:reportForm.fields.remark")}
            </span>
            <textarea
              rows={2}
              value={formState.remark}
              disabled={optionsLoading || submitting}
              data-inline-editor-key="modal-remark"
              onChange={(event) =>
                setFormState((prev) => ({ ...prev, remark: event.target.value }))
              }
            />
          </label>

          <section className="modal-advanced-section">
            <div className="modal-advanced-toggle is-open">
              <span>{tr("workReport:reportForm.advanced.title")}</span>
            </div>

            <div className="modal-advanced-content">
              <ReportFormSetupSection
                formState={formState}
                setFormState={setFormState}
                setupAdjustTypeOptions={setupAdjustTypeOptions}
                countSetupTimeFlagOptions={countSetupTimeFlagOptions}
                containerUnitOptions={containerUnitOptions}
                disabled={optionsLoading || submitting}
              />

              <ReportFormReasonSection
                formState={formState}
                setFormState={setFormState}
                disabled={optionsLoading || submitting}
              />
            </div>
          </section>

          {optionsLoading ? (
            <p className="modal-loading">{tr("workReport:reportForm.loadingOptions")}</p>
          ) : null}
          <ReportFormFooter
            mode={mode}
            submitting={submitting}
            submitDisabled={submitDisabled}
            saveProgress={saveProgress}
            error={error}
            optionsLoading={optionsLoading}
            onClose={onClose}
            onClearForm={resetToEmptyForm}
          />
        </form>
      </div>

      {machinePickerOpen ? (
        <DetailLinkedPickerModal
          title={tr("workReport:detailPage.machinePickerTitle")}
          hint={tr("workReport:detailPage.machinePickerHint")}
          closeLabel={tr("common:actions.cancel")}
          currentSelectionLabel={tr("workReport:detailPage.pickerCurrentSelectionLabel")}
          currentSelectionOption={currentMachinePickerOption}
          topContent={
            <OperatorGroupFilter
              className="detail-picker-group-filter"
              label={tr("workReport:detailPage.machinePickerGroupLabel")}
              allLabel={tr("common:options.all")}
              selectedGroupKey={selectedMachineGroupKey || effectiveSelectedMachineGroupKey}
              options={machineGroupOptions}
              onChange={handleMachineGroupPreferenceChange}
            />
          }
          searchLabel={tr("workReport:detailPage.machinePickerSearchLabel")}
          searchPlaceholder={tr("workReport:detailPage.machinePickerSearchPlaceholder")}
          emptyText={tr("workReport:detailPage.machinePickerEmpty")}
          searchValue={machinePickerSearch}
          options={filteredMachinePickerOptions}
          selectedValue={formState.machineId}
          onSearchChange={setMachinePickerSearch}
          onSelect={handleMachineChange}
          onClose={() => {
            setMachinePickerOpen(false);
            setMachinePickerSearch("");
          }}
        />
      ) : null}

      {operatorPickerOpen ? (
        <DetailLinkedPickerModal
          title={tr("workReport:detailPage.operatorPickerTitle")}
          hint={tr("workReport:detailPage.operatorPickerHint")}
          closeLabel={tr("common:actions.cancel")}
          currentSelectionLabel={tr("workReport:detailPage.pickerCurrentSelectionLabel")}
          currentSelectionOption={currentOperatorPickerOption}
          topContent={
            <OperatorGroupFilter
              className="detail-picker-group-filter"
              label={tr("workReport:detailPage.operatorPickerGroupLabel")}
              allLabel={tr("common:options.all")}
              selectedGroupKey={selectedOperatorGroupKey}
              options={operatorGroupOptions}
              onChange={handleOperatorGroupChange}
            />
          }
          searchLabel={tr("workReport:detailPage.operatorPickerSearchLabel")}
          searchPlaceholder={tr("workReport:detailPage.operatorPickerSearchPlaceholder")}
          emptyText={tr("workReport:detailPage.operatorPickerEmpty")}
          searchValue={operatorPickerSearch}
          options={filteredOperatorPickerOptions}
          selectedValue={formState.operatorId}
          onSearchChange={setOperatorPickerSearch}
          onSelect={handleOperatorChange}
          onClose={() => {
            setOperatorPickerOpen(false);
            setOperatorPickerSearch("");
          }}
        />
      ) : null}

      {processPickerOpen ? (
        <DetailLinkedPickerModal
          title={tr("workReport:detailPage.processPickerTitle")}
          hint={tr("workReport:detailPage.processPickerHint")}
          closeLabel={tr("common:actions.cancel")}
          currentSelectionLabel={tr("workReport:detailPage.pickerCurrentSelectionLabel")}
          currentSelectionOption={currentProcessPickerOption}
          topContent={
            <OperatorGroupFilter
              className="detail-picker-group-filter"
              label={tr("workReport:detailPage.processPickerGroupLabel")}
              allLabel={tr("common:options.all")}
              selectedGroupKey={selectedProcessGroupKey || effectiveSelectedProcessGroupKey}
              options={processGroupOptions}
              onChange={handleProcessGroupPreferenceChange}
            />
          }
          searchLabel={tr("workReport:detailPage.processPickerSearchLabel")}
          searchPlaceholder={tr("workReport:detailPage.processPickerSearchPlaceholder")}
          emptyText={tr("workReport:detailPage.processPickerEmpty")}
          searchValue={processPickerSearch}
          options={filteredProcessPickerOptions}
          selectedValue={formState.processCode}
          onSearchChange={setProcessPickerSearch}
          onSelect={handleProcessChange}
          onClose={() => {
            setProcessPickerOpen(false);
            setProcessPickerSearch("");
          }}
        />
      ) : null}
    </div>
  );
}

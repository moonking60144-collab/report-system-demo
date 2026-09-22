import { memo, useCallback, useMemo, useState } from "react";
import {
  DeleteOutlined,
  PlusOutlined,
  SaveOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { Input, Modal, Select } from "antd";
import { useTranslation } from "react-i18next";
import {
  WORK_REPORT_MAX_FILTER_CONDITIONS,
  WORK_REPORT_MAX_FILTER_VALUES,
  WORK_REPORT_MAX_SAVED_FILTERS,
  WORK_REPORT_MAX_SAVED_FILTER_NAME_LENGTH,
} from "../constants";
import {
  deleteWorkReportFilterPreset,
  readSavedWorkReportFilters,
  saveWorkReportFilterPreset,
} from "../savedFilterPresetStore";
import type {
  ColumnSortRule,
  SavedWorkReportFilterPreset,
  WorkReportFilterCondition,
  WorkReportFilterField,
  WorkReportFilterGroup,
  WorkReportFilterOperator,
  WorkReportFormId,
  WorkReportLandingPageKey,
} from "../types";
import {
  createWorkReportFilterCondition,
  getWorkReportFilterFields,
  getWorkReportFilterOperators,
  isSameWorkReportFilterGroup,
  isWorkReportFilterConditionComplete,
} from "../utils";

interface SelectOption {
  value: string;
  label: string;
  display: string;
}

interface ActiveFilterChip {
  key: string;
  label: string;
  removable?: boolean;
  removeActionKey?: string;
}

export interface WorkReportFilterPanelProps {
  currentFormId: WorkReportFormId;
  activeLandingPageKey: WorkReportLandingPageKey;
  filterGroup: WorkReportFilterGroup;
  onFilterGroupChange: (group: WorkReportFilterGroup) => void;
  machineFilterOptions: SelectOption[];
  statusFilterOptions: SelectOption[];
  siteRunningFilterOptions: SelectOption[];
  columnSortRules: ColumnSortRule[];
  filterControlDisabled: boolean;
  activeFilterChips: ActiveFilterChip[];
  columnFilterCount: number;
  machineColumnFilterTokens: readonly string[];
  hasPendingChanges: boolean;
  onRemoveActiveFilterChip: (actionKey: string) => void;
  onClearMachineColumnFilter: () => void;
  onApplyFilters: () => void;
  onClearFilters: () => void;
  onApplySavedFilter: (filterGroup: WorkReportFilterGroup, sortRules: ColumnSortRule[]) => void;
}

function cloneGroup(group: WorkReportFilterGroup): WorkReportFilterGroup {
  return {
    joinMode: group.joinMode,
    conditions: group.conditions.map((condition) => ({
      ...condition,
      values: [...condition.values],
    })),
  };
}

export const WorkReportFilterPanel = memo(function WorkReportFilterPanel({
  currentFormId,
  activeLandingPageKey,
  filterGroup,
  onFilterGroupChange,
  machineFilterOptions,
  statusFilterOptions,
  siteRunningFilterOptions,
  columnSortRules,
  filterControlDisabled,
  activeFilterChips,
  columnFilterCount,
  machineColumnFilterTokens,
  hasPendingChanges,
  onRemoveActiveFilterChip,
  onClearMachineColumnFilter,
  onApplyFilters,
  onClearFilters,
  onApplySavedFilter,
}: WorkReportFilterPanelProps) {
  const { t, i18n } = useTranslation(["workReport", "common"]);
  const [savedFilters, setSavedFilters] = useState<SavedWorkReportFilterPreset[]>(() =>
    readSavedWorkReportFilters(currentFormId, activeLandingPageKey)
  );
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [savedFilterName, setSavedFilterName] = useState("");
  const remainingColumnFilterCount = Math.max(
    0,
    columnFilterCount - (machineColumnFilterTokens.length > 0 ? 1 : 0)
  );

  const reloadSavedFilters = useCallback(() => {
    setSavedFilters(readSavedWorkReportFilters(currentFormId, activeLandingPageKey));
  }, [activeLandingPageKey, currentFormId]);

  const fieldOptions = useMemo(
    () =>
      getWorkReportFilterFields(currentFormId).map((field) => ({
        value: field,
        label: t(`workReport:filters.builder.fields.${field}`),
      })),
    [currentFormId, t]
  );

  const machineOptions = useMemo(
    () =>
      machineFilterOptions
        .filter((option) => option.value !== "__all__")
        .map((option) => ({ value: option.value, label: option.label })),
    [machineFilterOptions]
  );
  const statusOptions = useMemo(
    () =>
      statusFilterOptions
        .filter((option) => option.value !== "__all__")
        .map((option) => ({ value: option.value, label: option.label })),
    [statusFilterOptions]
  );
  const booleanOptions = useMemo(
    () =>
      siteRunningFilterOptions
        .filter((option) => option.value === "yes" || option.value === "no")
        .map((option) => ({ value: option.value, label: option.label })),
    [siteRunningFilterOptions]
  );

  const updateCondition = useCallback(
    (id: string, patch: Partial<WorkReportFilterCondition>) => {
      onFilterGroupChange({
        ...filterGroup,
        conditions: filterGroup.conditions.map((condition) =>
          condition.id === id ? { ...condition, ...patch } : condition
        ),
      });
    },
    [filterGroup, onFilterGroupChange]
  );

  const handleFieldChange = useCallback(
    (condition: WorkReportFilterCondition, field: WorkReportFilterField) => {
      updateCondition(condition.id, {
        field,
        operator: getWorkReportFilterOperators(field)[0],
        values: [],
      });
    },
    [updateCondition]
  );

  const handleOperatorChange = useCallback(
    (condition: WorkReportFilterCondition, operator: WorkReportFilterOperator) => {
      updateCondition(condition.id, {
        operator,
        values: operator === "isEmpty" || operator === "isNotEmpty" ? [] : condition.values,
      });
    },
    [updateCondition]
  );

  const addCondition = useCallback(() => {
    if (filterGroup.conditions.length >= WORK_REPORT_MAX_FILTER_CONDITIONS) {
      return;
    }
    onFilterGroupChange({
      ...filterGroup,
      conditions: [...filterGroup.conditions, createWorkReportFilterCondition("machineCode")],
    });
  }, [filterGroup, onFilterGroupChange]);

  const removeCondition = useCallback(
    (id: string) => {
      onFilterGroupChange({
        ...filterGroup,
        conditions: filterGroup.conditions.filter((condition) => condition.id !== id),
      });
    },
    [filterGroup, onFilterGroupChange]
  );

  const conditionsAreComplete = filterGroup.conditions.every(isWorkReportFilterConditionComplete);
  const canApply = conditionsAreComplete && !filterControlDisabled;
  const canSave =
    canApply &&
    filterGroup.conditions.length > 0 &&
    savedFilters.length < WORK_REPORT_MAX_SAVED_FILTERS;

  const getMultiOptions = (field: WorkReportFilterField) => {
    if (field === "machineCode") {
      return machineOptions;
    }
    if (field === "status") {
      return statusOptions;
    }
    return booleanOptions;
  };

  const renderConditionValue = (condition: WorkReportFilterCondition) => {
    if (condition.operator === "isEmpty" || condition.operator === "isNotEmpty") {
      return (
        <div className="custom-filter-valueless">
          {t("workReport:filters.builder.noValueNeeded")}
        </div>
      );
    }

    if (
      condition.field === "machineCode" ||
      condition.field === "status" ||
      condition.field === "siteRunning" ||
      condition.field === "startSchedule"
    ) {
      return (
        <div className="custom-filter-multi-value">
          <Select
            mode="multiple"
            showSearch
            maxTagCount="responsive"
            value={condition.values}
            options={getMultiOptions(condition.field)}
            placeholder={t("workReport:filters.builder.chooseValues")}
            disabled={filterControlDisabled}
            optionFilterProp="label"
            onChange={(values) =>
              updateCondition(condition.id, {
                values: values.slice(0, WORK_REPORT_MAX_FILTER_VALUES),
              })
            }
          />
          <span className="custom-filter-value-cap">
            {condition.values.length} / {WORK_REPORT_MAX_FILTER_VALUES}
          </span>
        </div>
      );
    }

    if (condition.field === "lastUpdatedAt") {
      const isBetween = condition.operator === "between";
      return (
        <div className={`custom-filter-date-value ${isBetween ? "is-range" : ""}`}>
          <input
            type="date"
            value={condition.values[0] ?? ""}
            max={isBetween ? condition.values[1] || undefined : undefined}
            disabled={filterControlDisabled}
            aria-label={t("workReport:filters.builder.dateStart")}
            onChange={(event) =>
              updateCondition(condition.id, {
                values: [event.target.value, ...(isBetween ? [condition.values[1] ?? ""] : [])],
              })
            }
          />
          {isBetween ? (
            <>
              <span>{t("workReport:filters.builder.to")}</span>
              <input
                type="date"
                value={condition.values[1] ?? ""}
                min={condition.values[0] || undefined}
                disabled={filterControlDisabled}
                aria-label={t("workReport:filters.builder.dateEnd")}
                onChange={(event) =>
                  updateCondition(condition.id, {
                    values: [condition.values[0] ?? "", event.target.value],
                  })
                }
              />
            </>
          ) : null}
        </div>
      );
    }

    return (
      <Input
        value={condition.values[0] ?? ""}
        maxLength={120}
        disabled={filterControlDisabled}
        placeholder={t("workReport:filters.builder.enterValue")}
        onChange={(event) => updateCondition(condition.id, { values: [event.target.value] })}
        onPressEnter={() => {
          if (canApply) {
            onApplyFilters();
          }
        }}
      />
    );
  };

  const describeCondition = (condition: WorkReportFilterCondition): string => {
    const fieldLabel = t(`workReport:filters.builder.fields.${condition.field}`);
    const operatorLabel = t(`workReport:filters.builder.operators.${condition.operator}`);
    const valueLabel = condition.values.join("、");
    return valueLabel ? `${fieldLabel} ${operatorLabel} ${valueLabel}` : `${fieldLabel} ${operatorLabel}`;
  };

  const handleSave = () => {
    const name = savedFilterName.trim();
    if (!name) {
      return;
    }
    const saved = saveWorkReportFilterPreset({
      name,
      formId: currentFormId,
      landingPageKey: activeLandingPageKey,
      filterGroup,
      sortRules: columnSortRules,
    });
    if (!saved) {
      Modal.error({
        title: t("workReport:filters.saved.storageErrorTitle"),
        content: t("workReport:filters.saved.storageErrorMessage"),
        okText: t("common:actions.ok"),
        centered: true,
      });
      return;
    }
    setSavedFilterName("");
    setSaveModalOpen(false);
    reloadSavedFilters();
  };

  const handleDeleteSavedFilter = (preset: SavedWorkReportFilterPreset) => {
    Modal.confirm({
      title: t("workReport:filters.saved.deleteTitle"),
      content: t("workReport:filters.saved.deleteMessage", { name: preset.name }),
      okText: t("common:actions.delete"),
      cancelText: t("common:actions.cancel"),
      okButtonProps: { danger: true },
      centered: true,
      onOk: () => {
        if (!deleteWorkReportFilterPreset(preset.id)) {
          Modal.error({
            title: t("workReport:filters.saved.storageErrorTitle"),
            content: t("workReport:filters.saved.storageErrorMessage"),
            okText: t("common:actions.ok"),
            centered: true,
          });
        }
        reloadSavedFilters();
      },
    });
  };

  const formatUpdatedAt = (value: string) =>
    new Intl.DateTimeFormat(i18n.resolvedLanguage ?? i18n.language, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));

  return (
    <section
      id="work-report-filter-panel"
      className={`work-report-filter-panel custom-filter-panel ${hasPendingChanges ? "has-pending-changes" : ""}`}
      aria-label={t("workReport:filters.panelLabel")}
    >
      <div className="work-report-filter-panel-heading custom-filter-heading">
        <div>
          <strong>{t("workReport:filters.builder.title")}</strong>
          <span>{t("workReport:filters.builder.subtitle")}</span>
        </div>
        {hasPendingChanges ? (
          <span className="filter-pending-state" role="status" aria-live="polite">
            {t("workReport:filters.pendingChanges")}
          </span>
        ) : null}
      </div>

      <div className="custom-filter-layout">
        <div className="custom-filter-builder">
          <div className="custom-filter-builder-tools">
            <div className="custom-filter-logic-control">
              <span>{t("workReport:filters.builder.matchLabel")}</span>
              <div className="custom-filter-segmented" role="group" aria-label={t("workReport:filters.builder.matchLabel")}>
                {(["all", "any"] as const).map((joinMode) => (
                  <button
                    type="button"
                    key={joinMode}
                    className={filterGroup.joinMode === joinMode ? "is-active" : ""}
                    aria-pressed={filterGroup.joinMode === joinMode}
                    disabled={filterControlDisabled}
                    onClick={() => onFilterGroupChange({ ...filterGroup, joinMode })}
                  >
                    {t(`workReport:filters.builder.joinModes.${joinMode}`)}
                  </button>
                ))}
              </div>
            </div>
            <span className="custom-filter-condition-cap">
              {filterGroup.conditions.length} / {WORK_REPORT_MAX_FILTER_CONDITIONS}
            </span>
          </div>

          <div className="custom-filter-condition-list">
            {filterGroup.conditions.map((condition, index) => (
              <article
                key={condition.id}
                className={`custom-filter-condition-row ${
                  isWorkReportFilterConditionComplete(condition) ? "" : "is-incomplete"
                }`}
              >
                <span className="custom-filter-condition-index">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <Select
                  className="custom-filter-field-select"
                  value={condition.field}
                  options={fieldOptions}
                  disabled={filterControlDisabled}
                  aria-label={t("workReport:filters.builder.fieldLabel", { index: index + 1 })}
                  onChange={(field) => handleFieldChange(condition, field)}
                />
                <Select
                  className="custom-filter-operator-select"
                  value={condition.operator}
                  options={getWorkReportFilterOperators(condition.field).map((operator) => ({
                    value: operator,
                    label: t(`workReport:filters.builder.operators.${operator}`),
                  }))}
                  disabled={filterControlDisabled}
                  aria-label={t("workReport:filters.builder.operatorLabel", { index: index + 1 })}
                  onChange={(operator) => handleOperatorChange(condition, operator)}
                />
                <div className="custom-filter-value-control">{renderConditionValue(condition)}</div>
                <button
                  type="button"
                  className="custom-filter-remove-condition"
                  disabled={filterControlDisabled}
                  aria-label={t("workReport:filters.builder.removeCondition", { index: index + 1 })}
                  title={t("workReport:filters.builder.removeCondition", { index: index + 1 })}
                  onClick={() => removeCondition(condition.id)}
                >
                  <DeleteOutlined aria-hidden="true" />
                </button>
              </article>
            ))}
          </div>

          {filterGroup.conditions.length === 0 ? (
            <div className="custom-filter-empty-state">
              <strong>{t("workReport:filters.builder.emptyTitle")}</strong>
              <span>{t("workReport:filters.builder.emptyHint")}</span>
            </div>
          ) : null}

          {!conditionsAreComplete ? (
            <p className="filter-validation-message" role="alert">
              {t("workReport:filters.builder.incompleteCondition")}
            </p>
          ) : null}

          <div className="custom-filter-condition-actions">
            <button
              type="button"
              className="toolbar-btn custom-filter-add-condition"
              disabled={
                filterControlDisabled ||
                filterGroup.conditions.length >= WORK_REPORT_MAX_FILTER_CONDITIONS
              }
              onClick={addCondition}
            >
              <PlusOutlined aria-hidden="true" />
              {t("workReport:filters.builder.addCondition")}
            </button>
            <span>{t(`workReport:filters.builder.explanation.${filterGroup.joinMode}`)}</span>
          </div>
        </div>

        <aside className="custom-filter-saved-panel" aria-label={t("workReport:filters.saved.title")}>
          <div className="custom-filter-saved-heading">
            <strong>{t("workReport:filters.saved.title")}</strong>
            <span>{savedFilters.length} / {WORK_REPORT_MAX_SAVED_FILTERS}</span>
          </div>
          <div className="custom-filter-saved-list">
            {savedFilters.map((preset) => {
              const isActive =
                isSameWorkReportFilterGroup(filterGroup, preset.filterGroup) &&
                JSON.stringify(columnSortRules) === JSON.stringify(preset.sortRules);
              return (
                <article key={preset.id} className={`custom-filter-saved-item ${isActive ? "is-active" : ""}`}>
                  <div className="custom-filter-saved-copy">
                    <strong title={preset.name}>{preset.name}</strong>
                    <span>
                      {t("workReport:filters.saved.meta", {
                        count: preset.filterGroup.conditions.length,
                        time: formatUpdatedAt(preset.updatedAt),
                      })}
                    </span>
                  </div>
                  <div className="custom-filter-saved-actions">
                    <button
                      type="button"
                      disabled={filterControlDisabled}
                      onClick={() => {
                        onFilterGroupChange(cloneGroup(preset.filterGroup));
                        onApplySavedFilter(preset.filterGroup, preset.sortRules);
                      }}
                    >
                      {t("workReport:filters.saved.apply")}
                    </button>
                    <button
                      type="button"
                      className="is-danger"
                      aria-label={t("workReport:filters.saved.deleteNamed", { name: preset.name })}
                      disabled={filterControlDisabled}
                      onClick={() => handleDeleteSavedFilter(preset)}
                    >
                      <DeleteOutlined aria-hidden="true" />
                    </button>
                  </div>
                </article>
              );
            })}
            {savedFilters.length === 0 ? (
              <div className="custom-filter-saved-empty">
                {t("workReport:filters.saved.empty")}
              </div>
            ) : null}
          </div>
          <p className="custom-filter-storage-note">
            <strong>{t("workReport:filters.saved.deviceOnlyTitle")}</strong>
            {t("workReport:filters.saved.deviceOnlyHint")}
          </p>
        </aside>
      </div>

      <div className="work-report-filter-panel-footer custom-filter-footer">
        <div className="filter-active-summary" role="status" aria-live="polite">
          <span className="filter-active-summary-label">
            {t("workReport:sidebar.currentFilter")}
          </span>
          <div className="filter-active-chip-list">
            {filterGroup.conditions.map((condition) => (
              <span key={condition.id} className="filter-active-chip">
                <span className="filter-active-chip-text">{describeCondition(condition)}</span>
              </span>
            ))}
            {activeFilterChips.map((chip) => (
              <span key={chip.key} className="filter-active-chip">
                <span className="filter-active-chip-text">{chip.label}</span>
                {chip.removable && chip.removeActionKey ? (
                  <button
                    type="button"
                    className="filter-active-chip-remove"
                    onClick={() => onRemoveActiveFilterChip(chip.removeActionKey!)}
                    aria-label={`${t("common:actions.clearFilters")} ${chip.label}`}
                  >
                    ×
                  </button>
                ) : null}
              </span>
            ))}
            {machineColumnFilterTokens.length > 0 ? (
              <span className="filter-active-chip">
                <span className="filter-active-chip-text">
                  {t("workReport:filters.machine")}｜{machineColumnFilterTokens.join("、")}
                </span>
                <button
                  type="button"
                  className="filter-active-chip-remove"
                  onClick={onClearMachineColumnFilter}
                  aria-label={`${t("common:actions.clearFilters")} ${t(
                    "workReport:filters.machine"
                  )}`}
                  title={t("common:actions.clearFilters")}
                >
                  ×
                </button>
              </span>
            ) : null}
            {remainingColumnFilterCount > 0 ? (
              <span className="filter-active-chip">
                {t("workReport:filters.columnFilterCount", { count: remainingColumnFilterCount })}
              </span>
            ) : null}
            {filterGroup.conditions.length === 0 && activeFilterChips.length === 0 && columnFilterCount === 0 ? (
              <span className="filter-empty-summary">{t("workReport:filters.noAppliedFilters")}</span>
            ) : null}
          </div>
        </div>

        <div className="work-report-filter-panel-actions custom-filter-footer-actions">
          <button
            type="button"
            className="toolbar-btn toolbar-btn--secondary"
            onClick={onClearFilters}
            disabled={filterControlDisabled}
          >
            {t("common:actions.clearFilters")}
          </button>
          <button
            type="button"
            className="toolbar-btn custom-filter-save-button"
            onClick={() => setSaveModalOpen(true)}
            disabled={!canSave}
            title={
              savedFilters.length >= WORK_REPORT_MAX_SAVED_FILTERS
                ? t("workReport:filters.saved.limitReached")
                : undefined
            }
          >
            <SaveOutlined aria-hidden="true" />
            {t("workReport:filters.saved.save")}
          </button>
          <button
            type="button"
            className="toolbar-btn toolbar-btn--primary"
            onClick={onApplyFilters}
            disabled={!canApply}
          >
            <SearchOutlined aria-hidden="true" />
            <span>{t("common:actions.applyFilters")}</span>
          </button>
        </div>
      </div>

      <Modal
        title={t("workReport:filters.saved.modalTitle")}
        open={saveModalOpen}
        centered
        okText={t("workReport:filters.saved.save")}
        cancelText={t("common:actions.cancel")}
        okButtonProps={{ disabled: savedFilterName.trim().length === 0 }}
        onOk={handleSave}
        onCancel={() => {
          setSaveModalOpen(false);
          setSavedFilterName("");
        }}
      >
        <label className="custom-filter-save-name">
          <span>{t("workReport:filters.saved.nameLabel")}</span>
          <Input
            autoFocus
            value={savedFilterName}
            maxLength={WORK_REPORT_MAX_SAVED_FILTER_NAME_LENGTH}
            showCount
            placeholder={t("workReport:filters.saved.namePlaceholder")}
            onChange={(event) => setSavedFilterName(event.target.value)}
            onPressEnter={() => {
              if (savedFilterName.trim()) {
                handleSave();
              }
            }}
          />
        </label>
      </Modal>
    </section>
  );
});

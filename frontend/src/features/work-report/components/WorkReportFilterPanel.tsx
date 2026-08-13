import { memo, type Dispatch, type SetStateAction } from "react";
import { SearchOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { SearchableSelect } from "../../../components/SearchableSelect";
import { ALL_FILTER_VALUE } from "../constants";
import type { GlobalFilters, WorkReportFormId } from "../types";
import { isValidUpdatedDateRange } from "../utils";

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

interface WorkReportFilterPanelProps {
  currentFormId: WorkReportFormId;
  globalFilterDraft: GlobalFilters;
  setGlobalFilterDraft: Dispatch<SetStateAction<GlobalFilters>>;
  machineFilterOptions: SelectOption[];
  statusFilterOptions: SelectOption[];
  siteRunningFilterOptions: SelectOption[];
  filterControlDisabled: boolean;
  activeFilterChips: ActiveFilterChip[];
  columnFilterCount: number;
  hasPendingChanges: boolean;
  onRemoveActiveFilterChip: (actionKey: string) => void;
  onApplyFilters: () => void;
  onClearFilters: () => void;
}

export const WorkReportFilterPanel = memo(function WorkReportFilterPanel({
  currentFormId,
  globalFilterDraft,
  setGlobalFilterDraft,
  machineFilterOptions,
  statusFilterOptions,
  siteRunningFilterOptions,
  filterControlDisabled,
  activeFilterChips,
  columnFilterCount,
  hasPendingChanges,
  onRemoveActiveFilterChip,
  onApplyFilters,
  onClearFilters,
}: WorkReportFilterPanelProps) {
  const { t } = useTranslation(["workReport", "common"]);
  const hasValidUpdatedDateRange = isValidUpdatedDateRange(globalFilterDraft);
  const machineFilterValue =
    currentFormId === "105"
      ? globalFilterDraft.filterMachineCode
      : globalFilterDraft.machineCode;
  const hasAppliedFilterSummary = activeFilterChips.length > 0 || columnFilterCount > 0;

  return (
    <section
      id="work-report-filter-panel"
      className={`work-report-filter-panel ${hasPendingChanges ? "has-pending-changes" : ""}`}
      aria-label={t("workReport:filters.panelLabel")}
    >
      <div className="work-report-filter-panel-heading">
        <div>
          <strong>{t("workReport:filters.preciseConditions")}</strong>
          <span>{t("workReport:filters.matchingHint")}</span>
        </div>
        {hasPendingChanges ? (
          <span className="filter-pending-state" role="status" aria-live="polite">
            {t("workReport:filters.pendingChanges")}
          </span>
        ) : null}
      </div>

      <div className="filter-advanced-panel">
        <div className="filter-card-grid">
          <label className="filter-field" data-filter-key="workOrderKeyword">
            <span>{t("workReport:filters.workOrderNo")}</span>
            <div className="filter-search-control">
              <SearchOutlined aria-hidden="true" />
              <input
                value={globalFilterDraft.workOrderKeyword}
                placeholder={t("workReport:filters.placeholderWorkOrderNo")}
                disabled={filterControlDisabled}
                onChange={(event) =>
                  setGlobalFilterDraft((previous) => ({
                    ...previous,
                    workOrderKeyword: event.target.value,
                  }))
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    onApplyFilters();
                  }
                }}
              />
            </div>
          </label>

          <label className="filter-field" data-filter-key="customerPartKeyword">
            <span>{t("workReport:filters.customerPartNo")}</span>
            <div className="filter-search-control">
              <SearchOutlined aria-hidden="true" />
              <input
                value={globalFilterDraft.customerPartKeyword}
                placeholder={t("workReport:filters.placeholderCustomerPartNo")}
                disabled={filterControlDisabled}
                onChange={(event) =>
                  setGlobalFilterDraft((previous) => ({
                    ...previous,
                    customerPartKeyword: event.target.value,
                  }))
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    onApplyFilters();
                  }
                }}
              />
            </div>
          </label>

          <label className="filter-field" data-filter-key="machineCode">
            <span>{t("workReport:filters.machine")}</span>
            <SearchableSelect
              value={machineFilterValue}
              options={machineFilterOptions}
              disabled={filterControlDisabled}
              labelMode="value-display"
              clearable={false}
              onChange={(value) =>
                setGlobalFilterDraft((previous) => ({
                  ...previous,
                  machineCode:
                    currentFormId === "104" ? value || ALL_FILTER_VALUE : ALL_FILTER_VALUE,
                  filterMachineCode:
                    currentFormId === "105" ? value || ALL_FILTER_VALUE : ALL_FILTER_VALUE,
                }))
              }
            />
          </label>

          <label className="filter-field" data-filter-key="status">
            <span>{t("workReport:filters.workOrderStatus")}</span>
            <SearchableSelect
              value={globalFilterDraft.status}
              options={statusFilterOptions}
              disabled={filterControlDisabled}
              labelMode="value-display"
              clearable={false}
              onChange={(value) =>
                setGlobalFilterDraft((previous) => ({
                  ...previous,
                  status: value || ALL_FILTER_VALUE,
                }))
              }
            />
          </label>

          <label className="filter-field" data-filter-key="siteRunning">
            <span>{t("workReport:filters.siteRunning")}</span>
            <SearchableSelect
              value={globalFilterDraft.siteRunning}
              options={siteRunningFilterOptions}
              disabled={filterControlDisabled}
              labelMode="value-display"
              searchable={false}
              clearable={false}
              onChange={(value) =>
                setGlobalFilterDraft((previous) => ({
                  ...previous,
                  siteRunning: value === "yes" || value === "no" ? value : "all",
                }))
              }
            />
          </label>

          <label className="filter-field" data-filter-key="startSchedule">
            <span>{t("workReport:filters.startSchedule")}</span>
            <SearchableSelect
              value={globalFilterDraft.startSchedule}
              options={siteRunningFilterOptions}
              disabled={filterControlDisabled}
              labelMode="value-display"
              searchable={false}
              clearable={false}
              onChange={(value) =>
                setGlobalFilterDraft((previous) => ({
                  ...previous,
                  startSchedule: value === "yes" || value === "no" ? value : "all",
                }))
              }
            />
          </label>

          <label className="filter-field" data-filter-key="updatedDateFrom">
            <span>{t("workReport:filters.updatedDateFrom")}</span>
            <input
              className="filter-date-input"
              type="date"
              value={globalFilterDraft.updatedDateFrom}
              max={globalFilterDraft.updatedDateTo || undefined}
              disabled={filterControlDisabled}
              aria-invalid={!hasValidUpdatedDateRange}
              onChange={(event) =>
                setGlobalFilterDraft((previous) => ({
                  ...previous,
                  updatedDateFrom: event.target.value,
                }))
              }
            />
          </label>

          <label className="filter-field" data-filter-key="updatedDateTo">
            <span>{t("workReport:filters.updatedDateTo")}</span>
            <input
              className="filter-date-input"
              type="date"
              value={globalFilterDraft.updatedDateTo}
              min={globalFilterDraft.updatedDateFrom || undefined}
              disabled={filterControlDisabled}
              aria-invalid={!hasValidUpdatedDateRange}
              onChange={(event) =>
                setGlobalFilterDraft((previous) => ({
                  ...previous,
                  updatedDateTo: event.target.value,
                }))
              }
            />
          </label>
        </div>
        {!hasValidUpdatedDateRange ? (
          <p className="filter-validation-message" role="alert">
            {t("workReport:filters.invalidUpdatedDateRange")}
          </p>
        ) : null}
      </div>

      <div className="work-report-filter-panel-footer">
        {hasAppliedFilterSummary ? (
          <div className="filter-active-summary" role="status" aria-live="polite">
            <span className="filter-active-summary-label">
              {t("workReport:sidebar.currentFilter")}
            </span>
            <div className="filter-active-chip-list">
              {activeFilterChips.map((chip) => (
                <span key={chip.key} className="filter-active-chip">
                  <span className="filter-active-chip-text">{chip.label}</span>
                  {chip.removable && chip.removeActionKey ? (
                    <button
                      type="button"
                      className="filter-active-chip-remove"
                      onClick={() => onRemoveActiveFilterChip(chip.removeActionKey!)}
                      aria-label={`${t("common:actions.clearFilters")} ${chip.label}`}
                      title={t("common:actions.clearFilters")}
                    >
                      ×
                    </button>
                  ) : null}
                </span>
              ))}
              {columnFilterCount > 0 ? (
                <span className="filter-active-chip">
                  <span className="filter-active-chip-text">
                    {t("workReport:filters.columnFilterCount", { count: columnFilterCount })}
                  </span>
                </span>
              ) : null}
            </div>
          </div>
        ) : (
          <span className="filter-empty-summary">{t("workReport:filters.noAppliedFilters")}</span>
        )}

        <div className="work-report-filter-panel-actions">
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
            className="toolbar-btn toolbar-btn--primary"
            onClick={onApplyFilters}
            disabled={filterControlDisabled || !hasValidUpdatedDateRange}
          >
            <SearchOutlined aria-hidden="true" />
            <span>{t("common:actions.applyFilters")}</span>
          </button>
        </div>
      </div>
    </section>
  );
});

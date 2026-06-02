import { memo, useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { ExclamationCircleOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { Modal, Popover } from "antd";
import { SearchableSelect } from "../../../components/SearchableSelect";
import { ALL_FILTER_VALUE } from "../constants";
import type {
  ColumnDisplayMode,
  ColumnKey,
  GlobalFilters,
  UiLanguage,
  WorkReportLandingPageKey,
  WorkReportTopView,
} from "../types";
import { SystemNoticePanel } from "./SystemNoticePanel";
import type { NoticeState } from "../types";
import type { WorkReportSelectableColumnMeta } from "../hooks/workReportColumnDefinitions";

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

interface WorkReportToolbarProps {
  uiLanguage: UiLanguage;
  setUiLanguage: (language: UiLanguage) => void;
  activeTopView: WorkReportTopView;
  activeLandingPageKey: WorkReportLandingPageKey;
  currentPageGroupLabel: string;
  onOpenLandingPage: (key: WorkReportLandingPageKey) => void;
  onOpenDowntimePage?: () => void;
  onOpenTechnicalInfoView: () => void;
  onOpenLocalSettingsView: () => void;
  showMobileFilterButton?: boolean;
  onOpenMobileFilters?: () => void;
  globalFilterDraft: GlobalFilters;
  setGlobalFilterDraft: Dispatch<SetStateAction<GlobalFilters>>;
  statusFilterOptions: SelectOption[];
  siteRunningFilterOptions: SelectOption[];
  pageSizeOptions: SelectOption[];
  columnDisplayMode: ColumnDisplayMode;
  setColumnDisplayMode: (mode: ColumnDisplayMode) => void;
  columnSettingsOpen: boolean;
  setColumnSettingsOpen: (open: boolean) => void;
  selectableColumns: WorkReportSelectableColumnMeta[];
  hiddenColumnKeys: Set<ColumnKey>;
  onToggleColumnVisibility: (columnKey: ColumnKey) => void;
  onShowAllColumns: () => void;
  onResetDefaultColumns: () => void;
  pageSize: number;
  setPageSize: (nextPageSize: number | ((prev: number) => number)) => void;
  setPage: (nextPage: number | ((prev: number) => number)) => void;
  filterControlDisabled: boolean;
  loading: boolean;
  submitting: boolean;
  isHydratingAllRecords: boolean;
  isSyncingFromRagic?: boolean;
  activeFilterChips?: ActiveFilterChip[];
  onRemoveActiveFilterChip?: (actionKey: string) => void;
  onApplyFilters: () => void;
  onClearFilters: () => void;
  onRefresh: () => void | Promise<void>;
  onSystemNoticeForceRefresh?: (forceRefreshToken: string) => void | Promise<void>;
  systemNoticeForceReloadToken?: string;
  systemStatusNotice?: NoticeState | null;
}

export const WorkReportToolbar = memo(function WorkReportToolbar({
  uiLanguage,
  setUiLanguage,
  activeTopView,
  activeLandingPageKey,
  currentPageGroupLabel,
  onOpenLandingPage,
  onOpenDowntimePage,
  onOpenTechnicalInfoView,
  onOpenLocalSettingsView,
  showMobileFilterButton = false,
  onOpenMobileFilters,
  globalFilterDraft,
  setGlobalFilterDraft,
  statusFilterOptions,
  siteRunningFilterOptions,
  pageSizeOptions,
  columnDisplayMode,
  setColumnDisplayMode,
  columnSettingsOpen,
  setColumnSettingsOpen,
  selectableColumns,
  hiddenColumnKeys,
  onToggleColumnVisibility,
  onShowAllColumns,
  onResetDefaultColumns,
  pageSize,
  setPageSize,
  setPage,
  filterControlDisabled,
  loading,
  submitting,
  isHydratingAllRecords,
  isSyncingFromRagic = false,
  activeFilterChips = [],
  onRemoveActiveFilterChip,
  onApplyFilters,
  onClearFilters,
  onRefresh,
  onSystemNoticeForceRefresh,
  systemNoticeForceReloadToken,
  systemStatusNotice,
}: WorkReportToolbarProps) {
  const { t } = useTranslation(["workReport", "common"]);
  const handleConfirmRefresh = useCallback(() => {
    Modal.confirm({
      title: t("workReport:toolbar.refreshConfirm.title"),
      icon: <ExclamationCircleOutlined />,
      content: (
        <div>
          <p>{t("workReport:toolbar.refreshConfirm.message")}</p>
          <p>{t("workReport:toolbar.refreshConfirm.detail")}</p>
        </div>
      ),
      okText: t("workReport:toolbar.refreshConfirm.confirm"),
      cancelText: t("workReport:toolbar.refreshConfirm.cancel"),
      centered: true,
      onOk: () => {
        void onRefresh();
      },
    });
  }, [onRefresh, t]);

  return (
    <header className="page-header">
      <div className="toolbar-layer toolbar-layer--title">
        <div className="toolbar-layer-main-row">
          <div className="page-title-block">
            <h1>{t("workReport:page.title")}</h1>
            <div className="page-group-pill">{currentPageGroupLabel}</div>
            <div className="page-view-switch" role="tablist" aria-label={t("workReport:page.viewSwitchAria")}>
              <button
                type="button"
                role="tab"
                aria-selected={activeTopView === "report" && activeLandingPageKey === "thread-rolling-104"}
                className={`page-view-chip ${
                  activeTopView === "report" && activeLandingPageKey === "thread-rolling-104" ? "is-active" : ""
                }`}
                onClick={() => onOpenLandingPage("thread-rolling-104")}
              >
                {t("workReport:page.views.threadRolling104")}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTopView === "report" && activeLandingPageKey === "heading-105"}
                className={`page-view-chip ${
                  activeTopView === "report" && activeLandingPageKey === "heading-105" ? "is-active" : ""
                }`}
                onClick={() => onOpenLandingPage("heading-105")}
              >
                {t("workReport:page.views.heading105")}
              </button>
              {onOpenDowntimePage ? (
                <button
                  type="button"
                  role="tab"
                  aria-selected={false}
                  className="page-view-chip"
                  onClick={onOpenDowntimePage}
                >
                  {t("workReport:page.views.downtime16")}
                </button>
              ) : null}
              <button
                type="button"
                role="tab"
                aria-selected={activeTopView === "local-settings"}
                className={`page-view-chip ${activeTopView === "local-settings" ? "is-active" : ""}`}
                onClick={onOpenLocalSettingsView}
              >
                {t("workReport:page.views.localSettings")}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTopView === "technical-info"}
                className={`page-view-chip ${activeTopView === "technical-info" ? "is-active" : ""}`}
                onClick={onOpenTechnicalInfoView}
              >
                {t("workReport:page.views.technicalInfo")}
              </button>
            </div>
          </div>

          <div className="toolbar-title-side">
            <div className="toolbar-title-actions">
              {showMobileFilterButton && (
                <button
                  type="button"
                  className="toolbar-btn toolbar-btn--secondary toolbar-mobile-sidebar-btn"
                  onClick={() => onOpenMobileFilters?.()}
                >
                  {t("workReport:sidebar.title")}
                </button>
              )}
              <button
                type="button"
                className={`toolbar-icon-btn ${isSyncingFromRagic ? "is-busy" : ""}`}
                onClick={handleConfirmRefresh}
                disabled={loading || submitting || isHydratingAllRecords || isSyncingFromRagic}
                aria-label={t("common:actions.refresh")}
                title={t("common:actions.refresh")}
              >
                <ReloadOutlined />
              </button>

              <div className="toolbar-segmented" role="group" aria-label={t("workReport:table.displayMode.label")}>
                <button
                  type="button"
                  className={columnDisplayMode === "compact" ? "is-active" : ""}
                  onClick={() => setColumnDisplayMode("compact")}
                >
                  {t("workReport:table.displayMode.compact")}
                </button>
                <button
                  type="button"
                  className={columnDisplayMode === "fit" ? "is-active" : ""}
                  onClick={() => setColumnDisplayMode("fit")}
                >
                  {t("workReport:table.displayMode.fit")}
                </button>
                <button
                  type="button"
                  className={columnDisplayMode === "full" ? "is-active" : ""}
                  onClick={() => setColumnDisplayMode("full")}
                >
                  {t("workReport:table.displayMode.full")}
                </button>
              </div>

              <Popover
                trigger="click"
                placement="bottomRight"
                open={columnSettingsOpen}
                onOpenChange={setColumnSettingsOpen}
                overlayClassName="toolbar-column-settings-popover"
                content={
                  <section className="toolbar-column-settings-panel">
                    <strong className="toolbar-column-settings-title">
                      {t("workReport:table.columnSettingsTitle")}
                    </strong>
                    <p className="toolbar-column-settings-hint">
                      {t("workReport:table.columnSettingsHint")}
                    </p>
                    <div className="toolbar-column-settings-actions">
                      <button
                        type="button"
                        className="toolbar-column-settings-action-btn"
                        onClick={onShowAllColumns}
                      >
                        {t("workReport:table.columnSettingsShowAll")}
                      </button>
                      <button
                        type="button"
                        className="toolbar-column-settings-action-btn"
                        onClick={onResetDefaultColumns}
                      >
                        {t("workReport:table.columnSettingsResetDefault")}
                      </button>
                    </div>
                    <div className="toolbar-column-settings-list">
                      {selectableColumns.map((column) => {
                        const checked = !hiddenColumnKeys.has(column.key);
                        return (
                          <label key={`toolbar-column-toggle-${column.key}`} className="toolbar-column-settings-item">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => onToggleColumnVisibility(column.key)}
                            />
                            <span>{column.label}</span>
                          </label>
                        );
                      })}
                    </div>
                  </section>
                }
              >
                <button
                  type="button"
                  className={`toolbar-btn toolbar-btn--secondary toolbar-column-settings-btn ${
                    columnSettingsOpen ? "is-active" : ""
                  }`}
                >
                  {t("workReport:table.columnSettingsButton")}
                </button>
              </Popover>

              <div className="header-language-toggle" role="group" aria-label={t("common:language.toggleAria")}>
                <span className="header-language-toggle-label">{t("common:language.label")}</span>
                <button type="button" className={uiLanguage === "zh" ? "is-active" : ""} onClick={() => setUiLanguage("zh")}>
                  {t("common:language.zh")}
                </button>
                <button type="button" className={uiLanguage === "en" ? "is-active" : ""} onClick={() => setUiLanguage("en")}>
                  {t("common:language.en")}
                </button>
              </div>

              <label className="select-inline toolbar-page-size">
                {t("common:pager.rowsLabel")}
                <SearchableSelect
                  value={String(pageSize)}
                  options={pageSizeOptions}
                  disabled={loading || submitting || isHydratingAllRecords}
                  labelMode="value-only"
                  searchable={false}
                  clearable={false}
                  onChange={(value) => {
                    const parsed = Number(value);
                    if (!Number.isFinite(parsed) || parsed <= 0) {
                      return;
                    }
                    setPageSize(parsed);
                    setPage(1);
                  }}
                />
                {t("common:pager.rowsUnit")}
              </label>
            </div>
          </div>
        </div>

        {activeTopView === "report" && (
          <div className="toolbar-layer-notice-row">
            <div className="toolbar-notice-slot">
              <SystemNoticePanel
                onForceRefreshRequested={onSystemNoticeForceRefresh}
                forceReloadToken={systemNoticeForceReloadToken}
                statusNotice={systemStatusNotice}
              />
            </div>
          </div>
        )}
      </div>

      {activeTopView === "report" && (
      <section className="toolbar-layer toolbar-layer--filters">
        <div className="filter-card-grid">
          <label className="filter-field">
            <span>{t("workReport:filters.globalSearch")}</span>
            <input
              type="text"
              placeholder={t("workReport:filters.placeholderGlobalSearch")}
              value={globalFilterDraft.globalKeyword}
              onChange={(event) =>
                setGlobalFilterDraft((prev) => ({
                  ...prev,
                  globalKeyword: event.target.value,
                }))
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  onApplyFilters();
                }
              }}
              disabled={filterControlDisabled}
            />
          </label>

          <label className="filter-field">
            <span>{t("workReport:filters.workOrderNo")}</span>
            <input
              type="text"
              placeholder={t("workReport:filters.placeholderWorkOrderNo")}
              value={globalFilterDraft.workOrderKeyword}
              onChange={(event) =>
                setGlobalFilterDraft((prev) => ({
                  ...prev,
                  workOrderKeyword: event.target.value,
                }))
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  onApplyFilters();
                }
              }}
              disabled={filterControlDisabled}
            />
          </label>

          <label className="filter-field">
            <span>{t("workReport:filters.customerPartNo")}</span>
            <input
              type="text"
              placeholder={t("workReport:filters.placeholderCustomerPartNo")}
              value={globalFilterDraft.customerPartKeyword}
              onChange={(event) =>
                setGlobalFilterDraft((prev) => ({
                  ...prev,
                  customerPartKeyword: event.target.value,
                }))
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  onApplyFilters();
                }
              }}
              disabled={filterControlDisabled}
            />
          </label>

          <label className="filter-field">
            <span>{t("workReport:filters.workOrderStatus")}</span>
            <SearchableSelect
              value={globalFilterDraft.status}
              options={statusFilterOptions}
              disabled={filterControlDisabled}
              labelMode="value-display"
              onChange={(value) =>
                setGlobalFilterDraft((prev) => ({
                  ...prev,
                  status: value === "undefined" ? ALL_FILTER_VALUE : value,
                }))
              }
            />
          </label>

          <label className="filter-field">
            <span>{t("workReport:filters.siteRunning")}</span>
            <SearchableSelect
              value={globalFilterDraft.siteRunning}
              options={siteRunningFilterOptions}
              disabled={filterControlDisabled}
              labelMode="value-display"
              onChange={(value) =>
                setGlobalFilterDraft((prev) => ({
                  ...prev,
                  siteRunning: value === "yes" || value === "no" ? value : "all",
                }))
              }
            />
          </label>
        </div>

        <div className="filter-card-actions">
          <div className="filter-active-summary" role="status" aria-live="polite">
            <span className="filter-active-summary-label">{t("workReport:sidebar.currentFilter")}</span>
            <div className="filter-active-chip-list">
              {activeFilterChips.map((chip) => (
                <span key={chip.key} className="filter-active-chip">
                  <span className="filter-active-chip-text">{chip.label}</span>
                  {chip.removable && chip.removeActionKey ? (
                    <button
                      type="button"
                      className="filter-active-chip-remove"
                      onClick={() => onRemoveActiveFilterChip?.(chip.removeActionKey!)}
                      aria-label={`${t("common:actions.clearFilters")} ${chip.label}`}
                      title={t("common:actions.clearFilters")}
                    >
                      ×
                    </button>
                  ) : null}
                </span>
              ))}
            </div>
          </div>
          <div className="filter-actions">
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
              disabled={filterControlDisabled}
            >
              <SearchOutlined />
              <span>{t("common:actions.applyFilters")}</span>
            </button>
          </div>
        </div>
      </section>
      )}
    </header>
  );
});

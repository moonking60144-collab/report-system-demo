import { memo, useCallback, useEffect, useRef } from "react";
import {
  ExclamationCircleOutlined,
  FilterOutlined,
  LeftOutlined,
  LoadingOutlined,
  PrinterOutlined,
  ReloadOutlined,
  RightOutlined,
  SearchOutlined,
  SettingOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import { Modal } from "antd";
import { useTranslation } from "react-i18next";
import { SearchableSelect } from "../../../components/SearchableSelect";
import type { ColumnDisplayMode } from "../types";

interface SelectOption {
  value: string;
  label: string;
  display: string;
}

interface WorkReportWorkspaceToolbarProps {
  currentPageGroupLabel: string;
  currentPageContextLabel: string;
  matchedCount: number;
  searchValue: string;
  onSearchValueChange: (value: string) => void;
  onSearchSubmit: () => void;
  page: number;
  hasMoreForPager: boolean;
  onPrevPage: () => void;
  onNextPage: () => void;
  activeFilterCount: number;
  hasPendingFilterChanges: boolean;
  filterPanelOpen: boolean;
  onOpenFilters: () => void;
  columnDisplayMode: ColumnDisplayMode;
  onChangeColumnDisplayMode: (mode: ColumnDisplayMode) => void;
  columnSettingsOpen: boolean;
  onOpenColumnSettings: () => void;
  onOpenTaskQueue: () => void;
  onOpenPrintView: () => void;
  printViewChecking: boolean;
  pageSize: number;
  pageSizeOptions: SelectOption[];
  onChangePageSize: (pageSize: number) => void;
  controlsDisabled: boolean;
  isSyncingFromRagic: boolean;
  onRefresh: () => void | Promise<void>;
  stickyEnabled: boolean;
  onHeightChange: (height: number) => void;
}

export const WorkReportWorkspaceToolbar = memo(function WorkReportWorkspaceToolbar({
  currentPageGroupLabel,
  currentPageContextLabel,
  matchedCount,
  searchValue,
  onSearchValueChange,
  onSearchSubmit,
  page,
  hasMoreForPager,
  onPrevPage,
  onNextPage,
  activeFilterCount,
  hasPendingFilterChanges,
  filterPanelOpen,
  onOpenFilters,
  columnDisplayMode,
  onChangeColumnDisplayMode,
  columnSettingsOpen,
  onOpenColumnSettings,
  onOpenTaskQueue,
  onOpenPrintView,
  printViewChecking,
  pageSize,
  pageSizeOptions,
  onChangePageSize,
  controlsDisabled,
  isSyncingFromRagic,
  onRefresh,
  stickyEnabled,
  onHeightChange,
}: WorkReportWorkspaceToolbarProps) {
  const { t } = useTranslation(["workReport", "common"]);
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!stickyEnabled) {
      onHeightChange(0);
      return;
    }
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const reportHeight = () => onHeightChange(Math.ceil(root.getBoundingClientRect().height));
    reportHeight();
    const observer = new ResizeObserver(reportHeight);
    observer.observe(root);
    return () => observer.disconnect();
  }, [onHeightChange, stickyEnabled]);

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
    <section
      ref={rootRef}
      className={`work-report-workspace-toolbar ${stickyEnabled ? "is-sticky" : ""} ${
        filterPanelOpen ? "has-open-filter-panel" : ""
      }`}
      aria-label={t("workReport:table.workspaceToolbarLabel")}
    >
      <div className="work-report-workspace-context">
        <span className="work-report-workspace-indicator" aria-hidden="true" />
        <div>
          <strong>{currentPageGroupLabel}</strong>
          <span>{currentPageContextLabel}</span>
        </div>
        <span className="work-report-workspace-count">
          {t("workReport:table.matchedOrders", { count: matchedCount })}
        </span>
      </div>

      <div className="work-report-workspace-center">
        <form
          className="workspace-quick-search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            onSearchSubmit();
          }}
        >
          <SearchOutlined aria-hidden="true" />
          <input
            type="search"
            value={searchValue}
            placeholder={t("workReport:filters.placeholderGlobalSearch")}
            aria-label={t("workReport:filters.globalSearch")}
            disabled={controlsDisabled}
            onChange={(event) => onSearchValueChange(event.target.value)}
          />
          <button
            type="submit"
            disabled={controlsDisabled}
            aria-label={t("common:actions.applyFilters")}
            title={t("common:actions.applyFilters")}
          >
            <SearchOutlined aria-hidden="true" />
          </button>
        </form>

        <nav
          className="workspace-pager"
          aria-label={t("common:pager.page", { page })}
        >
          <button
            type="button"
            onClick={onPrevPage}
            disabled={controlsDisabled || page <= 1}
            aria-label={t("common:pager.prev")}
            title={t("common:pager.prev")}
          >
            <LeftOutlined aria-hidden="true" />
          </button>
          <span>{t("common:pager.page", { page })}</span>
          <button
            type="button"
            onClick={onNextPage}
            disabled={controlsDisabled || !hasMoreForPager}
            aria-label={t("common:pager.next")}
            title={t("common:pager.next")}
          >
            <RightOutlined aria-hidden="true" />
          </button>
        </nav>
      </div>

      <div className="work-report-workspace-actions">
        <button
          type="button"
          className="toolbar-btn toolbar-btn--secondary"
          onClick={onOpenPrintView}
          disabled={controlsDisabled || printViewChecking || hasPendingFilterChanges}
          aria-label={t("workReport:table.printScheduleButton")}
          title={
            hasPendingFilterChanges
              ? t("workReport:filters.applyBeforePrint")
              : t("workReport:table.printScheduleButton")
          }
        >
          {printViewChecking ? (
            <LoadingOutlined aria-hidden="true" />
          ) : (
            <PrinterOutlined aria-hidden="true" />
          )}
          <span>
            {printViewChecking
              ? t("workReport:table.printScheduleChecking")
              : t("workReport:table.printScheduleButton")}
          </span>
        </button>

        <button
          type="button"
          className="toolbar-btn toolbar-btn--secondary"
          onClick={onOpenTaskQueue}
          aria-label={t("workReport:taskQueue.button")}
        >
          <UnorderedListOutlined aria-hidden="true" />
          <span>{t("workReport:taskQueue.button")}</span>
        </button>

        <button
          type="button"
          className={`toolbar-btn toolbar-btn--secondary workspace-filter-btn ${
            filterPanelOpen ? "is-active" : ""
          } ${hasPendingFilterChanges ? "has-pending-changes" : ""}`}
          onClick={onOpenFilters}
          aria-expanded={filterPanelOpen}
          aria-controls="work-report-filter-panel"
        >
          <FilterOutlined aria-hidden="true" />
          <span>{t("workReport:filters.filterButton")}</span>
          {activeFilterCount > 0 ? (
            <span className="filter-count-badge">{activeFilterCount}</span>
          ) : null}
          {hasPendingFilterChanges ? (
            <span className="filter-draft-badge">{t("workReport:filters.pendingChangesShort")}</span>
          ) : null}
        </button>

        <div className="toolbar-segmented workspace-display-mode" role="group" aria-label={t("workReport:table.displayMode.label")}>
          <button
            type="button"
            className={columnDisplayMode === "compact" ? "is-active" : ""}
            onClick={() => onChangeColumnDisplayMode("compact")}
          >
            {t("workReport:table.displayMode.compact")}
          </button>
          <button
            type="button"
            className={columnDisplayMode === "fit" ? "is-active" : ""}
            onClick={() => onChangeColumnDisplayMode("fit")}
          >
            {t("workReport:table.displayMode.fit")}
          </button>
        </div>

        <button
          type="button"
          className={`toolbar-btn toolbar-btn--secondary toolbar-column-settings-btn ${columnSettingsOpen ? "is-active" : ""}`}
          onClick={onOpenColumnSettings}
        >
          <SettingOutlined aria-hidden="true" />
          <span>{t("workReport:table.columnSettingsButton")}</span>
        </button>

        <label className="select-inline toolbar-page-size workspace-page-size">
          {t("common:pager.rowsLabel")}
          <SearchableSelect
            value={String(pageSize)}
            options={pageSizeOptions}
            disabled={controlsDisabled}
            labelMode="value-only"
            searchable={false}
            clearable={false}
            onChange={(value) => {
              const parsed = Number(value);
              if (Number.isFinite(parsed) && parsed > 0) {
                onChangePageSize(parsed);
              }
            }}
          />
          {t("common:pager.rowsUnit")}
        </label>

        <button
          type="button"
          className={`toolbar-icon-btn workspace-refresh-btn ${isSyncingFromRagic ? "is-busy" : ""}`}
          onClick={handleConfirmRefresh}
          disabled={controlsDisabled || isSyncingFromRagic}
          aria-label={t("common:actions.refresh")}
          title={t("common:actions.refresh")}
        >
          <ReloadOutlined aria-hidden="true" />
        </button>
      </div>
    </section>
  );
});

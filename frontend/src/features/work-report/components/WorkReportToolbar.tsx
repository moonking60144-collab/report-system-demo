import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ColumnColorOverrides,
  ColumnKey,
  UiLanguage,
  WorkReportColumnColor,
  WorkReportLandingPageKey,
  WorkReportTopView,
} from "../types";
import { EfficiencyStatsModal } from "./EfficiencyStatsModal";
import { CsvIcon } from "./ExportFileIcons";
import { SystemNoticePanel } from "./SystemNoticePanel";
import type { NoticeState } from "../types";
import type { WorkReportSelectableColumnMeta } from "../hooks/workReportColumnDefinitions";
import { APP_VERSION } from "../../../version";
import { SubsystemMenu } from "../../subsystems/components/SubsystemMenu";
import { WorkReportColumnSettingsDrawer } from "./WorkReportColumnSettingsDrawer";

interface WorkReportToolbarProps {
  uiLanguage: UiLanguage;
  setUiLanguage: (language: UiLanguage) => void;
  activeTopView: WorkReportTopView;
  activeLandingPageKey: WorkReportLandingPageKey;
  currentPageGroupLabel: string;
  currentPageContextLabel: string;
  onOpenLandingPage: (key: WorkReportLandingPageKey) => void;
  onOpenDowntimePage?: () => void;
  onOpenLocalSettingsView: () => void;
  showMobileFilterButton?: boolean;
  onOpenMobileFilters?: () => void;
  columnSettingsOpen: boolean;
  setColumnSettingsOpen: (open: boolean) => void;
  selectableColumns: WorkReportSelectableColumnMeta[];
  columnOrder: ColumnKey[];
  hiddenColumnKeys: Set<ColumnKey>;
  columnColors: ColumnColorOverrides;
  onToggleColumnVisibility: (columnKey: ColumnKey) => void;
  onMoveColumn: (columnKey: ColumnKey, targetColumnKey: ColumnKey) => void;
  onMoveColumnByOffset: (columnKey: ColumnKey, offset: -1 | 1) => void;
  onChangeColumnColor: (columnKey: ColumnKey, color: WorkReportColumnColor) => void;
  onShowAllColumns: () => void;
  onResetDefaultColumns: () => void;
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
  currentPageContextLabel,
  onOpenLandingPage,
  onOpenDowntimePage,
  onOpenLocalSettingsView,
  showMobileFilterButton = false,
  onOpenMobileFilters,
  columnSettingsOpen,
  setColumnSettingsOpen,
  selectableColumns,
  columnOrder,
  hiddenColumnKeys,
  columnColors,
  onToggleColumnVisibility,
  onMoveColumn,
  onMoveColumnByOffset,
  onChangeColumnColor,
  onShowAllColumns,
  onResetDefaultColumns,
  onSystemNoticeForceRefresh,
  systemNoticeForceReloadToken,
  systemStatusNotice,
}: WorkReportToolbarProps) {
  const { t } = useTranslation(["workReport", "common"]);
  const [efficiencyStatsOpen, setEfficiencyStatsOpen] = useState(false);

  return (
    <header className="page-header">
      <div className="toolbar-layer toolbar-layer--title">
        <div className="toolbar-layer-main-row">
          <div className="page-title-block">
            <div className="page-product-kicker">
              <span>{t("workReport:page.title")}</span>
              <span className="app-version-tag" title={`App version ${APP_VERSION}`}>
                v{APP_VERSION}
              </span>
            </div>
            <div className="page-current-context">
              <h1>{currentPageGroupLabel}</h1>
              <span className="page-context-code">{currentPageContextLabel}</span>
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
              <div className="header-language-toggle" role="group" aria-label={t("common:language.toggleAria")}>
                <span className="header-language-toggle-label">{t("common:language.label")}</span>
                <button type="button" className={uiLanguage === "zh" ? "is-active" : ""} onClick={() => setUiLanguage("zh")}>
                  {t("common:language.zh")}
                </button>
                <button type="button" className={uiLanguage === "en" ? "is-active" : ""} onClick={() => setUiLanguage("en")}>
                  {t("common:language.en")}
                </button>
              </div>
              <SubsystemMenu className="page-view-chip page-view-chip--utility" />
            </div>
          </div>
        </div>
        <div className="page-view-toolbar">
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
              aria-selected={false}
              className="page-view-chip"
              onClick={() => setEfficiencyStatsOpen(true)}
            >
              <CsvIcon size="1.05em" />
              {t("workReport:efficiencyStats.entry")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTopView === "local-settings"}
              className={`page-view-chip ${activeTopView === "local-settings" ? "is-active" : ""}`}
              onClick={onOpenLocalSettingsView}
            >
              {t("workReport:page.views.localSettings")}
            </button>
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

      <WorkReportColumnSettingsDrawer
        open={columnSettingsOpen}
        columns={selectableColumns}
        columnOrder={columnOrder}
        hiddenColumnKeys={hiddenColumnKeys}
        columnColors={columnColors}
        onClose={() => setColumnSettingsOpen(false)}
        onToggleColumnVisibility={onToggleColumnVisibility}
        onMoveColumn={onMoveColumn}
        onMoveColumnByOffset={onMoveColumnByOffset}
        onChangeColumnColor={onChangeColumnColor}
        onShowAllColumns={onShowAllColumns}
        onResetDefaultColumns={onResetDefaultColumns}
      />
      <EfficiencyStatsModal
        open={efficiencyStatsOpen}
        onClose={() => setEfficiencyStatsOpen(false)}
      />
    </header>
  );
});

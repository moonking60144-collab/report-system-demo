import { useTranslation } from "react-i18next";
import type {
  FixedFilterPreset,
  FixedFilterPresetId,
  SidebarMachinePreset,
  WorkReportFormId,
} from "../types";
import {
  FIXED_FILTER_PRESETS,
  SIDEBAR_PLACEHOLDER_VIEWS,
  SIDEBAR_PRIMARY_ITEM_ORDER_BY_FORM,
} from "../constants";

interface SidebarDisplayText {
  label: string;
  shortLabel: string;
  description: string;
}

interface SidebarPrimaryItem {
  key: string;
  active: boolean;
  title?: string;
  label: string;
  description: string;
  onClick: () => void;
}

interface FixedFilterSidebarProps {
  collapsed: boolean;
  mobileMode?: boolean;
  mobileOpen?: boolean;
  currentFormId: WorkReportFormId;
  filterControlDisabled: boolean;
  activeFixedFilterPresetId: FixedFilterPresetId | null;
  activePlaceholderViewId: "starred" | "last-updated" | null;
  activeUnfinishedMachineShortcut: SidebarMachinePreset | null;
  unfinishedMachineShortcuts: SidebarMachinePreset[];
  onToggleCollapsed: () => void;
  onCloseMobile?: () => void;
  onApplyFixedFilterPreset: (presetId: FixedFilterPresetId) => void;
  onPlaceholderViewClick: (viewId: "starred" | "last-updated") => void;
  onApplyUnfinishedMachineShortcut: (preset: SidebarMachinePreset) => void;
}

export function FixedFilterSidebar({
  collapsed,
  mobileMode = false,
  mobileOpen = false,
  currentFormId,
  filterControlDisabled,
  activeFixedFilterPresetId,
  activePlaceholderViewId,
  activeUnfinishedMachineShortcut,
  unfinishedMachineShortcuts,
  onToggleCollapsed,
  onCloseMobile,
  onApplyFixedFilterPreset,
  onPlaceholderViewClick,
  onApplyUnfinishedMachineShortcut,
}: FixedFilterSidebarProps) {
  const { t } = useTranslation(["workReport", "common"]);
  const effectiveCollapsed = mobileMode ? false : collapsed;
  const getFixedPresetDisplayText = (preset: FixedFilterPreset): SidebarDisplayText => {
    switch (preset.id) {
      case "all-data":
        return {
          label: t("workReport:sidebar.presets.allData.label"),
          shortLabel: t("workReport:sidebar.presets.allData.shortLabel"),
          description: t("workReport:sidebar.presets.allData.description"),
        };
      case "unfinished-runnable":
        return {
          label: t("workReport:sidebar.presets.unfinishedRunnable.label"),
          shortLabel: t("workReport:sidebar.presets.unfinishedRunnable.shortLabel"),
          description: t("workReport:sidebar.presets.unfinishedRunnable.description"),
        };
      case "unfinished-orders":
        return {
          label: t("workReport:sidebar.presets.unfinishedOrders.label"),
          shortLabel: t("workReport:sidebar.presets.unfinishedOrders.shortLabel"),
          description: t("workReport:sidebar.presets.unfinishedOrders.description"),
        };
      case "finished-orders":
        return {
          label: t("workReport:sidebar.presets.finishedOrders.label"),
          shortLabel: t("workReport:sidebar.presets.finishedOrders.shortLabel"),
          description: t("workReport:sidebar.presets.finishedOrders.description"),
        };
      default:
        return {
          label: preset.label,
          shortLabel: preset.shortLabel,
          description: preset.description,
        };
    }
  };
  const getSidebarPlaceholderDisplayText = (itemId: "starred" | "last-updated"): SidebarDisplayText => {
    if (itemId === "starred") {
      return {
        label: t("workReport:sidebar.placeholders.starred.label"),
        shortLabel: t("workReport:sidebar.placeholders.starred.shortLabel"),
        description: t("workReport:sidebar.placeholders.starred.description"),
      };
    }
    return {
      label: t("workReport:sidebar.placeholders.lastUpdated.label"),
      shortLabel: t("workReport:sidebar.placeholders.lastUpdated.shortLabel"),
      description: t("workReport:sidebar.placeholders.lastUpdated.description"),
    };
  };
  const machineOpenDescription =
    currentFormId === "105"
      ? t("workReport:sidebar.machineOpenDesc105")
      : t("workReport:sidebar.machineOpenDesc");
  const fixedPresetById = (id: FixedFilterPresetId): FixedFilterPreset | undefined =>
    FIXED_FILTER_PRESETS.find((preset) => preset.id === id);
  const placeholderById = (id: "starred" | "last-updated") =>
    SIDEBAR_PLACEHOLDER_VIEWS.find((item) => item.id === id);

  const sidebarPrimaryItems: SidebarPrimaryItem[] = [];
  for (const itemId of SIDEBAR_PRIMARY_ITEM_ORDER_BY_FORM[currentFormId]) {
    if (itemId === "starred" || itemId === "last-updated") {
      const item = placeholderById(itemId);
      if (!item) {
        continue;
      }
      const itemText = getSidebarPlaceholderDisplayText(item.id);
      sidebarPrimaryItems.push({
        key: item.id,
        active: activePlaceholderViewId === item.id,
        title: effectiveCollapsed ? itemText.label : undefined,
        label: effectiveCollapsed ? itemText.shortLabel : itemText.label,
        description: itemText.description,
        onClick: () => onPlaceholderViewClick(item.id),
      });
      continue;
    }

    const preset = fixedPresetById(itemId);
    if (!preset) {
      continue;
    }
    const presetText = getFixedPresetDisplayText(preset);
    sidebarPrimaryItems.push({
      key: preset.id,
      active: activeFixedFilterPresetId === preset.id,
      title: effectiveCollapsed ? presetText.label : undefined,
      label: effectiveCollapsed ? presetText.shortLabel : presetText.label,
      description: presetText.description,
      onClick: () => onApplyFixedFilterPreset(preset.id),
    });
  }

  const currentViewLabel = activeFixedFilterPresetId
    ? getFixedPresetDisplayText(
        FIXED_FILTER_PRESETS.find((preset) => preset.id === activeFixedFilterPresetId) ?? FIXED_FILTER_PRESETS[0]
      ).label
    : activeUnfinishedMachineShortcut
      ? t("workReport:sidebar.machineOpenLabel", {
          machineCode: activeUnfinishedMachineShortcut.machineCode,
        })
      : t("workReport:sidebar.customFilters");

  return (
    <div
      className={`fixed-filter-sidebar-shell ${mobileMode ? "is-mobile" : ""} ${
        mobileOpen ? "is-open" : ""
      }`}
    >
      {mobileMode && mobileOpen && (
        <button
          type="button"
          className="fixed-filter-sidebar-backdrop"
          aria-label={t("common:actions.close")}
          onClick={onCloseMobile}
        />
      )}
      <aside
        className={`fixed-filter-sidebar ${effectiveCollapsed ? "is-collapsed" : ""}`}
        aria-label={t("workReport:sidebar.title")}
      >
      <div className="fixed-filter-sidebar-header">
        {!effectiveCollapsed && (
          <div className="fixed-filter-sidebar-title">
            <strong>{t("workReport:sidebar.title")}</strong>
            <p>{t("workReport:sidebar.subtitle")}</p>
          </div>
        )}
        {!mobileMode && (
          <button
            type="button"
            className="fixed-filter-collapse-btn"
            onClick={onToggleCollapsed}
            aria-label={effectiveCollapsed ? t("workReport:sidebar.expand") : t("workReport:sidebar.collapse")}
            title={effectiveCollapsed ? t("workReport:sidebar.expand") : t("workReport:sidebar.collapse")}
          >
            {effectiveCollapsed ? ">" : "<"}
          </button>
        )}
      </div>

      <div className="fixed-filter-sidebar-body">
        {sidebarPrimaryItems.map((item) => {
          return (
            <button
              key={item.key}
              type="button"
              className={`fixed-filter-item ${item.active ? "is-active" : ""}`}
              onClick={() => {
                item.onClick();
                if (mobileMode) {
                  onCloseMobile?.();
                }
              }}
              disabled={filterControlDisabled}
              title={item.title}
            >
              <span className="fixed-filter-item-label">{item.label}</span>
              {!effectiveCollapsed && <span className="fixed-filter-item-desc">{item.description}</span>}
            </button>
          );
        })}

        {!effectiveCollapsed && unfinishedMachineShortcuts.length > 0 && (
          <section className="fixed-filter-machine-group" aria-label={t("workReport:sidebar.openMachines")}>
            <div className="fixed-filter-machine-group-title">{t("workReport:sidebar.openMachines")}</div>
            <div className="fixed-filter-machine-list">
              {unfinishedMachineShortcuts.map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  className={`fixed-filter-item fixed-filter-item--machine ${
                    activeUnfinishedMachineShortcut?.machineCode === preset.machineCode ? "is-active" : ""
                  }`}
                  onClick={() => {
                    onApplyUnfinishedMachineShortcut(preset);
                    if (mobileMode) {
                      onCloseMobile?.();
                    }
                  }}
                  disabled={filterControlDisabled}
                >
                  <span className="fixed-filter-item-label">
                    {t("workReport:sidebar.machineOpenLabel", { machineCode: preset.machineCode })}
                  </span>
                  <span className="fixed-filter-item-desc">
                    {machineOpenDescription}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

      </div>

      {!effectiveCollapsed && (
        <div className="fixed-filter-sidebar-footer">
          {t("workReport:sidebar.currentView")}
          <strong>{currentViewLabel}</strong>
        </div>
      )}
      </aside>
    </div>
  );
}

import { useCallback, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { BACKEND_FACET_COLUMN_KEYS } from "../constants";
import type {
  ColumnFacetOption,
  ColumnFilterState,
  ColumnKey,
  ColumnMenuMeta,
  ColumnSortDirection,
  ColumnSortRule,
  UiLanguage,
} from "../types";
import { getColumnMenuFilterTitle } from "../utils";

export interface WorkReportColumnsMenuState {
  columnFilterState: ColumnFilterState;
  columnSortRules: ColumnSortRule[];
  columnMenuOpenKey: ColumnKey | null;
  openColumnFacetOptionsFiltered: ColumnFacetOption[];
  columnMenuSearchState: Partial<Record<ColumnKey, string>>;
}

export interface WorkReportColumnsMenuActions {
  clearColumnFilter: (columnKey: ColumnKey) => void;
  applyColumnSortRule: (columnKey: ColumnKey, direction: ColumnSortDirection) => void;
  clearColumnSortRule: (columnKey: ColumnKey) => void;
  openColumnAnalysis: (columnKey: ColumnKey, label: string) => void;
  handleColumnMenuSearchChange: (columnKey: ColumnKey, searchText: string) => void;
  markColumnMenuInteract: () => void;
  openColumnTextFilterDialog: (columnKey: ColumnKey, columnLabel: string) => void;
  toggleColumnFilterToken: (columnKey: ColumnKey, token: string) => void;
  clearColumnMenuSettings: (columnKey: ColumnKey) => void;
}

interface UseWorkReportColumnMenuContentArgs {
  uiLanguage: UiLanguage;
  menuState: WorkReportColumnsMenuState;
  menuActions: WorkReportColumnsMenuActions;
}

export function useWorkReportColumnMenuContent(args: UseWorkReportColumnMenuContentArgs) {
  const {
    uiLanguage,
    menuState: {
      columnFilterState,
      columnSortRules,
      columnMenuOpenKey,
      openColumnFacetOptionsFiltered,
      columnMenuSearchState,
    },
    menuActions: {
      clearColumnFilter,
      applyColumnSortRule,
      clearColumnSortRule,
      openColumnAnalysis,
      handleColumnMenuSearchChange,
      markColumnMenuInteract,
      openColumnTextFilterDialog,
      toggleColumnFilterToken,
      clearColumnMenuSettings,
    },
  } = args;
  const { t } = useTranslation(["workReport", "common"]);

  const renderColumnMenuContent = useCallback(
    (meta: ColumnMenuMeta): ReactNode => {
      const filterRule = columnFilterState[meta.key];
      const selectedTokens = filterRule?.selectedTokens ?? [];
      const appliedTextQuery = filterRule?.textQuery ?? "";
      const sortIndex = columnSortRules.findIndex((rule) => rule.key === meta.key);
      const sortRule = sortIndex >= 0 ? columnSortRules[sortIndex] : null;
      const isOpenMenu = columnMenuOpenKey === meta.key;
      const facetOptions = isOpenMenu ? openColumnFacetOptionsFiltered : [];
      const isBackendFacetTextColumn =
        meta.type === "text" &&
        BACKEND_FACET_COLUMN_KEYS.includes(
          meta.key as (typeof BACKEND_FACET_COLUMN_KEYS)[number]
        );
      const isTextFilter = meta.type === "text" && !isBackendFacetTextColumn;
      const searchText = columnMenuSearchState[meta.key] ?? appliedTextQuery;

      return (
        <div
          className="column-menu"
          onMouseDownCapture={() => markColumnMenuInteract()}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="column-menu-section">
            {isTextFilter ? (
              <button
                type="button"
                className="column-menu-action column-menu-action--primary"
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openColumnTextFilterDialog(meta.key, meta.label);
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
              >
                {t("workReport:columnMenu.textFilterButton")}
              </button>
            ) : (
              <div className="column-menu-section-title">{getColumnMenuFilterTitle(meta.type, uiLanguage, t)}</div>
            )}
            <button
              type="button"
              className="column-menu-action"
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                clearColumnFilter(meta.key);
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              {t("workReport:columnMenu.clearFilterCondition")}
            </button>
            {isTextFilter && (
              <div className="column-menu-filter-help">
                {appliedTextQuery
                  ? t("workReport:columnMenu.textFilterCurrent", { value: appliedTextQuery })
                  : t("workReport:columnMenu.textFilterOpenHint")}
              </div>
            )}
          </div>

          <div className="column-menu-divider" />

          <div className="column-menu-section">
            <button
              type="button"
              className="column-menu-action"
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                applyColumnSortRule(meta.key, "asc");
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              {t("workReport:columnMenu.sortAscBy", { label: meta.label })}
            </button>
            <button
              type="button"
              className="column-menu-action"
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                applyColumnSortRule(meta.key, "desc");
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              {t("workReport:columnMenu.sortDescBy", { label: meta.label })}
            </button>
            <button
              type="button"
              className="column-menu-action"
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                clearColumnSortRule(meta.key);
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              {t("workReport:columnMenu.clearSort")}
            </button>
            {sortRule && (
              <div className="column-menu-sort-hint">
                {t("workReport:columnMenu.sortHint", {
                  priority: sortIndex + 1,
                  direction:
                    sortRule.direction === "asc"
                      ? t("workReport:columnMenu.sortDirectionAsc")
                      : t("workReport:columnMenu.sortDirectionDesc"),
                })}
              </div>
            )}
          </div>

          <div className="column-menu-divider" />

          <div className="column-menu-section">
            <button
              type="button"
              className="column-menu-action"
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openColumnAnalysis(meta.key, meta.label);
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              {t("workReport:columnMenu.analyzeButton")}
            </button>
          </div>

          <div className="column-menu-divider" />

          <div className="column-menu-section">
            {isTextFilter ? (
              <>
                <div className="column-menu-selection-bar">
                  <span>
                    {appliedTextQuery
                      ? t("workReport:columnMenu.appliedTextFilter", { value: appliedTextQuery })
                      : t("workReport:columnMenu.noTextFilterApplied")}
                  </span>
                  <button
                    type="button"
                    className="column-menu-inline-action"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      clearColumnFilter(meta.key);
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                  >
                    {t("workReport:columnMenu.clearColumn")}
                  </button>
                </div>
                <div className="column-menu-text-actions">
                  <button
                    type="button"
                    className="column-menu-action"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openColumnTextFilterDialog(meta.key, meta.label);
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                  >
                    {t("workReport:columnMenu.openTextFilterDialog")}
                  </button>
                </div>
                <div className="column-menu-filter-help">{t("workReport:columnMenu.textFilterDialogHelp")}</div>
              </>
            ) : (
              <>
                <input
                  className="column-menu-search"
                  type="text"
                  placeholder={t("workReport:columnMenu.searchValuesPlaceholder", { label: meta.label })}
                  value={searchText}
                  onMouseDown={(event) => {
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                  }}
                  onChange={(event) => handleColumnMenuSearchChange(meta.key, event.target.value)}
                />
                <div className="column-menu-selection-bar">
                  <span>{t("workReport:columnMenu.selectedCount", { count: selectedTokens.length })}</span>
                  <button
                    type="button"
                    className="column-menu-inline-action"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      clearColumnFilter(meta.key);
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                  >
                    {t("workReport:columnMenu.clearColumn")}
                  </button>
                </div>
                <div className="column-menu-values">
                  {facetOptions.length === 0 && (
                    <div className="column-menu-empty">{t("workReport:columnMenu.noValues")}</div>
                  )}
                  {facetOptions.map((option) => {
                    const checked = selectedTokens.includes(option.token);
                    return (
                      <label
                        key={option.token}
                        className="column-menu-value-item"
                        onMouseDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          toggleColumnFilterToken(meta.key, option.token);
                        }}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          readOnly
                          onMouseDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                        />
                        <span>{option.label}</span>
                      </label>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          <div className="column-menu-divider" />

          <div className="column-menu-section">
            <button
              type="button"
              className="column-menu-action column-menu-action--danger"
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                clearColumnMenuSettings(meta.key);
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              {t("workReport:columnMenu.clearAllSettings")}
            </button>
          </div>
        </div>
      );
    },
    [
      columnFilterState,
      columnSortRules,
      columnMenuOpenKey,
      openColumnFacetOptionsFiltered,
      columnMenuSearchState,
      clearColumnFilter,
      applyColumnSortRule,
      clearColumnSortRule,
      openColumnAnalysis,
      handleColumnMenuSearchChange,
      markColumnMenuInteract,
      openColumnTextFilterDialog,
      toggleColumnFilterToken,
      clearColumnMenuSettings,
      t,
      uiLanguage,
    ]
  );

  return { renderColumnMenuContent };
}

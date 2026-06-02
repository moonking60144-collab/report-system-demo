import { useCallback, useMemo, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Popover, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useTranslation } from "react-i18next";
import type { WorkReportRecord } from "../../../api/workReport";
import { COLUMN_TYPE_MAP } from "../constants";
import type {
  ColumnDisplayMode,
  ColumnKey,
  ColumnMenuMeta,
  ColumnWidthOverrides,
  UiLanguage,
  WorkReportFormId,
} from "../types";
import { getColumnHeaderLocaleText } from "../utils";
import {
  useWorkReportColumnMenuContent,
  type WorkReportColumnsMenuActions,
  type WorkReportColumnsMenuState,
} from "./useWorkReportColumnMenuContent";
import { buildFormAwareColumns } from "./workReportColumnDefinitions";
import {
  createHighlightedTextRenderer,
  renderSemanticCheck,
  toColumnSortableDate,
  toColumnSortableNumber,
} from "./workReportColumnRenderUtils";

interface UseWorkReportColumnsArgs {
  enabled?: boolean;
  currentFormId: WorkReportFormId;
  columnDisplayMode: ColumnDisplayMode;
  columnWidthOverrides: ColumnWidthOverrides;
  hiddenColumnKeys: Set<ColumnKey>;
  onColumnResizeStart: (
    columnKey: ColumnKey,
    currentWidth: number,
    event: ReactPointerEvent<HTMLSpanElement>
  ) => void;
  disableFixedColumns?: boolean;
  uiLanguage: UiLanguage;
  onOpenDetail: (entryId: string) => void;
  globalSearchKeyword: string;
  menuState: WorkReportColumnsMenuState;
  menuActions: WorkReportColumnsMenuActions & {
    handleColumnMenuOpenChange: (columnKey: ColumnKey, nextOpen: boolean) => void;
  };
}

export function useWorkReportColumns(args: UseWorkReportColumnsArgs) {
  const {
    enabled = true,
    currentFormId,
    columnDisplayMode,
    columnWidthOverrides,
    hiddenColumnKeys,
    onColumnResizeStart,
    disableFixedColumns = false,
    uiLanguage,
    onOpenDetail,
    globalSearchKeyword,
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
      handleColumnMenuOpenChange,
    },
  } = args;
  const { t } = useTranslation(["workReport", "common"]);
  const { renderColumnMenuContent } = useWorkReportColumnMenuContent({
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
  });

  const renderColumnHeaderWithMenu = useCallback(
    (
      fallbackZhTitle: string,
      columnKey: ColumnKey,
      currentWidth: number | null
    ): ReactNode => {
      const filterRule = columnFilterState[columnKey];
      const tokenFilterCount = filterRule?.selectedTokens?.length ?? 0;
      const hasTextFilter = Boolean(filterRule?.textQuery?.trim());
      const filterCount = tokenFilterCount > 0 ? tokenFilterCount : hasTextFilter ? 1 : 0;
      const sortIndex = columnSortRules.findIndex((rule) => rule.key === columnKey);
      const sortRule = sortIndex >= 0 ? columnSortRules[sortIndex] : null;
      const hasActive = filterCount > 0 || Boolean(sortRule);
      const localeTitle = getColumnHeaderLocaleText(columnKey, fallbackZhTitle);
      const displayTitle = uiLanguage === "en" ? localeTitle.en : localeTitle.zh;
      const titleTooltip =
        localeTitle.en && localeTitle.en !== localeTitle.zh
          ? `${localeTitle.zh} / ${localeTitle.en}`
          : localeTitle.zh;
      const meta: ColumnMenuMeta = {
        key: columnKey,
        label: displayTitle,
        type: COLUMN_TYPE_MAP[columnKey] ?? "text",
      };

      return (
        <div className={`column-header-menu ${hasActive ? "is-active" : ""}`}>
          <Tooltip
            placement="top"
            title={titleTooltip}
            overlayClassName="work-report-header-tooltip"
          >
            <span className="column-header-menu-title">{displayTitle}</span>
          </Tooltip>
          {sortRule && (
            <span
              className="column-header-sort-badge"
              aria-label={t("workReport:columnMenu.sortPriorityTitle", { priority: sortIndex + 1 })}
            >
              {sortRule.direction === "asc" ? "↑" : "↓"}
              {sortIndex + 1}
            </span>
          )}
          {filterCount > 0 && (
            <span
              className="column-header-filter-badge"
              aria-label={
                tokenFilterCount > 0
                  ? t("workReport:columnMenu.selectedValuesTitle", { count: tokenFilterCount })
                  : t("workReport:columnMenu.textFilterAppliedTitle")
              }
            >
              {tokenFilterCount > 0 ? filterCount : t("workReport:columnMenu.textFilterBadge")}
            </span>
          )}
          <Popover
            trigger="click"
            placement="bottomLeft"
            open={columnMenuOpenKey === columnKey}
            onOpenChange={(open) => handleColumnMenuOpenChange(columnKey, open)}
            content={renderColumnMenuContent(meta)}
            overlayClassName="column-menu-popover"
          >
            <button
              type="button"
              className={`column-header-menu-trigger ${hasActive ? "is-active" : ""}`}
              aria-label={t("workReport:columnMenu.columnMenuAria", { label: displayTitle })}
              onClick={(event) => event.stopPropagation()}
            >
              ▼
            </button>
          </Popover>
          {currentWidth !== null ? (
            <span
              className="column-header-resize-handle"
              role="presentation"
              onPointerDown={(event) => {
                onColumnResizeStart(columnKey, currentWidth, event);
              }}
            />
          ) : null}
        </div>
      );
    },
    [
      columnFilterState,
      columnSortRules,
      uiLanguage,
      t,
      columnMenuOpenKey,
      handleColumnMenuOpenChange,
      renderColumnMenuContent,
      onColumnResizeStart,
    ]
  );
  const baseColumns = useMemo<ColumnsType<WorkReportRecord>>(() => {
    if (!enabled) {
      return [] as ColumnsType<WorkReportRecord>;
    }
    const renderHighlightedText = createHighlightedTextRenderer(globalSearchKeyword);
    const textCellClassName = columnDisplayMode === "fit" ? "table-cell-text is-fit" : "table-cell-text";

    const renderValue = (value: unknown) => (
      <span className={textCellClassName}>{renderHighlightedText(value)}</span>
    );
    const renderMachineValue = (_value: unknown, record: WorkReportRecord): ReactNode => {
      const displayValue = String(record.machineCode ?? "").trim();
      const filterValue = String(record.filterMachineCode ?? "").trim();
      return (
        <span className={textCellClassName}>
          {renderHighlightedText(displayValue || filterValue)}
        </span>
      );
    };
    const renderWorkOrderValue = (value: unknown, record: WorkReportRecord): ReactNode => {
      const text = renderHighlightedText(value);
      const entryId = String(record.id);
      return (
        <button
          type="button"
          className={`work-order-cell-button ${columnDisplayMode === "fit" ? "is-fit" : ""}`}
          onClick={(event) => {
            event.stopPropagation();
            onOpenDetail(entryId);
          }}
        >
          {text}
        </button>
      );
    };

    const formAwareColumns = buildFormAwareColumns({
      currentFormId,
      columnDisplayMode,
      renderValue,
      renderMachineValue,
      renderWorkOrderValue,
      renderCheck: renderSemanticCheck,
      toNumber: toColumnSortableNumber,
      toDateValue: toColumnSortableDate,
    });

    return formAwareColumns;
  }, [
    enabled,
    globalSearchKeyword,
    columnDisplayMode,
    currentFormId,
    onOpenDetail,
  ]);

  const columns = useMemo<ColumnsType<WorkReportRecord>>(() => {
    return baseColumns
      .filter((column) => {
        const isDataColumn =
          "dataIndex" in column &&
          typeof column.dataIndex === "string" &&
          String(column.key ?? "") !== "scheduleAction";

        if (!isDataColumn) {
          return true;
        }

        return !hiddenColumnKeys.has(column.dataIndex as ColumnKey);
      })
      .map((column) => {
      const isDataColumn =
        "dataIndex" in column &&
        typeof column.dataIndex === "string" &&
        String(column.key ?? "") !== "scheduleAction";

      if (!isDataColumn) {
        return disableFixedColumns && "fixed" in column
          ? {
              ...column,
              fixed: undefined,
            }
          : column;
      }

      const columnKey = column.dataIndex as string;
      const titleText = typeof column.title === "string" ? column.title : String(column.dataIndex);

      return {
        ...column,
        width:
          typeof columnWidthOverrides[columnKey] === "number"
            ? columnWidthOverrides[columnKey]
            : column.width,
        fixed: disableFixedColumns ? undefined : column.fixed,
        title: renderColumnHeaderWithMenu(
          titleText,
          columnKey,
          typeof columnWidthOverrides[columnKey] === "number"
            ? columnWidthOverrides[columnKey] ?? null
            : typeof column.width === "number"
              ? column.width
              : null
        ),
        sorter: false,
      };
      });
  }, [
    baseColumns,
    columnWidthOverrides,
    disableFixedColumns,
    hiddenColumnKeys,
    renderColumnHeaderWithMenu,
  ]);

  return { columns };
}

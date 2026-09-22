import { useCallback, useMemo, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Tooltip } from "antd";
import { FireFilled } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { useTranslation } from "react-i18next";
import type { FormOptionItem, WorkReportRecord } from "../../../api/workReport";
import { COLUMN_TYPE_MAP } from "../constants";
import type {
  ColumnColorOverrides,
  ColumnDisplayMode,
  ColumnKey,
  ColumnMenuMeta,
  ColumnWidthOverrides,
  UiLanguage,
  WorkReportEntryFieldMutationOperation,
  WorkReportFormId,
} from "../types";
import { getColumnHeaderLocaleText, parseSemanticBoolean } from "../utils";
import { formatPlannedEndDateDisplay } from "../utils/plannedEndDateUtils";
import {
  useWorkReportColumnMenuContent,
  type WorkReportColumnsMenuActions,
  type WorkReportColumnsMenuState,
} from "./useWorkReportColumnMenuContent";
import { buildFormAwareColumns } from "./workReportColumnDefinitions";
import { WorkReportSortOrderCell } from "../components/WorkReportSortOrderCell";
import { WorkReportColumnMenuPopoverTrigger } from "../components/WorkReportColumnMenuPopoverTrigger";
import { WorkReportPlannedEndDateCell } from "../components/WorkReportPlannedEndDateCell";
import { WorkReportBooleanCell } from "../components/WorkReportBooleanCell";
import { WorkReportMainMachineCell } from "../components/WorkReportMainMachineCell";
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
  columnOrder: ColumnKey[];
  hiddenColumnKeys: Set<ColumnKey>;
  columnColors: ColumnColorOverrides;
  onColumnResizeStart: (
    columnKey: ColumnKey,
    currentWidth: number,
    event: ReactPointerEvent<HTMLSpanElement>
  ) => void;
  disableFixedColumns?: boolean;
  uiLanguage: UiLanguage;
  onOpenDetail: (entryId: string) => void;
  onUpdateStartSchedule: (record: WorkReportRecord, startSchedule: boolean) => Promise<void>;
  onUpdateMainMachine: (record: WorkReportRecord, machineCode: string) => Promise<void>;
  onUpdateUrgent: (record: WorkReportRecord, urgent: boolean) => Promise<void>;
  onUpdateSortOrder: (record: WorkReportRecord, sortOrder: number) => Promise<void>;
  onUpdatePlannedEndDate: (record: WorkReportRecord, plannedEndDate: string) => Promise<void>;
  entryFieldMutationSyncingEntryIdsByOperation: ReadonlyMap<
    WorkReportEntryFieldMutationOperation,
    ReadonlySet<string>
  >;
  entryFieldMutationBlockedEntryIds: ReadonlySet<string>;
  machineOptions: FormOptionItem[];
  globalSearchKeyword: string;
  menuState: WorkReportColumnsMenuState;
  menuActions: WorkReportColumnsMenuActions & {
    handleColumnMenuOpenChange: (
      columnKey: ColumnKey,
      ownerId: string,
      nextOpen: boolean
    ) => void;
  };
}

type EntryFieldSyncingColumnKey =
  | "startSchedule"
  | "machineCode"
  | "urgent"
  | "sortOrder"
  | "plannedEndDate";

const ENTRY_FIELD_OPERATION_BY_SYNCING_COLUMN = {
  startSchedule: "work-report-start-schedule",
  machineCode: "work-report-main-machine",
  urgent: "work-report-urgent",
  sortOrder: "work-report-sort-order",
  plannedEndDate: "work-report-planned-end-date",
} as const satisfies Readonly<
  Record<EntryFieldSyncingColumnKey, WorkReportEntryFieldMutationOperation>
>;

export function isWorkReportEntryFieldColumnSyncing(
  syncingEntryIdsByOperation: ReadonlyMap<
    WorkReportEntryFieldMutationOperation,
    ReadonlySet<string>
  >,
  columnKey: EntryFieldSyncingColumnKey,
  entryId: string
): boolean {
  return (
    syncingEntryIdsByOperation
      .get(ENTRY_FIELD_OPERATION_BY_SYNCING_COLUMN[columnKey])
      ?.has(entryId) ?? false
  );
}

export function getWorkReportColumnInteractionKey(
  formId: WorkReportFormId,
  columnKey: ColumnKey
): ColumnKey {
  return formId === "902" && columnKey === "machineCode"
    ? "filterMachineCode"
    : columnKey;
}

export function useWorkReportColumns(args: UseWorkReportColumnsArgs) {
  const {
    enabled = true,
    currentFormId,
    columnDisplayMode,
    columnWidthOverrides,
    columnOrder,
    hiddenColumnKeys,
    columnColors,
    onColumnResizeStart,
    disableFixedColumns = false,
    uiLanguage,
    onOpenDetail,
    onUpdateStartSchedule,
    onUpdateMainMachine,
    onUpdateUrgent,
    onUpdateSortOrder,
    onUpdatePlannedEndDate,
    entryFieldMutationSyncingEntryIdsByOperation,
    entryFieldMutationBlockedEntryIds,
    machineOptions,
    globalSearchKeyword,
    menuState: {
      columnFilterState,
      columnSortRules,
      columnMenuOpenKey,
      columnMenuOpenOwnerId,
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
      columnMenuOpenOwnerId,
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
      const interactionColumnKey = getWorkReportColumnInteractionKey(
        currentFormId,
        columnKey
      );
      const filterRule = columnFilterState[interactionColumnKey];
      const tokenFilterCount = filterRule?.selectedTokens?.length ?? 0;
      const hasTextFilter = Boolean(filterRule?.textQuery?.trim());
      const filterCount = tokenFilterCount > 0 ? tokenFilterCount : hasTextFilter ? 1 : 0;
      const sortIndex = columnSortRules.findIndex(
        (rule) => rule.key === interactionColumnKey
      );
      const sortRule = sortIndex >= 0 ? columnSortRules[sortIndex] : null;
      const hasActive = filterCount > 0 || Boolean(sortRule);
      const isBooleanControlColumn =
        columnKey === "startSchedule" || columnKey === "urgent";
      const localeTitle = getColumnHeaderLocaleText(columnKey, fallbackZhTitle);
      const displayTitle = uiLanguage === "en" ? localeTitle.en : localeTitle.zh;
      const visibleTitle =
        columnKey === "startSchedule" && uiLanguage !== "en"
          ? displayTitle.replace(/\?$/, "")
          : displayTitle;
      const stackStartScheduleTitle =
        columnKey === "startSchedule" &&
        uiLanguage !== "en" &&
        columnDisplayMode === "fit";
      const titleTooltip =
        localeTitle.en && localeTitle.en !== localeTitle.zh
          ? `${localeTitle.zh} / ${localeTitle.en}`
          : localeTitle.zh;
      const meta: ColumnMenuMeta = {
        key: interactionColumnKey,
        label: displayTitle,
        type: COLUMN_TYPE_MAP[interactionColumnKey] ?? "text",
      };

      return (
        <div
          className={`column-header-menu ${hasActive ? "is-active" : ""}${
            isBooleanControlColumn ? " is-boolean-control" : ""
          }`}
        >
          <Tooltip
            placement="top"
            title={titleTooltip}
            overlayClassName="work-report-header-tooltip"
          >
            <span
              className={`column-header-menu-title${
                stackStartScheduleTitle ? " is-stacked-start-schedule" : ""
              }`}
            >
              {stackStartScheduleTitle ? (
                <>
                  <span className="column-header-menu-title-line">
                    {visibleTitle.slice(0, 2)}
                  </span>
                  <span className="column-header-menu-title-line">
                    {visibleTitle.slice(2)}
                  </span>
                </>
              ) : (
                visibleTitle
              )}
            </span>
          </Tooltip>
          {sortRule && (
            <span
              className="column-header-sort-badge"
              aria-label={t("workReport:columnMenu.sortPriorityTitle", { priority: sortIndex + 1 })}
            >
              {sortRule.direction === "asc" ? "↑" : "↓"}
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
          <WorkReportColumnMenuPopoverTrigger
            columnKey={interactionColumnKey}
            activeColumnKey={columnMenuOpenKey}
            activeOwnerId={columnMenuOpenOwnerId}
            content={renderColumnMenuContent(meta)}
            hasActive={hasActive}
            label={t("workReport:columnMenu.columnMenuAria", { label: displayTitle })}
            sortPriority={sortRule ? sortIndex + 1 : null}
            onOpenChange={handleColumnMenuOpenChange}
          />
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
      columnDisplayMode,
      currentFormId,
      uiLanguage,
      t,
      columnMenuOpenKey,
      columnMenuOpenOwnerId,
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
    const renderMachineCodeChip = (
      value: unknown,
      variant: "current" | "previous"
    ): ReactNode => {
      const normalizedValue = String(value ?? "").trim();
      return (
        <span className={textCellClassName}>
          {normalizedValue ? (
            <span
              className={`machine-code-chip machine-code-chip--${variant}`}
              title={normalizedValue}
            >
              {renderHighlightedText(normalizedValue)}
            </span>
          ) : (
            "-"
          )}
        </span>
      );
    };
    const renderMachineValue = (_value: unknown, record: WorkReportRecord): ReactNode => {
      const displayValue = String(record.machineCode ?? "").trim();
      const filterValue = String(record.filterMachineCode ?? "").trim();
      const editableValue = currentFormId === "902" ? filterValue : displayValue;
      return (
        <WorkReportMainMachineCell
          value={editableValue}
          record={record}
          displayValue={renderMachineCodeChip(editableValue, "current")}
          options={machineOptions}
          onSubmit={onUpdateMainMachine}
          syncing={isWorkReportEntryFieldColumnSyncing(
            entryFieldMutationSyncingEntryIdsByOperation,
            "machineCode",
            String(record.id)
          )}
          blocked={entryFieldMutationBlockedEntryIds.has(String(record.id))}
        />
      );
    };
    const renderPreviousMachineValue = (value: unknown): ReactNode =>
      renderMachineCodeChip(value, "previous");
    const urgentLabel = uiLanguage === "en" ? "Urgent" : "急件";
    const startScheduleLabel = uiLanguage === "en" ? "Start Schedule" : "開始排程";
    const renderWorkOrderValue = (value: unknown, record: WorkReportRecord): ReactNode => {
      const text = renderHighlightedText(value);
      const workOrderNo = String(value ?? "").trim();
      const entryId = String(record.id);
      const isUrgent = parseSemanticBoolean(record.urgent) === true;
      return (
        <button
          type="button"
          className={`work-order-cell-button ${columnDisplayMode === "fit" ? "is-fit" : ""}`}
          title={workOrderNo || undefined}
          onClick={(event) => {
            event.stopPropagation();
            onOpenDetail(entryId);
          }}
        >
          <span
            className={`work-order-cell-content ${isUrgent ? "is-urgent" : ""}`}
          >
            <span className="work-order-cell-text">{text}</span>
            {isUrgent ? (
              <span
                className="work-order-urgent-flame"
                aria-label={urgentLabel}
                title={urgentLabel}
              >
                <FireFilled aria-hidden="true" />
              </span>
            ) : null}
          </span>
        </button>
      );
    };
    const renderSortOrderValue = (
      value: unknown,
      record: WorkReportRecord
    ): ReactNode => (
      <WorkReportSortOrderCell
        value={value}
        record={record}
        displayValue={renderHighlightedText(value)}
        onSubmit={onUpdateSortOrder}
        syncing={isWorkReportEntryFieldColumnSyncing(
          entryFieldMutationSyncingEntryIdsByOperation,
          "sortOrder",
          String(record.id)
        )}
        blocked={entryFieldMutationBlockedEntryIds.has(String(record.id))}
      />
    );
    const renderPlannedEndDateValue = (
      value: unknown,
      record: WorkReportRecord
    ): ReactNode => (
      <WorkReportPlannedEndDateCell
        value={value}
        record={record}
        displayValue={renderHighlightedText(formatPlannedEndDateDisplay(value))}
        onSubmit={onUpdatePlannedEndDate}
        syncing={isWorkReportEntryFieldColumnSyncing(
          entryFieldMutationSyncingEntryIdsByOperation,
          "plannedEndDate",
          String(record.id)
        )}
        blocked={entryFieldMutationBlockedEntryIds.has(String(record.id))}
      />
    );
    const renderStartScheduleValue = (
      value: unknown,
      record: WorkReportRecord
    ): ReactNode => (
      <WorkReportBooleanCell
        value={value}
        record={record}
        label={startScheduleLabel}
        onSubmit={onUpdateStartSchedule}
        syncing={isWorkReportEntryFieldColumnSyncing(
          entryFieldMutationSyncingEntryIdsByOperation,
          "startSchedule",
          String(record.id)
        )}
        blocked={entryFieldMutationBlockedEntryIds.has(String(record.id))}
        editable={currentFormId === "901"}
      />
    );
    const renderUrgentValue = (value: unknown, record: WorkReportRecord): ReactNode => (
      <WorkReportBooleanCell
        value={value}
        record={record}
        label={urgentLabel}
        onSubmit={onUpdateUrgent}
        syncing={isWorkReportEntryFieldColumnSyncing(
          entryFieldMutationSyncingEntryIdsByOperation,
          "urgent",
          String(record.id)
        )}
        blocked={entryFieldMutationBlockedEntryIds.has(String(record.id))}
        urgent
      />
    );
    const formAwareColumns = buildFormAwareColumns({
      currentFormId,
      columnDisplayMode,
      renderValue,
      renderMachineValue,
      renderPreviousMachineValue,
      renderWorkOrderValue,
      renderSortOrderValue,
      renderPlannedEndDateValue,
      renderStartSchedule: renderStartScheduleValue,
      renderUrgent: renderUrgentValue,
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
    onUpdateStartSchedule,
    onUpdateMainMachine,
    onUpdateUrgent,
    onUpdateSortOrder,
    onUpdatePlannedEndDate,
    entryFieldMutationSyncingEntryIdsByOperation,
    entryFieldMutationBlockedEntryIds,
    machineOptions,
    uiLanguage,
  ]);

  const columns = useMemo<ColumnsType<WorkReportRecord>>(() => {
    const visibleBaseColumns = baseColumns
      .filter((column) => {
        const isDataColumn =
          "dataIndex" in column &&
          typeof column.dataIndex === "string" &&
          String(column.key ?? "") !== "scheduleAction";

        if (!isDataColumn) {
          return true;
        }

        return !hiddenColumnKeys.has(column.dataIndex as ColumnKey);
      });
    const baseDataColumnKeys = visibleBaseColumns
      .map((column) =>
        "dataIndex" in column && typeof column.dataIndex === "string"
          ? (column.dataIndex as ColumnKey)
          : null
      )
      .filter((key): key is ColumnKey => key !== null);
    const visibleOrder = columnOrder.filter((key) => !hiddenColumnKeys.has(key));
    const hasCustomOrder =
      visibleOrder.length === baseDataColumnKeys.length &&
      visibleOrder.some((key, index) => key !== baseDataColumnKeys[index]);
    const orderRank = new Map(visibleOrder.map((key, index) => [key, index]));

    return visibleBaseColumns
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

        const columnKey = column.dataIndex as ColumnKey;
        const titleText = typeof column.title === "string" ? column.title : String(column.dataIndex);
        const color = columnColors[columnKey];
        const toneClassName = color && color !== "none"
          ? `work-report-column-tone--${color}`
          : "";

        return {
          ...column,
          className: [column.className, toneClassName].filter(Boolean).join(" ") || undefined,
          width:
            typeof columnWidthOverrides[columnKey] === "number"
              ? columnWidthOverrides[columnKey]
              : column.width,
          fixed: disableFixedColumns || hasCustomOrder ? undefined : column.fixed,
          onHeaderCell: () => ({
            className: toneClassName || undefined,
          }),
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
      })
      .sort((left, right) => {
        const leftKey =
          "dataIndex" in left && typeof left.dataIndex === "string"
            ? (left.dataIndex as ColumnKey)
            : null;
        const rightKey =
          "dataIndex" in right && typeof right.dataIndex === "string"
            ? (right.dataIndex as ColumnKey)
            : null;
        if (leftKey === null) {
          return rightKey === null ? 0 : 1;
        }
        if (rightKey === null) {
          return -1;
        }
        return (orderRank.get(leftKey) ?? Number.MAX_SAFE_INTEGER) -
          (orderRank.get(rightKey) ?? Number.MAX_SAFE_INTEGER);
      });
  }, [
    baseColumns,
    columnColors,
    columnOrder,
    columnWidthOverrides,
    disableFixedColumns,
    hiddenColumnKeys,
    renderColumnHeaderWithMenu,
  ]);

  return { columns };
}

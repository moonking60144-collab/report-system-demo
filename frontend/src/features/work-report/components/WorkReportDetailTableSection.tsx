import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { FixedHorizontalScrollbar } from "./FixedHorizontalScrollbar";
import type { FormState } from "../../../components/report-form/types";
import type { DetailTableRow, InlineEditableDetailKey } from "../hooks/detail/types";
import { showClosedLockWarning } from "../utils/closedLockWarning";

interface DetailColumnDefinitionLike {
  key: string;
  label: ReactNode;
  className?: string;
  renderCell: (item: DetailTableRow) => ReactNode;
  isToggleable?: boolean;
}

interface ToggleableDetailColumnLike {
  key: string;
  label: ReactNode;
}

interface BatchCreateFillDragStateLike {
  sourceRowId: string;
  sourceKey: InlineEditableDetailKey;
  endKey: InlineEditableDetailKey;
  startIndex: number;
  endIndex: number;
}

interface DisplayDetailRowMeta {
  previousDate: string;
  currentDate: string;
  groupIndex: number;
}

interface BatchCreateFillPreviewRowMeta {
  isPreviewRow: boolean;
  isPreviewEndRow: boolean;
  previewLabel: string | null;
}

interface WorkReportDetailTableSectionProps {
  detailRowsCount: number;
  batchCreateMode: boolean;
  batchCreateDraftCount: number;
  batchDeleteMode: boolean;
  allBatchDeleteRowsSelected: boolean;
  selectedBatchDeleteCount: number;
  editingRowId: string | null;
  savingRowId: string | null;
  /** 當前所有列產量 draft 的 signature，用於判斷是否需要重算預估累計量 */
  predictionSignature: string;
  /** inline 編輯中列的 draft signature；draft 任一欄位變動就重新產生，
   *  讓被 memo 化的 row 能在使用者打字時跟著 re-render。
   *  Why: DetailTableRowView 用 columnKeysSignature + renderContextKey 當 memo key，
   *  兩者皆不反映 draft 內容，如果沒有這條訊號，inline 時間/數量輸入會卡在 stale closure */
  editingRowDraftSignature: string;
  loading: boolean;
  refreshing: boolean;
  submitting: boolean;
  hasActiveMutationTask: boolean;
  hasBlockingMutationTask: boolean;
  modalOpen: boolean;
  workOrderClosing: boolean;
  recordStatus?: string | null;
  highlightedDetailRowId: string | null;
  renderedDetailColumns: ReadonlyArray<DetailColumnDefinitionLike>;
  toggleableDetailColumns: ReadonlyArray<ToggleableDetailColumnLike>;
  hiddenColumnKeys: ReadonlySet<string>;
  displayDetailRows: ReadonlyArray<DetailTableRow>;
  displayDetailRowMetaByRowId: Map<string, DisplayDetailRowMeta>;
  detailTableScrollRef: RefObject<HTMLDivElement | null>;
  batchCreateFillDrag: BatchCreateFillDragStateLike | null;
  batchCreateFieldErrorsByRowId: Record<string, Partial<Record<InlineEditableDetailKey, string>>>;
  inlineEditableColumnKeySet: ReadonlySet<InlineEditableDetailKey>;
  autoHighlightedInlineKeys: readonly InlineEditableDetailKey[];
  selectedBatchDeleteRowIds: ReadonlySet<string>;
  getBatchCreateFillPreviewRowMeta: (rowId: string) => BatchCreateFillPreviewRowMeta;
  getBatchCreateDraftForRow: (rowId: string) => FormState | null;
  resolveBatchCreateFillKeys: (
    sourceKey: InlineEditableDetailKey,
    endKey: InlineEditableDetailKey
  ) => InlineEditableDetailKey[];
  isBatchCreateFillPreviewCell: (rowId: string, key: InlineEditableDetailKey) => boolean;
  onFillPreviewHover: (rowId: string, key: InlineEditableDetailKey) => void;
  onDetailRowClick: (event: ReactMouseEvent<HTMLTableRowElement>, row: DetailTableRow) => void;
  onDetailTableKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onToggleColumnVisibility: (columnKey: string) => void;
  onShowAllColumns: () => void;
  onResetDefaultColumns: () => void;
  onRefresh: () => void;
  onOpenTaskQueue: () => void;
  onToggleSelectAllBatchDeleteRows: () => void;
  onClearBatchDeleteSelection: () => void;
  onHandleBatchDelete: () => void;
  onCancelBatchDeleteMode: () => void;
  onSaveBatchCreate: () => void;
  onCancelBatchCreate: () => void;
  onClearBatchCreate: () => void;
  onEnterBatchDeleteMode: () => void;
  onOpenMainMachineModal: () => void;
  onHandleManualCloseWorkOrder: (action: "close" | "reopen") => void;
  onOpenCreateModal: () => void;
}

function isCreatePlaceholderRow(row: DetailTableRow): boolean {
  return Boolean(row.__placeholder);
}

function isPlannedIdleYesValue(value: unknown): boolean {
  return String(value ?? "").trim() === "Yes";
}

function upperBound(sortedValues: number[], target: number): number {
  let low = 0;
  let high = sortedValues.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (sortedValues[mid] <= target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function findRowIndexForOffset(rowOffsets: number[], target: number): number {
  if (rowOffsets.length <= 1) {
    return 0;
  }
  const upperIndex = upperBound(rowOffsets, target);
  return Math.max(0, Math.min(rowOffsets.length - 2, upperIndex - 1));
}

interface DetailTableRowViewProps {
  item: DetailTableRow;
  placeholderRow: boolean;
  rowClassName?: string;
  isEditing: boolean;
  isSelected: boolean;
  renderedDetailColumns: ReadonlyArray<DetailColumnDefinitionLike>;
  fillPreviewMeta: BatchCreateFillPreviewRowMeta;
  rowDraft: FormState | null;
  rowFieldErrors: Partial<Record<InlineEditableDetailKey, string>> | null;
  fillPreviewKeys: readonly InlineEditableDetailKey[];
  firstFillPreviewKey: InlineEditableDetailKey | null;
  lastFillPreviewKey: InlineEditableDetailKey | null;
  batchCreateMode: boolean;
  batchDeleteMode: boolean;
  batchCreateFillSourceRowId: string | null;
  batchCreateFillEndKey: InlineEditableDetailKey | null;
  inlineEditableColumnKeySet: ReadonlySet<InlineEditableDetailKey>;
  autoHighlightedInlineKeys: readonly InlineEditableDetailKey[];
  isBatchCreateFillPreviewCell: (rowId: string, key: InlineEditableDetailKey) => boolean;
  onFillPreviewHover: (rowId: string, key: InlineEditableDetailKey) => void;
  onDetailRowClick: (event: ReactMouseEvent<HTMLTableRowElement>, row: DetailTableRow) => void;
  /** 把所有會影響此 row render 結果的訊號 pack 成單一字串，memo equality 只比這個 key。
   *  Why: 原本 20+ 行手寫 === 比對，加新 prop 必須手動回來補一條，漏掉就 stale render
   *       （editingRowDraft 卡死就是這樣發生的）。
   *  How to apply: 新增影響 row render 的訊號 → 加進 parent 的 key builder；memo comparator 本身不用動。 */
  rowMemoKey: string;
}

const DetailTableRowView = memo(function DetailTableRowView({
  item,
  placeholderRow,
  rowClassName,
  isEditing,
  isSelected,
  renderedDetailColumns,
  fillPreviewMeta,
  rowFieldErrors,
  fillPreviewKeys,
  firstFillPreviewKey,
  lastFillPreviewKey,
  batchCreateMode,
  batchDeleteMode,
  batchCreateFillSourceRowId,
  batchCreateFillEndKey,
  inlineEditableColumnKeySet,
  autoHighlightedInlineKeys,
  isBatchCreateFillPreviewCell,
  onFillPreviewHover,
  onDetailRowClick,
}: DetailTableRowViewProps) {
  const normalizedRowClassName = rowClassName?.trim() || undefined;

  return (
    <tr
      data-row-id={item.rowId}
      data-row-kind={placeholderRow ? "create-placeholder" : "detail"}
      className={[
        normalizedRowClassName,
        isEditing ? "is-inline-editing" : "",
      ]
        .filter(Boolean)
        .join(" ")
        .trim() || undefined}
      aria-selected={isSelected ? true : undefined}
      onClick={(event) => onDetailRowClick(event, item)}
      onDoubleClick={batchDeleteMode ? undefined : (event) => onDetailRowClick(event, item)}
    >
      {renderedDetailColumns.map((column) => {
        const columnKey = column.key as InlineEditableDetailKey;
        const isFillBoundaryLeft =
          fillPreviewKeys.includes(columnKey) && firstFillPreviewKey === columnKey;
        const isFillBoundaryRight =
          fillPreviewKeys.includes(columnKey) && lastFillPreviewKey === columnKey;
        const isFillSourceCell =
          batchCreateMode &&
          batchCreateFillSourceRowId === item.rowId &&
          fillPreviewKeys.includes(columnKey);
        const isFillPreviewCell =
          batchCreateMode &&
          isBatchCreateFillPreviewCell(item.rowId, columnKey);
        const isFillPreviewEndCell =
          isFillPreviewCell &&
          fillPreviewMeta.isPreviewEndRow &&
          batchCreateFillEndKey === columnKey;
        const isFillRectCell = isFillSourceCell || isFillPreviewCell;

        return (
          <td
            key={`${item.rowId}-${column.key}`}
            data-inline-cell-key={column.key}
            data-fill-preview-label={
              isFillPreviewEndCell ? fillPreviewMeta.previewLabel ?? undefined : undefined
            }
            className={[
              column.className,
              isFillSourceCell ? "detail-inline-fill-source" : "",
              isFillPreviewCell ? "detail-inline-fill-preview" : "",
              isFillRectCell ? "detail-inline-fill-rect" : "",
              isFillRectCell && isFillBoundaryLeft ? "detail-inline-fill-rect-left" : "",
              isFillRectCell && isFillBoundaryRight ? "detail-inline-fill-rect-right" : "",
              isFillSourceCell ? "detail-inline-fill-rect-top" : "",
              isFillPreviewCell && fillPreviewMeta.isPreviewEndRow
                ? "detail-inline-fill-rect-bottom"
                : "",
              isFillPreviewEndCell ? "detail-inline-fill-preview-end" : "",
              batchCreateMode &&
              Boolean(rowFieldErrors?.[columnKey])
                ? "detail-inline-batch-error"
                : "",
              inlineEditableColumnKeySet.has(columnKey) && isEditing
                ? "detail-inline-editor-cell"
                : "",
              inlineEditableColumnKeySet.has(columnKey) &&
              isEditing &&
              autoHighlightedInlineKeys.includes(columnKey)
                ? "detail-inline-autofill-highlight"
                : "",
            ]
              .filter(Boolean)
              .join(" ")
              .trim() || undefined}
            onMouseEnter={() => {
              if (!batchCreateMode || !batchCreateFillSourceRowId || !placeholderRow) {
                return;
              }
              onFillPreviewHover(item.rowId, columnKey);
            }}
          >
            {column.renderCell(item)}
          </td>
        );
      })}
    </tr>
  );
},
function areDetailTableRowViewPropsEqual(
  previous: Readonly<DetailTableRowViewProps>,
  next: Readonly<DetailTableRowViewProps>
) {
  // 所有會影響 render 的訊號已 pack 進 rowMemoKey；item / rowDraft 是 per-row ref 所以單獨比。
  // 加新 prop 請去 parent 的 key builder 補，不要回頭加 === 在這。
  return (
    previous.item === next.item &&
    previous.rowDraft === next.rowDraft &&
    previous.rowMemoKey === next.rowMemoKey
  );
});

export const WorkReportDetailTableSection = memo(function WorkReportDetailTableSection({
  detailRowsCount,
  batchCreateMode,
  batchCreateDraftCount,
  batchDeleteMode,
  allBatchDeleteRowsSelected,
  selectedBatchDeleteCount,
  editingRowId,
  savingRowId,
  predictionSignature,
  editingRowDraftSignature,
  loading,
  refreshing,
  submitting,
  hasActiveMutationTask,
  hasBlockingMutationTask,
  modalOpen,
  workOrderClosing,
  recordStatus,
  highlightedDetailRowId,
  renderedDetailColumns,
  toggleableDetailColumns,
  hiddenColumnKeys,
  displayDetailRows,
  displayDetailRowMetaByRowId,
  detailTableScrollRef,
  batchCreateFillDrag,
  batchCreateFieldErrorsByRowId,
  inlineEditableColumnKeySet,
  autoHighlightedInlineKeys,
  selectedBatchDeleteRowIds,
  getBatchCreateFillPreviewRowMeta,
  getBatchCreateDraftForRow,
  resolveBatchCreateFillKeys,
  isBatchCreateFillPreviewCell,
  onFillPreviewHover,
  onDetailRowClick,
  onDetailTableKeyDown,
  onToggleColumnVisibility,
  onShowAllColumns,
  onResetDefaultColumns,
  onRefresh,
  onOpenTaskQueue,
  onToggleSelectAllBatchDeleteRows,
  onClearBatchDeleteSelection,
  onHandleBatchDelete,
  onCancelBatchDeleteMode,
  onSaveBatchCreate,
  onCancelBatchCreate,
  onClearBatchCreate,
  onEnterBatchDeleteMode,
  onOpenMainMachineModal,
  onHandleManualCloseWorkOrder,
  onOpenCreateModal,
}: WorkReportDetailTableSectionProps) {
  const { i18n, t } = useTranslation(["workReport", "common"]);
  const [columnSettingsOpen, setColumnSettingsOpen] = useState(false);
  const [virtualScrollTop, setVirtualScrollTop] = useState(0);
  const [virtualViewportHeight, setVirtualViewportHeight] = useState(0);
  const columnSettingsRef = useRef<HTMLDivElement | null>(null);
  const effectiveColumnSettingsOpen =
    columnSettingsOpen && !batchDeleteMode && !batchCreateMode;

  useEffect(() => {
    if (!effectiveColumnSettingsOpen) {
      return;
    }
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target;
      if (!columnSettingsRef.current || !(target instanceof Node)) {
        return;
      }
      if (!columnSettingsRef.current.contains(target)) {
        setColumnSettingsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [effectiveColumnSettingsOpen]);

  const fillPreviewKeys = useMemo(
    () =>
      batchCreateFillDrag
        ? resolveBatchCreateFillKeys(batchCreateFillDrag.sourceKey, batchCreateFillDrag.endKey)
        : [],
    [batchCreateFillDrag, resolveBatchCreateFillKeys]
  );
  const firstFillPreviewKey = fillPreviewKeys[0] ?? null;
  const lastFillPreviewKey =
    fillPreviewKeys.length > 0 ? fillPreviewKeys[fillPreviewKeys.length - 1] : null;
  const fillPreviewKeysSignature = useMemo(
    () => fillPreviewKeys.join("|"),
    [fillPreviewKeys]
  );
  const autoHighlightedKeySignature = useMemo(
    () => autoHighlightedInlineKeys.join("|"),
    [autoHighlightedInlineKeys]
  );
  const rowEstimateHeights = useMemo(
    () =>
      displayDetailRows.map((item) => {
        const placeholderRow = isCreatePlaceholderRow(item);
        const draftedRow = Boolean(getBatchCreateDraftForRow(item.rowId));
        if (editingRowId === item.rowId) {
          return placeholderRow ? 96 : 104;
        }
        if (placeholderRow) {
          return draftedRow ? 62 : 48;
        }
        return 52;
      }),
    [displayDetailRows, editingRowId, getBatchCreateDraftForRow]
  );
  const rowOffsets = useMemo(() => {
    const offsets = [0];
    for (const height of rowEstimateHeights) {
      offsets.push(offsets[offsets.length - 1] + height);
    }
    return offsets;
  }, [rowEstimateHeights]);
  const totalVirtualHeight = rowOffsets[rowOffsets.length - 1] ?? 0;
  const shouldVirtualizeRows =
    displayDetailRows.length >= 40 && virtualViewportHeight > 0;

  useLayoutEffect(() => {
    const scrollRoot = detailTableScrollRef.current;
    if (!scrollRoot) {
      return;
    }

    const syncMetrics = () => {
      setVirtualScrollTop(scrollRoot.scrollTop);
      setVirtualViewportHeight(scrollRoot.clientHeight);
    };

    syncMetrics();
    scrollRoot.addEventListener("scroll", syncMetrics, { passive: true });
    const resizeObserver = new ResizeObserver(() => {
      syncMetrics();
    });
    resizeObserver.observe(scrollRoot);

    return () => {
      scrollRoot.removeEventListener("scroll", syncMetrics);
      resizeObserver.disconnect();
    };
  }, [detailTableScrollRef]);

  const virtualWindow = useMemo(() => {
    if (!shouldVirtualizeRows) {
      return {
        startIndex: 0,
        endIndexExclusive: displayDetailRows.length,
        topSpacerHeight: 0,
        bottomSpacerHeight: 0,
        rows: displayDetailRows,
      };
    }

    const overscanPx = Math.max(virtualViewportHeight, 320);
    let startIndex = findRowIndexForOffset(
      rowOffsets,
      Math.max(0, virtualScrollTop - overscanPx)
    );
    let endIndexExclusive =
      findRowIndexForOffset(
        rowOffsets,
        virtualScrollTop + virtualViewportHeight + overscanPx
      ) + 1;

    const forceVisibleRowIds = [
      editingRowId,
      highlightedDetailRowId,
      batchCreateFillDrag?.sourceRowId ?? null,
    ].filter((value): value is string => Boolean(value));

    for (const rowId of forceVisibleRowIds) {
      const forcedIndex = displayDetailRows.findIndex((row) => row.rowId === rowId);
      if (forcedIndex === -1) {
        continue;
      }
      startIndex = Math.min(startIndex, forcedIndex);
      endIndexExclusive = Math.max(endIndexExclusive, forcedIndex + 1);
    }

    startIndex = Math.max(0, startIndex);
    endIndexExclusive = Math.min(displayDetailRows.length, endIndexExclusive);

    return {
      startIndex,
      endIndexExclusive,
      topSpacerHeight: rowOffsets[startIndex] ?? 0,
      bottomSpacerHeight:
        totalVirtualHeight - (rowOffsets[endIndexExclusive] ?? totalVirtualHeight),
      rows: displayDetailRows.slice(startIndex, endIndexExclusive),
    };
  }, [
    batchCreateFillDrag?.sourceRowId,
    displayDetailRows,
    editingRowId,
    highlightedDetailRowId,
    rowOffsets,
    shouldVirtualizeRows,
    totalVirtualHeight,
    virtualScrollTop,
    virtualViewportHeight,
  ]);
  const columnKeysSignature = useMemo(
    () => renderedDetailColumns.map((column) => column.key).join("|"),
    [renderedDetailColumns]
  );
  const rowRenderContextKey = useMemo(
    () =>
      [
        i18n.resolvedLanguage || i18n.language || "",
        batchCreateMode ? "1" : "0",
        batchDeleteMode ? "1" : "0",
        loading ? "1" : "0",
        refreshing ? "1" : "0",
        submitting ? "1" : "0",
        hasActiveMutationTask ? "1" : "0",
        hasBlockingMutationTask ? "1" : "0",
        modalOpen ? "1" : "0",
        workOrderClosing ? "1" : "0",
        editingRowId ?? "",
        savingRowId ?? "",
        recordStatus ?? "",
        predictionSignature,
      ].join("|"),
    [
      batchCreateMode,
      batchDeleteMode,
      editingRowId,
      hasActiveMutationTask,
      hasBlockingMutationTask,
      i18n.language,
      i18n.resolvedLanguage,
      loading,
      modalOpen,
      recordStatus,
      refreshing,
      predictionSignature,
      savingRowId,
      submitting,
      workOrderClosing,
    ]
  );

  const handleToggleColumnSettings = useCallback(() => {
    setColumnSettingsOpen((previous) => !previous);
  }, []);

  return (
    <section className="detail-table-outer" aria-label={t("workReport:table.detailRecordsTitle")}>
      <div className="detail-table-head">
        <div className="detail-table-head-main">
          <div className="detail-table-head-summary">
            <strong>{t("workReport:table.detailRecordsCount", { count: detailRowsCount })}</strong>
            {batchCreateMode ? (
              <span className="detail-editing-pill" role="status" aria-live="polite">
                {t("workReport:detailPage.batchCreateEditing", { count: batchCreateDraftCount })}
              </span>
            ) : editingRowId !== null ? (
              <span className="detail-editing-pill" role="status" aria-live="polite">
                編輯中...
              </span>
            ) : null}
          </div>
          <div className="detail-table-head-actions">
            <div className="detail-column-settings" ref={columnSettingsRef}>
              <button
                type="button"
                className="detail-column-settings-btn"
                onClick={handleToggleColumnSettings}
                aria-expanded={effectiveColumnSettingsOpen}
                aria-label={t("workReport:table.columnSettingsButton")}
                disabled={batchDeleteMode || batchCreateMode}
              >
                ⚙ {t("workReport:table.columnSettingsButton")}
              </button>
              {effectiveColumnSettingsOpen && (
                <section className="detail-column-settings-panel">
                  <strong className="detail-column-settings-title">
                    {t("workReport:table.columnSettingsTitle")}
                  </strong>
                  <p className="detail-column-settings-hint">
                    {t("workReport:table.columnSettingsHint")}
                  </p>
                  <div className="detail-column-settings-actions">
                    <button
                      type="button"
                      className="detail-column-settings-action-btn"
                      onClick={onShowAllColumns}
                      disabled={batchDeleteMode || batchCreateMode}
                    >
                      {t("workReport:table.columnSettingsShowAll")}
                    </button>
                    <button
                      type="button"
                      className="detail-column-settings-action-btn"
                      onClick={onResetDefaultColumns}
                      disabled={batchDeleteMode || batchCreateMode}
                    >
                      {t("workReport:table.columnSettingsResetDefault")}
                    </button>
                  </div>
                  <div className="detail-column-settings-list">
                    {toggleableDetailColumns.map((column) => {
                      const checked = !hiddenColumnKeys.has(column.key);
                      return (
                        <label key={`column-toggle-${column.key}`} className="detail-column-settings-item">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => onToggleColumnVisibility(column.key)}
                            disabled={batchDeleteMode || batchCreateMode}
                          />
                          <span>{column.label}</span>
                        </label>
                      );
                    })}
                  </div>
                </section>
              )}
            </div>
            <button
              type="button"
              onClick={onRefresh}
              disabled={
                batchDeleteMode ||
                batchCreateMode ||
                loading ||
                refreshing ||
                submitting ||
                hasActiveMutationTask
              }
            >
              {t("workReport:detailPage.refresh")}
            </button>
            <button
              type="button"
              className="detail-page-task-btn"
              onClick={onOpenTaskQueue}
              disabled={batchDeleteMode || batchCreateMode || loading || refreshing}
            >
              {t("workReport:taskQueue.button")}
            </button>
            {batchDeleteMode ? (
              <>
                <button
                  type="button"
                  onClick={onToggleSelectAllBatchDeleteRows}
                  disabled={loading || refreshing || submitting}
                >
                  {allBatchDeleteRowsSelected
                    ? t("workReport:detailPage.clearBatchSelection")
                    : t("workReport:detailPage.selectAllOnPage")}
                </button>
                <button
                  type="button"
                  onClick={onClearBatchDeleteSelection}
                  disabled={selectedBatchDeleteCount === 0}
                >
                  {t("workReport:detailPage.clearBatchSelection")}
                </button>
                <button
                  type="button"
                  className="detail-delete-btn"
                  onClick={onHandleBatchDelete}
                  disabled={selectedBatchDeleteCount === 0 || submitting}
                >
                  {t("workReport:detailPage.batchDeleteAction", { count: selectedBatchDeleteCount })}
                </button>
                <button type="button" onClick={onCancelBatchDeleteMode}>
                  {t("common:actions.cancel")}
                </button>
              </>
            ) : batchCreateMode ? (
              <>
                <button
                  type="button"
                  className="detail-batch-create-save-btn"
                  onClick={onSaveBatchCreate}
                  disabled={submitting}
                >
                  {submitting ? t("common:actions.saving") : t("common:actions.save")}
                </button>
                <button
                  type="button"
                  className="detail-batch-create-cancel-btn"
                  onClick={onCancelBatchCreate}
                  disabled={submitting}
                >
                  {t("common:actions.cancel")}
                </button>
                <button
                  type="button"
                  className="detail-clear-btn"
                  onClick={onClearBatchCreate}
                  disabled={submitting}
                >
                  {t("workReport:reportForm.actions.clearAll")}
                </button>
              </>
            ) : (
              <button
                type="button"
                className={`detail-delete-btn${recordStatus === "已結案" ? " is-locked" : ""}`}
                onClick={() => {
                  if (recordStatus === "已結案") {
                    showClosedLockWarning(t("workReport:detailPage.closedLockedMessage"));
                    return;
                  }
                  onEnterBatchDeleteMode();
                }}
                disabled={loading || refreshing || submitting || hasActiveMutationTask}
              >
                {t("workReport:detailPage.batchDeleteButton")}
              </button>
            )}
            <button
              type="button"
              className={recordStatus === "已結案" ? "is-locked" : undefined}
              onClick={() => {
                if (recordStatus === "已結案") {
                  showClosedLockWarning(t("workReport:detailPage.closedLockedMessage"));
                  return;
                }
                onOpenMainMachineModal();
              }}
              disabled={
                batchDeleteMode ||
                batchCreateMode ||
                loading ||
                refreshing ||
                submitting ||
                hasActiveMutationTask ||
                editingRowId !== null ||
                modalOpen
              }
            >
              {t("workReport:detailPage.changeMainMachine")}
            </button>
            {recordStatus === "已結案" ? (
              <button
                type="button"
                className="detail-page-reopen-btn"
                onClick={() => onHandleManualCloseWorkOrder("reopen")}
                disabled={
                  workOrderClosing ||
                  batchCreateMode ||
                  loading ||
                  refreshing ||
                  submitting ||
                  hasActiveMutationTask ||
                  editingRowId !== null ||
                  modalOpen
                }
              >
                {workOrderClosing ? t("common:actions.saving") : t("workReport:detailPage.manualReopen")}
              </button>
            ) : (
              <button
                type="button"
                className="detail-page-close-btn"
                onClick={() => onHandleManualCloseWorkOrder("close")}
                disabled={
                  workOrderClosing ||
                  batchCreateMode ||
                  loading ||
                  refreshing ||
                  submitting ||
                  hasActiveMutationTask ||
                  editingRowId !== null ||
                  modalOpen
                }
              >
                {workOrderClosing ? t("common:actions.saving") : t("workReport:detailPage.manualClose")}
              </button>
            )}
            <button
              type="button"
              className={`detail-page-primary-btn${recordStatus === "已結案" ? " is-locked" : ""}`}
              onClick={() => {
                if (recordStatus === "已結案") {
                  showClosedLockWarning(t("workReport:detailPage.closedLockedMessage"));
                  return;
                }
                onOpenCreateModal();
              }}
              disabled={
                batchDeleteMode ||
                batchCreateMode ||
                loading ||
                refreshing ||
                submitting ||
                hasBlockingMutationTask
              }
            >
              {t("common:actions.addDetail")}
            </button>
          </div>
        </div>
      </div>
      <div className="detail-table-wrap">
        <div
          ref={detailTableScrollRef}
          className="detail-table-scroll"
          onKeyDown={onDetailTableKeyDown}
        >
          <table className="subtable detail-subtable">
            <thead>
              <tr>
                {renderedDetailColumns.map((column) => (
                  <th key={`header-${column.key}`} className={column.className} title={String(column.label)}>
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {virtualWindow.topSpacerHeight > 0 ? (
                <tr aria-hidden="true" className="detail-virtual-spacer-row">
                  <td colSpan={renderedDetailColumns.length} style={{ height: `${virtualWindow.topSpacerHeight}px` }} />
                </tr>
              ) : null}
              {virtualWindow.rows.map((item) => {
                const placeholderRow = isCreatePlaceholderRow(item);
                const fillPreviewMeta = placeholderRow
                  ? getBatchCreateFillPreviewRowMeta(item.rowId)
                  : {
                      isPreviewRow: false,
                      isPreviewEndRow: false,
                      previewLabel: null,
                    };
                const rowMeta = displayDetailRowMetaByRowId.get(item.rowId) ?? {
                  previousDate: "",
                  currentDate: "",
                  groupIndex: 0,
                };
                const { previousDate, currentDate, groupIndex } = rowMeta;
                const rowClassName = placeholderRow
                  ? [
                      "detail-editable-row",
                      "detail-create-placeholder-row",
                      batchCreateMode &&
                      Boolean(batchCreateFieldErrorsByRowId[item.rowId]) &&
                      Object.keys(batchCreateFieldErrorsByRowId[item.rowId] ?? {}).length > 0
                        ? "detail-row-batch-create-error"
                        : "",
                      batchCreateMode && getBatchCreateDraftForRow(item.rowId)
                        ? "detail-row-batch-create-drafted"
                        : "",
                      batchDeleteMode ? "detail-row-batch-selectable" : "",
                      batchDeleteMode && selectedBatchDeleteRowIds.has(item.rowId)
                        ? "detail-row-batch-selected"
                        : "",
                      highlightedDetailRowId === item.rowId ? "detail-row-highlight" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")
                      .trim() || undefined
                  : [
                      "detail-editable-row",
                      batchDeleteMode ? "detail-row-batch-selectable" : "",
                      groupIndex % 2 === 0 ? "detail-date-group-even" : "detail-date-group-odd",
                      isPlannedIdleYesValue(item.plannedIdle) ? "detail-row-planned-idle" : "",
                      batchDeleteMode && selectedBatchDeleteRowIds.has(item.rowId)
                        ? "detail-row-batch-selected"
                        : "",
                      previousDate && currentDate !== previousDate ? "detail-date-group-start" : "",
                      highlightedDetailRowId === item.rowId ? "detail-row-highlight" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")
                      .trim() || undefined;

                const rowFieldErrors = batchCreateFieldErrorsByRowId[item.rowId] ?? null;
                const isEditing = editingRowId === item.rowId;
                const isSelected = batchDeleteMode && selectedBatchDeleteRowIds.has(item.rowId);
                const batchCreateFillSourceRowId = batchCreateFillDrag?.sourceRowId ?? null;
                const batchCreateFillEndKey = batchCreateFillDrag?.endKey ?? null;
                // 所有會讓此 row 需要 re-render 的訊號都 pack 進來。新加訊號就擴這條。
                // memo comparator 只比 rowMemoKey 字串，不用分別加 === 檢查。
                const rowMemoKey = [
                  rowClassName ?? "",
                  isEditing ? "1" : "0",
                  isSelected ? "1" : "0",
                  placeholderRow ? "1" : "0",
                  Object.keys(rowFieldErrors ?? {}).sort().join(","),
                  fillPreviewKeysSignature,
                  firstFillPreviewKey ?? "",
                  lastFillPreviewKey ?? "",
                  fillPreviewMeta.isPreviewRow ? "1" : "0",
                  fillPreviewMeta.isPreviewEndRow ? "1" : "0",
                  fillPreviewMeta.previewLabel ?? "",
                  batchCreateFillSourceRowId === item.rowId ? "1" : "0",
                  batchCreateFillEndKey ?? "",
                  columnKeysSignature,
                  rowRenderContextKey,
                  autoHighlightedKeySignature,
                  // editing 特有訊號：只有編輯中的 row 需要隨 draft 變動 re-render；
                  // 非編輯 row 這欄永遠空字串，不會因為別 row 打字被連累
                  isEditing ? editingRowDraftSignature : "",
                ].join("|");

                return (
                  <DetailTableRowView
                    key={item.rowId}
                    item={item}
                    placeholderRow={placeholderRow}
                    rowClassName={rowClassName}
                    isEditing={isEditing}
                    isSelected={isSelected}
                    renderedDetailColumns={renderedDetailColumns}
                    fillPreviewMeta={fillPreviewMeta}
                    rowDraft={getBatchCreateDraftForRow(item.rowId)}
                    rowFieldErrors={rowFieldErrors}
                    fillPreviewKeys={fillPreviewKeys}
                    firstFillPreviewKey={firstFillPreviewKey}
                    lastFillPreviewKey={lastFillPreviewKey}
                    batchCreateMode={batchCreateMode}
                    batchDeleteMode={batchDeleteMode}
                    batchCreateFillSourceRowId={batchCreateFillSourceRowId}
                    batchCreateFillEndKey={batchCreateFillEndKey}
                    inlineEditableColumnKeySet={inlineEditableColumnKeySet}
                    autoHighlightedInlineKeys={autoHighlightedInlineKeys}
                    isBatchCreateFillPreviewCell={isBatchCreateFillPreviewCell}
                    onFillPreviewHover={onFillPreviewHover}
                    onDetailRowClick={onDetailRowClick}
                    rowMemoKey={rowMemoKey}
                  />
                );
              })}
              {virtualWindow.bottomSpacerHeight > 0 ? (
                <tr aria-hidden="true" className="detail-virtual-spacer-row">
                  <td
                    colSpan={renderedDetailColumns.length}
                    style={{ height: `${virtualWindow.bottomSpacerHeight}px` }}
                  />
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
      <FixedHorizontalScrollbar tableWrapRef={detailTableScrollRef} />
    </section>
  );
});

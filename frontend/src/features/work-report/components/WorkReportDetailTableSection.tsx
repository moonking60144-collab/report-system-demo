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
import { WorkReportDetailBatchCreateActions } from "./detail-table/WorkReportDetailBatchCreateActions";
import { WorkReportDetailBatchDeleteActions } from "./detail-table/WorkReportDetailBatchDeleteActions";
import { WorkReportDetailColumnSettings } from "./detail-table/WorkReportDetailColumnSettings";
import { WorkReportDetailDefaultActions } from "./detail-table/WorkReportDetailDefaultActions";
import { WorkReportDetailScrollHintButton } from "./detail-table/WorkReportDetailScrollHintButton";
import { WorkReportDetailTableSummaryBar } from "./detail-table/WorkReportDetailTableSummaryBar";

// 欄位視覺分組（沿用 i18n 既有的 reasonSection 停機原因 14 欄 / setupSection 架調車8欄）：
// 給 th/td 掛 class 上淡背景，讓「現在在填停機原因區」一眼可辨。只加 class，不動 column 定義/autofill。
const DOWNTIME_KEYS = new Set<string>([
  "plannedIdleMinutes", "unplannedIdleMinutes", "absentOrTrainingMinutes",
  "noMaterialMinutes", "waitingQcApprovalMinutes", "meetingMinutes",
  "cleaningMinutes", "rdSamplingMinutes", "supportOtherMachinesMinutes",
  "machineBreakdownMinutes", "machineAdjustmentMinutes", "othersMinutes",
  "waitingForDiesMinutes", "testingDiesMinutes",
]);
const SETUP_KEYS = new Set<string>([
  "setupAdjustType", "setupAdjustMinutes", "countSetupTimeFlag",
  "setupTimeStandardHours", "setupLossQtyPerPcs", "processLossQtyPerPcs",
  "totalContainerQty", "containerUnit",
]);
function colGroupClass(key: string): string {
  if (DOWNTIME_KEYS.has(key)) return "detail-col-downtime";
  if (SETUP_KEYS.has(key)) return "detail-col-setup";
  return "";
}

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

const DETAIL_ROW_FALLBACK_HEIGHT = 70;
const DETAIL_EDITING_ROW_FALLBACK_HEIGHT = 120;
const DETAIL_PLACEHOLDER_ROW_FALLBACK_HEIGHT = 50;
const DETAIL_PLACEHOLDER_DRAFT_ROW_FALLBACK_HEIGHT = 62;
const DETAIL_PLACEHOLDER_EDITING_ROW_FALLBACK_HEIGHT = 120;

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
  onMeasuredRowHeight: (rowId: string, height: number) => void;
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
  onMeasuredRowHeight,
  rowMemoKey,
}: DetailTableRowViewProps) {
  const normalizedRowClassName = rowClassName?.trim() || undefined;
  const rowRef = useRef<HTMLTableRowElement | null>(null);

  useLayoutEffect(() => {
    const node = rowRef.current;
    if (!node) {
      return;
    }

    const publishHeight = () => {
      const height = Math.ceil(node.getBoundingClientRect().height);
      if (height > 0) {
        onMeasuredRowHeight(item.rowId, height);
      }
    };

    publishHeight();
    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const resizeObserver = new ResizeObserver(publishHeight);
    resizeObserver.observe(node);
    return () => {
      resizeObserver.disconnect();
    };
  }, [item.rowId, onMeasuredRowHeight, rowMemoKey]);

  return (
    <tr
      ref={rowRef}
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
              colGroupClass(columnKey),
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
  // inline 編輯時追當前 focus 的欄位（事件委派讀 data-inline-cell-key）→ 表頭高亮 + 浮動標籤，
  // 解寬表格「不知道在填哪一欄」。只加這個 state，不碰 cell/autofill/批次（cell 是另一個 memo component）。
  const [focusedColKey, setFocusedColKey] = useState<string | null>(null);
  const focusedColLabel = focusedColKey
    ? renderedDetailColumns.find((c) => c.key === focusedColKey)?.label ?? null
    : null;
  const { i18n, t } = useTranslation(["workReport", "common"]);
  const [columnSettingsOpen, setColumnSettingsOpen] = useState(false);
  const [virtualScrollTop, setVirtualScrollTop] = useState(0);
  const [virtualViewportHeight, setVirtualViewportHeight] = useState(0);
  const scrollHintFrameRef = useRef<number | null>(null);
  // 雙層 scroll 的智慧鈕：接近頂顯示 ↓（帶往下）、接近底顯示 ↑（帶回頂）；點擊時 window + 表格內部一起動
  const [scrollHint, setScrollHint] = useState<"down" | "up" | null>(null);
  useEffect(() => {
    const el = detailTableScrollRef.current;
    const compute = () => {
      const tableMax = el ? el.scrollHeight - el.clientHeight : 0;
      const winMax = document.documentElement.scrollHeight - window.innerHeight;
      if (tableMax <= 40 && winMax <= 40) {
        setScrollHint(null);
        return;
      }
      const tp = tableMax > 40 ? (el?.scrollTop ?? 0) / tableMax : 0;
      const wp = winMax > 40 ? window.scrollY / winMax : 0;
      setScrollHint(Math.max(tp, wp) < 0.5 ? "down" : "up");
    };
    const scheduleCompute = () => {
      if (scrollHintFrameRef.current !== null) {
        return;
      }
      scrollHintFrameRef.current = requestAnimationFrame(() => {
        scrollHintFrameRef.current = null;
        compute();
      });
    };
    scheduleCompute();
    window.addEventListener("scroll", scheduleCompute, { passive: true });
    el?.addEventListener("scroll", scheduleCompute, { passive: true });
    return () => {
      if (scrollHintFrameRef.current !== null) {
        cancelAnimationFrame(scrollHintFrameRef.current);
        scrollHintFrameRef.current = null;
      }
      window.removeEventListener("scroll", scheduleCompute);
      el?.removeEventListener("scroll", scheduleCompute);
    };
  }, [detailTableScrollRef]);
  // sticky 卡頂：量標題列(sticky-stack)高度 → CSS 變數，讓表格區(outer)黏在它下方、高度自適應視窗
  useEffect(() => {
    const stack = document.querySelector<HTMLElement>(".detail-sticky-stack");
    if (!stack) return;
    const root = document.documentElement;
    const update = () => root.style.setProperty("--detail-sticky-stack-h", `${stack.offsetHeight}px`);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(stack);
    return () => ro.disconnect();
  }, []);
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
  const [measuredRowHeightsByRowId, setMeasuredRowHeightsByRowId] = useState<Record<string, number>>({});
  const pendingMeasuredRowHeightsRef = useRef<Record<string, number>>({});
  const measuredRowHeightFrameRef = useRef<number | null>(null);
  const handleMeasuredRowHeight = useCallback((rowId: string, height: number) => {
    pendingMeasuredRowHeightsRef.current[rowId] = height;
    if (measuredRowHeightFrameRef.current !== null) {
      return;
    }
    measuredRowHeightFrameRef.current = requestAnimationFrame(() => {
      measuredRowHeightFrameRef.current = null;
      const pending = pendingMeasuredRowHeightsRef.current;
      pendingMeasuredRowHeightsRef.current = {};
      setMeasuredRowHeightsByRowId((previous) => {
        const changedEntries = Object.entries(pending).filter(
          ([pendingRowId, pendingHeight]) => previous[pendingRowId] !== pendingHeight
        );
        return changedEntries.length > 0
          ? { ...previous, ...Object.fromEntries(changedEntries) }
          : previous;
      });
    });
  }, []);
  useEffect(() => {
    return () => {
      if (measuredRowHeightFrameRef.current !== null) {
        cancelAnimationFrame(measuredRowHeightFrameRef.current);
        measuredRowHeightFrameRef.current = null;
      }
      pendingMeasuredRowHeightsRef.current = {};
    };
  }, []);
  const rowEstimateHeights = useMemo(
    () =>
      displayDetailRows.map((item) => {
        const measuredHeight = measuredRowHeightsByRowId[item.rowId];
        if (measuredHeight) {
          return measuredHeight;
        }
        const placeholderRow = isCreatePlaceholderRow(item);
        const draftedRow = Boolean(getBatchCreateDraftForRow(item.rowId));
        if (editingRowId === item.rowId) {
          return placeholderRow
            ? DETAIL_PLACEHOLDER_EDITING_ROW_FALLBACK_HEIGHT
            : DETAIL_EDITING_ROW_FALLBACK_HEIGHT;
        }
        if (placeholderRow) {
          return draftedRow
            ? DETAIL_PLACEHOLDER_DRAFT_ROW_FALLBACK_HEIGHT
            : DETAIL_PLACEHOLDER_ROW_FALLBACK_HEIGHT;
        }
        return DETAIL_ROW_FALLBACK_HEIGHT;
      }),
    [displayDetailRows, editingRowId, getBatchCreateDraftForRow, measuredRowHeightsByRowId]
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

    let metricsFrameId: number | null = null;
    const publishMetrics = () => {
      setVirtualScrollTop(scrollRoot.scrollTop);
      setVirtualViewportHeight(scrollRoot.clientHeight);
    };
    const scheduleMetrics = () => {
      if (metricsFrameId !== null) {
        return;
      }
      metricsFrameId = requestAnimationFrame(() => {
        metricsFrameId = null;
        publishMetrics();
      });
    };

    publishMetrics();
    scrollRoot.addEventListener("scroll", scheduleMetrics, { passive: true });
    const resizeObserver = new ResizeObserver(() => {
      scheduleMetrics();
    });
    resizeObserver.observe(scrollRoot);

    return () => {
      if (metricsFrameId !== null) {
        cancelAnimationFrame(metricsFrameId);
      }
      scrollRoot.removeEventListener("scroll", scheduleMetrics);
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
  const closedLockedMessage = t("workReport:detailPage.closedLockedMessage");
  const isRecordClosed = recordStatus === "已結案";
  const detailRecordsCountText = t("workReport:table.detailRecordsCount", {
    count: detailRowsCount,
  });
  const batchCreateEditingText = batchCreateMode
    ? t("workReport:detailPage.batchCreateEditing", { count: batchCreateDraftCount })
    : null;
  const editingText = editingRowId !== null ? "編輯中..." : null;
  const focusedColHint = focusedColLabel ? `正在填：${focusedColLabel}` : null;
  const isColumnSettingsDisabled = batchDeleteMode || batchCreateMode;
  const isDefaultModeButtonDisabled = isColumnSettingsDisabled;
  const handleEnterBatchDeleteMode = useCallback(() => {
    if (isRecordClosed) {
      showClosedLockWarning(closedLockedMessage);
      return;
    }
    onEnterBatchDeleteMode();
  }, [closedLockedMessage, isRecordClosed, onEnterBatchDeleteMode]);
  const handleOpenMainMachine = useCallback(() => {
    if (isRecordClosed) {
      showClosedLockWarning(closedLockedMessage);
      return;
    }
    onOpenMainMachineModal();
  }, [closedLockedMessage, isRecordClosed, onOpenMainMachineModal]);
  const handleOpenCreateModal = useCallback(() => {
    if (isRecordClosed) {
      showClosedLockWarning(closedLockedMessage);
      return;
    }
    onOpenCreateModal();
  }, [closedLockedMessage, isRecordClosed, onOpenCreateModal]);
  const closeActionDisabled = workOrderClosing ||
    batchCreateMode ||
    loading ||
    refreshing ||
    submitting ||
    hasActiveMutationTask ||
    hasBlockingMutationTask ||
    editingRowId !== null ||
    modalOpen;
  const batchDeleteActionDisabled =
    loading ||
    refreshing ||
    submitting ||
    hasActiveMutationTask ||
    hasBlockingMutationTask;
  const handleScrollHintJump = () => {
    const el = detailTableScrollRef.current;
    if (scrollHint === "up") {
      window.scrollTo({ top: 0, behavior: "smooth" });
      el?.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
      el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  };
  const scrollHintBackToTopLabel = t("workReport:detailPage.backToTop");
  const scrollHintBackToBottomLabel = t("workReport:detailPage.backToBottom");

  return (
    <section className="detail-table-outer" aria-label={t("workReport:table.detailRecordsTitle")}>
      <div className="detail-table-head">
        <div className="detail-table-head-main">
          <WorkReportDetailTableSummaryBar
            detailRecordsCountText={detailRecordsCountText}
            batchCreateEditingText={batchCreateEditingText}
            editingText={editingText}
            focusedColHint={focusedColHint}
          />
          <div className="detail-table-head-actions">
            <WorkReportDetailColumnSettings
              columnSettingsRef={columnSettingsRef}
              open={effectiveColumnSettingsOpen}
              disabled={isColumnSettingsDisabled}
              ariaLabel={t("workReport:table.columnSettingsButton")}
              toggleableColumns={toggleableDetailColumns}
              hiddenColumnKeys={hiddenColumnKeys}
              labels={{
                button: `⚙ ${t("workReport:table.columnSettingsButton")}`,
                panelTitle: t("workReport:table.columnSettingsTitle"),
                hint: t("workReport:table.columnSettingsHint"),
                showAll: t("workReport:table.columnSettingsShowAll"),
                resetDefault: t("workReport:table.columnSettingsResetDefault"),
              }}
              onToggle={handleToggleColumnSettings}
              onShowAllColumns={onShowAllColumns}
              onResetDefaultColumns={onResetDefaultColumns}
              onToggleColumnVisibility={onToggleColumnVisibility}
            />
            {!batchCreateMode && !batchDeleteMode ? (
              <WorkReportDetailDefaultActions
                state={{
                  disableRefresh: isDefaultModeButtonDisabled || loading || refreshing || submitting || hasActiveMutationTask,
                  disableTaskQueue: isDefaultModeButtonDisabled || loading || refreshing,
                  disableMainMachine: isDefaultModeButtonDisabled || loading || refreshing || submitting || hasActiveMutationTask || hasBlockingMutationTask || editingRowId !== null || modalOpen,
                  disableBatchDelete: batchDeleteActionDisabled,
                  disableClose: closeActionDisabled,
                  disableReopen: closeActionDisabled,
                  disableAddDetail: isDefaultModeButtonDisabled || loading || refreshing || submitting || hasBlockingMutationTask,
                  isRecordClosed,
                  workOrderClosing,
                }}
                labels={{
                  refresh: t("workReport:detailPage.refresh"),
                  taskQueue: t("workReport:taskQueue.button"),
                  changeMainMachine: t("workReport:detailPage.changeMainMachine"),
                  manualClose: t("workReport:detailPage.manualClose"),
                  manualReopen: t("workReport:detailPage.manualReopen"),
                  addDetail: t("common:actions.addDetail"),
                  batchDeleteButton: t("workReport:detailPage.batchDeleteButton"),
                  saving: t("common:actions.saving"),
                }}
                onRefresh={onRefresh}
                onOpenTaskQueue={onOpenTaskQueue}
                onOpenMainMachineModal={handleOpenMainMachine}
                onManualClose={() => onHandleManualCloseWorkOrder("close")}
                onManualReopen={() => onHandleManualCloseWorkOrder("reopen")}
                onOpenCreateModal={handleOpenCreateModal}
                onEnterBatchDeleteMode={handleEnterBatchDeleteMode}
              />
            ) : null}
            {batchDeleteMode ? (
              <WorkReportDetailBatchDeleteActions
                state={{
                  allBatchDeleteRowsSelected,
                  selectedBatchDeleteCount,
                  loading,
                  refreshing,
                  submitting,
                }}
                labels={{
                  selectAllOnPage: t("workReport:detailPage.selectAllOnPage"),
                  clearSelection: t("workReport:detailPage.clearBatchSelection"),
                  batchDeleteAction: t("workReport:detailPage.batchDeleteAction", {
                    count: selectedBatchDeleteCount,
                  }),
                  cancel: t("common:actions.cancel"),
                }}
                onToggleSelectAll={onToggleSelectAllBatchDeleteRows}
                onClearSelection={onClearBatchDeleteSelection}
                onHandleBatchDelete={onHandleBatchDelete}
                onCancelBatchDeleteMode={onCancelBatchDeleteMode}
              />
            ) : batchCreateMode ? (
              <WorkReportDetailBatchCreateActions
                submitting={submitting}
                labels={{
                  save: t("common:actions.save"),
                  saving: t("common:actions.saving"),
                  cancel: t("common:actions.cancel"),
                  clearAll: t("workReport:reportForm.actions.clearAll"),
                }}
                onSaveBatchCreate={onSaveBatchCreate}
                onCancelBatchCreate={onCancelBatchCreate}
                onClearBatchCreate={onClearBatchCreate}
              />
            ) : (
              null
            )}
          </div>
        </div>
      </div>
      <div className="detail-table-wrap">
        <div
          ref={detailTableScrollRef}
          className="detail-table-scroll"
          onKeyDown={onDetailTableKeyDown}
          onFocusCapture={(e) => {
            const cell = (e.target as HTMLElement).closest("[data-inline-cell-key]");
            const k = cell?.getAttribute("data-inline-cell-key");
            // 只有可 inline 編輯的欄位才顯示「正在填」；操作欄/唯讀欄的按鈕得到焦點不算
            setFocusedColKey(k && (inlineEditableColumnKeySet as ReadonlySet<string>).has(k) ? k : null);
          }}
          onBlurCapture={() => setFocusedColKey(null)}
        >
          <table className="subtable detail-subtable">
            <thead>
              <tr>
                {renderedDetailColumns.map((column) => (
                  <th
                    key={`header-${column.key}`}
                    className={[
                      column.className,
                      colGroupClass(column.key),
                      focusedColKey === column.key ? "detail-col-focused" : "",
                    ].filter(Boolean).join(" ") || undefined}
                    title={String(column.label)}
                  >
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
                      item.__optimisticState === "frozen"
                        ? "detail-row-optimistic-frozen"
                        : item.__optimisticState
                          ? "detail-row-optimistic-syncing"
                          : "",
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
                    onMeasuredRowHeight={handleMeasuredRowHeight}
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
        <WorkReportDetailScrollHintButton
          visible={scrollHint}
          onJump={handleScrollHintJump}
          backToTopLabel={scrollHintBackToTopLabel}
          backToBottomLabel={scrollHintBackToBottomLabel}
        />
      </div>
      <FixedHorizontalScrollbar tableWrapRef={detailTableScrollRef} />
    </section>
  );
});

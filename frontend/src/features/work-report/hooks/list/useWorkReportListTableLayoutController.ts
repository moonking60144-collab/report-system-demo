import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { getSelectableWorkReportColumns } from "../workReportColumnDefinitions";
import type {
  ColumnDisplayMode,
  ColumnKey,
  WorkReportColumnColor,
  WorkReportFormId,
  WorkReportTableLayoutPreferences,
} from "../../types";
import {
  createDefaultWorkReportTableLayout,
  readColumnDisplayMode,
  readWorkReportTableLayout,
  reconcileWorkReportTableLayout,
  resetWorkReportTableLayout,
  writeColumnDisplayMode,
  writeWorkReportTableLayout,
} from "../../utils";

export function useWorkReportListTableLayoutController(
  currentFormId: WorkReportFormId
) {
  const [columnDisplayMode, setColumnDisplayMode] = useState(readColumnDisplayMode);
  const [columnSettingsOpen, setColumnSettingsOpen] = useState(false);
  const selectableColumns = useMemo(
    () => getSelectableWorkReportColumns(currentFormId, columnDisplayMode),
    [columnDisplayMode, currentFormId]
  );
  const selectableColumnKeys = useMemo(
    () => selectableColumns.map((column) => column.key),
    [selectableColumns]
  );
  const currentColumnLayoutKey = `${currentFormId}:${columnDisplayMode}`;
  const [tableLayoutsByKey, setTableLayoutsByKey] = useState<
    Record<string, WorkReportTableLayoutPreferences>
  >(() => ({
    [currentColumnLayoutKey]: readWorkReportTableLayout(
      currentFormId,
      columnDisplayMode,
      selectableColumnKeys
    ),
  }));
  const tableLayoutsByKeyRef = useRef(tableLayoutsByKey);
  const currentTableLayout =
    tableLayoutsByKey[currentColumnLayoutKey] ??
    readWorkReportTableLayout(
      currentFormId,
      columnDisplayMode,
      selectableColumnKeys
    );
  const columnWidthOverrides = currentTableLayout.columnWidths;
  const hiddenColumnKeySet = useMemo(
    () => new Set(currentTableLayout.hiddenColumnKeys),
    [currentTableLayout.hiddenColumnKeys]
  );
  const resizeFrameRef = useRef<number | null>(null);

  const applyCurrentTableLayoutState = useCallback(
    (layout: WorkReportTableLayoutPreferences) => {
      const nextLayouts = {
        ...tableLayoutsByKeyRef.current,
        [currentColumnLayoutKey]: layout,
      };
      tableLayoutsByKeyRef.current = nextLayouts;
      setTableLayoutsByKey(nextLayouts);
    },
    [currentColumnLayoutKey]
  );

  const updateCurrentTableLayout = useCallback(
    (
      updater: (
        current: WorkReportTableLayoutPreferences
      ) => WorkReportTableLayoutPreferences
    ) => {
      const current =
        tableLayoutsByKeyRef.current[currentColumnLayoutKey] ??
        readWorkReportTableLayout(
          currentFormId,
          columnDisplayMode,
          selectableColumnKeys
        );
      const next = reconcileWorkReportTableLayout(
        updater(current),
        selectableColumnKeys
      );
      applyCurrentTableLayoutState(next);
      writeWorkReportTableLayout(
        currentFormId,
        columnDisplayMode,
        next,
        selectableColumnKeys
      );
    },
    [
      applyCurrentTableLayoutState,
      columnDisplayMode,
      currentColumnLayoutKey,
      currentFormId,
      selectableColumnKeys,
    ]
  );

  const handleColumnDisplayModeChange = useCallback((mode: ColumnDisplayMode) => {
    setColumnSettingsOpen(false);
    setColumnDisplayMode(mode);
    writeColumnDisplayMode(mode);
  }, []);

  const handleOpenColumnSettings = useCallback(() => {
    setColumnSettingsOpen(true);
  }, []);

  const handleToggleColumnVisibility = useCallback(
    (columnKey: ColumnKey) => {
      updateCurrentTableLayout((current) => {
        const hiddenColumnKeys = current.hiddenColumnKeys.includes(columnKey)
          ? current.hiddenColumnKeys.filter((key) => key !== columnKey)
          : [...current.hiddenColumnKeys, columnKey];
        return { ...current, hiddenColumnKeys };
      });
    },
    [updateCurrentTableLayout]
  );

  const handleShowAllColumns = useCallback(() => {
    updateCurrentTableLayout((current) => ({
      ...current,
      hiddenColumnKeys: [],
    }));
  }, [updateCurrentTableLayout]);

  const handleResetDefaultColumns = useCallback(() => {
    resetWorkReportTableLayout(currentFormId, columnDisplayMode);
    applyCurrentTableLayoutState(
      createDefaultWorkReportTableLayout(selectableColumnKeys)
    );
  }, [
    applyCurrentTableLayoutState,
    columnDisplayMode,
    currentFormId,
    selectableColumnKeys,
  ]);

  const handleMoveColumn = useCallback(
    (columnKey: ColumnKey, targetColumnKey: ColumnKey) => {
      updateCurrentTableLayout((current) => {
        const withoutSource = current.columnOrder.filter(
          (key) => key !== columnKey
        );
        const targetIndex = withoutSource.indexOf(targetColumnKey);
        if (targetIndex < 0) {
          return current;
        }
        withoutSource.splice(targetIndex, 0, columnKey);
        return { ...current, columnOrder: withoutSource };
      });
    },
    [updateCurrentTableLayout]
  );

  const handleMoveColumnByOffset = useCallback(
    (columnKey: ColumnKey, offset: -1 | 1) => {
      updateCurrentTableLayout((current) => {
        const currentIndex = current.columnOrder.indexOf(columnKey);
        const targetIndex = currentIndex + offset;
        if (
          currentIndex < 0 ||
          targetIndex < 0 ||
          targetIndex >= current.columnOrder.length
        ) {
          return current;
        }
        const columnOrder = [...current.columnOrder];
        [columnOrder[currentIndex], columnOrder[targetIndex]] = [
          columnOrder[targetIndex],
          columnOrder[currentIndex],
        ];
        return { ...current, columnOrder };
      });
    },
    [updateCurrentTableLayout]
  );

  const handleChangeColumnColor = useCallback(
    (columnKey: ColumnKey, color: WorkReportColumnColor) => {
      updateCurrentTableLayout((current) => {
        const columnColors = { ...current.columnColors };
        if (color === "none") {
          delete columnColors[columnKey];
        } else {
          columnColors[columnKey] = color;
        }
        return { ...current, columnColors };
      });
    },
    [updateCurrentTableLayout]
  );

  const handleColumnResizeStart = useCallback(
    (
      columnKey: string,
      currentWidth: number,
      event: ReactPointerEvent<HTMLSpanElement>
    ) => {
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startWidth = Math.max(48, currentWidth);
      const minWidth = Math.max(48, Math.min(96, startWidth));
      const maxWidth = 420;
      let latestWidth = startWidth;
      document.body.classList.add("work-report-column-resizing");

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const deltaX = moveEvent.clientX - startX;
        const nextWidth = Math.min(
          maxWidth,
          Math.max(minWidth, Math.round(startWidth + deltaX))
        );
        latestWidth = nextWidth;
        if (resizeFrameRef.current !== null) {
          return;
        }
        resizeFrameRef.current = window.requestAnimationFrame(() => {
          resizeFrameRef.current = null;
          const current =
            tableLayoutsByKeyRef.current[currentColumnLayoutKey] ??
            readWorkReportTableLayout(
              currentFormId,
              columnDisplayMode,
              selectableColumnKeys
            );
          if (current.columnWidths[columnKey] === latestWidth) {
            return;
          }
          applyCurrentTableLayoutState(
            reconcileWorkReportTableLayout(
              {
                ...current,
                columnWidths: {
                  ...current.columnWidths,
                  [columnKey]: latestWidth,
                },
              },
              selectableColumnKeys
            )
          );
        });
      };

      const handlePointerUp = () => {
        if (resizeFrameRef.current !== null) {
          window.cancelAnimationFrame(resizeFrameRef.current);
          resizeFrameRef.current = null;
        }
        document.body.classList.remove("work-report-column-resizing");
        const current =
          tableLayoutsByKeyRef.current[currentColumnLayoutKey] ??
          currentTableLayout;
        const persistedLayout = reconcileWorkReportTableLayout(
          {
            ...current,
            columnWidths: {
              ...current.columnWidths,
              [columnKey]: latestWidth,
            },
          },
          selectableColumnKeys
        );
        applyCurrentTableLayoutState(persistedLayout);
        writeWorkReportTableLayout(
          currentFormId,
          columnDisplayMode,
          persistedLayout,
          selectableColumnKeys
        );
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
    },
    [
      applyCurrentTableLayoutState,
      columnDisplayMode,
      currentColumnLayoutKey,
      currentFormId,
      currentTableLayout,
      selectableColumnKeys,
    ]
  );

  return {
    columnDisplayMode,
    columnSettingsOpen,
    setColumnSettingsOpen,
    selectableColumns,
    currentTableLayout,
    columnWidthOverrides,
    hiddenColumnKeySet,
    handleColumnDisplayModeChange,
    handleOpenColumnSettings,
    handleToggleColumnVisibility,
    handleShowAllColumns,
    handleResetDefaultColumns,
    handleMoveColumn,
    handleMoveColumnByOffset,
    handleChangeColumnColor,
    handleColumnResizeStart,
  };
}

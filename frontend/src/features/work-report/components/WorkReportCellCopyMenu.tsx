import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { CopyOutlined, EditOutlined, FilterOutlined, PushpinFilled, PushpinOutlined, TableOutlined } from "@ant-design/icons";
import { Dropdown, message, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useTranslation } from "react-i18next";
import type { WorkReportRecord } from "../../../api/workReport";
import type { ColumnKey, UiLanguage, WorkReportFilterCondition, WorkReportFormId } from "../types";
import { getWorkReportCellFilterCondition, getWorkReportRowCopyValue, WORK_REPORT_BOOLEAN_EDIT_EVENT } from "../workReportCellCopy";

export function WorkReportCellCopyMenu({ children, columns, records, currentFormId, uiLanguage, onFilterByValue, markedEntryId, onToggleMarkedRow }: {
  children: ReactNode;
  columns: ColumnsType<WorkReportRecord>;
  records: WorkReportRecord[];
  currentFormId: WorkReportFormId;
  uiLanguage: UiLanguage;
  onFilterByValue?: (condition: WorkReportFilterCondition) => void;
  markedEntryId: string | null;
  onToggleMarkedRow: (record: WorkReportRecord) => void;
}) {
  const { t } = useTranslation("workReport");
  const recordsById = useMemo(() => new Map(records.map(record => [String(record.id), record])), [records]);
  const [menu, setMenu] = useState<{
    x: number; y: number; value: string; entryId: string; cell: HTMLElement;
    editor: HTMLButtonElement | null; condition: WorkReportFilterCondition | null;
  } | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const scrollOriginRef = useRef<{
    x: number; y: number;
    ancestors: { element: HTMLElement; left: number; top: number }[];
  } | null>(null);
  const closeMenu = useCallback(() => {
    scrollOriginRef.current = null;
    setMenu(null);
    returnFocusRef.current?.focus({ preventScroll: true });
  }, []);
  const closeOnScroll = useCallback(() => {
    const origin = scrollOriginRef.current;
    if (!origin) return;
    // A scroll queued before the right click can arrive after the menu opens.
    if (window.scrollX !== origin.x || window.scrollY !== origin.y || origin.ancestors.some(
      ({ element, left, top }) => element.scrollLeft !== left || element.scrollTop !== top
    )) closeMenu();
  }, [closeMenu]);

  useEffect(() => {
    if (!menu) return;
    window.addEventListener("scroll", closeOnScroll, true);
    window.addEventListener("resize", closeMenu);
    return () => {
      window.removeEventListener("scroll", closeOnScroll, true);
      window.removeEventListener("resize", closeMenu);
    };
  }, [menu, closeMenu, closeOnScroll]);

  const openMenuForCell = (cell: HTMLElement, x: number, y: number) => {
    const entryId = cell.closest<HTMLElement>("[data-row-key]")?.dataset.rowKey;
    const record = entryId ? recordsById.get(entryId) : undefined;
    if (!record) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const ancestors: { element: HTMLElement; left: number; top: number }[] = [];
    for (let element: HTMLElement | null = cell; element; element = element.parentElement) {
      ancestors.push({ element, left: element.scrollLeft, top: element.scrollTop });
    }
    scrollOriginRef.current = { x: window.scrollX, y: window.scrollY, ancestors };
    setMenu({
      x,
      y,
      value: cell.dataset.workReportCopyValue ?? "",
      entryId: String(record.id),
      cell,
      editor: cell.querySelector<HTMLButtonElement>(".work-report-editable-edit-btn, .work-report-boolean-toggle"),
      condition: getWorkReportCellFilterCondition(record, cell.dataset.workReportColumnKey ?? "", currentFormId),
    });
  };

  const getMenuCell = (target: EventTarget): HTMLElement | null => {
    if (!(target instanceof Element)) return null;
    if (target.closest("input, textarea, select, [contenteditable], [role='textbox'], [role='combobox'], .work-report-editable-editor")) return null;
    return target.closest<HTMLElement>("[data-work-report-copy-value]");
  };

  const handleContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    const cell = getMenuCell(event.target);
    if (!cell) {
      if (menu) closeMenu();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const rect = cell.getBoundingClientRect();
    openMenuForCell(cell, event.clientX || rect.left, event.clientY || rect.bottom);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
    const cell = getMenuCell(event.target);
    if (!cell) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = cell.getBoundingClientRect();
    openMenuForCell(cell, rect.left, rect.bottom);
  };

  const handleAction = async (key: string) => {
    if (!menu) return;
    const record = recordsById.get(menu.entryId);
    closeMenu();
    if (key === "mark") {
      if (record) onToggleMarkedRow(record);
      return;
    }
    if (key === "filter") {
      if (menu.condition) onFilterByValue?.(menu.condition);
      return;
    }
    if (key === "edit") {
      const editor = menu.editor;
      if (!editor?.isConnected || editor.disabled || menu.cell.closest<HTMLElement>("[data-row-key]")?.dataset.rowKey !== menu.entryId) return;
      if (editor.classList.contains("work-report-boolean-toggle")) editor.dispatchEvent(new CustomEvent(WORK_REPORT_BOOLEAN_EDIT_EVENT));
      else editor.click();
      return;
    }
    const value = key === "row" && record ? getWorkReportRowCopyValue(record, columns.flatMap(column =>
      "dataIndex" in column && typeof column.dataIndex === "string" && column.key !== "scheduleAction"
        ? [column.dataIndex as ColumnKey] : []
    ), currentFormId, uiLanguage) : key === "copy" ? menu.value : "";
    if (!value) {
      void message.info(t("cellCopy.empty"));
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      void message.success(t("cellCopy.copied"));
    } catch {
      void message.error(t("cellCopy.failed"));
    }
  };

  return (
    <div className="work-report-cell-copy-surface" onContextMenu={handleContextMenu} onKeyDown={handleKeyDown}>
      {children}
      {menu && (
        <Dropdown
          key={`${menu.x}:${menu.y}`}
          open
          trigger={["click"]}
          autoFocus
          placement="bottomLeft"
          onOpenChange={open => { if (!open) closeMenu(); }}
          menu={{ items: [
            { key: "copy", icon: <CopyOutlined aria-hidden />, label: t("cellCopy.action") },
            { key: "row", icon: <TableOutlined aria-hidden />, label: t("cellCopy.row") },
            { key: "mark", icon: markedEntryId === menu.entryId ? <PushpinFilled aria-hidden /> : <PushpinOutlined aria-hidden />,
              label: t(markedEntryId === menu.entryId ? "cellCopy.unmarkRow" : "cellCopy.markRow") },
            { key: "filter", icon: <FilterOutlined aria-hidden />, disabled: !menu.condition || !onFilterByValue,
              label: <Tooltip title={!menu.condition ? t("cellCopy.filterUnavailable") : undefined}><span>{t("cellCopy.filter")}</span></Tooltip> },
            { key: "edit", icon: <EditOutlined aria-hidden />, disabled: !menu.editor?.isConnected || menu.editor.disabled,
              label: <Tooltip title={!menu.editor || menu.editor.disabled ? t("cellCopy.editUnavailable") : undefined}><span>{t("cellCopy.edit")}</span></Tooltip> },
          ], onClick: ({ key }) => { void handleAction(key); } }}
        >
          <span className="work-report-cell-copy-anchor" tabIndex={-1} style={{ left: menu.x, top: menu.y }} />
        </Dropdown>
      )}
    </div>
  );
}

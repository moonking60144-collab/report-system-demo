import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { PushpinFilled, PushpinOutlined } from "@ant-design/icons";
import { Dropdown } from "antd";
import { useTranslation } from "react-i18next";
import type { WorkReportRecord } from "../../../api/workReport";

export function WorkReportRowMarkMenu({ children, records, markedEntryId, onToggleMarkedRow }: {
  children: ReactNode;
  records: WorkReportRecord[];
  markedEntryId: string | null;
  onToggleMarkedRow: (record: WorkReportRecord) => void;
}) {
  const { t } = useTranslation("workReport");
  const recordsById = useMemo(() => new Map(records.map(record => [String(record.id), record])), [records]);
  const [menu, setMenu] = useState<{ x: number; y: number; entryId: string } | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const closeMenu = useCallback(() => {
    setMenu(null);
    returnFocusRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!menu) return;
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("resize", closeMenu);
    return () => {
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("resize", closeMenu);
    };
  }, [menu, closeMenu]);

  const getRow = (target: EventTarget): HTMLElement | null => {
    if (!(target instanceof Element)) return null;
    if (target.closest("input, textarea, select, [contenteditable], [role='textbox'], [role='combobox'], .work-report-editable-editor")) return null;
    return target.closest<HTMLElement>("[data-row-key]");
  };
  const openForRow = (row: HTMLElement, x: number, y: number) => {
    const entryId = row.dataset.rowKey;
    if (!entryId || !recordsById.has(entryId)) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMenu({ x, y, entryId });
  };
  const handleContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    const row = getRow(event.target);
    if (!row) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = row.getBoundingClientRect();
    openForRow(row, event.clientX || rect.left, event.clientY || rect.bottom);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
    const row = getRow(event.target);
    if (!row) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = row.getBoundingClientRect();
    openForRow(row, rect.left, rect.bottom);
  };

  return <div className="work-report-cell-copy-surface" onContextMenu={handleContextMenu} onKeyDown={handleKeyDown}>
    {children}
    {menu && <Dropdown
      key={`${menu.x}:${menu.y}`}
      open
      trigger={["click"]}
      autoFocus
      placement="bottomLeft"
      onOpenChange={open => { if (!open) closeMenu(); }}
      menu={{ items: [{
        key: "mark",
        icon: markedEntryId === menu.entryId ? <PushpinFilled aria-hidden /> : <PushpinOutlined aria-hidden />,
        label: t(markedEntryId === menu.entryId ? "cellCopy.unmarkRow" : "cellCopy.markRow"),
      }], onClick: () => {
        const record = recordsById.get(menu.entryId);
        closeMenu();
        if (record) onToggleMarkedRow(record);
      } }}
    ><span className="work-report-cell-copy-anchor" tabIndex={-1} style={{ left: menu.x, top: menu.y }} /></Dropdown>}
  </div>;
}

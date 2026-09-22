import { useId, type ReactNode } from "react";
import { Popover } from "antd";
import type { ColumnKey } from "../types";

interface WorkReportColumnMenuPopoverTriggerProps {
  columnKey: ColumnKey;
  activeColumnKey: ColumnKey | null;
  activeOwnerId: string | null;
  content: ReactNode;
  hasActive: boolean;
  label: string;
  sortPriority: number | null;
  onOpenChange: (columnKey: ColumnKey, ownerId: string, nextOpen: boolean) => void;
}

export function WorkReportColumnMenuPopoverTrigger({
  columnKey,
  activeColumnKey,
  activeOwnerId,
  content,
  hasActive,
  label,
  sortPriority,
  onOpenChange,
}: WorkReportColumnMenuPopoverTriggerProps) {
  const ownerId = useId();
  // NOTE: Ant Table 會把欄位標題再渲染到量測列，只有實際被點擊的 instance 可以開啟選單。
  const open = activeColumnKey === columnKey && activeOwnerId === ownerId;

  return (
    <Popover
      trigger="click"
      placement="bottomLeft"
      open={open}
      onOpenChange={(nextOpen) => onOpenChange(columnKey, ownerId, nextOpen)}
      content={content}
      overlayClassName="column-menu-popover"
    >
      <button
        type="button"
        className={`column-header-menu-trigger ${hasActive ? "is-active" : ""}`}
        aria-label={label}
        aria-expanded={open}
        onClick={(event) => event.stopPropagation()}
      >
        <span className="column-header-menu-trigger-icon" aria-hidden="true">▼</span>
        {sortPriority !== null ? (
          <span className="column-header-menu-trigger-priority" aria-hidden="true">
            {sortPriority}
          </span>
        ) : null}
      </button>
    </Popover>
  );
}

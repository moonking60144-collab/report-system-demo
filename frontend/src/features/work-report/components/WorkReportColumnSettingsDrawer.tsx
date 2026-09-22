import { useState, type DragEvent } from "react";
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  HolderOutlined,
} from "@ant-design/icons";
import { Drawer, Popover } from "antd";
import { useTranslation } from "react-i18next";
import type { WorkReportSelectableColumnMeta } from "../hooks/workReportColumnDefinitions";
import type {
  ColumnColorOverrides,
  ColumnKey,
  WorkReportColumnColor,
} from "../types";

const COLUMN_COLOR_OPTIONS: WorkReportColumnColor[] = [
  "none",
  "gray-soft",
  "amber-soft",
  "blue-soft",
  "cyan-soft",
  "green-soft",
  "rose-soft",
  "violet-soft",
];

interface WorkReportColumnSettingsDrawerProps {
  open: boolean;
  columns: WorkReportSelectableColumnMeta[];
  columnOrder: ColumnKey[];
  hiddenColumnKeys: Set<ColumnKey>;
  columnColors: ColumnColorOverrides;
  onClose: () => void;
  onToggleColumnVisibility: (columnKey: ColumnKey) => void;
  onMoveColumn: (columnKey: ColumnKey, targetColumnKey: ColumnKey) => void;
  onMoveColumnByOffset: (columnKey: ColumnKey, offset: -1 | 1) => void;
  onChangeColumnColor: (columnKey: ColumnKey, color: WorkReportColumnColor) => void;
  onShowAllColumns: () => void;
  onResetDefaultColumns: () => void;
}

export function WorkReportColumnSettingsDrawer({
  open,
  columns,
  columnOrder,
  hiddenColumnKeys,
  columnColors,
  onClose,
  onToggleColumnVisibility,
  onMoveColumn,
  onMoveColumnByOffset,
  onChangeColumnColor,
  onShowAllColumns,
  onResetDefaultColumns,
}: WorkReportColumnSettingsDrawerProps) {
  const { t } = useTranslation(["workReport", "common"]);
  const [draggedColumnKey, setDraggedColumnKey] = useState<ColumnKey | null>(null);
  const columnByKey = new Map(columns.map((column) => [column.key, column]));
  const orderedColumns = columnOrder
    .map((key) => columnByKey.get(key))
    .filter((column): column is WorkReportSelectableColumnMeta => Boolean(column));

  const handleDrop = (event: DragEvent<HTMLDivElement>, targetColumnKey: ColumnKey) => {
    event.preventDefault();
    if (!draggedColumnKey || draggedColumnKey === targetColumnKey) {
      return;
    }
    onMoveColumn(draggedColumnKey, targetColumnKey);
    setDraggedColumnKey(null);
  };

  return (
    <Drawer
      open={open}
      placement="right"
      width="min(440px, calc(100vw - 16px))"
      title={t("workReport:table.columnSettingsTitle")}
      onClose={onClose}
      className="work-report-column-settings-drawer"
    >
      <div className="work-report-column-settings-intro">
        <p>{t("workReport:table.columnSettingsDrawerHint")}</p>
        <div className="work-report-column-settings-actions">
          <button type="button" onClick={onShowAllColumns}>
            {t("workReport:table.columnSettingsShowAll")}
          </button>
          <button type="button" onClick={onResetDefaultColumns}>
            {t("workReport:table.columnSettingsResetDefault")}
          </button>
        </div>
      </div>

      <div className="work-report-column-settings-list" role="list">
        {orderedColumns.map((column, index) => {
          const checked = !hiddenColumnKeys.has(column.key);
          const color = columnColors[column.key] ?? "none";
          return (
            <div
              key={column.key}
              role="listitem"
              data-column-key={column.key}
              draggable
              className={`work-report-column-settings-row ${
                draggedColumnKey === column.key ? "is-dragging" : ""
              }`}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", column.key);
                setDraggedColumnKey(column.key);
              }}
              onDragEnd={() => setDraggedColumnKey(null)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => handleDrop(event, column.key)}
            >
              <span
                className="work-report-column-settings-handle"
                aria-hidden="true"
              >
                <HolderOutlined />
              </span>
              <label className="work-report-column-settings-visibility">
                <input
                  type="checkbox"
                  data-column-key={column.key}
                  checked={checked}
                  onChange={() => onToggleColumnVisibility(column.key)}
                />
                <span>{column.label}</span>
              </label>

              <Popover
                trigger="click"
                placement="left"
                overlayClassName="work-report-column-color-popover"
                content={
                  <div
                    className="work-report-column-color-options"
                    role="group"
                    aria-label={t("workReport:table.columnColorLabel", {
                      label: column.label,
                    })}
                  >
                    {COLUMN_COLOR_OPTIONS.map((option) => (
                      <button
                        key={option}
                        type="button"
                        className={`work-report-column-color-option work-report-column-tone--${option} ${
                          color === option ? "is-selected" : ""
                        }`}
                        aria-label={t(`workReport:table.columnColors.${option}`)}
                        aria-pressed={color === option}
                        onClick={() => onChangeColumnColor(column.key, option)}
                      >
                        <span className="work-report-column-color-option-swatch" />
                        <span>{t(`workReport:table.columnColors.${option}`)}</span>
                      </button>
                    ))}
                  </div>
                }
              >
                <button
                  type="button"
                  className={`work-report-column-color-trigger work-report-column-tone--${color}`}
                  aria-label={t("workReport:table.columnColorLabel", {
                    label: column.label,
                  })}
                  title={t(`workReport:table.columnColors.${color}`)}
                >
                  <span />
                </button>
              </Popover>

              <div className="work-report-column-settings-move-actions">
                <button
                  type="button"
                  disabled={index === 0}
                  aria-label={t("workReport:table.moveColumnUp", { label: column.label })}
                  onClick={() => onMoveColumnByOffset(column.key, -1)}
                >
                  <ArrowUpOutlined />
                </button>
                <button
                  type="button"
                  disabled={index === orderedColumns.length - 1}
                  aria-label={t("workReport:table.moveColumnDown", { label: column.label })}
                  onClick={() => onMoveColumnByOffset(column.key, 1)}
                >
                  <ArrowDownOutlined />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </Drawer>
  );
}

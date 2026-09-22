import { memo, type ReactNode, type RefObject } from "react";

interface ToggleableColumn {
  key: string;
  label: ReactNode;
}

interface Labels {
  button: string;
  panelTitle: string;
  hint: string;
  showAll: string;
  resetDefault: string;
}

interface Props {
  columnSettingsRef: RefObject<HTMLDivElement | null>;
  open: boolean;
  disabled: boolean;
  ariaLabel: string;
  toggleableColumns: ReadonlyArray<ToggleableColumn>;
  hiddenColumnKeys: ReadonlySet<string>;
  labels: Labels;
  onToggle: () => void;
  onShowAllColumns: () => void;
  onResetDefaultColumns: () => void;
  onToggleColumnVisibility: (columnKey: string) => void;
}

export const WorkReportDetailColumnSettings = memo(function WorkReportDetailColumnSettings({
  columnSettingsRef,
  open,
  disabled,
  ariaLabel,
  toggleableColumns,
  hiddenColumnKeys,
  labels,
  onToggle,
  onShowAllColumns,
  onResetDefaultColumns,
  onToggleColumnVisibility,
}: Props) {
  return (
    <div className="detail-column-settings" ref={columnSettingsRef}>
      <button
        type="button"
        className="detail-column-settings-btn"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
      >
        {labels.button}
      </button>
      {open && (
        <section className="detail-column-settings-panel">
          <strong className="detail-column-settings-title">{labels.panelTitle}</strong>
          <p className="detail-column-settings-hint">{labels.hint}</p>
          <div className="detail-column-settings-actions">
            <button
              type="button"
              className="detail-column-settings-action-btn"
              onClick={onShowAllColumns}
              disabled={disabled}
            >
              {labels.showAll}
            </button>
            <button
              type="button"
              className="detail-column-settings-action-btn"
              onClick={onResetDefaultColumns}
              disabled={disabled}
            >
              {labels.resetDefault}
            </button>
          </div>
          <div className="detail-column-settings-list">
            {toggleableColumns.map((column) => {
              const checked = !hiddenColumnKeys.has(column.key);
              return (
                <label key={`column-toggle-${column.key}`} className="detail-column-settings-item">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggleColumnVisibility(column.key)}
                    disabled={disabled}
                    data-column-key={column.key}
                  />
                  <span>{column.label}</span>
                </label>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
});

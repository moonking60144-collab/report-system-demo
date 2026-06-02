import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

interface DetailLinkedPickerOption {
  value: string;
  display: string;
  group?: string;
  metaLines?: string[];
}

type PickerVirtualItem =
  | {
      kind: "group";
      key: string;
      label: string;
      top: number;
      height: number;
    }
  | {
      kind: "option";
      key: string;
      option: DetailLinkedPickerOption;
      top: number;
      height: number;
      isSelected: boolean;
    };

/** display 跟 value trim 後相同時視為重複資訊，不再多佔一行（例：「整天 / 整天」）。 */
function isDisplayRedundant(option: DetailLinkedPickerOption): boolean {
  return option.display.trim() === option.value.trim();
}

function estimatePickerOptionHeight(option: DetailLinkedPickerOption): number {
  const metaLineCount = option.metaLines?.filter(Boolean).length ?? 0;
  const displayLines = isDisplayRedundant(option)
    ? 0
    : 1 + Math.max(0, Math.ceil(Math.max(0, option.display.length - 26) / 26));
  // base (padding + value 一行) + display 行（含 gap） + meta 行（含 gap）
  const contentHeight = 46 + displayLines * 20 + metaLineCount * 18;
  // 對齊 CSS .detail-picker-option min-height 56px，避免單行 option（例：整天）被壓扁
  return Math.max(56, contentHeight);
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

function findVirtualItemIndex(offsets: number[], target: number): number {
  if (offsets.length <= 1) {
    return 0;
  }
  const index = upperBound(offsets, target) - 1;
  return Math.max(0, Math.min(offsets.length - 2, index));
}

interface DetailInlinePickerTriggerProps {
  value: string;
  hint?: string | null;
  blankLabel: string;
  editorKey: string;
  disabled?: boolean;
  onOpen: () => void;
}

interface DetailLinkedPickerModalProps {
  title: string;
  hint: string;
  closeLabel: string;
  currentSelectionLabel?: string;
  currentSelectionOption?: DetailLinkedPickerOption | null;
  topContent?: ReactNode;
  searchLabel: string;
  searchPlaceholder: string;
  emptyText: string;
  searchValue: string;
  options: DetailLinkedPickerOption[];
  selectedValue: string;
  onSearchChange: (value: string) => void;
  onSelect: (value: string) => void;
  onClose: () => void;
}

export function DetailInlinePickerTrigger({
  value,
  hint,
  blankLabel,
  editorKey,
  disabled = false,
  onOpen,
}: DetailInlinePickerTriggerProps) {
  return (
    <div className="detail-inline-picker-control" data-prevent-row-click="true">
      <button
        type="button"
        className="detail-inline-picker-trigger"
        onClick={onOpen}
        disabled={disabled}
        data-inline-editor-key={editorKey}
        data-prevent-row-click="true"
      >
        <span className="detail-inline-picker-value">{value || blankLabel}</span>
        {hint ? <span className="detail-inline-picker-hint">{hint}</span> : null}
        <span className="detail-inline-picker-caret" aria-hidden="true">
          ▾
        </span>
      </button>
    </div>
  );
}

export function DetailLinkedPickerModal({
  title,
  hint,
  closeLabel,
  currentSelectionLabel,
  currentSelectionOption,
  topContent,
  searchLabel,
  searchPlaceholder,
  emptyText,
  searchValue,
  options,
  selectedValue,
  onSearchChange,
  onSelect,
  onClose,
}: DetailLinkedPickerModalProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const shouldRenderCurrentSelection =
    Boolean(currentSelectionOption?.value.trim()) &&
    !options.some(
      (option) =>
        option.value.trim() === String(currentSelectionOption?.value ?? "").trim()
    );

  const pickerVirtualItems = useMemo<PickerVirtualItem[]>(() => {
    if (options.length === 0) {
      return [];
    }

    let offsetTop = 0;
    const items: PickerVirtualItem[] = [];
    const grouped = options.some((option) => option.group !== undefined);
    if (grouped) {
      const groupOrder: string[] = [];
      const groupMap = new Map<string, DetailLinkedPickerOption[]>();
      for (const option of options) {
        const groupLabel = option.group ?? "其他";
        if (!groupMap.has(groupLabel)) {
          groupMap.set(groupLabel, []);
          if (groupLabel !== "其他") {
            groupOrder.push(groupLabel);
          }
        }
        groupMap.get(groupLabel)?.push(option);
      }
      if (groupMap.has("其他")) {
        groupOrder.push("其他");
      }

      for (const groupLabel of groupOrder) {
        items.push({
          kind: "group",
          key: `group:${groupLabel}`,
          label: groupLabel,
          top: offsetTop,
          height: 32,
        });
        offsetTop += 40;
        for (const option of groupMap.get(groupLabel) ?? []) {
          const height = estimatePickerOptionHeight(option);
          items.push({
            kind: "option",
            key: `option:${option.value}`,
            option,
            top: offsetTop,
            height,
            isSelected: selectedValue.trim() === option.value.trim(),
          });
          offsetTop += height + 8;
        }
      }
      return items;
    }

    for (const option of options) {
      const height = estimatePickerOptionHeight(option);
      items.push({
        kind: "option",
        key: `option:${option.value}`,
        option,
        top: offsetTop,
        height,
        isSelected: selectedValue.trim() === option.value.trim(),
      });
      offsetTop += height + 8;
    }
    return items;
  }, [options, selectedValue]);

  const shouldVirtualize = pickerVirtualItems.length >= 80;
  const virtualOffsets = useMemo(() => {
    const offsets = [0];
    for (const item of pickerVirtualItems) {
      offsets.push(item.top + item.height + 8);
    }
    return offsets;
  }, [pickerVirtualItems]);
  const totalVirtualHeight =
    pickerVirtualItems.length > 0
      ? pickerVirtualItems[pickerVirtualItems.length - 1].top +
        pickerVirtualItems[pickerVirtualItems.length - 1].height
      : 0;

  useLayoutEffect(() => {
    if (!shouldVirtualize) {
      return;
    }
    const node = listRef.current;
    if (!node) {
      return;
    }
    const syncMetrics = () => {
      setScrollTop(node.scrollTop);
      setViewportHeight(node.clientHeight);
    };
    syncMetrics();
    node.addEventListener("scroll", syncMetrics, { passive: true });
    const resizeObserver = new ResizeObserver(() => {
      syncMetrics();
    });
    resizeObserver.observe(node);

    return () => {
      node.removeEventListener("scroll", syncMetrics);
      resizeObserver.disconnect();
    };
  }, [shouldVirtualize]);

  useEffect(() => {
    const node = listRef.current;
    if (!node) {
      return;
    }
    node.scrollTop = 0;
    const frameId = window.requestAnimationFrame(() => {
      setScrollTop(0);
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [options, searchValue]);

  const virtualWindow = useMemo(() => {
    if (!shouldVirtualize || viewportHeight <= 0) {
      return pickerVirtualItems;
    }
    const overscanPx = Math.max(240, viewportHeight);
    const startIndex = findVirtualItemIndex(
      virtualOffsets,
      Math.max(0, scrollTop - overscanPx)
    );
    const endIndex =
      findVirtualItemIndex(virtualOffsets, scrollTop + viewportHeight + overscanPx) + 1;
    return pickerVirtualItems.slice(startIndex, Math.min(pickerVirtualItems.length, endIndex));
  }, [pickerVirtualItems, scrollTop, shouldVirtualize, viewportHeight, virtualOffsets]);

  return (
    <div
      className="detail-picker-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={onClose}
    >
      <section className="detail-picker-modal" onMouseDown={(event) => event.stopPropagation()}>
        <header className="detail-picker-header">
          <div>
            <strong>{title}</strong>
            <p>{hint}</p>
          </div>
          <button type="button" onClick={onClose}>
            {closeLabel}
          </button>
        </header>
        {topContent}
        <label className="detail-picker-search">
          <span>{searchLabel}</span>
          <input
            type="text"
            value={searchValue}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={searchPlaceholder}
            autoFocus
          />
        </label>
        <div className="detail-picker-list" role="listbox" aria-label={title} ref={listRef}>
          {shouldRenderCurrentSelection && currentSelectionOption ? (
            <section className="detail-picker-current-section">
              <div className="detail-picker-group-header detail-picker-group-header--current">
                {currentSelectionLabel ?? "目前選擇"}
              </div>
              <button
                type="button"
                className="detail-picker-option is-selected"
                data-option-value={currentSelectionOption.value}
                onClick={() => onSelect(currentSelectionOption.value)}
              >
                <span className="detail-picker-option-value">{currentSelectionOption.value}</span>
                {!isDisplayRedundant(currentSelectionOption) ? (
                  <span className="detail-picker-option-display">{currentSelectionOption.display}</span>
                ) : null}
                {currentSelectionOption.metaLines?.filter(Boolean).map((line) => (
                  <span
                    key={`${currentSelectionOption.value}:${line}`}
                    className="detail-picker-option-meta"
                  >
                    {line}
                  </span>
                ))}
              </button>
            </section>
          ) : null}
          {options.length === 0 ? (
            <p className="detail-picker-empty">{emptyText}</p>
          ) : (
            <div
              className={
                shouldVirtualize ? "detail-picker-virtual-list" : "detail-picker-option-list"
              }
              style={shouldVirtualize ? { height: `${totalVirtualHeight}px`, position: "relative" } : undefined}
            >
              {(shouldVirtualize ? virtualWindow : pickerVirtualItems).map((item) => {
                if (item.kind === "group") {
                  return (
                    <div
                      key={item.key}
                      className="detail-picker-group-header"
                      style={
                        shouldVirtualize
                          ? {
                              position: "absolute",
                              top: `${item.top}px`,
                              left: 0,
                              right: 0,
                            }
                          : undefined
                      }
                    >
                      {item.label}
                    </div>
                  );
                }
                const option = item.option;
                return (
                  <button
                    key={item.key}
                    type="button"
                    className={`detail-picker-option ${item.isSelected ? "is-selected" : ""}`}
                    data-option-value={option.value}
                    onClick={() => onSelect(option.value)}
                    style={
                      shouldVirtualize
                        ? {
                            position: "absolute",
                            top: `${item.top}px`,
                            left: 0,
                            right: 0,
                            minHeight: `${item.height}px`,
                          }
                        : undefined
                    }
                  >
                    {!option.value.startsWith("__") && (
                      <span className="detail-picker-option-value">{option.value}</span>
                    )}
                    {!isDisplayRedundant(option) ? (
                      <span className="detail-picker-option-display">{option.display}</span>
                    ) : null}
                    {option.metaLines?.filter(Boolean).map((line) => (
                      <span key={`${option.value}:${line}`} className="detail-picker-option-meta">
                        {line}
                      </span>
                    ))}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

const BACKGROUND_INTERACTION_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "label",
  "summary",
  "[contenteditable='true']",
  "[role='button']",
  "[role='checkbox']",
  "[role='combobox']",
  "[role='link']",
  "[role='menuitem']",
  "[role='option']",
  "[role='slider']",
  "[role='switch']",
  "[role='tab']",
  "[role='textbox']",
  ".work-report-filter-drawer",
  ".ant-modal-root",
  ".ant-select-dropdown",
  ".clickable-row",
  ".ant-table-body",
  ".ant-table-content",
  ".column-header-resize-handle",
  ".fixed-filter-machine-list",
  ".fixed-h-scrollbar-shell",
].join(",");

export function shouldCloseFilterDrawerFromBackgroundClick(target: EventTarget | null): boolean {
  const element = target as { closest?: (selector: string) => Element | null } | null;
  return typeof element?.closest === "function" && !element.closest(BACKGROUND_INTERACTION_SELECTOR);
}

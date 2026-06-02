const commonEn = {
  language: {
    label: "Language",
    toggleAria: "UI language toggle",
    zh: "Chinese",
    en: "English",
  },
  actions: {
    applyFilters: "Apply Filters",
    clearFilters: "Clear Filters",
    refresh: "Refresh",
    cancel: "Cancel",
    close: "Close",
    confirm: "Confirm",
    ok: "Confirm",
    collapse: "Collapse",
    expand: "Expand",
    addDetail: "Add Report",
    edit: "Edit",
    delete: "Delete",
    save: "Save",
    saving: "Saving...",
    clearFinished: "Clear Finished",
    history: "History",
  },
  options: {
    all: "All",
    select: "Please select",
  },
  pager: {
    rowsLabel: "Rows",
    rowsUnit: "rows",
    prev: "Prev",
    next: "Next",
    page: "Page {{page}}",
    showingRange: "Showing {{from}}-{{to}}",
  },
  states: {
    loadingData: "Loading data...",
    noData: "No data found.",
    noOptions: "No options found",
    unknownError: "Unknown error occurred",
  },
  yesNo: {
    yes: "Yes",
    no: "No",
    blank: "Blank",
  },
} as const;

export default commonEn;

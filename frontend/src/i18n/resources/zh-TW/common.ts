const commonZhTw = {
  language: {
    label: "語言",
    toggleAria: "介面語言切換",
    zh: "中文",
    en: "English",
  },
  actions: {
    applyFilters: "套用篩選",
    clearFilters: "清除篩選",
    refresh: "重新整理",
    cancel: "取消",
    close: "關閉",
    confirm: "確認送出",
    ok: "確認",
    collapse: "收合",
    expand: "展開",
    addDetail: "新增報工",
    edit: "編輯",
    delete: "刪除",
    save: "儲存",
    saving: "儲存中...",
    clearFinished: "清除已完成",
    history: "歷史",
  },
  options: {
    all: "全部",
    select: "請選擇",
  },
  pager: {
    rowsLabel: "每頁",
    rowsUnit: "筆",
    prev: "上一頁",
    next: "下一頁",
    page: "第 {{page}} 頁",
    showingRange: "顯示 {{from}}-{{to}}",
  },
  states: {
    loadingData: "資料讀取中...",
    noData: "查無資料。",
    noOptions: "查無選項",
    unknownError: "發生未知錯誤",
  },
  yesNo: {
    yes: "是",
    no: "否",
    blank: "空白",
  },
} as const;

export default commonZhTw;

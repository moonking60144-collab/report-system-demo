// 開發者面板工具的單一事實來源：hub 卡片、左側導覽、路由都讀這份。
// 加工具＝在這陣列多一筆，hub / sidebar 會同步長出來。

export type DevToolGroup = "primary" | "data" | "analysis" | "settings";

export interface DevTool {
  id: string;
  path: string;
  label: string;
  desc: string;
  group: DevToolGroup;
}

export const DEV_TOOLS: DevTool[] = [
  {
    id: "search",
    path: "/dev/search",
    label: "欄位索引",
    desc: "搜尋 Ragic 欄位／表單，點開看單表 detail",
    group: "primary",
  },
  {
    id: "deps",
    path: "/dev/deps",
    label: "欄位依賴查詢",
    desc: "查一個欄位的上下游（公式／連結／載入）",
    group: "analysis",
  },
  {
    id: "workflow",
    path: "/dev/workflow",
    label: "JS Workflow 依賴",
    desc: "JS 盲區：跨表查詢／寫值／連外副作用",
    group: "analysis",
  },
  {
    id: "definitions",
    path: "/dev/definitions",
    label: "Definitions baseline",
    desc: "讀 ragic-definitions：表單／欄位／公式／workflow",
    group: "primary",
  },
  {
    id: "ai",
    path: "/dev/ai",
    label: "AI 助手",
    desc: "保存 Dev AI 對話、查看 thread memory 與 artifacts",
    group: "primary",
  },
  {
    id: "it-duty",
    path: "/it/duty",
    label: "IT 值班表",
    desc: "IT 值班、交接與內部工具入口",
    group: "data",
  },
  {
    id: "it-sop",
    path: "/it/sop",
    label: "SOP 文件",
    desc: "新電腦配置、交付檢查與可編輯 SOP",
    group: "data",
  },
  {
    id: "entities",
    path: "/dev/entities",
    label: "實體瀏覽",
    desc: "整理 DB 藍圖：mainKey 群組成的實體表",
    group: "analysis",
  },
  {
    id: "matrix",
    path: "/dev/matrix",
    label: "群耦合矩陣",
    desc: "模組群 DSM：哪些群纏在一起、該一起正規化",
    group: "analysis",
  },
  {
    id: "normalize",
    path: "/dev/normalize",
    label: "正規化表單依賴",
    desc: "Link&Load fan-in/out 分主檔/交易檔/葉表，找該拆的表",
    group: "analysis",
  },
  {
    id: "settings",
    path: "/dev/settings",
    label: "帳號設定",
    desc: "改帳密／帳號管理",
    group: "settings",
  },
];

export const DEV_GROUP_ORDER: DevToolGroup[] = ["primary", "data", "analysis", "settings"];

export const DEV_GROUP_META: Record<DevToolGroup, { label: string }> = {
  primary: { label: "主要工具" },
  data: { label: "資料" },
  analysis: { label: "分析" },
  settings: { label: "設定" },
};

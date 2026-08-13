// 開發者面板工具的單一事實來源：hub 卡片、左側導覽、路由都讀這份。
// 加工具＝在這陣列多一筆，hub / sidebar 會同步長出來。

export type DevToolGroup = "primary" | "data" | "settings";

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
    id: "definitions",
    path: "/dev/definitions",
    label: "NUI GUI",
    desc: "檢視 NUI 表單／欄位／公式／workflow，管理 definitions baseline",
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
    id: "meeting-libraries",
    path: "/dev/meeting-libraries",
    label: "會議錄音庫",
    desc: "搜尋錄音庫、唯讀開啟與重設分享 Code",
    group: "data",
  },
  {
    id: "settings",
    path: "/dev/settings",
    label: "帳號設定",
    desc: "改帳密／帳號管理",
    group: "settings",
  },
];

export const DEV_GROUP_ORDER: DevToolGroup[] = ["primary", "data", "settings"];

export const DEV_GROUP_META: Record<DevToolGroup, { label: string }> = {
  primary: { label: "主要工具" },
  data: { label: "資料" },
  settings: { label: "設定" },
};

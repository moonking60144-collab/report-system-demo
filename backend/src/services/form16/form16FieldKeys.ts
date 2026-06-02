import type { RagicRecord } from "../../ragic/client";

/**
 * Form 16 record 欄位 key 候選表。
 *
 * Ragic API 回 record 時是以「欄位名稱」為 key（不是 field ID），同一個概念欄位
 * 可能有多個名字（history / linked view 等因素），所以每個欄位用候選陣列表示、
 * 依序 fallback。
 *
 * 這是 Form 16 讀取相關流程的單一真相來源，verify / orphan / cleanup / audit
 * 都該 import 這邊，避免欄位 key 散寫在多個檔。
 */
export const FORM16_FIELD_KEYS = {
  workOrderNo: [
    "工令單單號",
    "ERP Work Order No.工令單單號",
    "No.工令單單號",
  ],
  reportType: ["Type報工類別", "報工類別"],
  plannedDowntime: ["計畫停機?", "Planned Idle計畫停機？"],
  creatorAccount: ["開單者帳號"],
  erpPartNo: [
    "ERP Part No.完工ERP料號",
    "完工ERP料號",
    "ERP Part No.",
    "ERP Part No",
    "料號",
  ],
  createdAt: ["Created建立日期時間"],
  date: ["Date生產日期", "Production Date生產日"],
  processCode: ["PROCESS子製程別代碼", "子製程別代碼"],
  machineId: ["Mach機台/Pack Type包裝類別", "機台/Pack Type"],
} as const;

/**
 * 從 Ragic record 依候選 key 順序取第一個非空值，trim 後回傳。全部沒命中回空字串。
 */
export function pickRagicField(
  record: RagicRecord | null | undefined,
  candidates: readonly string[]
): string {
  if (!record) return "";
  for (const key of candidates) {
    const v = (record as Record<string, unknown>)[key];
    if (v !== undefined && v !== null) {
      const trimmed = String(v).trim();
      if (trimmed !== "") return trimmed;
    }
  }
  return "";
}

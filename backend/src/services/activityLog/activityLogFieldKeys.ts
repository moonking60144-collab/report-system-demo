import type { RagicRecord } from "../../ragic/client";

/**
 * activity log record 欄位 key 候選表。
 *
 * Ragic API 回 record 時是以「欄位名稱」為 key（不是 field ID），同一個概念欄位
 * 可能有多個名字（history / linked view 等因素），所以每個欄位用候選陣列表示、
 * 依序 fallback。
 *
 * 這是 activity log 讀取相關流程的單一真相來源，verify / orphan / cleanup / audit
 * 都該 import 這邊，避免欄位 key 散寫在多個檔。
 */
export const ACTIVITY_LOG_FIELD_KEYS = {
  workOrderNo: ["demo_work_order_no", "work_order_no"],
  reportType: ["demo_report_type", "report_type"],
  plannedDowntime: ["demo_planned_idle", "planned_idle"],
  creatorAccount: ["demo_created_by"],
  erpPartNo: ["demo_part_no"],
  createdAt: ["demo_created_at"],
  date: ["demo_date"],
  processCode: ["demo_process_code"],
  machineId: ["demo_machine_id"],
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

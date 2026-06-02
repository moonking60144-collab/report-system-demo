import type { RagicRecord } from "../../ragic/client";
import { FORM16_FIELD_KEYS, pickRagicField } from "./form16FieldKeys";

/**
 * Form 16 孤兒判定策略（policy）。
 *
 * audit script / 背景 cleanup / 未來任何 orphan 工具都 import 這邊，確保判定一致。
 * 判定條件要調就改這個 file，別處不再各寫一份。
 */

/** 應該要有 workOrderNo 的報工類別；空 workOrderNo + 這些類別 = orphan 種子 */
export const FORM16_WORK_ORDER_REQUIRED_TYPES: readonly string[] = [
  "TI-ProcessA",
  "HF-Forge",
  "PROC-LM",
  "PROC-EP",
  "CH-ManualInspect",
  "CH-MachineInspect",
];

const WORK_ORDER_REQUIRED_TYPES_SET = new Set(FORM16_WORK_ORDER_REQUIRED_TYPES);

export interface Form16OrphanPolicyOptions {
  /** 只抓此 creator 寫的 entry（通常是 API 使用的 service account 名稱） */
  creatorAccount: string;
}

/**
 * 五 AND 判定：
 *   workOrderNo 空 + 計畫停機!=Yes + 報工類別∈白名單 + creator 符合 + ERP料號不含 test
 */
export function isForm16Orphan(
  record: RagicRecord,
  options: Form16OrphanPolicyOptions
): boolean {
  const workOrderNo = pickRagicField(record, FORM16_FIELD_KEYS.workOrderNo);
  if (workOrderNo !== "") return false;

  const plannedDowntime = pickRagicField(record, FORM16_FIELD_KEYS.plannedDowntime);
  if (plannedDowntime === "Yes") return false;

  const reportType = pickRagicField(record, FORM16_FIELD_KEYS.reportType);
  if (!WORK_ORDER_REQUIRED_TYPES_SET.has(reportType)) return false;

  const creator = pickRagicField(record, FORM16_FIELD_KEYS.creatorAccount);
  if (!options.creatorAccount || creator !== options.creatorAccount) return false;

  const erpPartNo = pickRagicField(record, FORM16_FIELD_KEYS.erpPartNo).toLowerCase();
  if (erpPartNo.includes("test")) return false;

  return true;
}

/**
 * 「其他五 AND 都中、但報工類別不在白名單」的偵測器。
 *
 * 用在背景 cleanup 的觀察層：回傳未列入白名單的實際 reportType（空值回 "(empty)"）。
 * 如果 cleanup log 看到某個 reportType 頻繁出現，就代表白名單該加這類。
 *
 * 回 null 代表這筆不是「疑似但漏抓」的候選（其他條件已經擋掉了）。
 */
export function detectNonWhitelistedOrphanType(
  record: RagicRecord,
  options: Form16OrphanPolicyOptions
): string | null {
  const workOrderNo = pickRagicField(record, FORM16_FIELD_KEYS.workOrderNo);
  if (workOrderNo !== "") return null;

  const plannedDowntime = pickRagicField(record, FORM16_FIELD_KEYS.plannedDowntime);
  if (plannedDowntime === "Yes") return null;

  const creator = pickRagicField(record, FORM16_FIELD_KEYS.creatorAccount);
  if (!options.creatorAccount || creator !== options.creatorAccount) return null;

  const erpPartNo = pickRagicField(record, FORM16_FIELD_KEYS.erpPartNo).toLowerCase();
  if (erpPartNo.includes("test")) return null;

  const reportType = pickRagicField(record, FORM16_FIELD_KEYS.reportType);
  if (WORK_ORDER_REQUIRED_TYPES_SET.has(reportType)) return null;

  return reportType || "(empty)";
}

/**
 * Parse Ragic createdAt "2026/04/14 20:42:00"（Asia/Taipei local time、無 tz）
 * 轉成 UTC epoch ms。
 *
 * Ragic 不帶 tz、直接 Date.parse 會被 Node server 的 local tz 解析，
 * UTC container 跑就偏 8 小時 → age 判定錯。所以這裡強制附 +08:00。
 */
export function parseForm16CreatedAtMs(record: RagicRecord): number | null {
  const raw = pickRagicField(record, FORM16_FIELD_KEYS.createdAt);
  if (!raw) return null;
  const match = raw.match(/^(\d{4})[/-](\d{2})[/-](\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const parsed = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}+08:00`);
  return Number.isFinite(parsed) ? parsed : null;
}

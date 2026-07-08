/**
 * Ragic 欄位 → 正規化分類（角色 / 約束 / FK 目標）。
 *
 * 抽成共用模組,讓「批次匯出 CSV」(scripts/export-ragic-schema.ts) 與
 * 「實體瀏覽 endpoint」(repository.getEntityFields) 用同一套判定,不會邏輯分叉。
 *
 * 判定規則都吃過對抗審查的修正:
 *   - 角色衍生判定切段感知(否則「預設值: X; 公式:」「預設值公式:」漏判成原始)
 *   - unique 約束切段感知(否則 link/load 目標名字面「(不可重複)」誤觸發)
 */

export const SIDE_EFFECT_EDGE_TYPES = new Set([
  "external_db_write",
  "cross_form_write",
  "external_http",
  "ragic_action",
]);

export type RagicFieldRole = "primary" | "derived" | "foreign" | "side_effect";

/** broken note：目標連結已失效,這視圖的 FK 目標/約束不可信 */
export function isBrokenNote(note: string | null): boolean {
  return /not found|deleted|configuration invalid|original link field/i.test(note ?? "");
}

/**
 * 角色（優先序：副作用 > 外來 > 衍生 > 原始）。
 * 衍生判定不能靠 startsWith('公式:')——要切段感知,涵蓋「預設值: …; 公式:」與「預設值公式:」。
 */
export function classifyRole(
  outTypes: string | null,
  note: string | null
): RagicFieldRole {
  const t = outTypes ?? "";
  if (t.split(",").some((x) => SIDE_EFFECT_EDGE_TYPES.has(x))) return "side_effect";
  if (/\b(link|load)\b/.test(t)) return "foreign";
  if (/(^|; )(預設值)?公式:/.test(note ?? "") || /formula_ref/.test(t)) return "derived";
  return "primary";
}

export interface RagicFieldConstraints {
  readOnly: boolean;
  unique: boolean;
  required: boolean;
  autoGen: boolean;
}

/** 約束。unique 的「不可重複」必須是獨立段(切段感知),不能是 link/load 目標名裡字面命中。*/
export function classifyConstraints(note: string | null): RagicFieldConstraints {
  const n = note ?? "";
  return {
    readOnly: /唯讀/.test(n),
    unique: /(^|; )不可重複(;|$)/.test(n),
    required: /必填/.test(n),
    autoGen: /自動產生:/.test(n),
  };
}

/** 從 note 抽 link/load 的目標表單名（FK 指向）*/
export function fkTargetName(note: string | null): string | null {
  const m = (note ?? "").match(/(連結到|從)(.+?)表單上的/);
  return m && m[2] ? m[2].trim() : null;
}

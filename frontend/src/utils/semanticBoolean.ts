/**
 * Ragic 欄位常回傳字串形式的布林（"Yes"、"是"、"v"、"✓"、"0"、"否" 等），
 * 這份檔案是整個前端解析這類「語意布林」的唯一來源。
 * 匹配方式：trim + toLowerCase 後查表。
 */
export const TRUE_BOOLEAN_VALUES = new Set(["yes", "true", "1", "v", "✓", "是"]);
export const FALSE_BOOLEAN_VALUES = new Set(["no", "false", "0", "否"]);

export function parseSemanticBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  if (!text) {
    return null;
  }
  const lowered = text.toLowerCase();
  if (TRUE_BOOLEAN_VALUES.has(lowered)) {
    return true;
  }
  if (FALSE_BOOLEAN_VALUES.has(lowered)) {
    return false;
  }
  return null;
}

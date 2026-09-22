import { HttpError } from "../../../utils/httpError";

export function parseDevAiJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced ? fenced[1] : trimmed) as unknown;
  } catch {
    throw new HttpError(
      502,
      "AI provider 回傳不是可解析的 JSON",
      "DEV_AI_MALFORMED_JSON"
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(502, "AI provider 回傳格式不是物件", "DEV_AI_BAD_JSON");
  }
  return parsed as Record<string, unknown>;
}

export function requireDevAiString(
  object: Record<string, unknown>,
  field: string
): string {
  const value = object[field];
  if (typeof value !== "string") {
    throw new HttpError(
      502,
      `AI provider 回傳欄位 ${field} 不是字串`,
      "DEV_AI_BAD_JSON"
    );
  }
  return value.trim();
}

export function requireDevAiStringArray(
  object: Record<string, unknown>,
  field: string
): string[] {
  const value = object[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new HttpError(
      502,
      `AI provider 回傳欄位 ${field} 不是字串陣列`,
      "DEV_AI_BAD_JSON"
    );
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

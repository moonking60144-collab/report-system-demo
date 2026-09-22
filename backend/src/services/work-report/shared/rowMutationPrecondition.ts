import { createHash } from "node:crypto";
import type { RagicRecord } from "../../../ragic/client";
import type { FormConfig } from "../../../types/formConfig";
import { HttpError } from "../../../utils/httpError";

function normalizeRowValue(value: unknown): unknown {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(normalizeRowValue);
  if (typeof value !== "object") return String(value).trim();
  const object = value as Record<string, unknown>;
  for (const key of ["value", "_value", "label", "_label"]) {
    if (Object.hasOwn(object, key)) return normalizeRowValue(object[key]);
  }
  return Object.fromEntries(Object.keys(object).sort().map(key => [key, normalizeRowValue(object[key])]));
}

export function buildRowSnapshotHash(config: FormConfig, rowId: string, row: RagicRecord): string {
  const values = Object.entries(config.writeConfig.subtableWriteFields)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, fieldId]) => {
      const raw = row[fieldId] ?? row[config.subtableFields[key] ?? ""];
      return [key, normalizeRowValue(raw)];
    });
  return createHash("sha256").update(JSON.stringify([config.formId, rowId, values])).digest("hex");
}

export function parseExpectedRowSnapshotHash(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new HttpError(400, "報工明細的原始版本格式錯誤，請重新整理後再試。", "INVALID_PAYLOAD");
  }
  return value;
}

export function assertRowSnapshotUnchanged(config: FormConfig, rowId: string, row: RagicRecord, expected: string): void {
  if (buildRowSnapshotHash(config, rowId, row) !== expected) {
    throw new HttpError(409, "這筆報工明細在編輯期間已被修改，請重新整理後確認。", "REPORT_ROW_CONFLICT");
  }
}

import { ragicClient, RagicRecord } from "../../../ragic/client";
import { FormConfig } from "../../../types/formConfig";
import { HttpError } from "../../../utils/httpError";
import { isObject } from "./ragicRowUtils";
import { collectSubtableRows } from "./subtableUtils";

export async function getRawEntry(
  config: FormConfig,
  entryId: string,
  useCache = false
): Promise<RagicRecord> {
  // 被 workReportService mutation 流程呼叫（使用者同步請求路徑），走 user lane
  const entry = await ragicClient.getEntry(config.ragicPath, entryId, useCache, {
    priority: "user",
  });
  if (!entry) {
    throw new HttpError(404, `找不到報工資料：${entryId}`, "REPORT_NOT_FOUND");
  }
  return entry;
}

export async function getExistingSubtableRow(
  config: FormConfig,
  entryId: string,
  rowId: string
): Promise<RagicRecord> {
  const entryData = await getRawEntry(config, entryId);
  const subtableRaw = entryData[config.writeConfig.subtableId];

  if (!isObject(subtableRaw)) {
    throw new HttpError(404, `找不到報工明細：${rowId}`, "REPORT_NOT_FOUND");
  }

  const existingRow = subtableRaw[rowId];
  if (!isObject(existingRow)) {
    throw new HttpError(404, `找不到報工明細：${rowId}`, "REPORT_NOT_FOUND");
  }

  return existingRow;
}

export async function getSubtableRowDataByRowId(
  config: FormConfig,
  entryId: string,
  rowId: string
): Promise<RagicRecord | null> {
  const latestEntry = await getRawEntry(config, entryId, false);
  const latestRows = collectSubtableRows(latestEntry[config.writeConfig.subtableId]);
  const target = latestRows.find((row) => row.rowId === rowId);
  return target?.rowData ?? null;
}

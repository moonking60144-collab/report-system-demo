import { env } from "../../config/env";
import { sqliteClient } from "../../storage/sqlite/sqliteClient";

/**
 * 從 SQLite cache 讀工令報工單列 row 在 mutation 前的內容。
 * SQLite 沒開或讀不到都回 null（audit 接受 null before snapshot）。
 */
export async function readWorkReportRowSnapshot(
  formId: string,
  entryId: string,
  rowId: string
): Promise<unknown | null> {
  if (!env.SQLITE_ENABLED) return null;
  try {
    const db = await sqliteClient.getDb();
    const row = await db.get<{ payload_json: string }>(
      `SELECT payload_json FROM work_report_rows
       WHERE form_id = ? AND entry_id = ? AND row_id = ?`,
      formId,
      entryId,
      rowId
    );
    if (!row?.payload_json) return null;
    try {
      return JSON.parse(row.payload_json);
    } catch {
      return null;
    }
  } catch (error) {
    console.warn("[record-audit-log][snapshot-read-failed]", {
      kind: "work-report",
      formId,
      entryId,
      rowId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * 從 SQLite cache 讀停機紀錄 entry 在 mutation 前的內容。
 */
export async function readDowntimeSnapshot(entryId: string): Promise<unknown | null> {
  if (!env.SQLITE_ENABLED) return null;
  try {
    const db = await sqliteClient.getDb();
    const row = await db.get<{ raw_json: string }>(
      `SELECT raw_json FROM form16_downtime_records WHERE entry_id = ?`,
      entryId
    );
    if (!row?.raw_json) return null;
    try {
      return JSON.parse(row.raw_json);
    } catch {
      return null;
    }
  } catch (error) {
    console.warn("[record-audit-log][snapshot-read-failed]", {
      kind: "downtime",
      entryId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

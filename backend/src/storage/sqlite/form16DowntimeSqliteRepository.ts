import { createHash } from "node:crypto";
import type { Database } from "sqlite";
import { env } from "../../config/env";
import { sqliteClient, withWriteTransaction } from "./sqliteClient";
import {
  buildSqliteMultiRowPlaceholders,
  resolveSqliteInsertChunkSize,
} from "./sqliteBulkInsert";
import type { Form16DowntimeRecord } from "../../types/form16Downtime";

interface Form16DowntimeStateRow {
  snapshot_at: string | null;
  total_records: number;
  updated_at: string;
}

export interface StoredForm16DowntimeState {
  snapshotAt: string | null;
  totalRecords: number;
  updatedAt: string;
}

const DOWNTIME_RECORD_COLUMN_COUNT = 15;

export function buildForm16DowntimeSnapshotHash(rawJson: string | null | undefined): string | null {
  if (!rawJson) return null;
  return createHash("sha256").update(rawJson).digest("hex");
}

function serializeForm16DowntimeRecord(record: Form16DowntimeRecord): string {
  const stored = {
    id: record.id,
    date: record.date,
    machineId: record.machineId,
    processCode: record.processCode,
    operatorId: record.operatorId,
    operatorName: record.operatorName,
    reportType: record.reportType,
    startTime: record.startTime,
    endTime: record.endTime,
    breakTime: record.breakTime,
    plannedIdleMinutes: record.plannedIdleMinutes,
    remark: record.remark,
    workOrderNo: record.workOrderNo,
  };
  return JSON.stringify(stored);
}

function toDowntimeInsertParams(record: Form16DowntimeRecord, syncedAt: string): unknown[] {
  return [
    record.id,
    record.date,
    record.machineId,
    record.processCode,
    record.operatorId,
    record.operatorName,
    record.reportType,
    record.startTime,
    record.endTime,
    record.breakTime,
    record.plannedIdleMinutes,
    record.remark,
    record.workOrderNo,
    serializeForm16DowntimeRecord(record),
    syncedAt,
  ];
}

class Form16DowntimeSqliteRepository {
  async listRecords(options: { limit?: number; offset?: number } = {}): Promise<Form16DowntimeRecord[]> {
    const db = await sqliteClient.getReadDb();
    const normalizedLimit =
      typeof options.limit === "number" && Number.isFinite(options.limit) && options.limit > 0
        ? Math.trunc(options.limit)
        : undefined;
    const normalizedOffset =
      typeof options.offset === "number" && Number.isFinite(options.offset) && options.offset > 0
        ? Math.trunc(options.offset)
        : 0;
    const baseSql = `
      SELECT
        entry_id,
        date_value,
        machine_id,
        process_code,
        operator_id,
        operator_name,
        report_type,
        start_time,
        end_time,
        break_time,
        planned_idle_minutes,
        remark,
        work_order_no,
        raw_json
      FROM form16_downtime_records
      ORDER BY CAST(entry_id AS INTEGER) DESC, entry_id DESC
    `;
    const rows = normalizedLimit
      ? await db.all<
      Array<{
        entry_id: string;
        date_value: string | null;
        machine_id: string | null;
        process_code: string | null;
        operator_id: string | null;
        operator_name: string | null;
        report_type: string | null;
        start_time: string | null;
        end_time: string | null;
        break_time: string | null;
        planned_idle_minutes: number | null;
        remark: string | null;
        work_order_no: string | null;
        raw_json: string | null;
      }>
      >(`${baseSql}\nLIMIT ? OFFSET ?`, normalizedLimit, normalizedOffset)
      : await db.all<
      Array<{
        entry_id: string;
        date_value: string | null;
        machine_id: string | null;
        process_code: string | null;
        operator_id: string | null;
        operator_name: string | null;
        report_type: string | null;
        start_time: string | null;
        end_time: string | null;
        break_time: string | null;
        planned_idle_minutes: number | null;
        remark: string | null;
        work_order_no: string | null;
        raw_json: string | null;
      }>
      >(baseSql);

    return rows.map((row) => ({
      id: row.entry_id,
      snapshotHash: buildForm16DowntimeSnapshotHash(row.raw_json),
      date: row.date_value,
      machineId: row.machine_id,
      processCode: row.process_code,
      operatorId: row.operator_id,
      operatorName: row.operator_name,
      reportType: row.report_type,
      startTime: row.start_time,
      endTime: row.end_time,
      breakTime: row.break_time,
      plannedIdleMinutes:
        typeof row.planned_idle_minutes === "number" && Number.isFinite(row.planned_idle_minutes)
          ? row.planned_idle_minutes
          : null,
      remark: row.remark,
      workOrderNo: row.work_order_no,
    }));
  }

  async replaceSnapshot(records: Form16DowntimeRecord[], syncedAt: string): Promise<void> {
    await withWriteTransaction(async (db) => {
      await db.exec("DELETE FROM form16_downtime_records");
      await this.upsertRecordsWithDb(db, records, syncedAt);

      await db.run(
        `
        INSERT INTO form16_downtime_state (id, snapshot_at, total_records, updated_at)
        VALUES (1, ?, ?, ?)
        ON CONFLICT(id)
        DO UPDATE SET
          snapshot_at = excluded.snapshot_at,
          total_records = excluded.total_records,
          updated_at = excluded.updated_at
        `,
        syncedAt,
        records.length,
        new Date().toISOString()
      );
    });
  }

  /**
   * Incremental sync：比對 Ragic 回傳 set 跟 SQLite 現有 set
   * - 兩邊都有 → upsert（資料可能更新過）
   * - Ragic 有 SQLite 沒 → upsert 新增
   * - SQLite 有 Ragic 沒 → delete（在 Ragic 被刪或已離開時間範圍）
   *
   * 不會洗掉透過 upsertRecord 進來的新建 entry（只要它在 Ragic 回傳 set 裡）
   *
   * **重要：這是一個範圍限定 (scoped) 的同步，不是完整全表 mirror**
   *
   * Caller（form16DowntimeService.fetchRecordsFromRagic）目前只抓**近 30 天**內的
   * `計畫停機 = Yes` 紀錄。所以 SQLite 表上**只會保留近 30 天的 projection**，
   * 30 天前的紀錄會被本 method 的 delete 邏輯清掉（因為 incoming set 不包含它們）。
   *
   * 這是 intentional product decision（90 天範圍 7000+ 筆讀取太慢，停機紀錄
   * UI 也只需要近期資料），不是「完整停機紀錄表」。如果要查歷史 30+ 天前的
   * 停機紀錄需要直接查 Ragic。
   */
  async syncSnapshot(records: Form16DowntimeRecord[], syncedAt: string): Promise<void> {
    await withWriteTransaction(async (db) => {
      const existingRows = await db.all<Array<{ entry_id: string }>>(
        "SELECT entry_id FROM form16_downtime_records"
      );
      const existingIds = new Set(existingRows.map((r) => r.entry_id));
      const incomingIds = new Set(records.map((r) => r.id));
      const toDelete = [...existingIds].filter((id) => !incomingIds.has(id));

      for (const entryId of toDelete) {
        await db.run("DELETE FROM form16_downtime_records WHERE entry_id = ?", entryId);
      }
      await this.upsertRecordsWithDb(db, records, syncedAt);
      await db.run(
        `
        INSERT INTO form16_downtime_state (id, snapshot_at, total_records, updated_at)
        VALUES (1, ?, ?, ?)
        ON CONFLICT(id)
        DO UPDATE SET
          snapshot_at = excluded.snapshot_at,
          total_records = excluded.total_records,
          updated_at = excluded.updated_at
        `,
        syncedAt,
        records.length,
        new Date().toISOString()
      );
    });
  }

  async upsertRecord(record: Form16DowntimeRecord, syncedAt: string): Promise<void> {
    await withWriteTransaction(async (db) => {
      await this.upsertRecordWithDb(db, record, syncedAt);
      await this.updateSnapshotStateWithDb(db, syncedAt);
    });
  }

  async deleteRecord(entryId: string, syncedAt: string): Promise<void> {
    await withWriteTransaction(async (db) => {
      await db.run("DELETE FROM form16_downtime_records WHERE entry_id = ?", entryId);
      await this.updateSnapshotStateWithDb(db, syncedAt);
    });
  }

  async getSnapshotState(): Promise<StoredForm16DowntimeState | null> {
    const db = await sqliteClient.getReadDb();
    const row = await db.get<Form16DowntimeStateRow>(
      `
      SELECT snapshot_at, total_records, updated_at
      FROM form16_downtime_state
      WHERE id = 1
      `
    );
    if (!row) {
      return null;
    }
    return {
      snapshotAt: row.snapshot_at ?? null,
      totalRecords:
        typeof row.total_records === "number" && Number.isFinite(row.total_records)
          ? row.total_records
          : 0,
      updatedAt: row.updated_at,
    };
  }

  async getRecordSnapshotHash(entryId: string): Promise<string | null> {
    const db = await sqliteClient.getReadDb();
    const row = await db.get<{ raw_json: string | null }>(
      "SELECT raw_json FROM form16_downtime_records WHERE entry_id = ?",
      entryId
    );
    return buildForm16DowntimeSnapshotHash(row?.raw_json);
  }

  private async upsertRecordWithDb(
    db: Database,
    record: Form16DowntimeRecord,
    syncedAt: string
  ): Promise<void> {
    await this.upsertRecordsWithDb(db, [record], syncedAt);
  }

  private async upsertRecordsWithDb(
    db: Database,
    records: Form16DowntimeRecord[],
    syncedAt: string
  ): Promise<void> {
    const chunkSize = resolveSqliteInsertChunkSize(
      env.SQLITE_SYNC_BATCH_SIZE,
      DOWNTIME_RECORD_COLUMN_COUNT
    );
    for (let index = 0; index < records.length; index += chunkSize) {
      const chunk = records.slice(index, index + chunkSize);
      const params = chunk.flatMap((record) => toDowntimeInsertParams(record, syncedAt));
      if (params.length === 0) {
        continue;
      }

      await db.run(
        `
        INSERT INTO form16_downtime_records (
          entry_id,
          date_value,
          machine_id,
          process_code,
          operator_id,
          operator_name,
          report_type,
          start_time,
          end_time,
          break_time,
          planned_idle_minutes,
          remark,
          work_order_no,
          raw_json,
          synced_at
        ) VALUES ${buildSqliteMultiRowPlaceholders(chunk.length, DOWNTIME_RECORD_COLUMN_COUNT)}
        ON CONFLICT(entry_id)
        DO UPDATE SET
          date_value = excluded.date_value,
          machine_id = excluded.machine_id,
          process_code = excluded.process_code,
          operator_id = excluded.operator_id,
          operator_name = excluded.operator_name,
          report_type = excluded.report_type,
          start_time = excluded.start_time,
          end_time = excluded.end_time,
          break_time = excluded.break_time,
          planned_idle_minutes = excluded.planned_idle_minutes,
          remark = excluded.remark,
          work_order_no = excluded.work_order_no,
          raw_json = excluded.raw_json,
          synced_at = excluded.synced_at
        `,
        ...params
      );
    }
  }

  private async updateSnapshotStateWithDb(db: Database, snapshotAt: string): Promise<void> {
    const countRow = await db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM form16_downtime_records"
    );
    const totalRecords =
      typeof countRow?.count === "number" && Number.isFinite(countRow.count) ? countRow.count : 0;

    await db.run(
      `
      INSERT INTO form16_downtime_state (id, snapshot_at, total_records, updated_at)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id)
      DO UPDATE SET
        snapshot_at = excluded.snapshot_at,
        total_records = excluded.total_records,
        updated_at = excluded.updated_at
      `,
      snapshotAt,
      totalRecords,
      new Date().toISOString()
    );
  }
}

export const form16DowntimeSqliteRepository = new Form16DowntimeSqliteRepository();

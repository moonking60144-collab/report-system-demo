import type { Database } from "sqlite";
import { sqliteClient } from "./sqliteClient";
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

class Form16DowntimeSqliteRepository {
  private writeChain: Promise<void> = Promise.resolve();

  private async runSerializedWrite<T>(
    operation: (db: Database) => Promise<T>
  ): Promise<T> {
    const scheduled = this.writeChain
      .catch(() => {
        // NOTE: 避免前一次失敗讓後續 SQLite 寫入鏈卡死。
      })
      .then(async () => operation(await sqliteClient.getDb()));

    this.writeChain = scheduled.then(
      () => undefined,
      () => undefined
    );

    return scheduled;
  }

  async listRecords(options: { limit?: number; offset?: number } = {}): Promise<Form16DowntimeRecord[]> {
    const db = await sqliteClient.getDb();
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
        work_order_no
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
      }>
      >(baseSql);

    return rows.map((row) => ({
      id: row.entry_id,
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
    await this.runSerializedWrite(async (db) => {
      await db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        await db.exec("DELETE FROM form16_downtime_records");

        for (const record of records) {
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
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
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
            JSON.stringify(record),
            syncedAt
          );
        }

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

        await db.exec("COMMIT");
      } catch (error) {
        await db.exec("ROLLBACK");
        throw error;
      }
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
    await this.runSerializedWrite(async (db) => {
      const existingRows = await db.all<Array<{ entry_id: string }>>(
        "SELECT entry_id FROM form16_downtime_records"
      );
      const existingIds = new Set(existingRows.map((r) => r.entry_id));
      const incomingIds = new Set(records.map((r) => r.id));
      const toDelete = [...existingIds].filter((id) => !incomingIds.has(id));

      await db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        for (const entryId of toDelete) {
          await db.run("DELETE FROM form16_downtime_records WHERE entry_id = ?", entryId);
        }
        for (const record of records) {
          await this.upsertRecordWithDb(db, record, syncedAt);
        }
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
        await db.exec("COMMIT");
      } catch (error) {
        await db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async upsertRecord(record: Form16DowntimeRecord, syncedAt: string): Promise<void> {
    await this.runSerializedWrite(async (db) => {
      await db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        await this.upsertRecordWithDb(db, record, syncedAt);
        await this.updateSnapshotStateWithDb(db, syncedAt);
        await db.exec("COMMIT");
      } catch (error) {
        await db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async deleteRecord(entryId: string, syncedAt: string): Promise<void> {
    await this.runSerializedWrite(async (db) => {
      await db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        await db.run("DELETE FROM form16_downtime_records WHERE entry_id = ?", entryId);
        await this.updateSnapshotStateWithDb(db, syncedAt);
        await db.exec("COMMIT");
      } catch (error) {
        await db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async getSnapshotState(): Promise<StoredForm16DowntimeState | null> {
    const db = await sqliteClient.getDb();
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

  private async upsertRecordWithDb(
    db: Database,
    record: Form16DowntimeRecord,
    syncedAt: string
  ): Promise<void> {
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      JSON.stringify(record),
      syncedAt
    );
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

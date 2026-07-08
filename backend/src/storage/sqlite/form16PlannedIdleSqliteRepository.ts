import type { Database } from "sqlite";
import { env } from "../../config/env";
import { sqliteClient, withWriteTransaction } from "./sqliteClient";
import {
  buildSqliteMultiRowPlaceholders,
  resolveSqliteInsertChunkSize,
} from "./sqliteBulkInsert";

export interface PlannedIdleSqliteRecord {
  entryId: string;
  date: string;
  monthKey: string;
  machineId: string;
  prodType: string;
  plannedMinutes: number;
}

export interface PlannedIdleMachineAggregate {
  machineId: string;
  prodType: string;
  totalMinutes: number;
  count: number;
}

export interface PlannedIdleSyncState {
  syncedAt: string | null;
  oldestMonth: string | null;
  totalRecords: number;
}

const PLANNED_IDLE_RECORD_COLUMN_COUNT = 7;

function toPlannedIdleInsertParams(record: PlannedIdleSqliteRecord, syncedAt: string): unknown[] {
  return [
    record.entryId,
    record.date,
    record.monthKey,
    record.machineId,
    record.prodType,
    record.plannedMinutes,
    syncedAt,
  ];
}

class Form16PlannedIdleSqliteRepository {
  // 半年背景同步：全量替換 + 記錄同步範圍/時間。
  // B4 註：用「全量替換」而非 incremental diff 是刻意的 —— incremental 的「刪掉 incoming 沒有的」
  // 會誤刪使用者剛 refresh 新建、但背景快照（撈在使用者改之前）尚未含到的當月 entry。
  // 全量替換最差只是「背景舊快照短暫蓋過 refresh」，下次背景（撈到改後）即修正，30 分內自我修復。
  async replaceAll(
    records: PlannedIdleSqliteRecord[],
    oldestMonth: string,
    syncedAt: string
  ): Promise<void> {
    await withWriteTransaction(async (db) => {
      await db.exec("DELETE FROM form16_planned_idle_records");
      await this.insertManyWithDb(db, records, syncedAt);
      await this.upsertStateWithDb(db, syncedAt, oldestMonth, records.length);
    });
  }

  // 單月替換（refresh 即時撈該月後用）：只換該月，不動背景同步範圍 state。
  async replaceMonth(
    monthKey: string,
    records: PlannedIdleSqliteRecord[],
    syncedAt: string
  ): Promise<void> {
    await withWriteTransaction(async (db) => {
      await db.run("DELETE FROM form16_planned_idle_records WHERE month_key = ?", monthKey);
      await this.insertManyWithDb(db, records, syncedAt);
    });
  }

  // 某月每機台 (P)計畫停機分加總。
  // SQLite WAL 讀連線只會看到已 commit snapshot，不需要排進寫入鏈等背景 replaceAll。
  // A3：prodType 取「該機台 entry_id 最小的非空值」，與 service.aggregateRecords 的 JS 端同一基準，避免兩路徑分類不一致。
  // C6：WHERE planned_idle_minutes > 0 與 fetch 端已 filter 同口徑（防禦性重複，不會漏算）。
  async aggregateByMonth(monthKey: string): Promise<PlannedIdleMachineAggregate[]> {
    const db = await sqliteClient.getReadDb();
    const rows = await db.all<
      Array<{ machine_id: string; prod_type: string | null; total_minutes: number; count: number }>
    >(
      `
      SELECT
        r1.machine_id AS machine_id,
        (
          SELECT r2.prod_type FROM form16_planned_idle_records r2
          WHERE r2.machine_id = r1.machine_id AND r2.month_key = r1.month_key
            AND r2.planned_idle_minutes > 0 AND r2.prod_type <> ''
          ORDER BY CAST(r2.entry_id AS INTEGER) ASC
          LIMIT 1
        ) AS prod_type,
        SUM(r1.planned_idle_minutes) AS total_minutes,
        COUNT(*) AS count
      FROM form16_planned_idle_records r1
      WHERE r1.month_key = ? AND r1.planned_idle_minutes > 0
        AND r1.machine_id IS NOT NULL AND r1.machine_id <> ''
      GROUP BY r1.machine_id
      ORDER BY total_minutes DESC
      `,
      monthKey
    );
    return rows.map((row) => ({
      machineId: row.machine_id,
      prodType: row.prod_type ?? "",
      totalMinutes:
        typeof row.total_minutes === "number" && Number.isFinite(row.total_minutes)
          ? row.total_minutes
          : 0,
      count: typeof row.count === "number" && Number.isFinite(row.count) ? row.count : 0,
    }));
  }

  // 背景同步狀態（給 summarize 判斷「同步過且 0 筆」vs「沒同步過」，以及觀測上次同步時間）。
  async getState(): Promise<PlannedIdleSyncState | null> {
    const db = await sqliteClient.getReadDb();
    const row = await db.get<{
      synced_at: string | null;
      oldest_month: string | null;
      total_records: number;
    }>(
      "SELECT synced_at, oldest_month, total_records FROM form16_planned_idle_state WHERE id = 1"
    );
    if (!row) {
      return null;
    }
    return {
      syncedAt: row.synced_at ?? null,
      oldestMonth: row.oldest_month ?? null,
      totalRecords:
        typeof row.total_records === "number" && Number.isFinite(row.total_records)
          ? row.total_records
          : 0,
    };
  }

  private async upsertStateWithDb(
    db: Database,
    syncedAt: string,
    oldestMonth: string,
    totalRecords: number
  ): Promise<void> {
    await db.run(
      `
      INSERT INTO form16_planned_idle_state (id, synced_at, oldest_month, total_records, updated_at)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        synced_at = excluded.synced_at,
        oldest_month = excluded.oldest_month,
        total_records = excluded.total_records,
        updated_at = excluded.updated_at
      `,
      syncedAt,
      oldestMonth,
      totalRecords,
      syncedAt
    );
  }

  private async insertManyWithDb(
    db: Database,
    records: PlannedIdleSqliteRecord[],
    syncedAt: string
  ): Promise<void> {
    const chunkSize = resolveSqliteInsertChunkSize(
      env.SQLITE_SYNC_BATCH_SIZE,
      PLANNED_IDLE_RECORD_COLUMN_COUNT
    );
    for (let index = 0; index < records.length; index += chunkSize) {
      const chunk = records.slice(index, index + chunkSize);
      const params = chunk.flatMap((record) => toPlannedIdleInsertParams(record, syncedAt));
      if (params.length === 0) {
        continue;
      }

      await db.run(
        `
        INSERT INTO form16_planned_idle_records (
          entry_id, date_value, month_key, machine_id, prod_type, planned_idle_minutes, synced_at
        ) VALUES ${buildSqliteMultiRowPlaceholders(chunk.length, PLANNED_IDLE_RECORD_COLUMN_COUNT)}
        ON CONFLICT(entry_id) DO UPDATE SET
          date_value = excluded.date_value,
          month_key = excluded.month_key,
          machine_id = excluded.machine_id,
          prod_type = excluded.prod_type,
          planned_idle_minutes = excluded.planned_idle_minutes,
          synced_at = excluded.synced_at
        `,
        ...params
      );
    }
  }
}

export const form16PlannedIdleSqliteRepository = new Form16PlannedIdleSqliteRepository();

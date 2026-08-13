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
  fullRevision: number;
  projectionRevision: number;
}

export interface PlannedIdleRefreshBarrier {
  fullRevision: number;
  projectionRevision: number;
  monthRevision: number;
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
  // 半年背景同步：只有 projection revision 未變時才提交整份快照。
  async replaceAll(
    records: PlannedIdleSqliteRecord[],
    oldestMonth: string,
    syncedAt: string,
    expectedProjectionRevision: number
  ): Promise<"applied" | "stale"> {
    return withWriteTransaction(async (db) => {
      const globalState = await db.get<{ projection_revision: number }>(
        "SELECT projection_revision FROM form16_planned_idle_state WHERE id = 1"
      );
      if ((globalState?.projection_revision ?? 0) !== expectedProjectionRevision) {
        return "stale";
      }

      await db.exec("DELETE FROM form16_planned_idle_records");
      await db.exec("DELETE FROM form16_planned_idle_month_state");
      await this.insertManyWithDb(db, records, syncedAt);
      for (const monthKey of new Set(records.map((record) => record.monthKey))) {
        await this.upsertMonthStateWithDb(db, monthKey, syncedAt);
      }
      await this.commitFullStateWithCurrentCount(db, syncedAt, oldestMonth);
      return "applied";
    });
  }

  // 單月替換（refresh 即時撈該月後用）：只換該月，不動背景同步範圍 state。
  async replaceMonth(
    monthKey: string,
    records: PlannedIdleSqliteRecord[],
    syncedAt: string,
    expectedBarrier: PlannedIdleRefreshBarrier
  ): Promise<"applied" | "stale"> {
    return withWriteTransaction(async (db) => {
      const globalState = await db.get<{
        full_revision: number;
        projection_revision: number;
      }>(
        `SELECT full_revision, projection_revision
         FROM form16_planned_idle_state
         WHERE id = 1`
      );
      const monthState = await db.get<{ revision: number }>(
        "SELECT revision FROM form16_planned_idle_month_state WHERE month_key = ?",
        monthKey
      );
      if (
        (globalState?.full_revision ?? 0) !== expectedBarrier.fullRevision ||
        (globalState?.projection_revision ?? 0) !== expectedBarrier.projectionRevision ||
        (monthState?.revision ?? 0) !== expectedBarrier.monthRevision
      ) {
        return "stale";
      }
      await db.run("DELETE FROM form16_planned_idle_records WHERE month_key = ?", monthKey);
      await this.insertManyWithDb(db, records, syncedAt);
      await this.upsertMonthStateWithDb(db, monthKey, syncedAt);
      await this.incrementProjectionRevisionWithCurrentCount(db, syncedAt);
      return "applied";
    });
  }

  async getRefreshBarrier(monthKey: string): Promise<PlannedIdleRefreshBarrier> {
    const db = await sqliteClient.getReadDb();
    const globalState = await db.get<{
      full_revision: number;
      projection_revision: number;
    }>(
      "SELECT full_revision, projection_revision FROM form16_planned_idle_state WHERE id = 1"
    );
    const monthState = await db.get<{ revision: number }>(
      "SELECT revision FROM form16_planned_idle_month_state WHERE month_key = ?",
      monthKey
    );
    return {
      fullRevision: globalState?.full_revision ?? 0,
      projectionRevision: globalState?.projection_revision ?? 0,
      monthRevision: monthState?.revision ?? 0,
    };
  }

  async getProjectionRevision(): Promise<number> {
    const db = await sqliteClient.getReadDb();
    const row = await db.get<{ projection_revision: number }>(
      "SELECT projection_revision FROM form16_planned_idle_state WHERE id = 1"
    );
    return row?.projection_revision ?? 0;
  }

  async bumpProjectionRevision(updatedAt = new Date().toISOString()): Promise<void> {
    await withWriteTransaction(async (db) => {
      await this.incrementProjectionRevisionWithCurrentCount(db, updatedAt);
    });
  }

  async getMonthSyncedAt(monthKey: string): Promise<string | null> {
    const db = await sqliteClient.getReadDb();
    const row = await db.get<{ synced_at: string | null }>(
      "SELECT synced_at FROM form16_planned_idle_month_state WHERE month_key = ?",
      monthKey
    );
    return row?.synced_at ?? null;
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
      full_revision: number;
      projection_revision: number;
    }>(
      `SELECT synced_at, oldest_month, total_records, full_revision, projection_revision
       FROM form16_planned_idle_state
       WHERE id = 1`
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
      fullRevision: row.full_revision ?? 0,
      projectionRevision: row.projection_revision ?? 0,
    };
  }

  private async commitFullStateWithCurrentCount(
    db: Database,
    syncedAt: string,
    oldestMonth: string
  ): Promise<void> {
    const countRow = await db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM form16_planned_idle_records"
    );
    const totalRecords =
      typeof countRow?.count === "number" && Number.isFinite(countRow.count)
        ? countRow.count
        : 0;
    await db.run(
      `
      INSERT INTO form16_planned_idle_state (
        id, synced_at, oldest_month, total_records, full_revision, projection_revision, updated_at
      )
      VALUES (1, ?, ?, ?, 1, 1, ?)
      ON CONFLICT(id) DO UPDATE SET
        synced_at = excluded.synced_at,
        oldest_month = excluded.oldest_month,
        total_records = excluded.total_records,
        full_revision = form16_planned_idle_state.full_revision + 1,
        projection_revision = form16_planned_idle_state.projection_revision + 1,
        updated_at = excluded.updated_at
      `,
      syncedAt,
      oldestMonth,
      totalRecords,
      syncedAt
    );
  }

  private async incrementProjectionRevisionWithCurrentCount(
    db: Database,
    updatedAt: string
  ): Promise<void> {
    const countRow = await db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM form16_planned_idle_records"
    );
    const totalRecords =
      typeof countRow?.count === "number" && Number.isFinite(countRow.count)
        ? countRow.count
        : 0;
    await db.run(
      `INSERT INTO form16_planned_idle_state (
         id, synced_at, oldest_month, total_records, full_revision, projection_revision, updated_at
       )
       VALUES (1, NULL, NULL, ?, 0, 1, ?)
       ON CONFLICT(id) DO UPDATE SET
         total_records = excluded.total_records,
         projection_revision = form16_planned_idle_state.projection_revision + 1,
         updated_at = excluded.updated_at`,
      totalRecords,
      updatedAt
    );
  }

  private async upsertMonthStateWithDb(
    db: Database,
    monthKey: string,
    syncedAt: string
  ): Promise<void> {
    await db.run(
      `INSERT INTO form16_planned_idle_month_state (month_key, synced_at, revision)
       VALUES (?, ?, 1)
       ON CONFLICT(month_key) DO UPDATE SET
         synced_at = excluded.synced_at,
         revision = form16_planned_idle_month_state.revision + 1`,
      monthKey,
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

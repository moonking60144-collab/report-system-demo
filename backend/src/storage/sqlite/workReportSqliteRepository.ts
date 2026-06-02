import { env } from "../../config/env";
import type { Database } from "sqlite";
import type {
  ReportFacetCount,
  ReportFacetQueryOptions,
  WorkReportItem,
  WorkReportRecord,
} from "../../types/workReport";
import { READ_MODEL_SCHEMA_VERSION } from "./readModelSchema";
import { sqliteClient } from "./sqliteClient";
import {
  buildEntryWhereClauses,
  buildSearchText,
  chunkArray,
  compareFacetTokens,
  dedupeRecordsByEntryId,
  type EntryDetailRecord,
  type EntryRowRecord,
  FACET_BLANK_TOKEN,
  parseRecordPayload,
  parseSemanticBooleanToInteger,
  type SqliteReportQueryOptions,
  type SupportedFacetField,
  toFacetToken,
  toNullableIsoDateTime,
  toNullableNumber,
  toNullableText,
} from "./workReportSqliteHelpers";

export type { SqliteReportQueryOptions } from "./workReportSqliteHelpers";

export interface SyncStatePatch {
  formId: string;
  status: "idle" | "running" | "success" | "failed";
  taskId?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  snapshotAt?: string | null;
  readModelVersion?: number | null;
  totalEntries?: number;
  totalRows?: number;
  message?: string | null;
}

export interface StoredSyncState {
  formId: string;
  status: string;
  taskId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  snapshotAt: string | null;
  readModelVersion: number | null;
  totalEntries: number;
  totalRows: number;
  message: string | null;
  updatedAt: string;
}

export interface SqliteReportQueryResult {
  data: WorkReportRecord[];
  count: number;
  totalCount: number;
  hasMore: boolean;
}

export type ProjectionQueueReason = "create" | "update" | "delete";

export interface PendingProjectionEntry {
  entryId: string;
  latestSeq: number;
}

class WorkReportSqliteRepository {
  private writeChain: Promise<void> = Promise.resolve();

  private async runSerializedWrite<T>(
    operation: (db: Database) => Promise<T>
  ): Promise<T> {
    const scheduled = this.writeChain
      .catch(() => {
        // NOTE: 讓後續 SQLite 寫入不會因前一次失敗而卡死。
      })
      .then(async () => operation(await sqliteClient.getDb()));

    this.writeChain = scheduled.then(
      () => undefined,
      () => undefined
    );

    return scheduled;
  }

  async replaceFormSnapshot(
    formId: string,
    records: WorkReportRecord[],
    syncedAt: string
  ): Promise<{ entryCount: number; rowCount: number }> {
    return this.runSerializedWrite(async (db) =>
      this.replaceFormSnapshotWithDb(db, formId, records, syncedAt)
    );
  }

  private async replaceFormSnapshotWithDb(
    db: Database,
    formId: string,
    records: WorkReportRecord[],
    syncedAt: string
  ): Promise<{ entryCount: number; rowCount: number }> {
    const dedupedRecords = dedupeRecordsByEntryId(records);
    const batchSize = env.SQLITE_SYNC_BATCH_SIZE;
    const rowPayloads: Array<{
      formId: string;
      entryId: string;
      rowId: string;
      dateValue: string | null;
      operatorId: string | null;
      processCode: string | null;
      machineId: string | null;
      payloadJson: string;
      syncedAt: string;
    }> = [];

    await db.exec("BEGIN IMMEDIATE TRANSACTION");
    const insertEntryStmt = await db.prepare(
      `
      INSERT INTO work_report_entries (
        form_id,
        entry_id,
        work_order_no,
        customer_part_no,
        machine_code,
        filter_machine_code,
        status,
        ragic_unfinished_status,
        site_running,
        start_schedule,
        sort_order,
        planned_start_date,
        last_updated_at,
        search_text,
        summary_json,
        detail_json,
        synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    );
    const insertRowStmt = await db.prepare(
      `
      INSERT INTO work_report_rows (
        form_id,
        entry_id,
        row_id,
        date_value,
        operator_id,
        process_code,
        machine_id,
        payload_json,
        synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    );
    try {
      await db.run("DELETE FROM work_report_rows WHERE form_id = ?", formId);
      await db.run("DELETE FROM work_report_entries WHERE form_id = ?", formId);

      for (const recordChunk of chunkArray(dedupedRecords, batchSize)) {
        for (const record of recordChunk) {
          const entryId = toNullableText(record.id);
          if (!entryId) {
            continue;
          }

          const reports = Array.isArray(record.reports) ? record.reports : [];
          const summaryRecord: WorkReportRecord = { ...record, reports: [] };
          const summaryJsonStr = JSON.stringify(summaryRecord);
          const searchText = buildSearchText(summaryRecord);
          // detail_json 直接用原 record；原本還多 spread 一次 { ...record, reports } 是多餘 clone
          const detailJsonStr = JSON.stringify(record);

          await insertEntryStmt.run(
            formId,
            entryId,
            toNullableText(record.workOrderNo),
            toNullableText(record.customerPartNo),
            toNullableText(record.machineCode),
            toNullableText(record.filterMachineCode),
            toNullableText(record.status),
            toNullableText(record.ragicUnfinishedStatus),
            parseSemanticBooleanToInteger(record.siteRunning),
            parseSemanticBooleanToInteger(record.startSchedule),
            toNullableNumber(record.sortOrder),
            toNullableIsoDateTime(record.plannedStartDate),
            toNullableIsoDateTime(record.lastUpdatedAt),
            searchText,
            summaryJsonStr,
            detailJsonStr,
            syncedAt
          );

          for (const report of reports) {
            const rowId = toNullableText((report as WorkReportItem).rowId);
            if (!rowId) {
              continue;
            }

            rowPayloads.push({
              formId,
              entryId,
              rowId,
              dateValue: toNullableText((report as WorkReportItem).date),
              operatorId: toNullableText((report as WorkReportItem).operatorId),
              processCode: toNullableText((report as WorkReportItem).processCode),
              machineId: toNullableText((report as WorkReportItem).machineId),
              payloadJson: JSON.stringify(report),
              syncedAt,
            });
          }
        }
      }

      for (const rowChunk of chunkArray(rowPayloads, batchSize * 2)) {
        for (const row of rowChunk) {
          await insertRowStmt.run(
            row.formId,
            row.entryId,
            row.rowId,
            row.dateValue,
            row.operatorId,
            row.processCode,
            row.machineId,
            row.payloadJson,
            row.syncedAt
          );
        }
      }

      await db.exec("COMMIT");
      return {
        entryCount: dedupedRecords.length,
        rowCount: rowPayloads.length,
      };
    } catch (error) {
      await db.exec("ROLLBACK");
      throw error;
    } finally {
      await insertEntryStmt.finalize();
      await insertRowStmt.finalize();
    }
  }

  async upsertSyncState(patch: SyncStatePatch): Promise<void> {
    await this.runSerializedWrite(async (db) => {
      await this.upsertSyncStateWithDb(db, patch);
    });
  }

  private async upsertSyncStateWithDb(
    db: Database,
    patch: SyncStatePatch
  ): Promise<void> {
    const now = new Date().toISOString();
    const existing = await this.getSyncStateWithDb(db, patch.formId);

    const nextTaskId =
      patch.taskId === undefined ? existing?.taskId ?? null : patch.taskId ?? null;
    const nextStartedAt =
      patch.startedAt === undefined ? existing?.startedAt ?? null : patch.startedAt ?? null;
    const nextFinishedAt =
      patch.finishedAt === undefined ? existing?.finishedAt ?? null : patch.finishedAt ?? null;
    const nextSnapshotAt =
      patch.snapshotAt === undefined ? existing?.snapshotAt ?? null : patch.snapshotAt ?? null;
    const nextReadModelVersion =
      patch.readModelVersion === undefined
        ? existing?.readModelVersion ?? null
        : patch.readModelVersion ?? null;
    const nextTotalEntries =
      patch.totalEntries === undefined ? existing?.totalEntries ?? 0 : patch.totalEntries;
    const nextTotalRows =
      patch.totalRows === undefined ? existing?.totalRows ?? 0 : patch.totalRows;
    const nextMessage =
      patch.message === undefined ? existing?.message ?? null : patch.message ?? null;

    await db.run(
      `
      INSERT INTO sync_state (
        form_id,
        status,
        task_id,
        started_at,
        finished_at,
        snapshot_at,
        read_model_version,
        total_entries,
        total_rows,
        message,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(form_id)
      DO UPDATE SET
        status = excluded.status,
        task_id = excluded.task_id,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        snapshot_at = excluded.snapshot_at,
        read_model_version = excluded.read_model_version,
        total_entries = excluded.total_entries,
        total_rows = excluded.total_rows,
        message = excluded.message,
        updated_at = excluded.updated_at
      `,
      patch.formId,
      patch.status,
      nextTaskId,
      nextStartedAt,
      nextFinishedAt,
      nextSnapshotAt,
      nextReadModelVersion,
      nextTotalEntries,
      nextTotalRows,
      nextMessage,
      now
    );
  }

  async enqueueProjectionEvent(
    formId: string,
    entryId: string,
    reason: ProjectionQueueReason
  ): Promise<number> {
    return this.runSerializedWrite(async (db) =>
      this.enqueueProjectionEventWithDb(db, formId, entryId, reason)
    );
  }

  private async enqueueProjectionEventWithDb(
    db: Database,
    formId: string,
    entryId: string,
    reason: ProjectionQueueReason
  ): Promise<number> {
    const normalizedEntryId = toNullableText(entryId);
    if (!normalizedEntryId) {
      return 0;
    }

    const now = new Date().toISOString();
    await db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      await db.run(
        `
        INSERT INTO projection_state (form_id, last_enqueued_seq, updated_at)
        VALUES (?, 0, ?)
        ON CONFLICT(form_id) DO NOTHING
        `,
        formId,
        now
      );

      const stateRow = await db.get<{ last_enqueued_seq: number }>(
        "SELECT last_enqueued_seq FROM projection_state WHERE form_id = ?",
        formId
      );
      const nextSeq = Number(stateRow?.last_enqueued_seq ?? 0) + 1;

      await db.run(
        `
        UPDATE projection_state
        SET last_enqueued_seq = ?, updated_at = ?
        WHERE form_id = ?
        `,
        nextSeq,
        now,
        formId
      );

      await db.run(
        `
        INSERT INTO projection_queue (
          form_id,
          seq,
          entry_id,
          reason,
          created_at,
          processed_at
        ) VALUES (?, ?, ?, ?, ?, NULL)
        `,
        formId,
        nextSeq,
        normalizedEntryId,
        reason,
        now
      );

      await db.exec("COMMIT");
      return nextSeq;
    } catch (error) {
      await db.exec("ROLLBACK");
      throw error;
    }
  }

  async getLatestProjectionSeq(formId: string): Promise<number> {
    const db = await sqliteClient.getDb();
    const row = await db.get<{ last_enqueued_seq: number }>(
      "SELECT last_enqueued_seq FROM projection_state WHERE form_id = ?",
      formId
    );
    return Number(row?.last_enqueued_seq ?? 0);
  }

  async getOldestPendingProjectionSeq(formId: string): Promise<number | null> {
    const db = await sqliteClient.getDb();
    const row = await db.get<{ seq: number }>(
      `
      SELECT seq
      FROM projection_queue
      WHERE form_id = ? AND processed_at IS NULL
      ORDER BY seq ASC
      LIMIT 1
      `,
      formId
    );
    if (!row) {
      return null;
    }
    return Number(row.seq);
  }

  async listPendingProjectionEntries(
    formId: string,
    afterSeq: number,
    upToSeq: number
  ): Promise<PendingProjectionEntry[]> {
    const db = await sqliteClient.getDb();
    const rows = await db.all<Array<{ entry_id: string; latest_seq: number }>>(
      `
      SELECT entry_id, MAX(seq) AS latest_seq
      FROM projection_queue
      WHERE form_id = ?
        AND processed_at IS NULL
        AND seq > ?
        AND seq <= ?
      GROUP BY entry_id
      ORDER BY latest_seq ASC
      `,
      formId,
      afterSeq,
      upToSeq
    );

    return rows.map((row) => ({
      entryId: row.entry_id,
      latestSeq: Number(row.latest_seq ?? 0),
    }));
  }

  async markProjectionEventProcessed(
    formId: string,
    seq: number,
    processedAt: string
  ): Promise<void> {
    await this.runSerializedWrite(async (db) => {
      await db.run(
        `
        UPDATE projection_queue
        SET processed_at = ?
        WHERE form_id = ? AND seq = ?
        `,
        processedAt,
        formId,
        seq
      );
    });
  }

  async markProjectionRangeProcessed(
    formId: string,
    upToSeq: number,
    processedAt: string
  ): Promise<void> {
    await this.runSerializedWrite(async (db) => {
      await db.run(
        `
        UPDATE projection_queue
        SET processed_at = ?
        WHERE form_id = ?
          AND processed_at IS NULL
          AND seq <= ?
        `,
        processedAt,
        formId,
        upToSeq
      );
    });
  }

  async cleanupProcessedProjectionEvents(formId: string, upToSeq: number): Promise<void> {
    await this.runSerializedWrite(async (db) => {
      await db.run(
        `
        DELETE FROM projection_queue
        WHERE form_id = ?
          AND processed_at IS NOT NULL
          AND seq <= ?
        `,
        formId,
        upToSeq
      );
    });
  }

  async getSyncState(formId: string): Promise<StoredSyncState | null> {
    const db = await sqliteClient.getDb();
    return this.getSyncStateWithDb(db, formId);
  }

  private async getSyncStateWithDb(
    db: Database,
    formId: string
  ): Promise<StoredSyncState | null> {
    const row = await db.get<{
      form_id: string;
      status: string;
      task_id: string | null;
      started_at: string | null;
      finished_at: string | null;
      snapshot_at: string | null;
      read_model_version: number | null;
      total_entries: number;
      total_rows: number;
      message: string | null;
      updated_at: string;
    }>("SELECT * FROM sync_state WHERE form_id = ?", formId);

    if (!row) {
      return null;
    }

    return {
      formId: row.form_id,
      status: row.status,
      taskId: row.task_id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      snapshotAt: row.snapshot_at,
      readModelVersion:
        row.read_model_version === null || row.read_model_version === undefined
          ? null
          : Number(row.read_model_version),
      totalEntries: Number(row.total_entries ?? 0),
      totalRows: Number(row.total_rows ?? 0),
      message: row.message,
      updatedAt: row.updated_at,
    };
  }

  async getReports(
    formId: string,
    options: SqliteReportQueryOptions
  ): Promise<SqliteReportQueryResult> {
    const db = await sqliteClient.getDb();
    const { whereClauses, whereParams } = buildEntryWhereClauses(formId, options);

    const queryLimit = Math.max(1, Math.trunc(options.limit));
    const queryOffset = Math.max(0, Math.trunc(options.offset));
    const orderByClauses =
      options.sortRules && options.sortRules.length > 0
        ? options.sortRules.map((rule) => {
            const direction = rule.direction === "desc" ? "DESC" : "ASC";
            if (rule.key === "sortOrder") {
              return `CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END, sort_order ${direction}`;
            }
            if (rule.key === "lastUpdatedAt") {
              return `last_updated_at ${direction}`;
            }
            if (rule.key === "plannedStartDate") {
              return `CASE WHEN planned_start_date IS NULL THEN 1 ELSE 0 END, planned_start_date ${direction}`;
            }
            const sortMachineExpression =
              "COALESCE(NULLIF(machine_code, ''), NULLIF(filter_machine_code, ''))";
            return `CASE WHEN ${sortMachineExpression} IS NULL THEN 1 ELSE 0 END, ${sortMachineExpression} COLLATE NOCASE ${direction}`;
          })
        : ["rowid ASC"];
    const countRow = await db.get<{ count: number }>(
      `
      SELECT COUNT(*) AS count
      FROM work_report_entries
      WHERE ${whereClauses.join(" AND ")}
      `,
      ...whereParams
    );
    const rows = await db.all<EntryRowRecord[]>(
      `
      SELECT entry_id, summary_json
      FROM work_report_entries
      WHERE ${whereClauses.join(" AND ")}
      ORDER BY ${orderByClauses.join(", ")}
      LIMIT ? OFFSET ?
      `,
      ...whereParams,
      queryLimit,
      queryOffset
    );

    const totalCount = Number(countRow?.count ?? 0);
    const parsedRecords = rows
      .map((row) => parseRecordPayload(row.summary_json, row.entry_id))
      .filter((record): record is WorkReportRecord => Boolean(record));
    const hasMore = queryOffset + queryLimit < totalCount;
    const data = parsedRecords;

    return {
      data,
      count: data.length,
      totalCount,
      hasMore,
    };
  }

  async getFacetCounts(
    formId: string,
    options: ReportFacetQueryOptions,
    fields: string[]
  ): Promise<Record<string, ReportFacetCount[]>> {
    const db = await sqliteClient.getDb();
    const { whereClauses, whereParams } = buildEntryWhereClauses(formId, options);
    const result: Record<string, ReportFacetCount[]> = {};

    for (const field of fields) {
      if (
        field !== "status" &&
        field !== "machineCode" &&
        field !== "siteRunning" &&
        field !== "startSchedule" &&
        field !== "lastUpdatedAt"
      ) {
        result[field] = [];
        continue;
      }

      const fieldName = field as SupportedFacetField;
      const columnName =
        fieldName === "status"
          ? "status"
          : fieldName === "machineCode"
            ? "COALESCE(NULLIF(machine_code, ''), NULLIF(filter_machine_code, ''))"
            : fieldName === "siteRunning"
          ? "site_running"
          : fieldName === "startSchedule"
            ? "start_schedule"
            : "last_updated_at";
      const rows = await db.all<Array<{ raw_value: string | number | null; count: number }>>(
        `
        SELECT ${columnName} AS raw_value, COUNT(*) AS count
        FROM work_report_entries
        WHERE ${whereClauses.join(" AND ")}
        GROUP BY ${columnName}
        `,
        ...whereParams
      );

      result[field] = rows
        .map((row) => ({
          token: toFacetToken(fieldName, row.raw_value),
          count: Number(row.count ?? 0),
        }))
        .sort((left, right) => compareFacetTokens(fieldName, left.token, right.token));
    }

    return result;
  }

  async getFullReports(formId: string): Promise<WorkReportRecord[]> {
    const db = await sqliteClient.getDb();
    const rows = await db.all<EntryRowRecord[]>(
      `
      SELECT entry_id, summary_json
      FROM work_report_entries
      WHERE form_id = ?
      ORDER BY rowid ASC
      LIMIT ?
      `,
      formId,
      env.REPORT_FULL_CACHE_MAX_RECORDS
    );

    const parsedRecords = rows
      .map((row) => parseRecordPayload(row.summary_json, row.entry_id))
      .filter((record): record is WorkReportRecord => Boolean(record));

    return parsedRecords;
  }

  async getReportByEntryId(formId: string, entryId: string): Promise<WorkReportRecord | null> {
    const db = await sqliteClient.getDb();
    const row = await db.get<EntryDetailRecord>(
      `
      SELECT detail_json
      FROM work_report_entries
      WHERE form_id = ? AND entry_id = ?
      LIMIT 1
      `,
      formId,
      entryId
    );

    if (!row?.detail_json) {
      return null;
    }
    return parseRecordPayload(row.detail_json, entryId);
  }

  async upsertEntrySnapshot(
    formId: string,
    record: WorkReportRecord,
    syncedAt: string
  ): Promise<{ rowCount: number }> {
    return this.runSerializedWrite(async (db) =>
      this.upsertEntrySnapshotWithDb(db, formId, record, syncedAt)
    );
  }

  private async upsertEntrySnapshotWithDb(
    db: Database,
    formId: string,
    record: WorkReportRecord,
    syncedAt: string
  ): Promise<{ rowCount: number }> {
    const entryId = toNullableText(record.id);
    if (!entryId) {
      return { rowCount: 0 };
    }

    const reports = Array.isArray(record.reports) ? record.reports : [];
    const summaryRecord: WorkReportRecord = {
      ...record,
      reports: [],
    };

    await db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      await db.run(
        "DELETE FROM work_report_rows WHERE form_id = ? AND entry_id = ?",
        formId,
        entryId
      );
      await db.run(
        "DELETE FROM work_report_entries WHERE form_id = ? AND entry_id = ?",
        formId,
        entryId
      );

      await db.run(
        `
        INSERT INTO work_report_entries (
          form_id,
          entry_id,
          work_order_no,
          customer_part_no,
          machine_code,
          filter_machine_code,
          status,
          ragic_unfinished_status,
          site_running,
          start_schedule,
          sort_order,
          planned_start_date,
          last_updated_at,
          search_text,
          summary_json,
          detail_json,
          synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        formId,
        entryId,
        toNullableText(record.workOrderNo),
        toNullableText(record.customerPartNo),
        toNullableText(record.machineCode),
        toNullableText(record.filterMachineCode),
        toNullableText(record.status),
        toNullableText(record.ragicUnfinishedStatus),
        parseSemanticBooleanToInteger(record.siteRunning),
        parseSemanticBooleanToInteger(record.startSchedule),
        toNullableNumber(record.sortOrder),
        toNullableIsoDateTime(record.plannedStartDate),
        toNullableIsoDateTime(record.lastUpdatedAt),
        buildSearchText(summaryRecord),
        JSON.stringify(summaryRecord),
        JSON.stringify({
          ...record,
          reports,
        }),
        syncedAt
      );

      let rowCount = 0;
      for (const report of reports) {
        const rowId = toNullableText((report as WorkReportItem).rowId);
        if (!rowId) {
          continue;
        }

        rowCount += 1;
        await db.run(
          `
          INSERT INTO work_report_rows (
            form_id,
            entry_id,
            row_id,
            date_value,
            operator_id,
            process_code,
            machine_id,
            payload_json,
            synced_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          formId,
          entryId,
          rowId,
          toNullableText((report as WorkReportItem).date),
          toNullableText((report as WorkReportItem).operatorId),
          toNullableText((report as WorkReportItem).processCode),
          toNullableText((report as WorkReportItem).machineId),
          JSON.stringify(report),
          syncedAt
        );
      }

      await db.exec("COMMIT");
      return { rowCount };
    } catch (error) {
      await db.exec("ROLLBACK");
      throw error;
    }
  }

  async deleteEntrySnapshot(formId: string, entryId: string): Promise<void> {
    await this.runSerializedWrite(async (db) => {
      await this.deleteEntrySnapshotWithDb(db, formId, entryId);
    });
  }

  async getFormSnapshotCounts(formId: string): Promise<{ entryCount: number; rowCount: number }> {
    const db = await sqliteClient.getDb();
    return this.getFormSnapshotCountsWithDb(db, formId);
  }

  private async getFormSnapshotCountsWithDb(
    db: Database,
    formId: string
  ): Promise<{ entryCount: number; rowCount: number }> {
    const entryCountRow = await db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM work_report_entries WHERE form_id = ?",
      formId
    );
    const rowCountRow = await db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM work_report_rows WHERE form_id = ?",
      formId
    );

    return {
      entryCount: Number(entryCountRow?.count ?? 0),
      rowCount: Number(rowCountRow?.count ?? 0),
    };
  }

  async touchSyncStateSnapshot(
    formId: string,
    snapshotAt: string,
    message: string | null = null
  ): Promise<void> {
    await this.runSerializedWrite(async (db) => {
      const existing = await this.getSyncStateWithDb(db, formId);
      if (!existing) {
        return;
      }

      const counts = await this.getFormSnapshotCountsWithDb(db, formId);

      await this.upsertSyncStateWithDb(db, {
        formId,
        status: existing.status as SyncStatePatch["status"],
        taskId: existing.taskId,
        startedAt: existing.startedAt,
        finishedAt: existing.finishedAt,
        snapshotAt,
        readModelVersion: existing.readModelVersion ?? READ_MODEL_SCHEMA_VERSION,
        totalEntries: counts.entryCount,
        totalRows: counts.rowCount,
        message: message ?? existing.message,
      });
    });
  }

  private async deleteEntrySnapshotWithDb(
    db: Database,
    formId: string,
    entryId: string
  ): Promise<void> {
    await db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      await db.run(
        "DELETE FROM work_report_rows WHERE form_id = ? AND entry_id = ?",
        formId,
        entryId
      );
      await db.run(
        "DELETE FROM work_report_entries WHERE form_id = ? AND entry_id = ?",
        formId,
        entryId
      );
      await db.exec("COMMIT");
    } catch (error) {
      await db.exec("ROLLBACK");
      throw error;
    }
  }

}

export const workReportSqliteRepository = new WorkReportSqliteRepository();

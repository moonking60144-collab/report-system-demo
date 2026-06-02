import type { Database } from "sqlite";
import { sqliteClient } from "./sqliteClient";

export interface BatchCreateRowKeyRecord {
  clientRowKey: string;
  formId: string;
  entryId: string;
  ragicRowId: string;
  createdAt: string;
}

interface RowShape {
  client_row_key: string;
  form_id: string;
  entry_id: string;
  ragic_row_id: string;
  created_at: string;
}

function mapRow(row: RowShape): BatchCreateRowKeyRecord {
  return {
    clientRowKey: row.client_row_key,
    formId: row.form_id,
    entryId: row.entry_id,
    ragicRowId: row.ragic_row_id,
    createdAt: row.created_at,
  };
}

export interface BatchCreateRowKeyRepository {
  lookup(clientRowKey: string): Promise<BatchCreateRowKeyRecord | null>;
  record(input: Omit<BatchCreateRowKeyRecord, "createdAt"> & { createdAt?: string }): Promise<void>;
  cleanupOlderThan(thresholdIso: string): Promise<number>;
}

export function createBatchCreateRowKeyRepository(
  dbProvider: () => Promise<Database>
): BatchCreateRowKeyRepository {
  return {
    async lookup(clientRowKey: string) {
      const trimmed = String(clientRowKey ?? "").trim();
      if (!trimmed) return null;
      const db = await dbProvider();
      const row = await db.get<RowShape>(
        `SELECT client_row_key, form_id, entry_id, ragic_row_id, created_at
         FROM batch_create_row_keys
         WHERE client_row_key = ?`,
        trimmed
      );
      return row ? mapRow(row) : null;
    },

    async record(input) {
      const trimmed = String(input.clientRowKey ?? "").trim();
      if (!trimmed) return;
      const createdAt = input.createdAt ?? new Date().toISOString();
      const db = await dbProvider();
      // ON CONFLICT 保留既有資料，避免重送 overwrite 掉第一次成功建立的映射
      await db.run(
        `INSERT INTO batch_create_row_keys
           (client_row_key, form_id, entry_id, ragic_row_id, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(client_row_key) DO NOTHING`,
        trimmed,
        input.formId,
        input.entryId,
        input.ragicRowId,
        createdAt
      );
    },

    async cleanupOlderThan(thresholdIso: string) {
      const db = await dbProvider();
      const result = await db.run(
        `DELETE FROM batch_create_row_keys WHERE created_at < ?`,
        thresholdIso
      );
      return typeof result.changes === "number" ? result.changes : 0;
    },
  };
}

export const batchCreateRowKeyRepository: BatchCreateRowKeyRepository =
  createBatchCreateRowKeyRepository(() => sqliteClient.getDb());

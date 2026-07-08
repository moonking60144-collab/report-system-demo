import type { Database } from "sqlite";
import { createConnectionSerializer, sqliteClient } from "./sqliteClient";

export interface BatchCreateRowKeyRecord {
  clientRowKey: string;
  formId: string;
  entryId: string;
  ragicRowId: string;
  status: BatchCreateRowKeyStatus;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export type BatchCreateRowKeyStatus = "pending" | "confirmed" | "indeterminate";

export interface BatchCreateRowKeyReserveResult {
  record: BatchCreateRowKeyRecord | null;
  reserved: boolean;
}

interface RowShape {
  client_row_key: string;
  form_id: string;
  entry_id: string;
  ragic_row_id: string;
  status: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

function normalizeStatus(status: string | null | undefined): BatchCreateRowKeyStatus {
  if (status === "pending" || status === "indeterminate") return status;
  return "confirmed";
}

function mapRow(row: RowShape): BatchCreateRowKeyRecord {
  return {
    clientRowKey: row.client_row_key,
    formId: row.form_id,
    entryId: row.entry_id,
    ragicRowId: row.ragic_row_id,
    status: normalizeStatus(row.status),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface BatchCreateRowKeyRepository {
  lookup(clientRowKey: string): Promise<BatchCreateRowKeyRecord | null>;
  reservePending(
    input: Pick<BatchCreateRowKeyRecord, "clientRowKey" | "formId" | "entryId"> & {
      createdAt?: string;
    }
  ): Promise<BatchCreateRowKeyReserveResult>;
  confirm(
    input: Omit<
      BatchCreateRowKeyRecord,
      "createdAt" | "updatedAt" | "status" | "errorMessage"
    > & {
      updatedAt?: string;
    }
  ): Promise<void>;
  markIndeterminate(input: {
    clientRowKey: string;
    formId: string;
    entryId: string;
    errorMessage: string;
    updatedAt?: string;
  }): Promise<void>;
  markStalePendingIndeterminate(input: {
    thresholdIso: string;
    errorMessage: string;
    updatedAt?: string;
  }): Promise<number>;
  releasePending(input: {
    clientRowKey: string;
    formId: string;
    entryId: string;
  }): Promise<number>;
  record(
    input: Omit<
      BatchCreateRowKeyRecord,
      "createdAt" | "updatedAt" | "status" | "errorMessage"
    > & {
      createdAt?: string;
    }
  ): Promise<void>;
  deleteByRagicRowId(ragicRowId: string): Promise<number>;
  cleanupOlderThan(thresholdIso: string): Promise<number>;
}

export function createBatchCreateRowKeyRepository(
  dbProvider: () => Promise<Database>
): BatchCreateRowKeyRepository {
  const { runSerializedWrite } = createConnectionSerializer(dbProvider);

  return {
    async lookup(clientRowKey: string) {
      const trimmed = String(clientRowKey ?? "").trim();
      if (!trimmed) return null;
      const db = await dbProvider();
      const row = await db.get<RowShape>(
        `SELECT client_row_key, form_id, entry_id, ragic_row_id, status, error_message, created_at, updated_at
         FROM batch_create_row_keys
         WHERE client_row_key = ?`,
        trimmed
      );
      return row ? mapRow(row) : null;
    },

    async reservePending(input) {
      const trimmed = String(input.clientRowKey ?? "").trim();
      if (!trimmed) return { record: null, reserved: false };
      const now = input.createdAt ?? new Date().toISOString();
      let reserved = false;
      await runSerializedWrite(async (db) => {
        const result = await db.run(
          `INSERT INTO batch_create_row_keys
             (client_row_key, form_id, entry_id, ragic_row_id, status, error_message, created_at, updated_at)
           VALUES (?, ?, ?, '', 'pending', NULL, ?, ?)
           ON CONFLICT(client_row_key) DO NOTHING`,
          trimmed,
          input.formId,
          input.entryId,
          now,
          now
        );
        reserved = typeof result.changes === "number" && result.changes > 0;
      });

      const db = await dbProvider();
      const row = await db.get<RowShape>(
        `SELECT client_row_key, form_id, entry_id, ragic_row_id, status, error_message, created_at, updated_at
         FROM batch_create_row_keys
         WHERE client_row_key = ?`,
        trimmed
      );
      return { record: row ? mapRow(row) : null, reserved };
    },

    async confirm(input) {
      const trimmed = String(input.clientRowKey ?? "").trim();
      if (!trimmed) return;
      const updatedAt = input.updatedAt ?? new Date().toISOString();
      await runSerializedWrite(async (db) => {
        await db.run(
          `UPDATE batch_create_row_keys
           SET form_id = ?,
               entry_id = ?,
               ragic_row_id = ?,
               status = 'confirmed',
               error_message = NULL,
               updated_at = ?
           WHERE client_row_key = ?`,
          input.formId,
          input.entryId,
          input.ragicRowId,
          updatedAt,
          trimmed
        );
      });
    },

    async markIndeterminate(input) {
      const trimmed = String(input.clientRowKey ?? "").trim();
      if (!trimmed) return;
      const updatedAt = input.updatedAt ?? new Date().toISOString();
      await runSerializedWrite(async (db) => {
        await db.run(
          `UPDATE batch_create_row_keys
           SET status = 'indeterminate',
               error_message = ?,
               updated_at = ?
           WHERE client_row_key = ?
             AND form_id = ?
             AND entry_id = ?
             AND status = 'pending'`,
          input.errorMessage,
          updatedAt,
          trimmed,
          input.formId,
          input.entryId
        );
      });
    },

    async markStalePendingIndeterminate(input) {
      const updatedAt = input.updatedAt ?? new Date().toISOString();
      return runSerializedWrite(async (db) => {
        const result = await db.run(
          `UPDATE batch_create_row_keys
           SET status = 'indeterminate',
               error_message = ?,
               updated_at = ?
           WHERE status = 'pending'
             AND updated_at < ?`,
          input.errorMessage,
          updatedAt,
          input.thresholdIso
        );
        return typeof result.changes === "number" ? result.changes : 0;
      });
    },

    async releasePending(input) {
      const trimmed = String(input.clientRowKey ?? "").trim();
      if (!trimmed) return 0;
      return runSerializedWrite(async (db) => {
        const result = await db.run(
          `DELETE FROM batch_create_row_keys
           WHERE client_row_key = ?
             AND form_id = ?
             AND entry_id = ?
             AND status = 'pending'`,
          trimmed,
          input.formId,
          input.entryId
        );
        return typeof result.changes === "number" ? result.changes : 0;
      });
    },

    async record(input) {
      const trimmed = String(input.clientRowKey ?? "").trim();
      if (!trimmed) return;
      const createdAt = input.createdAt ?? new Date().toISOString();
      await runSerializedWrite(async (db) => {
        // ON CONFLICT 只補 pending/indeterminate；已 confirmed 的既有映射不可覆蓋。
        await db.run(
          `INSERT INTO batch_create_row_keys
             (client_row_key, form_id, entry_id, ragic_row_id, status, error_message, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'confirmed', NULL, ?, ?)
           ON CONFLICT(client_row_key) DO UPDATE SET
             form_id = excluded.form_id,
             entry_id = excluded.entry_id,
             ragic_row_id = excluded.ragic_row_id,
             status = 'confirmed',
             error_message = NULL,
             updated_at = excluded.updated_at
           WHERE batch_create_row_keys.status <> 'confirmed'
             AND batch_create_row_keys.form_id = excluded.form_id
             AND batch_create_row_keys.entry_id = excluded.entry_id`,
          trimmed,
          input.formId,
          input.entryId,
          input.ragicRowId,
          createdAt,
          createdAt
        );
      });
    },

    async deleteByRagicRowId(ragicRowId: string) {
      // reverify 確認 orphan 把 Ragic entry 刪掉後，清掉指向這個已刪 rowId 的映射；
      // 否則同 clientRowKey 重試會命中舊映射、那一列被靜默跳過不重建。
      const trimmed = String(ragicRowId ?? "").trim();
      if (!trimmed) return 0;
      return runSerializedWrite(async (db) => {
        const result = await db.run(
          `DELETE FROM batch_create_row_keys WHERE ragic_row_id = ?`,
          trimmed
        );
        return typeof result.changes === "number" ? result.changes : 0;
      });
    },

    async cleanupOlderThan(thresholdIso: string) {
      return runSerializedWrite(async (db) => {
        const result = await db.run(
          `DELETE FROM batch_create_row_keys WHERE created_at < ?`,
          thresholdIso
        );
        return typeof result.changes === "number" ? result.changes : 0;
      });
    },
  };
}

export const batchCreateRowKeyRepository: BatchCreateRowKeyRepository =
  createBatchCreateRowKeyRepository(() => sqliteClient.getDb());

import type { Database } from "sqlite";
import { createConnectionSerializer, sqliteClient } from "./sqliteClient";

/**
 * Form 16 寫入的 idempotency key 映射表。
 *
 * 用來擋使用者「按送出→網路 timeout→又按一次」的 retry 風暴造成 Form 16 重複 entry。
 * 每次 create Form 16 前用 clientRowKey 先查：命中就回舊 entryId 不打 Ragic、未命中才真的寫。
 */
export interface Form16ClientRowKeyRecord {
  clientRowKey: string;
  entryId: string;
  source: string;
  status: Form16ClientRowKeyStatus;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export type Form16ClientRowKeyStatus = "pending" | "confirmed" | "indeterminate";

export interface Form16ClientRowKeyReserveResult {
  record: Form16ClientRowKeyRecord | null;
  reserved: boolean;
}

interface RowShape {
  client_row_key: string;
  entry_id: string;
  source: string;
  status: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

function normalizeStatus(status: string | null | undefined): Form16ClientRowKeyStatus {
  if (status === "pending" || status === "indeterminate") return status;
  return "confirmed";
}

function mapRow(row: RowShape): Form16ClientRowKeyRecord {
  return {
    clientRowKey: row.client_row_key,
    entryId: row.entry_id,
    source: row.source,
    status: normalizeStatus(row.status),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface Form16ClientRowKeyRepository {
  lookup(clientRowKey: string): Promise<Form16ClientRowKeyRecord | null>;
  reservePending(input: {
    clientRowKey: string;
    source: string;
    createdAt?: string;
  }): Promise<Form16ClientRowKeyReserveResult>;
  confirm(input: {
    clientRowKey: string;
    entryId: string;
    source: string;
    updatedAt?: string;
  }): Promise<void>;
  markIndeterminate(input: {
    clientRowKey: string;
    source: string;
    errorMessage: string;
    updatedAt?: string;
  }): Promise<void>;
  releasePending(input: {
    clientRowKey: string;
    source: string;
  }): Promise<number>;
  record(
    input: Omit<
      Form16ClientRowKeyRecord,
      "createdAt" | "updatedAt" | "status" | "errorMessage"
    > & { createdAt?: string }
  ): Promise<void>;
  deleteByEntryId(entryId: string): Promise<number>;
  cleanupOlderThan(thresholdIso: string): Promise<number>;
}

export function createForm16ClientRowKeyRepository(
  dbProvider: () => Promise<Database>
): Form16ClientRowKeyRepository {
  const { runSerializedWrite } = createConnectionSerializer(dbProvider);

  return {
    async lookup(clientRowKey: string) {
      const trimmed = String(clientRowKey ?? "").trim();
      if (!trimmed) return null;
      const db = await dbProvider();
      const row = await db.get<RowShape>(
        `SELECT client_row_key, entry_id, source, status, error_message, created_at, updated_at
         FROM form16_client_row_keys
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
          `INSERT INTO form16_client_row_keys
             (client_row_key, entry_id, source, status, error_message, created_at, updated_at)
           VALUES (?, '', ?, 'pending', NULL, ?, ?)
           ON CONFLICT(client_row_key) DO NOTHING`,
          trimmed,
          input.source,
          now,
          now
        );
        reserved = typeof result.changes === "number" && result.changes > 0;
      });

      const db = await dbProvider();
      const row = await db.get<RowShape>(
        `SELECT client_row_key, entry_id, source, status, error_message, created_at, updated_at
         FROM form16_client_row_keys
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
          `UPDATE form16_client_row_keys
           SET entry_id = ?,
               source = ?,
               status = 'confirmed',
               error_message = NULL,
               updated_at = ?
           WHERE client_row_key = ?`,
          input.entryId,
          input.source,
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
          `UPDATE form16_client_row_keys
           SET status = 'indeterminate',
               error_message = ?,
               updated_at = ?
           WHERE client_row_key = ?
             AND source = ?
             AND status = 'pending'`,
          input.errorMessage,
          updatedAt,
          trimmed,
          input.source
        );
      });
    },

    async releasePending(input) {
      const trimmed = String(input.clientRowKey ?? "").trim();
      if (!trimmed) return 0;
      return runSerializedWrite(async (db) => {
        const result = await db.run(
          `DELETE FROM form16_client_row_keys
           WHERE client_row_key = ?
             AND source = ?
             AND status = 'pending'`,
          trimmed,
          input.source
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
          `INSERT INTO form16_client_row_keys
             (client_row_key, entry_id, source, status, error_message, created_at, updated_at)
           VALUES (?, ?, ?, 'confirmed', NULL, ?, ?)
           ON CONFLICT(client_row_key) DO UPDATE SET
             entry_id = excluded.entry_id,
             source = excluded.source,
             status = 'confirmed',
             error_message = NULL,
             updated_at = excluded.updated_at
           WHERE form16_client_row_keys.status <> 'confirmed'`,
          trimmed,
          input.entryId,
          input.source,
          createdAt,
          createdAt
        );
      });
    },

    async deleteByEntryId(entryId: string) {
      // reverify 確認 orphan 刪掉 Ragic entry 後，清掉指向這個已刪 entryId 的映射；
      // 否則同 clientRowKey 重試會命中舊映射、回傳已刪 entryId 當成「已建立」。
      const trimmed = String(entryId ?? "").trim();
      if (!trimmed) return 0;
      return runSerializedWrite(async (db) => {
        const result = await db.run(
          `DELETE FROM form16_client_row_keys WHERE entry_id = ?`,
          trimmed
        );
        return typeof result.changes === "number" ? result.changes : 0;
      });
    },

    async cleanupOlderThan(thresholdIso: string) {
      return runSerializedWrite(async (db) => {
        const result = await db.run(
          `DELETE FROM form16_client_row_keys WHERE created_at < ?`,
          thresholdIso
        );
        return typeof result.changes === "number" ? result.changes : 0;
      });
    },
  };
}

export const form16ClientRowKeyRepository: Form16ClientRowKeyRepository =
  createForm16ClientRowKeyRepository(() => sqliteClient.getDb());

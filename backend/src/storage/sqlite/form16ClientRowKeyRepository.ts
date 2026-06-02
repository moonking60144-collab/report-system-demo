import type { Database } from "sqlite";
import { sqliteClient } from "./sqliteClient";

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
  createdAt: string;
}

interface RowShape {
  client_row_key: string;
  entry_id: string;
  source: string;
  created_at: string;
}

function mapRow(row: RowShape): Form16ClientRowKeyRecord {
  return {
    clientRowKey: row.client_row_key,
    entryId: row.entry_id,
    source: row.source,
    createdAt: row.created_at,
  };
}

export interface Form16ClientRowKeyRepository {
  lookup(clientRowKey: string): Promise<Form16ClientRowKeyRecord | null>;
  record(
    input: Omit<Form16ClientRowKeyRecord, "createdAt"> & { createdAt?: string }
  ): Promise<void>;
  cleanupOlderThan(thresholdIso: string): Promise<number>;
}

export function createForm16ClientRowKeyRepository(
  dbProvider: () => Promise<Database>
): Form16ClientRowKeyRepository {
  return {
    async lookup(clientRowKey: string) {
      const trimmed = String(clientRowKey ?? "").trim();
      if (!trimmed) return null;
      const db = await dbProvider();
      const row = await db.get<RowShape>(
        `SELECT client_row_key, entry_id, source, created_at
         FROM form16_client_row_keys
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
      // ON CONFLICT DO NOTHING — 避免 race 或重送把已有映射覆蓋
      await db.run(
        `INSERT INTO form16_client_row_keys
           (client_row_key, entry_id, source, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(client_row_key) DO NOTHING`,
        trimmed,
        input.entryId,
        input.source,
        createdAt
      );
    },

    async cleanupOlderThan(thresholdIso: string) {
      const db = await dbProvider();
      const result = await db.run(
        `DELETE FROM form16_client_row_keys WHERE created_at < ?`,
        thresholdIso
      );
      return typeof result.changes === "number" ? result.changes : 0;
    },
  };
}

export const form16ClientRowKeyRepository: Form16ClientRowKeyRepository =
  createForm16ClientRowKeyRepository(() => sqliteClient.getDb());

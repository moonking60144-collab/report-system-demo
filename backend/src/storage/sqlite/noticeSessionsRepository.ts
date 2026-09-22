import type { Database } from "sqlite";
import { createConnectionSerializer, sqliteClient } from "./sqliteClient";

export interface NoticeSession {
  token: string;
  username: string;
  expiresAtMs: number;
  createdAt: string;
}

interface RawRow {
  token: string;
  username: string;
  expires_at_ms: number;
  created_at: string;
}

function mapRow(row: RawRow): NoticeSession {
  return {
    token: row.token,
    username: row.username,
    expiresAtMs: row.expires_at_ms,
    createdAt: row.created_at,
  };
}

export interface NoticeSessionsRepository {
  list(): Promise<NoticeSession[]>;
  insert(input: { token: string; username: string; expiresAtMs: number }): Promise<void>;
  delete(token: string): Promise<void>;
  deleteByUsername(username: string): Promise<void>;
  deleteExpired(nowMs: number): Promise<number>;
}

export function createNoticeSessionsRepository(
  getDb: () => Promise<Database>
): NoticeSessionsRepository {
  const { runSerializedWrite } = createConnectionSerializer(getDb);

  return {
    async list() {
      const db = await getDb();
      const rows = await db.all<RawRow[]>(
        "SELECT token, username, expires_at_ms, created_at FROM notice_sessions ORDER BY created_at ASC"
      );
      return rows.map(mapRow);
    },

    async insert(input) {
      await runSerializedWrite(async (db) => {
        await db.run(
          "INSERT OR REPLACE INTO notice_sessions (token, username, expires_at_ms, created_at) VALUES (?, ?, ?, ?)",
          input.token,
          input.username,
          input.expiresAtMs,
          new Date().toISOString()
        );
      });
    },

    async delete(token) {
      await runSerializedWrite(async (db) => {
        await db.run("DELETE FROM notice_sessions WHERE token = ?", token);
      });
    },

    async deleteByUsername(username) {
      await runSerializedWrite(async (db) => {
        await db.run("DELETE FROM notice_sessions WHERE username = ?", username);
      });
    },

    async deleteExpired(nowMs) {
      return runSerializedWrite(async (db) => {
        const result = await db.run(
          "DELETE FROM notice_sessions WHERE expires_at_ms <= ?",
          nowMs
        );
        return result.changes ?? 0;
      });
    },
  };
}

export const noticeSessionsRepository: NoticeSessionsRepository =
  createNoticeSessionsRepository(() => sqliteClient.getDb());

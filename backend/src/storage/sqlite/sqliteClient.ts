import fs from "fs/promises";
import path from "path";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import { env } from "../../config/env";
import { HttpError } from "../../utils/httpError";
import { initializeReadModelSchema } from "./readModelSchema";
import { ensureItDutySchema } from "./itDutySchema";
import { ensureNoticeAdminUsersSchema } from "./noticeAdminUsersSchema";
import { ensureRagicFieldIndexSchema } from "./ragicFieldIndexSchema";

class SqliteClient {
  private dbPromise: Promise<Database> | null = null;

  async getDb(): Promise<Database> {
    if (!env.SQLITE_ENABLED) {
      throw new HttpError(503, "SQLite 功能目前未啟用", "SQLITE_DISABLED");
    }

    if (!this.dbPromise) {
      this.dbPromise = this.openDatabase();
    }

    return this.dbPromise;
  }

  async close(): Promise<void> {
    if (!this.dbPromise) return;
    const db = await this.dbPromise;
    this.dbPromise = null;
    try {
      await db.close();
      console.info("[sqlite][closed]");
    } catch (error) {
      console.warn("[sqlite][close-failed]", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async openDatabase(): Promise<Database> {
    const dbPath = path.resolve(env.SQLITE_DB_FILE);
    await fs.mkdir(path.dirname(dbPath), { recursive: true });

    const db = await open({
      filename: dbPath,
      driver: sqlite3.Database,
    });

    await db.exec(
      [
        "PRAGMA journal_mode=WAL;",
        "PRAGMA synchronous=NORMAL;",
        "PRAGMA foreign_keys=ON;",
        "PRAGMA busy_timeout=5000;",
      ].join("\n")
    );
    await initializeReadModelSchema(db);
    await ensureItDutySchema(db);
    await ensureRagicFieldIndexSchema(db);
    await ensureNoticeAdminUsersSchema(db);

    // 補救上一次 crash 留下的 stuck 'refreshing' 狀態
    await db.run(
      `
      UPDATE ragic_field_index_state
      SET status = 'idle',
          message = 'recovered on startup',
          updated_at = ?
      WHERE id = 1 AND status = 'refreshing'
      `,
      new Date().toISOString()
    );

    console.info("[sqlite][opened]", { dbPath });
    return db;
  }
}

export const sqliteClient = new SqliteClient();

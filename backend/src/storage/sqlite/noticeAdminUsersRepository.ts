import type { Database } from "sqlite";
import { sqliteClient } from "./sqliteClient";

export interface NoticeAdminUser {
  id: number;
  username: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
}

interface RawRow {
  id: number;
  username: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

function mapRow(row: RawRow): NoticeAdminUser {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
  };
}

export interface NoticeAdminUsersRepository {
  count(): Promise<number>;
  list(): Promise<NoticeAdminUser[]>;
  findByUsername(username: string): Promise<NoticeAdminUser | null>;
  create(input: {
    username: string;
    passwordHash: string;
    createdBy?: string | null;
  }): Promise<NoticeAdminUser>;
  delete(username: string): Promise<boolean>;
  updatePassword(input: {
    username: string;
    passwordHash: string;
  }): Promise<NoticeAdminUser | null>;
  /** 改 username + password 一起（讓使用者可以同時改 username）*/
  updateProfile(input: {
    currentUsername: string;
    nextUsername: string;
    passwordHash: string;
  }): Promise<NoticeAdminUser | null>;
}

export function createNoticeAdminUsersRepository(
  getDb: () => Promise<Database>
): NoticeAdminUsersRepository {
  let writeChain: Promise<void> = Promise.resolve();

  async function runSerializedWrite<T>(
    operation: (db: Database) => Promise<T>
  ): Promise<T> {
    const scheduled = writeChain
      .catch(() => undefined)
      .then(async () => operation(await getDb()));
    writeChain = scheduled.then(
      () => undefined,
      () => undefined
    );
    return scheduled;
  }

  return {
    async count() {
      const db = await getDb();
      const row = await db.get<{ cnt: number }>(
        "SELECT COUNT(*) AS cnt FROM notice_admin_users"
      );
      return row?.cnt ?? 0;
    },

    async list() {
      const db = await getDb();
      const rows = await db.all<RawRow[]>(
        "SELECT id, username, password_hash, created_at, updated_at, created_by FROM notice_admin_users ORDER BY id ASC"
      );
      return rows.map(mapRow);
    },

    async findByUsername(username) {
      const db = await getDb();
      const row = await db.get<RawRow>(
        "SELECT id, username, password_hash, created_at, updated_at, created_by FROM notice_admin_users WHERE username = ?",
        username
      );
      return row ? mapRow(row) : null;
    },

    async create(input) {
      return runSerializedWrite(async (db) => {
        const now = new Date().toISOString();
        const result = await db.run(
          `
          INSERT INTO notice_admin_users (username, password_hash, created_at, updated_at, created_by)
          VALUES (?, ?, ?, ?, ?)
          `,
          input.username,
          input.passwordHash,
          now,
          now,
          input.createdBy ?? null
        );
        const id = result.lastID;
        if (typeof id !== "number") {
          throw new Error("Failed to insert notice_admin_users: missing lastID");
        }
        const row = await db.get<RawRow>(
          "SELECT id, username, password_hash, created_at, updated_at, created_by FROM notice_admin_users WHERE id = ?",
          id
        );
        if (!row) throw new Error(`Failed to load inserted user id=${id}`);
        return mapRow(row);
      });
    },

    async delete(username) {
      return runSerializedWrite(async (db) => {
        const result = await db.run(
          "DELETE FROM notice_admin_users WHERE username = ?",
          username
        );
        const changes = typeof result.changes === "number" ? result.changes : 0;
        return changes > 0;
      });
    },

    async updatePassword(input) {
      return runSerializedWrite(async (db) => {
        const now = new Date().toISOString();
        await db.run(
          `
          UPDATE notice_admin_users
          SET password_hash = ?, updated_at = ?
          WHERE username = ?
          `,
          input.passwordHash,
          now,
          input.username
        );
        const row = await db.get<RawRow>(
          "SELECT id, username, password_hash, created_at, updated_at, created_by FROM notice_admin_users WHERE username = ?",
          input.username
        );
        return row ? mapRow(row) : null;
      });
    },

    async updateProfile(input) {
      return runSerializedWrite(async (db) => {
        const now = new Date().toISOString();
        await db.run(
          `
          UPDATE notice_admin_users
          SET username = ?, password_hash = ?, updated_at = ?
          WHERE username = ?
          `,
          input.nextUsername,
          input.passwordHash,
          now,
          input.currentUsername
        );
        const row = await db.get<RawRow>(
          "SELECT id, username, password_hash, created_at, updated_at, created_by FROM notice_admin_users WHERE username = ?",
          input.nextUsername
        );
        return row ? mapRow(row) : null;
      });
    },
  };
}

export const noticeAdminUsersRepository: NoticeAdminUsersRepository =
  createNoticeAdminUsersRepository(() => sqliteClient.getDb());

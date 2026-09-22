import type { Database } from "sqlite";

const NOTICE_ADMIN_USERS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS notice_admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT
);
`;

/** 把舊的 notice_admin_credentials 單列搬到新表（如果還沒搬過）*/
async function migrateLegacyCredentials(db: Database): Promise<void> {
  const usersCount = await db.get<{ cnt: number }>(
    "SELECT COUNT(*) AS cnt FROM notice_admin_users"
  );
  if (usersCount && usersCount.cnt > 0) {
    return;
  }
  // 看看舊表有沒有資料
  const tableExists = await db.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='notice_admin_credentials'"
  );
  if (!tableExists) return;
  const legacy = await db.get<{
    username: string;
    password_hash: string;
    updated_at: string;
    updated_by: string | null;
  }>(
    "SELECT username, password_hash, updated_at, updated_by FROM notice_admin_credentials WHERE id = 1"
  );
  if (!legacy) return;
  await db.run(
    `
    INSERT INTO notice_admin_users (username, password_hash, created_at, updated_at, created_by)
    VALUES (?, ?, ?, ?, ?)
    `,
    legacy.username,
    legacy.password_hash,
    legacy.updated_at,
    legacy.updated_at,
    legacy.updated_by ?? "migrated-from-credentials"
  );
}

export async function ensureNoticeAdminUsersSchema(db: Database): Promise<void> {
  await db.exec(NOTICE_ADMIN_USERS_SCHEMA_SQL);
  await migrateLegacyCredentials(db);
}

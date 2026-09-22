import fs from "node:fs/promises";
import path from "node:path";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import { env } from "../../config/env";

export interface MeetingLibraryRecord {
  libraryId: string;
  codeDigest: string;
  displayName: string | null;
  displayNameConfirmedAt: string | null;
  codeHint: string | null;
  accessVersion: number;
  createdAt: string;
  codeRotatedAt: string;
  revokedAt: string | null;
}

export type MeetingAdminAuditAction =
  | "list-libraries"
  | "open-library"
  | "rotate-code";

export interface MeetingAdminAuditRecord {
  auditId: string;
  adminUsername: string;
  action: MeetingAdminAuditAction;
  libraryId: string | null;
  sessionId: string | null;
  clientIp: string;
  createdAt: string;
}

interface MeetingLibraryRow {
  library_id: string;
  code_digest: string;
  display_name: string | null;
  display_name_confirmed_at: string | null;
  code_hint: string | null;
  access_version: number;
  created_at: string;
  code_rotated_at: string;
  revoked_at: string | null;
}

interface MeetingAdminAuditRow {
  insertion_order: number;
  audit_id: string;
  admin_username: string;
  action: MeetingAdminAuditAction;
  library_id: string | null;
  session_id: string | null;
  client_ip: string;
  created_at: string;
}

function mapLibrary(row: MeetingLibraryRow): MeetingLibraryRecord {
  return {
    libraryId: row.library_id,
    codeDigest: row.code_digest,
    displayName: row.display_name,
    displayNameConfirmedAt: row.display_name_confirmed_at,
    codeHint: row.code_hint,
    accessVersion: row.access_version,
    createdAt: row.created_at,
    codeRotatedAt: row.code_rotated_at,
    revokedAt: row.revoked_at,
  };
}

function mapAudit(row: MeetingAdminAuditRow): MeetingAdminAuditRecord {
  return {
    auditId: row.audit_id,
    adminUsername: row.admin_username,
    action: row.action,
    libraryId: row.library_id,
    sessionId: row.session_id,
    clientIp: row.client_ip,
    createdAt: row.created_at,
  };
}

export class MeetingLibraryRepository {
  private dbPromise: Promise<Database> | null = null;
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(private readonly dbFile = env.MEETING_PROCESSING_DB_FILE) {}

  async initialize(): Promise<void> {
    await this.getDb();
  }

  async close(): Promise<void> {
    await this.mutationChain;
    if (!this.dbPromise) return;
    const db = await this.dbPromise;
    this.dbPromise = null;
    await db.close();
  }

  async createLibrary(input: {
    libraryId: string;
    codeDigest: string;
    displayName: string;
    codeHint: string | null;
    now: string;
  }): Promise<{ library: MeetingLibraryRecord; created: boolean } | null> {
    return this.runMutationExclusive(async () => {
      const db = await this.getDb();
      const result = await db.run(
        `INSERT OR IGNORE INTO meeting_libraries (
          library_id, code_digest, display_name, display_name_confirmed_at, code_hint,
          access_version, created_at, code_rotated_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
        input.libraryId,
        input.codeDigest,
        input.displayName,
        input.now,
        input.codeHint,
        input.now,
        input.now
      );
      const row = await db.get<MeetingLibraryRow>(
        "SELECT * FROM meeting_libraries WHERE library_id = ?",
        input.libraryId
      );
      if (!row) return null;
      return { library: mapLibrary(row), created: result.changes === 1 };
    });
  }

  async getLibrary(libraryId: string): Promise<MeetingLibraryRecord | null> {
    const db = await this.getDb();
    const row = await db.get<MeetingLibraryRow>(
      "SELECT * FROM meeting_libraries WHERE library_id = ?",
      libraryId
    );
    return row ? mapLibrary(row) : null;
  }

  async getLibraryByCodeDigest(codeDigest: string): Promise<MeetingLibraryRecord | null> {
    const db = await this.getDb();
    const row = await db.get<MeetingLibraryRow>(
      "SELECT * FROM meeting_libraries WHERE code_digest = ? AND revoked_at IS NULL",
      codeDigest
    );
    return row ? mapLibrary(row) : null;
  }

  async rotateCode(input: {
    libraryId: string;
    codeDigest: string;
    codeHint: string;
    now: string;
  }): Promise<MeetingLibraryRecord | null> {
    return this.runMutationExclusive(async () => {
      const db = await this.getDb();
      const result = await db.run(
        `UPDATE OR IGNORE meeting_libraries
         SET code_digest = ?,
             code_hint = ?,
             access_version = access_version + 1,
             code_rotated_at = ?,
             revoked_at = NULL
         WHERE library_id = ?`,
        input.codeDigest,
        input.codeHint,
        input.now,
        input.libraryId
      );
      if (result.changes !== 1) return null;
      const row = await db.get<MeetingLibraryRow>(
        "SELECT * FROM meeting_libraries WHERE library_id = ?",
        input.libraryId
      );
      return row ? mapLibrary(row) : null;
    });
  }

  async rotateCodeWithAdminAudit(input: {
    libraryId: string;
    codeDigest: string;
    codeHint: string;
    now: string;
    audit: MeetingAdminAuditRecord;
  }): Promise<MeetingLibraryRecord | null> {
    return this.runMutationExclusive(async () => {
      const db = await this.getDb();
      await db.exec("BEGIN IMMEDIATE");
      try {
        const result = await db.run(
          `UPDATE OR IGNORE meeting_libraries
           SET code_digest = ?,
               code_hint = ?,
               access_version = access_version + 1,
               code_rotated_at = ?,
               revoked_at = NULL
           WHERE library_id = ?`,
          input.codeDigest,
          input.codeHint,
          input.now,
          input.libraryId
        );
        if (result.changes !== 1) {
          await db.exec("ROLLBACK");
          return null;
        }
        await this.insertAdminAuditWithDb(db, input.audit);
        const row = await db.get<MeetingLibraryRow>(
          "SELECT * FROM meeting_libraries WHERE library_id = ?",
          input.libraryId
        );
        await db.exec("COMMIT");
        return row ? mapLibrary(row) : null;
      } catch (error) {
        await db.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
  }

  async listLibraries(query: string, limit: number): Promise<MeetingLibraryRecord[]> {
    const db = await this.getDb();
    const normalizedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const normalizedQuery = query.trim().toLowerCase();
    const rows = normalizedQuery
      ? await db.all<MeetingLibraryRow[]>(
          `SELECT * FROM meeting_libraries
           WHERE lower(library_id) LIKE ?
              OR lower(COALESCE(display_name, '')) LIKE ?
           ORDER BY created_at DESC, library_id ASC
           LIMIT ?`,
          `%${normalizedQuery}%`,
          `%${normalizedQuery}%`,
          normalizedLimit
        )
      : await db.all<MeetingLibraryRow[]>(
          `SELECT * FROM meeting_libraries
           ORDER BY created_at DESC, library_id ASC
           LIMIT ?`,
          normalizedLimit
        );
    return rows.map(mapLibrary);
  }

  async listAllLibraries(): Promise<MeetingLibraryRecord[]> {
    const db = await this.getDb();
    const rows = await db.all<MeetingLibraryRow[]>(
      `SELECT * FROM meeting_libraries
       ORDER BY created_at DESC, library_id ASC`
    );
    return rows.map(mapLibrary);
  }

  async updateDisplayName(input: {
    libraryId: string;
    displayName: string;
    now: string;
  }): Promise<MeetingLibraryRecord | null> {
    return this.runMutationExclusive(async () => {
      const db = await this.getDb();
      const result = await db.run(
        `UPDATE meeting_libraries
         SET display_name = ?, display_name_confirmed_at = ?
         WHERE library_id = ?`,
        input.displayName,
        input.now,
        input.libraryId
      );
      if (result.changes !== 1) return null;
      const row = await db.get<MeetingLibraryRow>(
        "SELECT * FROM meeting_libraries WHERE library_id = ?",
        input.libraryId
      );
      return row ? mapLibrary(row) : null;
    });
  }

  async updateCodeHintIfMissing(input: {
    libraryId: string;
    codeDigest: string;
    accessVersion: number;
    codeHint: string;
  }): Promise<MeetingLibraryRecord | null> {
    return this.runMutationExclusive(async () => {
      const db = await this.getDb();
      await db.run(
        `UPDATE meeting_libraries
         SET code_hint = ?
         WHERE library_id = ?
           AND code_digest = ?
           AND access_version = ?
           AND code_hint IS NULL`,
        input.codeHint,
        input.libraryId,
        input.codeDigest,
        input.accessVersion
      );
      const row = await db.get<MeetingLibraryRow>(
        `SELECT * FROM meeting_libraries
         WHERE library_id = ? AND code_digest = ? AND access_version = ?`,
        input.libraryId,
        input.codeDigest,
        input.accessVersion
      );
      return row ? mapLibrary(row) : null;
    });
  }

  async insertAdminAudit(record: MeetingAdminAuditRecord): Promise<void> {
    await this.runMutationExclusive(async () => {
      const db = await this.getDb();
      await this.insertAdminAuditWithDb(db, record);
    });
  }

  async listAdminAudits(limit = 100): Promise<MeetingAdminAuditRecord[]> {
    const db = await this.getDb();
    const rows = await db.all<MeetingAdminAuditRow[]>(
      `SELECT rowid AS insertion_order, * FROM meeting_admin_audit_logs
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
      Math.max(1, Math.min(500, Math.trunc(limit)))
    );
    return rows.map(mapAudit);
  }

  private async getDb(): Promise<Database> {
    if (!this.dbPromise) {
      this.dbPromise = this.openDatabase().catch((error) => {
        this.dbPromise = null;
        throw error;
      });
    }
    return this.dbPromise;
  }

  private async insertAdminAuditWithDb(
    db: Database,
    record: MeetingAdminAuditRecord
  ): Promise<void> {
    await db.run(
      `INSERT INTO meeting_admin_audit_logs (
        audit_id, admin_username, action, library_id, session_id, client_ip, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      record.auditId,
      record.adminUsername,
      record.action,
      record.libraryId,
      record.sessionId,
      record.clientIp,
      record.createdAt
    );
  }

  private runMutationExclusive<T>(worker: () => Promise<T>): Promise<T> {
    const result = this.mutationChain.then(worker, worker);
    this.mutationChain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async openDatabase(): Promise<Database> {
    const filename = this.dbFile === ":memory:" ? ":memory:" : path.resolve(this.dbFile);
    if (filename !== ":memory:") {
      await fs.mkdir(path.dirname(filename), { recursive: true });
    }
    const db = await open({ filename, driver: sqlite3.Database });
    await db.exec(
      [
        "PRAGMA busy_timeout=5000;",
        "PRAGMA journal_mode=WAL;",
        "PRAGMA synchronous=NORMAL;",
        "PRAGMA foreign_keys=ON;",
        `CREATE TABLE IF NOT EXISTS meeting_libraries (
          library_id TEXT PRIMARY KEY,
          code_digest TEXT NOT NULL UNIQUE,
          display_name TEXT,
          display_name_confirmed_at TEXT,
          code_hint TEXT,
          access_version INTEGER NOT NULL DEFAULT 1 CHECK (access_version > 0),
          created_at TEXT NOT NULL,
          code_rotated_at TEXT NOT NULL,
          revoked_at TEXT
        );`,
        `CREATE TABLE IF NOT EXISTS meeting_admin_audit_logs (
          audit_id TEXT PRIMARY KEY,
          admin_username TEXT NOT NULL,
          action TEXT NOT NULL CHECK (action IN ('list-libraries', 'open-library', 'rotate-code')),
          library_id TEXT,
          session_id TEXT,
          client_ip TEXT NOT NULL,
          created_at TEXT NOT NULL
        );`,
        "CREATE INDEX IF NOT EXISTS idx_meeting_libraries_created ON meeting_libraries(created_at DESC);",
        "CREATE INDEX IF NOT EXISTS idx_meeting_admin_audit_created ON meeting_admin_audit_logs(created_at DESC);",
        "CREATE INDEX IF NOT EXISTS idx_meeting_admin_audit_library ON meeting_admin_audit_logs(library_id, created_at DESC);",
      ].join("\n")
    );
    const libraryColumns = await db.all<Array<{ name: string }>>(
      "PRAGMA table_info(meeting_libraries)"
    );
    const libraryColumnNames = new Set(libraryColumns.map((column) => column.name));
    if (!libraryColumnNames.has("display_name")) {
      await db.exec("ALTER TABLE meeting_libraries ADD COLUMN display_name TEXT");
    }
    if (!libraryColumnNames.has("code_hint")) {
      await db.exec("ALTER TABLE meeting_libraries ADD COLUMN code_hint TEXT");
    }
    if (!libraryColumnNames.has("display_name_confirmed_at")) {
      await db.exec(
        "ALTER TABLE meeting_libraries ADD COLUMN display_name_confirmed_at TEXT"
      );
    }
    await db.run(
      `UPDATE meeting_libraries
       SET display_name_confirmed_at = created_at
       WHERE display_name_confirmed_at IS NULL
         AND display_name IS NOT NULL
         AND TRIM(display_name) <> ''
         AND display_name <> ?`,
      "未命名錄音庫"
    );
    return db;
  }
}

export const meetingLibraryRepository = new MeetingLibraryRepository();

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import { HttpError } from "../../utils/httpError";
import { env } from "../../config/env";
import { validateMeetingRecord } from "../../services/meeting-minutes/meetingMinutesSchema";
import { compareMeetingSummaryRevision } from "../../services/meeting-minutes/meetingSummaryRevisionChanges";

export interface MeetingSummaryArchiveInput {
  sessionId: string;
  versionNumber: number;
  title: string;
  meetingDate: string | null;
  generatedAt: string;
  html: string;
}

export interface MeetingSummaryArchiveItem {
  sessionId: string;
  versionNumber: number;
  title: string;
  meetingDate: string | null;
  generatedAt: string;
  archivedAt: string;
  sizeBytes: number;
  sha256: string;
}

interface ArchiveRow {
  session_id: string;
  version_number: number;
  title: string;
  meeting_date: string | null;
  generated_at: string;
  archived_at: string;
  size_bytes: number;
  sha256: string;
  html: string;
}

function toItem(row: ArchiveRow): MeetingSummaryArchiveItem {
  return { sessionId: row.session_id, versionNumber: row.version_number, title: row.title,
    meetingDate: row.meeting_date, generatedAt: row.generated_at, archivedAt: row.archived_at,
    sizeBytes: row.size_bytes, sha256: row.sha256 };
}

export class MeetingSummaryArchiveRepository {
  private dbPromise: Promise<Database> | null = null;
  private operation: Promise<unknown> = Promise.resolve();

  constructor(private readonly dbFile: string, private readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Invalid summary archive capacity");
  }

  publish(input: MeetingSummaryArchiveInput, archivedAt: string,
    adoption?: { ownerId: string; expectedVersionId: string; versionId: string; jobId: string; acknowledgementToken?: unknown }): Promise<MeetingSummaryArchiveItem> {
    return this.serial(async () => {
      if (!input.sessionId || !input.html || !Number.isSafeInteger(input.versionNumber) || input.versionNumber < 1) {
        throw new HttpError(400, "摘要歸檔資料不完整。", "MEETING_SUMMARY_ARCHIVE_INVALID");
      }
      const db = await this.getDb();
      const sizeBytes = Buffer.byteLength(input.html, "utf8");
      const sha256 = createHash("sha256").update(input.html).digest("hex");
      await db.exec("BEGIN IMMEDIATE");
      try {
        if (adoption) {
          const session = await db.get<{ adopted_version_id: string | null; revision_job_id: string | null; expires_at: string | null; cleanup_started_at: string | null; cancel_requested_at: string | null }>(
            "SELECT * FROM meeting_one_shot_sessions WHERE session_id=? AND owner_id=?", input.sessionId, adoption.ownerId);
          if (!session) throw new HttpError(404, "找不到會議。", "MEETING_ONE_SHOT_NOT_FOUND");
          if (session.cleanup_started_at || !session.expires_at || session.expires_at <= archivedAt) throw new HttpError(410, "修訂期限已到，請使用已保存的摘要。", "MEETING_ONE_SHOT_EXPIRED");
          if (session.adopted_version_id !== adoption.versionId) {
            if (session.cancel_requested_at || session.adopted_version_id !== adoption.expectedVersionId || session.revision_job_id !== adoption.jobId) throw new HttpError(409, "修訂已由其他分頁更新，請重新讀取。", "MEETING_REVISION_CONFLICT");
            const version = await db.get<{ record_json: string; revision_base_version_id: string | null }>(`SELECT version.record_json, job.revision_base_version_id FROM meeting_minutes_versions version JOIN meeting_minutes_jobs job ON job.job_id=version.job_id
              WHERE version.version_id=? AND version.job_id=? AND version.session_id=? AND version.owner_id=? AND version.version_number=? AND version.status='ready' AND job.status='ready'`,
              adoption.versionId, adoption.jobId, input.sessionId, adoption.ownerId, input.versionNumber);
            if (!version) throw new HttpError(409, "修訂版尚未完成。", "MEETING_REVISION_NOT_READY");
            if (!version.revision_base_version_id) throw new HttpError(409, "修訂來源版本缺失，請放棄後重新產生。", "MEETING_REVISION_BASE_MISSING");
            if (version.revision_base_version_id !== adoption.expectedVersionId) throw new HttpError(409, "修訂來源版本不一致，請重新讀取。", "MEETING_REVISION_CONFLICT");
            const base = await db.get<{ record_json: string }>(`SELECT record_json FROM meeting_minutes_versions
              WHERE version_id=? AND session_id=? AND owner_id=? AND status='ready'`, version.revision_base_version_id, input.sessionId, adoption.ownerId);
            if (!base) throw new HttpError(409, "修訂來源版本缺失，請放棄後重新產生。", "MEETING_REVISION_BASE_MISSING");
            const comparison = compareMeetingSummaryRevision(version.revision_base_version_id, adoption.versionId,
              validateMeetingRecord(JSON.parse(base.record_json)), validateMeetingRecord(JSON.parse(version.record_json)));
            if (comparison.requiresAcknowledgement && adoption.acknowledgementToken !== comparison.acknowledgementToken) {
              throw new HttpError(409, "修訂移除或改寫了既有內容，請核對差異並明確確認後再採用。", "MEETING_REVISION_CHANGES_NOT_ACKNOWLEDGED");
            }
            await db.run("UPDATE meeting_one_shot_sessions SET adopted_version_id=?, revision_job_id=NULL WHERE session_id=?", adoption.versionId, input.sessionId);
          }
        }
        const previous = await db.get<ArchiveRow>("SELECT * FROM meeting_summary_archive WHERE session_id = ?", input.sessionId);
        if (previous && previous.version_number >= input.versionNumber) {
          if (previous.version_number === input.versionNumber && previous.sha256 !== sha256) {
            throw new HttpError(409, "同一摘要版本的內容不一致。", "MEETING_SUMMARY_ARCHIVE_CONFLICT");
          }
          await db.exec("COMMIT");
          return toItem(previous);
        }
        const usage = await db.get<{ bytes: number }>("SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM meeting_summary_archive");
        if ((usage?.bytes ?? 0) - (previous?.size_bytes ?? 0) + sizeBytes > this.maxBytes) {
          throw new HttpError(507, "摘要庫容量已滿，請聯絡開發者處理。", "MEETING_SUMMARY_ARCHIVE_FULL");
        }
        await db.run(
          `INSERT INTO meeting_summary_archive
           (session_id, version_number, title, meeting_date, generated_at, archived_at, size_bytes, sha256, html)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET version_number=excluded.version_number,
           title=excluded.title, meeting_date=excluded.meeting_date, generated_at=excluded.generated_at,
           size_bytes=excluded.size_bytes, sha256=excluded.sha256, html=excluded.html`,
          input.sessionId, input.versionNumber, input.title, input.meetingDate, input.generatedAt,
          archivedAt, sizeBytes, sha256, input.html
        );
        const saved = await db.get<ArchiveRow>("SELECT * FROM meeting_summary_archive WHERE session_id = ?", input.sessionId);
        await db.exec("COMMIT");
        return toItem(saved!);
      } catch (error) {
        await db.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
  }

  get(sessionId: string): Promise<(MeetingSummaryArchiveItem & { html: string }) | null> {
    return this.serial(async () => {
      const row = await (await this.getDb()).get<ArchiveRow>("SELECT * FROM meeting_summary_archive WHERE session_id = ?", sessionId);
      return row ? { ...toItem(row), html: row.html } : null;
    });
  }

  list(limit = 50, offset = 0, query = ""): Promise<MeetingSummaryArchiveItem[]> {
    return this.serial(async () => {
      const rows = await (await this.getDb()).all<ArchiveRow[]>(
        `SELECT session_id, version_number, title, meeting_date, generated_at, archived_at, size_bytes, sha256
         FROM meeting_summary_archive WHERE instr(title, ?) > 0
         ORDER BY archived_at DESC, session_id DESC LIMIT ? OFFSET ?`,
        query, Math.max(1, Math.min(100, Math.trunc(limit))), Math.max(0, Math.trunc(offset))
      );
      return rows.map(toItem);
    });
  }

  stats(): Promise<{ count: number; bytes: number; maxBytes: number }> {
    return this.serial(async () => {
      const row = await (await this.getDb()).get<{ count: number; bytes: number }>(
        "SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes FROM meeting_summary_archive"
      );
      return { count: row?.count ?? 0, bytes: row?.bytes ?? 0, maxBytes: this.maxBytes };
    });
  }

  close(): Promise<void> {
    return this.serial(async () => {
      if (this.dbPromise) await (await this.dbPromise).close();
      this.dbPromise = null;
    });
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    // 同一 connection 的讀取也排隊，不能讓管理介面觀察到尚未 commit 的歸檔。
    const result = this.operation.then(action, action);
    this.operation = result.catch(() => undefined);
    return result;
  }

  private getDb(): Promise<Database> {
    this.dbPromise ??= this.openDb().catch(error => { this.dbPromise = null; throw error; });
    return this.dbPromise;
  }

  private async openDb(): Promise<Database> {
    const filename = this.dbFile === ":memory:" ? this.dbFile : path.resolve(this.dbFile);
    if (filename !== ":memory:") await fs.mkdir(path.dirname(filename), { recursive: true });
    const db = await open({ filename, driver: sqlite3.Database });
    try {
      await db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS meeting_summary_archive (
          session_id TEXT PRIMARY KEY, version_number INTEGER NOT NULL CHECK(version_number > 0),
          title TEXT NOT NULL, meeting_date TEXT, generated_at TEXT NOT NULL, archived_at TEXT NOT NULL,
          size_bytes INTEGER NOT NULL CHECK(size_bytes > 0), sha256 TEXT NOT NULL, html TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_meeting_summary_archive_order ON meeting_summary_archive(archived_at DESC, session_id DESC);`);
      return db;
    } catch (error) { await db.close(); throw error; }
  }
}

export const meetingSummaryArchiveRepository = new MeetingSummaryArchiveRepository(
  env.MEETING_PROCESSING_DB_FILE, env.MEETING_SUMMARY_ARCHIVE_MAX_BYTES
);

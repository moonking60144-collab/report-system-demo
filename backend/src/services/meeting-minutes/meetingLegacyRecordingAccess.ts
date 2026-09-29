import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import type { Request, Response } from "express";
import { env } from "../../config/env";
import { HttpError } from "../../utils/httpError";

// Only validates previously issued session capabilities; never issues library credentials.
export class MeetingLegacyRecordingAccess {
  private db: Promise<Database> | null = null;
  constructor(private readonly dbFile = env.MEETING_PROCESSING_DB_FILE) {}

  readCookie(req: Request): string | null {
    const raw = req.header("cookie")?.split(";").map(item => item.trim())
      .find(item => item.startsWith("meeting_recording_session_v1="));
    if (!raw) return null;
    try { return decodeURIComponent(raw.slice(raw.indexOf("=") + 1)); } catch { return null; }
  }

  clearCookie(req: Request, res: Response, sessionId: string): void {
    res.clearCookie("meeting_recording_session_v1", { path: `/api/meetings/recordings/${sessionId}`,
      httpOnly: true, sameSite: "strict", secure: env.NODE_ENV === "production" || req.secure });
  }

  async assertActive(libraryId: string, expectedVersion: number): Promise<void> {
    let row: { access_version: number; revoked_at: string | null } | undefined;
    try {
      this.db ??= open({ filename: this.dbFile, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY })
        .catch(error => { this.db = null; throw error; });
      row = await (await this.db).get("SELECT access_version, revoked_at FROM meeting_libraries WHERE library_id=?", libraryId);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && ["SQLITE_CANTOPEN", "SQLITE_ERROR"].includes(String(error.code)))) throw error;
    }
    if (!Number.isInteger(expectedVersion) || expectedVersion <= 0 || !row || row.revoked_at || row.access_version !== expectedVersion) {
      throw new HttpError(401, "錄音 session 權限已失效。", "MEETING_RECORDING_SESSION_CAPABILITY_REVOKED");
    }
  }

  async close(): Promise<void> {
    if (this.db) await (await this.db).close();
    this.db = null;
  }
}

export const meetingLegacyRecordingAccess = new MeetingLegacyRecordingAccess();

import { notifyMeetingStateChanged } from "../../events/meetingStateEvents";
import fs from "node:fs/promises";
import path from "node:path";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import { env } from "../../config/env";
import type { MeetingProviderTranscriptSegment } from "../../services/meeting-minutes/meetingTranscriptionProvider";

export const LIVE_TRANSCRIPTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS meeting_live_chunks (
 session_id TEXT NOT NULL, source_id TEXT NOT NULL, chunk_index INTEGER NOT NULL,
 profile TEXT NOT NULL, audio_hash TEXT NOT NULL, audio_path TEXT NOT NULL,
 start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, window_start_ms INTEGER NOT NULL, window_end_ms INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', segments_json TEXT, attempts INTEGER NOT NULL DEFAULT 0,
 lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, error TEXT,
 last_claimed_at INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(session_id, source_id, chunk_index, profile)
);
CREATE INDEX IF NOT EXISTS idx_meeting_live_pending ON meeting_live_chunks(status,retry_at,start_ms);
CREATE TABLE IF NOT EXISTS meeting_live_decoder_leases (
 session_id TEXT NOT NULL, source_id TEXT NOT NULL, profile TEXT NOT NULL,
 lease_id TEXT NOT NULL, lease_until INTEGER NOT NULL,
 PRIMARY KEY(session_id, source_id, profile, lease_id)
);
CREATE TABLE IF NOT EXISTS meeting_live_sources (
 session_id TEXT NOT NULL, source_id TEXT NOT NULL, profile TEXT NOT NULL,
 decoded_ms INTEGER NOT NULL, complete INTEGER NOT NULL DEFAULT 0, deferred INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(session_id, source_id, profile)
);`;

export interface LiveChunk {
 sessionId: string; sourceId: "room-mic" | "remote-tab"; chunkIndex: number; profile: string;
 audioHash: string; audioPath: string; startMs: number; endMs: number; windowStartMs: number; windowEndMs: number;
}
const columns = `session_id AS sessionId, source_id AS sourceId, chunk_index AS chunkIndex, profile,
 audio_hash AS audioHash, audio_path AS audioPath, start_ms AS startMs, end_ms AS endMs,
 window_start_ms AS windowStartMs, window_end_ms AS windowEndMs`;

export class MeetingLiveTranscriptionRepository {
 private dbPromise: Promise<Database> | null = null;
 constructor(private readonly dbFile = env.MEETING_PROCESSING_DB_FILE) {}
 private getDb(): Promise<Database> {
   this.dbPromise ??= (async () => {
     if (this.dbFile !== ":memory:") await fs.mkdir(path.dirname(path.resolve(this.dbFile)), { recursive: true });
     const db = await open({ filename: this.dbFile, driver: sqlite3.Database });
     await db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; ${LIVE_TRANSCRIPTION_SCHEMA}`);
     await db.exec("BEGIN IMMEDIATE");
     try {
       const columns = await db.all<Array<{ name: string }>>("PRAGMA table_info(meeting_live_sources)");
       if (!columns.some(column => column.name === "deferred")) await db.exec("ALTER TABLE meeting_live_sources ADD COLUMN deferred INTEGER NOT NULL DEFAULT 0");
       const chunkColumns = await db.all<Array<{ name: string }>>("PRAGMA table_info(meeting_live_chunks)");
       if (!chunkColumns.some(column => column.name === "last_claimed_at")) await db.exec("ALTER TABLE meeting_live_chunks ADD COLUMN last_claimed_at INTEGER NOT NULL DEFAULT 0");
       await db.exec("COMMIT");
     } catch (error) { await db.exec("ROLLBACK").catch(() => undefined); await db.close(); throw error; }
     return db;
   })().catch(error => { this.dbPromise = null; throw error; });
   return this.dbPromise;
 }
 async close() { if (this.dbPromise) await (await this.dbPromise).close(); this.dbPromise = null; }
 async register(chunk: LiveChunk, decoderLeaseId?: string, now = Date.now()) {
   const db = await this.getDb();
   await db.run(`INSERT OR IGNORE INTO meeting_live_chunks
    (session_id,source_id,chunk_index,profile,audio_hash,audio_path,start_ms,end_ms,window_start_ms,window_end_ms)
    SELECT ?,?,?,?,?,?,?,?,?,? WHERE ? IS NULL OR EXISTS (
      SELECT 1 FROM meeting_live_decoder_leases WHERE session_id=? AND source_id=? AND profile=? AND lease_id=? AND lease_until>?
    )`, chunk.sessionId,chunk.sourceId,chunk.chunkIndex,chunk.profile,chunk.audioHash,chunk.audioPath,
    chunk.startMs,chunk.endMs,chunk.windowStartMs,chunk.windowEndMs,
    decoderLeaseId ?? null,chunk.sessionId,chunk.sourceId,chunk.profile,decoderLeaseId ?? null,now);
   const row = await db.get<{ audio_hash: string }>(`SELECT audio_hash FROM meeting_live_chunks
    WHERE session_id=? AND source_id=? AND chunk_index=? AND profile=?`,chunk.sessionId,chunk.sourceId,chunk.chunkIndex,chunk.profile);
   if (row?.audio_hash !== chunk.audioHash) throw new Error("Live audio window changed during replay");
 }
 async renewDecoderLease(sessionId: string, sourceId: string, profile: string, leaseId: string,
   now: number, leaseMs: number): Promise<boolean> {
   return (await (await this.getDb()).run(`INSERT INTO meeting_live_decoder_leases
    (session_id,source_id,profile,lease_id,lease_until)
    SELECT session_id,?,?,?,? FROM meeting_one_shot_sessions
    WHERE session_id=? AND pipeline_released_at IS NULL AND cleaned_at IS NULL AND cancel_requested_at IS NULL
      AND (recorder_lease_until > ? OR recording_finalized_at IS NOT NULL)
    ON CONFLICT(session_id,source_id,profile,lease_id) DO UPDATE SET lease_until=excluded.lease_until`,
    sourceId,profile,leaseId,now+leaseMs,sessionId,new Date(now).toISOString())).changes === 1;
 }
 async releaseDecoderLease(leaseId: string, sessionId?: string, sourceId?: string) {
   const result = await (await this.getDb()).run(`DELETE FROM meeting_live_decoder_leases WHERE lease_id=?
    ${sessionId ? "AND session_id=?" : ""} ${sourceId ? "AND source_id=?" : ""}`,
    leaseId,...(sessionId ? [sessionId] : []),...(sourceId ? [sourceId] : []));
   if (result.changes) notifyMeetingStateChanged();
 }
 async heartbeatDecoderLease(sessionId: string, sourceId: string, profile: string, leaseId: string, until: number, now = Date.now()): Promise<boolean> {
   return (await (await this.getDb()).run(`UPDATE meeting_live_decoder_leases SET lease_until=?
    WHERE session_id=? AND source_id=? AND profile=? AND lease_id=? AND lease_until>?`, until,sessionId,sourceId,profile,leaseId,now)).changes === 1;
 }
 async source(sessionId: string, sourceId: string, profile: string, decodedMs: number, complete: boolean) {
   await (await this.getDb()).run(`INSERT INTO meeting_live_sources (session_id,source_id,profile,decoded_ms,complete) VALUES(?,?,?,?,?)
    ON CONFLICT(session_id,source_id,profile) DO UPDATE SET decoded_ms=MAX(decoded_ms,excluded.decoded_ms),complete=MAX(complete,excluded.complete)`,
    sessionId,sourceId,profile,decodedMs,Number(complete));
   if (complete) notifyMeetingStateChanged();
 }
  async hasSession(sessionId: string, profile: string): Promise<boolean> {
   return Boolean(await (await this.getDb()).get("SELECT 1 FROM meeting_live_sources WHERE session_id=? AND profile=? LIMIT 1",sessionId,profile));
  }
 async hasReadySource(sessionId: string, sourceId: string, profile: string): Promise<boolean> {
   return Boolean(await (await this.getDb()).get("SELECT 1 FROM meeting_live_chunks WHERE session_id=? AND source_id=? AND profile=? AND status='ready' LIMIT 1",sessionId,sourceId,profile));
 }
 async sourceComplete(sessionId: string, sourceId: string, profile: string): Promise<boolean> {
   return Boolean(await (await this.getDb()).get("SELECT 1 FROM meeting_live_sources WHERE session_id=? AND source_id=? AND profile=? AND (complete=1 OR deferred=1)",sessionId,sourceId,profile));
 }
 async deferSource(sessionId: string, sourceId: string, profile: string) {
   await (await this.getDb()).run("UPDATE meeting_live_sources SET deferred=1 WHERE session_id=? AND source_id=? AND profile=?",sessionId,sourceId,profile);
   notifyMeetingStateChanged();
 }
 async claim(profile: string, lease: string, now: number, leaseMs: number): Promise<LiveChunk | null> {
   return await (await this.getDb()).get<LiveChunk>(`WITH turns AS (
     SELECT session_id,source_id,MAX(last_claimed_at) AS last_claim,MIN(rowid) AS first_row
     FROM meeting_live_chunks WHERE profile=? GROUP BY session_id,source_id)
    UPDATE meeting_live_chunks SET status='running',lease=?,lease_until=?,attempts=attempts+1,last_claimed_at=?
    WHERE rowid=(SELECT c.rowid FROM meeting_live_chunks c JOIN turns t USING(session_id,source_id)
     WHERE c.profile=? AND attempts<3 AND retry_at<=?
     AND (status='pending' OR (status='running' AND lease_until<=?))
     ORDER BY t.last_claim,t.first_row,c.chunk_index,c.rowid LIMIT 1)
    RETURNING ${columns}`,profile,lease,now+leaseMs,now,profile,now,now) ?? null;
 }
 async retireOtherProfiles(profile: string | null, now: number): Promise<void> {
   const result = await (await this.getDb()).run(`UPDATE meeting_live_chunks SET status='superseded',lease=NULL
    WHERE (? IS NULL OR profile!=? OR attempts>=3)
      AND (status='pending' OR (status='running' AND lease_until<=?))`,profile,profile,now);
   if (result.changes) notifyMeetingStateChanged();
 }
 async heartbeat(lease: string, until: number): Promise<boolean> {
   return (await (await this.getDb()).run("UPDATE meeting_live_chunks SET lease_until=? WHERE lease=? AND status='running'",until,lease)).changes === 1;
 }
 async finish(lease: string, segments: MeetingProviderTranscriptSegment[]): Promise<boolean> {
   const changed = (await (await this.getDb()).run("UPDATE meeting_live_chunks SET status='ready',segments_json=?,lease=NULL,error=NULL WHERE lease=? AND status='running'",JSON.stringify(segments),lease)).changes === 1;
   if (changed) notifyMeetingStateChanged();
   return changed;
 }
 async fail(lease: string, error: string, now: number, aborted: boolean) {
   await (await this.getDb()).run(`UPDATE meeting_live_chunks SET status='pending',lease=NULL,retry_at=?,error=?,attempts=MAX(0,attempts-?) WHERE lease=? AND status='running'`,now+ (aborted ? 0 : 30_000),error,Number(aborted),lease);
   notifyMeetingStateChanged();
 }
 async cached(chunk: Pick<LiveChunk,"sessionId"|"sourceId"|"chunkIndex"|"profile"|"audioHash">): Promise<MeetingProviderTranscriptSegment[] | null> {
   const row = await (await this.getDb()).get<{ segments_json: string }>(`SELECT segments_json FROM meeting_live_chunks
    WHERE session_id=? AND source_id=? AND chunk_index=? AND profile=? AND audio_hash=? AND status='ready'`,
    chunk.sessionId,chunk.sourceId,chunk.chunkIndex,chunk.profile,chunk.audioHash);
   return row ? JSON.parse(row.segments_json) : null;
 }
 async progress(sessionId: string, profile: string) {
   const rows = await (await this.getDb()).all<Array<{ sourceId: string; chunkIndex: number; endMs: number; status: string; attempts: number }>>(
    `SELECT source_id AS sourceId,chunk_index AS chunkIndex,end_ms AS endMs,status,attempts FROM meeting_live_chunks WHERE session_id=? AND profile=? ORDER BY source_id,chunk_index`,sessionId,profile);
   const sources = await (await this.getDb()).all<Array<{ sourceId: string; decodedMs: number; complete: number; deferred: number }>>(
    "SELECT source_id AS sourceId,decoded_ms AS decodedMs,complete,deferred FROM meeting_live_sources WHERE session_id=? AND profile=?",sessionId,profile);
   return sources.map(source => {
     let processedMs = 0; let expected = 0;
     for (const row of rows.filter(row => row.sourceId === source.sourceId)) {
       if (row.chunkIndex !== expected || row.status !== "ready") break;
       processedMs = row.endMs; expected++;
     }
     return { ...source, complete: Boolean(source.complete), deferred: Boolean(source.deferred), processedMs,
       failed: rows.some(row => row.sourceId === source.sourceId && row.attempts >= 3 && row.status !== "ready") };
   });
 }
 async forget(sessionId: string) {
   const db = await this.getDb();
   await db.run("DELETE FROM meeting_live_chunks WHERE session_id=?",sessionId);
   await db.run("DELETE FROM meeting_live_sources WHERE session_id=?",sessionId);
   await db.run("DELETE FROM meeting_live_decoder_leases WHERE session_id=?",sessionId);
 }
 async seal(sessionId: string) {
   await (await this.getDb()).run("UPDATE meeting_live_chunks SET status='superseded',lease=NULL WHERE session_id=? AND status!='ready'",sessionId);
 }
}
export const meetingLiveTranscriptionRepository = new MeetingLiveTranscriptionRepository();
